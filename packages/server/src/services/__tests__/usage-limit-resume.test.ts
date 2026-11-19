import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { EventBus } from '../../core/event-bus.js';
import type { TurnFailureCause } from '../../output/turn-failure.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-usage-limit-'));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
process.env.AGENT_TOWER_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
process.env.AGENT_TOWER_DATA_DIR = path.join(dir, 'data');

let db: PrismaClient;
let resumeModule: typeof import('../usage-limit-resume.js');

const NOW = new Date('2026-11-18T07:16:44Z');
const LIMIT_TEXT = "You've hit your 5-hour limit · resets 1:20am (America/Los_Angeles)";

function cause(overrides: Partial<TurnFailureCause> = {}): TurnFailureCause {
  return { kind: 'usage_limit', resetsAt: '2026-11-18T09:20:00.000Z', limitType: 'five_hour', code: 'usage_limit_reached', message: LIMIT_TEXT, ...overrides };
}

function policy(options: { enabled?: () => Promise<boolean> } = {}) {
  const scheduled: Array<{ sessionId: string; fireAt: Date; reason: string; payload: unknown }> = [];
  const eventBus = new EventBus();
  const resume = new resumeModule.UsageLimitResume({
    eventBus,
    wakeups: { scheduleUsageLimitResume: async (input) => { scheduled.push(input); return {} as never; } },
    ...(options.enabled ? { isEnabled: options.enabled } : {}),
    now: () => NOW,
  });
  return { resume, scheduled, eventBus };
}

async function taskSession(data: { purpose?: string } = {}) {
  const project = await db.project.create({ data: { name: 'usage limit', repoPath: dir } });
  const task = await db.task.create({ data: { projectId: project.id, title: 'resume me', status: 'IN_PROGRESS' } });
  const workspace = await db.workspace.create({ data: { taskId: task.id, branchName: `b-${task.id}`, worktreePath: dir } });
  const session = await db.session.create({ data: { workspaceId: workspace.id, agentType: 'CLAUDE_CODE', variant: 'DEFAULT', prompt: 'go', status: 'RUNNING', ...data } });
  return { task, session };
}

describe('UsageLimitResume', () => {
  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--schema=prisma/schema.prisma'], { cwd: root, env: process.env, stdio: 'pipe' });
    db = (await import('../../utils/index.js')).prisma;
    resumeModule = await import('../usage-limit-resume.js');
  }, 120_000);
  beforeEach(async () => {
    await db.appSettings.deleteMany();
    await db.project.deleteMany();
    await db.session.deleteMany();
  });
  afterAll(async () => { await db.$disconnect(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('wakes the session two minutes after the reset, through the event bus', async () => {
    const { session } = await taskSession();
    const { resume, scheduled, eventBus } = policy();
    resume.start();
    eventBus.emit('session:turn-failure-cause', { sessionId: session.id, cause: cause() });
    await vi.waitFor(() => expect(scheduled).toHaveLength(1), { timeout: 5_000 });
    expect(scheduled[0]).toEqual({
      sessionId: session.id,
      fireAt: new Date('2026-11-18T09:22:00.000Z'),
      reason: LIMIT_TEXT,
      payload: { resetsAt: '2026-11-18T09:20:00.000Z', limitType: 'five_hour', code: 'usage_limit_reached', message: LIMIT_TEXT },
    });
    resume.stop();
    eventBus.emit('session:turn-failure-cause', { sessionId: session.id, cause: cause() });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(scheduled).toHaveLength(1);
  });

  it('wakes two minutes from now when the reset time has already passed', async () => {
    const { session } = await taskSession();
    const { resume, scheduled } = policy();
    expect(await resume.handle(session.id, cause({ resetsAt: '2026-11-18T07:00:00.000Z' }))).toEqual(new Date('2026-11-18T07:18:44.000Z'));
    expect(scheduled).toHaveLength(1);
  });

  it('waits days for a weekly reset but ignores implausible or missing reset times', async () => {
    const { session } = await taskSession();
    const { resume, scheduled } = policy();
    expect(await resume.handle(session.id, cause({ resetsAt: '2026-11-24T01:00:00.000Z', limitType: 'seven_day' }))).toEqual(new Date('2026-11-24T01:02:00.000Z'));
    expect(await resume.handle(session.id, cause({ resetsAt: null }))).toBeNull();
    expect(await resume.handle(session.id, cause({ resetsAt: '2027-03-01T00:00:00.000Z' }))).toBeNull();
    expect(scheduled).toHaveLength(1);
  });

  it('follows the global switch, which is on by default', async () => {
    const { session } = await taskSession();
    expect(await resumeModule.isUsageLimitResumeEnabled()).toBe(true);
    await db.appSettings.create({ data: { id: 'singleton', autoResumeAfterUsageLimit: false } });
    expect(await resumeModule.isUsageLimitResumeEnabled()).toBe(false);
    const { resume, scheduled } = policy();
    expect(await resume.handle(session.id, cause())).toBeNull();
    await db.appSettings.update({ where: { id: 'singleton' }, data: { autoResumeAfterUsageLimit: true } });
    expect(await resume.handle(session.id, cause())).not.toBeNull();
    expect(scheduled).toHaveLength(1);
  });

  it('leaves out commit-message sessions, conversations and team-run members', async () => {
    const { resume, scheduled } = policy({ enabled: async () => true });
    const commit = await taskSession({ purpose: 'COMMIT_MSG' });
    expect(await resume.handle(commit.session.id, cause())).toBeNull();
    const conversation = await db.session.create({ data: { context: 'CONVERSATION', agentType: 'CLAUDE_CODE', variant: 'DEFAULT', prompt: 'hi', status: 'RUNNING' } });
    expect(await resume.handle(conversation.id, cause())).toBeNull();
    const member = await taskSession();
    const teamRun = await db.teamRun.create({ data: { taskId: member.task.id, mode: 'COLLABORATIVE' } });
    await db.agentInvocation.create({ data: { teamRunId: teamRun.id, workRequestId: 'wr-1', memberId: 'member-1', sessionId: member.session.id } });
    expect(await resume.handle(member.session.id, cause())).toBeNull();
    expect(await resume.handle('missing', cause())).toBeNull();
    expect(scheduled).toHaveLength(0);
  });
});
