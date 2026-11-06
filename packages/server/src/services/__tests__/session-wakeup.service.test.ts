import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { EventBus } from '../../core/event-bus.js';
import { ServiceError } from '../../errors.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-wakeup-'));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
process.env.AGENT_TOWER_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
process.env.AGENT_TOWER_DATA_DIR = path.join(dir, 'data');

let db: PrismaClient;
let SessionWakeupService: typeof import('../session-wakeup.service.js').SessionWakeupService;
let buildWakeupMessage: typeof import('../session-wakeup.service.js').buildWakeupMessage;

type Submission = { sessionId: string; message: string; systemEvent: true; clientSubmissionId: string };

function fakes() {
  const submissions: Submission[] = [];
  let activeTurn = false;
  let queueFull = false;
  const services = new Map<string, { id: string; workspaceId: string; name: string; runtimeState: string; runtimeInstanceId: string | null; exitCode: number | null }>();
  const now = { value: new Date('2026-11-06T00:00:00Z') };
  const eventBus = new EventBus();
  const service = new SessionWakeupService({
    eventBus,
    sessions: { hasActiveTurn: () => activeTurn },
    delivery: { submitSession: async (input) => {
      if (queueFull) throw new ServiceError('full', 'DELIVERY_QUEUE_FULL', 429);
      submissions.push(input);
      return { operationId: `op-${submissions.length}` };
    } },
    services: {
      findService: async (workspaceId, name) => services.get(`${workspaceId}:${name}`) ?? null,
      readLogTail: async () => ['tail line 1', 'tail line 2'],
    },
    pollIntervalMs: 60_000,
    maxPerSessionPerDay: 3,
    now: () => now.value,
  });
  return { service, submissions, eventBus, services, now, setActiveTurn: (value: boolean) => { activeTurn = value; }, setQueueFull: (value: boolean) => { queueFull = value; } };
}

async function fixture() {
  const project = await db.project.create({ data: { name: 'wakeup project', repoPath: dir } });
  const task = await db.task.create({ data: { projectId: project.id, title: 'wakeup task' } });
  const workspace = await db.workspace.create({ data: { taskId: task.id, branchName: 'wakeup', worktreePath: dir } });
  const session = await db.session.create({ data: { workspaceId: workspace.id, agentType: 'CLAUDE_CODE', variant: 'DEFAULT', prompt: 'go', status: 'COMPLETED' } });
  const serviceRow = await db.workspaceBackgroundService.create({ data: { workspaceId: workspace.id, name: 'route', command: 'python3', desiredState: 'RUNNING', runtimeState: 'RUNNING', runtimeInstanceId: 'rt-1', pid: 100 } });
  return { project, task, workspace, session, serviceRow };
}

