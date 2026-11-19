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
type WakeupServiceInstance = InstanceType<typeof SessionWakeupService>;

// A pump re-runs itself when asked while busy; stop every instance after each
// test so a trailing pump cannot deliver the next test's rows through old fakes.
const created: WakeupServiceInstance[] = [];

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
  created.push(service);
  return { service, submissions, eventBus, services, now, setActiveTurn: (value: boolean) => { activeTurn = value; }, setQueueFull: (value: boolean) => { queueFull = value; } };
}

async function fixture() {
  const project = await db.project.create({ data: { name: 'wakeup project', repoPath: dir } });
  const task = await db.task.create({ data: { projectId: project.id, title: 'wakeup task', status: 'IN_PROGRESS' } });
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
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const service of created.splice(0)) {
      service.stop();
      await (service as unknown as { pumping?: Promise<void> }).pumping;
    }
  });
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

  it('cancels instead of reopening a task that a person moved out of IN_PROGRESS', async () => {
    const { session, task } = await fixture();
    const f = fakes();
    const changed: string[] = [];
    f.eventBus.on('session:wakeups_changed', ({ sessionId }) => changed.push(sessionId));

    // Durable path: the task was moved while no listener was running.
    const timer = await f.service.scheduleTimer({ sessionId: session.id, delaySeconds: 60, reason: 'check' });
    await db.task.update({ where: { id: task.id }, data: { status: 'DONE' } });
    f.now.value = new Date('2026-11-06T00:02:00Z');
    await f.service.pump();
    expect(f.submissions).toHaveLength(0);
    expect(await db.sessionWakeup.findUniqueOrThrow({ where: { id: timer.id } })).toMatchObject({ state: 'CANCELLED', lastError: 'TASK_NOT_IN_PROGRESS' });

    // Live path: task:updated cancels right away, but only if the task is still out of IN_PROGRESS.
    await db.task.update({ where: { id: task.id }, data: { status: 'IN_PROGRESS' } });
    const second = await f.service.scheduleTimer({ sessionId: session.id, delaySeconds: 600, reason: 'later' });
    f.service.start();
    try {
      f.eventBus.emit('task:updated', { taskId: task.id, projectId: task.projectId, status: 'IN_REVIEW' });
      await new Promise((resolve) => setTimeout(resolve, 50));
      // The task row still says IN_PROGRESS (stale event): keep the wake-up.
      expect((await db.sessionWakeup.findUniqueOrThrow({ where: { id: second.id } })).state).toBe('PENDING');
      await db.task.update({ where: { id: task.id }, data: { status: 'IN_REVIEW' } });
      f.eventBus.emit('task:updated', { taskId: task.id, projectId: task.projectId, status: 'IN_REVIEW' });
      await vi.waitFor(async () => {
        expect(await db.sessionWakeup.findUniqueOrThrow({ where: { id: second.id } })).toMatchObject({ state: 'CANCELLED', lastError: 'TASK_NOT_IN_PROGRESS' });
      });
    } finally { f.service.stop(); }
    expect(changed.filter((id) => id === session.id).length).toBeGreaterThanOrEqual(4);
  });

  it('lets a person cancel one pending wake-up and reports one that already fired', async () => {
    const { session } = await fixture();
    const f = fakes();
    const changed: string[] = [];
    f.eventBus.on('session:wakeups_changed', ({ sessionId }) => changed.push(sessionId));
    const keep = await f.service.scheduleTimer({ sessionId: session.id, delaySeconds: 60, reason: 'keep' });
    const drop = await f.service.scheduleTimer({ sessionId: session.id, delaySeconds: 3600, reason: 'drop' });
    changed.length = 0;
    await expect(f.service.cancelById(session.id, drop.id)).resolves.toMatchObject({ id: drop.id, state: 'CANCELLED', lastError: 'USER_CANCELLED' });
    expect(changed).toEqual([session.id]);
    // Cancelling twice is harmless and does not notify again.
    await expect(f.service.cancelById(session.id, drop.id)).resolves.toMatchObject({ state: 'CANCELLED' });
    expect(changed).toEqual([session.id]);
    await expect(f.service.cancelById('other-session', keep.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    f.now.value = new Date('2026-11-06T00:02:00Z');
    await f.service.pump();
    expect(f.submissions).toHaveLength(1);
    await expect(f.service.cancelById(session.id, keep.id)).rejects.toMatchObject({ code: 'WAKEUP_ALREADY_FIRED' });
  });

  it('releases a service wait whose exit was never pushed, after a grace period', async () => {
    const { session, workspace, serviceRow } = await fixture();
    const f = fakes();
    f.services.set(`${workspace.id}:route`, { id: serviceRow.id, workspaceId: workspace.id, name: 'route', runtimeState: 'RUNNING', runtimeInstanceId: 'rt-1', exitCode: null });
    const wakeup = await f.service.waitForService({ sessionId: session.id, workspaceId: workspace.id, serviceName: 'route', reason: 'routing' });
    await db.sessionWakeup.update({ where: { id: wakeup.id }, data: { createdAt: new Date('2026-11-05T23:59:00Z') } });
    // Agent Tower restarted: startup reconcile marked the service STOPPED without an exit push.
    await db.workspaceBackgroundService.update({
      where: { id: serviceRow.id },
      data: { desiredState: 'STOPPED', runtimeState: 'STOPPED', runtimeInstanceId: null, pid: null, exitCode: 0, stoppedAt: new Date('2026-11-05T23:59:55Z') },
    });
    await f.service.pump();
    expect((await db.sessionWakeup.findUniqueOrThrow({ where: { id: wakeup.id } })).state).toBe('PENDING');
    f.now.value = new Date('2026-11-06T00:00:30Z');
    await f.service.pump();
    expect(f.submissions).toHaveLength(1);
    const message = f.submissions[0]!.message;
    expect(message).toContain('runtime_state="STOPPED"');
    // A STOPPED record may carry an older run's exit code; it is not reported as this exit.
    expect(message).toContain('exit_code="unknown"');
    expect(message).toContain('was stopped before it finished');
    expect(message).toContain('did not observe this exit');
    expect((await db.sessionWakeup.findUniqueOrThrow({ where: { id: wakeup.id } })).state).toBe('FIRED');
  });

  it('rejects wake-ups for conversation sessions and unknown sessions', async () => {
    const f = fakes();
    await expect(f.service.scheduleTimer({ sessionId: 'missing', delaySeconds: 60, reason: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // A session without a workspace (standalone conversation) cannot be woken.
    const session = await db.session.create({ data: { context: 'CONVERSATION', agentType: 'CLAUDE_CODE', variant: 'DEFAULT', prompt: 'hi', status: 'COMPLETED' } });
    await expect(f.service.scheduleTimer({ sessionId: session.id, delaySeconds: 60, reason: 'x' })).rejects.toMatchObject({ code: 'WAKEUP_UNAVAILABLE' });
  });

  it('schedules one usage-limit resume per session, moves it to a later reset and fires it like a timer', async () => {
    const { session } = await fixture();
    const f = fakes();
    const payload = { resetsAt: '2026-11-08T00:00:00.000Z', limitType: 'seven_day', code: 'usage_limit_reached', message: "You've hit your weekly limit · resets Nov 7, 4pm (America/Los_Angeles)" };
    // A weekly reset is days away; the agent-timer limit of 24 hours does not apply.
    const first = await f.service.scheduleUsageLimitResume({ sessionId: session.id, fireAt: new Date('2026-11-08T00:02:00Z'), reason: payload.message, payload });
    expect(first).toMatchObject({ kind: 'USAGE_LIMIT', state: 'PENDING', fireAt: '2026-11-08T00:02:00.000Z', reason: payload.message });
    // An earlier time does not move it; a later stop does.
    const same = await f.service.scheduleUsageLimitResume({ sessionId: session.id, fireAt: new Date('2026-11-06T05:00:00Z'), reason: 'earlier', payload });
    expect(same).toMatchObject({ id: first.id, fireAt: '2026-11-08T00:02:00.000Z' });
    const moved = await f.service.scheduleUsageLimitResume({ sessionId: session.id, fireAt: new Date('2026-11-09T00:02:00Z'), reason: 'later', payload: { ...payload, resetsAt: '2026-11-09T00:00:00.000Z' } });
    expect(moved).toMatchObject({ id: first.id, fireAt: '2026-11-09T00:02:00.000Z', reason: 'later' });
    expect(await db.sessionWakeup.count({ where: { sessionId: session.id } })).toBe(1);

    f.now.value = new Date('2026-11-08T12:00:00Z');
    await f.service.pump();
    expect(f.submissions).toHaveLength(0);
    f.now.value = new Date('2026-11-09T00:02:01Z');
    await f.service.pump();
    expect(f.submissions).toHaveLength(1);
    const message = f.submissions[0]!.message;
    expect(message.startsWith('[SYSTEM NOTIFICATION - NOT USER INPUT]')).toBe(true);
    expect(message).toContain('<agent_tower_wakeup kind="usage_limit" limit="seven_day" resets_at="2026-11-09T00:00:00.000Z">');
    expect(message).toContain(`the usage limit was reached: ${payload.message}`);
    expect(message).toContain('The limit has reset. Continue the work that was interrupted.');
    expect((await db.sessionWakeup.findUniqueOrThrow({ where: { id: first.id } })).state).toBe('FIRED');

    // After it fired, the next stop schedules a new one.
    const next = await f.service.scheduleUsageLimitResume({ sessionId: session.id, fireAt: new Date('2026-11-09T05:02:00Z'), reason: 'again', payload });
    expect(next.id).not.toBe(first.id);
  });

  it('builds messages that never read as user input', () => {
    const text = buildWakeupMessage({ kind: 'SERVICE_EXIT', reason: '', serviceName: 'a"b', fireAt: null, createdAt: new Date(), payload: JSON.stringify({ exitCode: 1, runtimeState: 'FAILED', logTail: ['x'] }) });
    expect(text.startsWith('[SYSTEM NOTIFICATION - NOT USER INPUT]')).toBe(true);
    expect(text).toContain('service="a&quot;b"');
    expect(text).toContain('Workspace service "a"b" exited with code 1.');
  });
});