describe('SessionWakeupService', () => {
  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--schema=prisma/schema.prisma'], { cwd: root, env: process.env, stdio: 'pipe' });
    db = (await import('../../utils/index.js')).prisma;
    ({ SessionWakeupService, buildWakeupMessage } = await import('../session-wakeup.service.js'));
  }, 120_000);
  beforeEach(async () => {
    await db.sessionWakeup.deleteMany();
    await db.project.deleteMany();
  });
  afterEach(() => { vi.restoreAllMocks(); });
  afterAll(async () => { await db.$disconnect(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('fires a timer wake-up once its time comes and delivers a system event to an idle session', async () => {
    const { session } = await fixture();
    const f = fakes();
    await expect(f.service.scheduleTimer({ sessionId: session.id, delaySeconds: 5, reason: 'too soon' })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const wakeup = await f.service.scheduleTimer({ sessionId: session.id, delaySeconds: 600, reason: 'check the router' });
    expect(wakeup).toMatchObject({ kind: 'TIMER', state: 'PENDING', fireAt: '2026-11-06T00:10:00.000Z' });
    await f.service.pump();
    expect(f.submissions).toHaveLength(0);
    f.now.value = new Date('2026-11-06T00:10:01Z');
    await f.service.pump();
    expect(f.submissions).toHaveLength(1);
    expect(f.submissions[0]).toMatchObject({ sessionId: session.id, systemEvent: true, clientSubmissionId: `wakeup:${wakeup.id}` });
    expect(f.submissions[0]!.message).toContain('[SYSTEM NOTIFICATION - NOT USER INPUT]');
    expect(f.submissions[0]!.message).toContain('kind="timer"');
    expect(f.submissions[0]!.message).toContain('Reason: check the router');
    const stored = await db.sessionWakeup.findUniqueOrThrow({ where: { id: wakeup.id } });
    expect(stored).toMatchObject({ state: 'FIRED', deliveryId: 'op-1' });
    await f.service.pump();
    expect(f.submissions).toHaveLength(1);
  });

  it('waits for a workspace service exit, then delivers the exit code and log tail', async () => {
    const { session, workspace, serviceRow } = await fixture();
    const f = fakes();
    f.services.set(`${workspace.id}:route`, { id: serviceRow.id, workspaceId: workspace.id, name: 'route', runtimeState: 'RUNNING', runtimeInstanceId: 'rt-1', exitCode: null });
    await expect(f.service.waitForService({ sessionId: session.id, workspaceId: workspace.id, serviceName: 'missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const wakeup = await f.service.waitForService({ sessionId: session.id, workspaceId: workspace.id, serviceName: 'route', reason: 'routing' });
    expect(wakeup).toMatchObject({ kind: 'SERVICE_EXIT', state: 'PENDING', serviceName: 'route' });
    // Asking twice for the same service returns the same pending wake-up.
    expect((await f.service.waitForService({ sessionId: session.id, workspaceId: workspace.id, serviceName: 'route' })).id).toBe(wakeup.id);
    await f.service.pump();
    expect(f.submissions).toHaveLength(0);
    await f.service.handleServiceExit({ serviceId: serviceRow.id, workspaceId: workspace.id, name: 'route', exitCode: 0, runtimeState: 'EXITED', stopped: false, logTail: ['routed 115 nets', 'done'] });
    await f.service.pump();
    expect(f.submissions).toHaveLength(1);
    const message = f.submissions[0]!.message;
    expect(message).toContain('kind="service_exit" service="route" exit_code="0" runtime_state="EXITED"');
    expect(message).toContain('Reason you gave for waiting: routing');
    expect(message).toContain('routed 115 nets\ndone');
    expect((await db.sessionWakeup.findUniqueOrThrow({ where: { id: wakeup.id } })).state).toBe('FIRED');
  });

  it('delivers immediately when the service already exited', async () => {
    const { session, workspace, serviceRow } = await fixture();
    const f = fakes();
    f.services.set(`${workspace.id}:route`, { id: serviceRow.id, workspaceId: workspace.id, name: 'route', runtimeState: 'FAILED', runtimeInstanceId: null, exitCode: 2 });
    const wakeup = await f.service.waitForService({ sessionId: session.id, workspaceId: workspace.id, serviceName: 'route' });
    expect(wakeup.state).toBe('READY');
    await f.service.pump();
    expect(f.submissions).toHaveLength(1);
    expect(f.submissions[0]!.message).toContain('exit_code="2" runtime_state="FAILED"');
    expect(f.submissions[0]!.message).toContain('tail line 1');
  });

  it('defers while a turn is running, drops for stopped sessions, and enforces the daily cap', async () => {
    const { session } = await fixture();
    const f = fakes();
    const first = await f.service.scheduleTimer({ sessionId: session.id, delaySeconds: 60, reason: 'one' });
    f.now.value = new Date('2026-11-06T00:02:00Z');
    f.setActiveTurn(true);
    await f.service.pump();
    expect(f.submissions).toHaveLength(0);
    expect((await db.sessionWakeup.findUniqueOrThrow({ where: { id: first.id } })).state).toBe('READY');
    f.setActiveTurn(false);
    f.setQueueFull(true);
    await f.service.pump();
    expect((await db.sessionWakeup.findUniqueOrThrow({ where: { id: first.id } })).state).toBe('READY');
    f.setQueueFull(false);
    await f.service.pump();
    expect(f.submissions).toHaveLength(1);

    for (const reason of ['two', 'three']) {
      await f.service.scheduleTimer({ sessionId: session.id, delaySeconds: 60, reason });
      f.now.value = new Date(f.now.value.getTime() + 61_000);
      await f.service.pump();
    }
    expect(f.submissions).toHaveLength(3);
    await expect(f.service.scheduleTimer({ sessionId: session.id, delaySeconds: 60, reason: 'four' })).rejects.toMatchObject({ code: 'WAKEUP_CAP_EXCEEDED' });

    await db.session.update({ where: { id: session.id }, data: { status: 'CANCELLED' } });
    await db.sessionWakeup.create({ data: { sessionId: session.id, kind: 'TIMER', reason: 'late', fireAt: new Date(0), state: 'PENDING' } });
    await f.service.pump();
    expect(f.submissions).toHaveLength(3);
    expect(await db.sessionWakeup.count({ where: { sessionId: session.id, state: 'CANCELLED', lastError: 'SESSION_STOPPED' } })).toBe(1);
  });

  it('cancels pending wake-ups when the session is stopped and limits pending ones', async () => {
    const { session } = await fixture();
    const f = fakes();
    f.service.start();
    try {
      for (let index = 0; index < 8; index += 1) await f.service.scheduleTimer({ sessionId: session.id, delaySeconds: 3600, reason: `r${index}` });
      await expect(f.service.scheduleTimer({ sessionId: session.id, delaySeconds: 3600, reason: 'overflow' })).rejects.toMatchObject({ code: 'WAKEUP_LIMIT' });
      f.eventBus.emit('session:stopped', { sessionId: session.id });
      await vi.waitFor(async () => {
        expect(await db.sessionWakeup.count({ where: { sessionId: session.id, state: 'CANCELLED' } })).toBe(8);
      });
    } finally { f.service.stop(); }
  });

  it('rejects wake-ups for conversation sessions and unknown sessions', async () => {
    const f = fakes();
    await expect(f.service.scheduleTimer({ sessionId: 'missing', delaySeconds: 60, reason: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // A session without a workspace (standalone conversation) cannot be woken.
    const session = await db.session.create({ data: { context: 'CONVERSATION', agentType: 'CLAUDE_CODE', variant: 'DEFAULT', prompt: 'hi', status: 'COMPLETED' } });
    await expect(f.service.scheduleTimer({ sessionId: session.id, delaySeconds: 60, reason: 'x' })).rejects.toMatchObject({ code: 'WAKEUP_UNAVAILABLE' });
  });

  it('builds messages that never read as user input', () => {
    const text = buildWakeupMessage({ kind: 'SERVICE_EXIT', reason: '', serviceName: 'a"b', fireAt: null, createdAt: new Date(), payload: JSON.stringify({ exitCode: 1, runtimeState: 'FAILED', logTail: ['x'] }) });
    expect(text.startsWith('[SYSTEM NOTIFICATION - NOT USER INPUT]')).toBe(true);
    expect(text).toContain('service="a&quot;b"');
    expect(text).toContain('Workspace service "a"b" exited with code 1.');
  });
});
