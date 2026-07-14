import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { EventBus } from '../../core/event-bus.js';
import { TeamLockService } from '../team-lock.service.js';
import type { SessionManager as SessionManagerInstance } from '../session-manager.js';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-heartbeat-'));
const dbPath = path.join(testDir, 'test.db');
process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, '../../..');
const schemaPath = path.join(serverRoot, 'prisma/schema.prisma');

const NOW = new Date(Date.UTC(2026, 0, 1, 12, 0, 0));
const IDLE_THRESHOLD_MS = 5_000;
const ABSOLUTE_BUDGET_MS = 60_000;
const DELAYS = [1_000, 2_000, 4_000, 8_000, 8_000];
const MAX_NUDGES = 5;

let prisma: PrismaClient;
let TeamReconcilerService: typeof import('../team-reconciler.service.js').TeamReconcilerService;
type TeamReconcilerServiceInstance = InstanceType<typeof import('../team-reconciler.service.js').TeamReconcilerService>;
let SessionManager: typeof import('../session-manager.js').SessionManager;
let MemberHeartbeatScheduler: typeof import('../member-heartbeat-scheduler.js').MemberHeartbeatScheduler;
let TEAM_HEARTBEAT_NUDGE: string;
let invocationSequence = 0;

const capabilities = {
  readRoom: true,
  postRoomMessage: true,
  mentionMembers: true,
  stopMemberWork: false,
  markReadyForReview: false,
  readFiles: true,
  writeFiles: true,
  runCommands: false,
  readDiff: true,
  mergeWorkspace: false,
};

function createSchedulerMock(lockService: TeamLockService) {
  return {
    releaseInvocationLocks: vi.fn((invocationId: string) => {
      lockService.releaseByOwner(invocationId);
    }),
    startNextSessions: vi.fn(async () => []),
  };
}

function createMessengerMock(options: { alive?: boolean } = {}) {
  return {
    sendMessage: vi.fn(async () => null),
    stop: vi.fn(async () => null),
    hasActivePipeline: vi.fn(() => options.alive ?? true),
  };
}

async function createFixture() {
  const project = await prisma.project.create({
    data: { name: 'Heartbeat project', repoPath: path.join(testDir, `repo-${invocationSequence}`) },
  });
  const task = await prisma.task.create({
    data: { title: 'Heartbeat task', status: 'IN_PROGRESS', projectId: project.id },
  });
  const workspace = await prisma.workspace.create({
    data: { taskId: task.id, branchName: 'team-shared', worktreePath: testDir, status: 'ACTIVE' },
  });
  const teamRun = await prisma.teamRun.create({ data: { taskId: task.id, mode: 'AUTO' } });
  const member = await prisma.teamMember.create({
    data: {
      teamRunId: teamRun.id,
      name: 'Member 1',
      aliases: JSON.stringify(['member-1']),
      providerId: 'provider-1',
      rolePrompt: 'Role',
      capabilities: JSON.stringify(capabilities),
      workspacePolicy: 'shared',
      triggerPolicy: 'MENTION_ONLY',
      sessionPolicy: 'new_per_request',
      queueManagementPolicy: 'own_only',
    },
  });
  return { project, task, workspace, teamRun, member };
}

async function createRunningInvocation(options: {
  teamRunId: string;
  workspaceId: string;
  memberId: string;
  roomReplyReminderCount?: number;
  lastHeartbeatAt?: Date | null;
  firstNudgeAt?: Date | null;
  nextRoomReplyReminderAt?: Date | null;
  createdAt?: Date;
  status?: string;
}) {
  const workRequest = await prisma.workRequest.create({
    data: {
      teamRunId: options.teamRunId,
      requesterType: 'user',
      targetMemberId: options.memberId,
      triggerMessageId: `msg-${invocationSequence++}`,
      instruction: 'Do the work',
      ifBusy: 'queue',
      cancelQueued: false,
      status: 'STARTED',
    },
  });
  const session = await prisma.session.create({
    data: {
      workspaceId: options.workspaceId,
      agentType: 'CODEX',
      providerId: 'provider-1',
      prompt: 'Do the work',
      status: 'RUNNING',
    },
  });
  return prisma.agentInvocation.create({
    data: {
      teamRunId: options.teamRunId,
      workRequestId: workRequest.id,
      memberId: options.memberId,
      workspaceId: options.workspaceId,
      sessionId: session.id,
      status: options.status ?? 'RUNNING',
      roomReplyReminderCount: options.roomReplyReminderCount ?? 0,
      lastHeartbeatAt: options.lastHeartbeatAt ?? null,
      firstNudgeAt: options.firstNudgeAt ?? null,
      nextRoomReplyReminderAt: options.nextRoomReplyReminderAt ?? null,
      createdAt: options.createdAt,
    },
  });
}

describe('TeamReconcilerService heartbeat watchdog', () => {
  let lockService: TeamLockService;
  let scheduler: ReturnType<typeof createSchedulerMock>;
  let eventBus: EventBus;

  function createService(
    messenger: ReturnType<typeof createMessengerMock>,
    options: { now?: () => Date } = {}
  ): TeamReconcilerServiceInstance {
    return new TeamReconcilerService({
      scheduler,
      sessionMessenger: messenger,
      eventBus,
      now: options.now ?? (() => NOW),
      reminderDelaysMs: DELAYS,
      maxRoomReplyReminders: MAX_NUDGES,
      heartbeatIdleThresholdMs: IDLE_THRESHOLD_MS,
      absoluteNudgeBudgetMs: ABSOLUTE_BUDGET_MS,
      scheduleReminders: false,
    });
  }

  beforeAll(async () => {
    execFileSync(
      'pnpm',
      ['exec', 'prisma', 'db', 'push', '--skip-generate', `--schema=${schemaPath}`],
      { cwd: serverRoot, env: { ...process.env, AGENT_TOWER_DATABASE_URL: `file:${dbPath}` }, stdio: 'pipe' }
    );
    const utilsModule = await import('../../utils/index.js');
    const reconcilerModule = await import('../team-reconciler.service.js');
    prisma = utilsModule.prisma;
    TeamReconcilerService = reconcilerModule.TeamReconcilerService;
    SessionManager = (await import('../session-manager.js')).SessionManager;
    MemberHeartbeatScheduler = (await import('../member-heartbeat-scheduler.js')).MemberHeartbeatScheduler;
    TEAM_HEARTBEAT_NUDGE = reconcilerModule.TEAM_HEARTBEAT_NUDGE;
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    invocationSequence = 0;
    lockService = new TeamLockService();
    scheduler = createSchedulerMock(lockService);
    eventBus = new EventBus();
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_work_request_terminal_sync');
    await prisma.agentInvocation.deleteMany();
    await prisma.workRequest.deleteMany();
    await prisma.session.deleteMany();
    await prisma.teamMember.deleteMany();
    await prisma.teamRun.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.task.deleteMany();
    await prisma.project.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('nudges a stalled RUNNING invocation and records the first nudge', async () => {
    const { teamRun, workspace, member } = await createFixture();
    const invocation = await createRunningInvocation({
      teamRunId: teamRun.id,
      workspaceId: workspace.id,
      memberId: member.id,
      lastHeartbeatAt: new Date(NOW.getTime() - 10_000), // idle 10s > 5s 阈值
    });
    const messenger = createMessengerMock({ alive: true });
    const service = createService(messenger);

    await service.reconcileStalledInvocations();

    expect(messenger.sendMessage).toHaveBeenCalledWith(invocation.sessionId, TEAM_HEARTBEAT_NUDGE);
    const reloaded = await prisma.agentInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(reloaded.roomReplyReminderCount).toBe(1);
    expect(reloaded.firstNudgeAt?.toISOString()).toBe(NOW.toISOString());
    expect(reloaded.nextRoomReplyReminderAt?.toISOString()).toBe(new Date(NOW.getTime() + DELAYS[0]!).toISOString());
    expect(messenger.stop).not.toHaveBeenCalled();
  });

  it('uses the TeamRun heartbeat timeout when no test override is provided', async () => {
    const { teamRun, workspace, member } = await createFixture();
    await prisma.teamRun.update({
      where: { id: teamRun.id },
      data: { heartbeatTimeoutMinutes: 10 },
    });
    await createRunningInvocation({
      teamRunId: teamRun.id,
      workspaceId: workspace.id,
      memberId: member.id,
      lastHeartbeatAt: new Date(NOW.getTime() - 9 * 60_000),
    });
    const messenger = createMessengerMock({ alive: true });
    const service = new TeamReconcilerService({
      scheduler,
      sessionMessenger: messenger,
      eventBus,
      now: () => NOW,
      scheduleReminders: false,
    });

    await service.reconcileStalledInvocations();

    expect(messenger.sendMessage).not.toHaveBeenCalled();
  });

  it('does not treat watchdog-updated timestamps as real heartbeat progress', async () => {
    const { teamRun, workspace, member } = await createFixture();
    const firstScanAt = NOW;
    let currentNow = firstScanAt;
    const invocation = await createRunningInvocation({
      teamRunId: teamRun.id,
      workspaceId: workspace.id,
      memberId: member.id,
      lastHeartbeatAt: null,
      createdAt: new Date(firstScanAt.getTime() - 10_000),
    });
    const messenger = createMessengerMock({ alive: true });
    const service = createService(messenger, { now: () => currentNow });

    await service.reconcileStalledInvocations();

    let reloaded = await prisma.agentInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(reloaded.roomReplyReminderCount).toBe(1);
    expect(reloaded.nextRoomReplyReminderAt?.toISOString()).toBe(new Date(firstScanAt.getTime() + DELAYS[0]!).toISOString());
    expect(messenger.sendMessage).toHaveBeenCalledTimes(1);

    currentNow = new Date(firstScanAt.getTime() + 500);
    await service.reconcileStalledInvocations();

    reloaded = await prisma.agentInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(reloaded.roomReplyReminderCount).toBe(1);
    expect(reloaded.nextRoomReplyReminderAt?.toISOString()).toBe(new Date(firstScanAt.getTime() + DELAYS[0]!).toISOString());
    expect(messenger.sendMessage).toHaveBeenCalledTimes(1);

    currentNow = new Date(firstScanAt.getTime() + DELAYS[0]!);
    await service.reconcileStalledInvocations();

    reloaded = await prisma.agentInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(reloaded.roomReplyReminderCount).toBe(2);
    expect(reloaded.nextRoomReplyReminderAt?.toISOString()).toBe(new Date(currentNow.getTime() + DELAYS[1]!).toISOString());
    expect(messenger.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('does not nudge while still within the backoff window', async () => {
    const { teamRun, workspace, member } = await createFixture();
    await createRunningInvocation({
      teamRunId: teamRun.id,
      workspaceId: workspace.id,
      memberId: member.id,
      roomReplyReminderCount: 1,
      lastHeartbeatAt: new Date(NOW.getTime() - 10_000),
      firstNudgeAt: new Date(NOW.getTime() - 10_000),
      nextRoomReplyReminderAt: new Date(NOW.getTime() + 30_000), // 退避未到
    });
    const messenger = createMessengerMock({ alive: true });
    const service = createService(messenger);

    await service.reconcileStalledInvocations();

    expect(messenger.sendMessage).not.toHaveBeenCalled();
    expect(messenger.stop).not.toHaveBeenCalled();
  });

  it('fails a RUNNING invocation when heartbeat nudge send destroys the pipeline and then fails', async () => {
    const { teamRun, workspace, member } = await createFixture();
    const invocation = await createRunningInvocation({
      teamRunId: teamRun.id,
      workspaceId: workspace.id,
      memberId: member.id,
      lastHeartbeatAt: new Date(NOW.getTime() - 10_000),
    });
    expect(lockService.acquire(invocation.id, ['workspace:task:write'])).toBe(true);
    let alive = true;
    const messenger = createMessengerMock({ alive: true });
    messenger.hasActivePipeline.mockImplementation(() => alive);
    messenger.sendMessage.mockImplementation(async () => {
      alive = false;
      throw new Error('spawn failed');
    });
    const service = createService(messenger);

    await service.reconcileStalledInvocations();

    const reloaded = await prisma.agentInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(reloaded.status).toBe('FAILED');
    await expect(prisma.workRequest.findUnique({ where: { id: reloaded.workRequestId } })).resolves.toMatchObject({
      status: 'FAILED',
    });
    expect(reloaded.roomReplyReminderCount).toBe(0);
    expect(reloaded.nextRoomReplyReminderAt).toBeNull();
    expect(reloaded.firstNudgeAt).toBeNull();
    expect(lockService.listLocks()).toEqual([]);
    expect(messenger.stop).not.toHaveBeenCalled();
    expect(scheduler.releaseInvocationLocks).toHaveBeenCalledWith(invocation.id);
    expect(scheduler.startNextSessions).toHaveBeenCalledWith(teamRun.id);
  });

  it('clears the nudge count once real progress resumes', async () => {
    const { teamRun, workspace, member } = await createFixture();
    const invocation = await createRunningInvocation({
      teamRunId: teamRun.id,
      workspaceId: workspace.id,
      memberId: member.id,
      roomReplyReminderCount: 3,
      lastHeartbeatAt: new Date(NOW.getTime() - 1_000), // idle 1s < 5s：已恢复
      firstNudgeAt: new Date(NOW.getTime() - 30_000),
      nextRoomReplyReminderAt: new Date(NOW.getTime() + 1_000),
    });
    const messenger = createMessengerMock({ alive: true });
    const service = createService(messenger);

    await service.reconcileStalledInvocations();

    const reloaded = await prisma.agentInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(reloaded.roomReplyReminderCount).toBe(0);
    expect(reloaded.nextRoomReplyReminderAt).toBeNull();
    expect(messenger.sendMessage).not.toHaveBeenCalled();
  });

  it('stops a live invocation after reaching the max nudge count', async () => {
    const { teamRun, workspace, member } = await createFixture();
    const invocation = await createRunningInvocation({
      teamRunId: teamRun.id,
      workspaceId: workspace.id,
      memberId: member.id,
      roomReplyReminderCount: MAX_NUDGES,
      lastHeartbeatAt: new Date(NOW.getTime() - 10_000),
      firstNudgeAt: new Date(NOW.getTime() - 20_000),
      nextRoomReplyReminderAt: new Date(NOW.getTime() - 1_000),
    });
    const messenger = createMessengerMock({ alive: true });
    const service = createService(messenger);

    await service.reconcileStalledInvocations();

    expect(messenger.stop).toHaveBeenCalledWith(invocation.sessionId);
    expect(messenger.sendMessage).not.toHaveBeenCalled();
  });

  it('releases via the absolute budget even when the nudge count is below the max', async () => {
    const { teamRun, workspace, member } = await createFixture();
    const invocation = await createRunningInvocation({
      teamRunId: teamRun.id,
      workspaceId: workspace.id,
      memberId: member.id,
      roomReplyReminderCount: 2,
      lastHeartbeatAt: new Date(NOW.getTime() - 10_000),
      firstNudgeAt: new Date(NOW.getTime() - (ABSOLUTE_BUDGET_MS + 5_000)), // 超绝对兜底
      nextRoomReplyReminderAt: new Date(NOW.getTime() - 1_000),
    });
    const messenger = createMessengerMock({ alive: true });
    const service = createService(messenger);

    await service.reconcileStalledInvocations();

    expect(messenger.stop).toHaveBeenCalledWith(invocation.sessionId);
  });

  it('fails an orphan RUNNING invocation with no live pipeline and starts queued work', async () => {
    const { teamRun, workspace, member } = await createFixture();
    const invocation = await createRunningInvocation({
      teamRunId: teamRun.id,
      workspaceId: workspace.id,
      memberId: member.id,
      lastHeartbeatAt: new Date(NOW.getTime() - 10_000),
    });
    expect(lockService.acquire(invocation.id, ['workspace:task:write'])).toBe(true);
    const messenger = createMessengerMock({ alive: false }); // 进程已脱管
    const service = createService(messenger);

    await service.reconcileOrphanInvocations();

    const reloaded = await prisma.agentInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(reloaded.status).toBe('FAILED');
    expect(messenger.stop).not.toHaveBeenCalled();
    expect(scheduler.releaseInvocationLocks).toHaveBeenCalledWith(invocation.id);
    expect(scheduler.startNextSessions).toHaveBeenCalledWith(teamRun.id);
  });

  it('retries a real orphan candidate on the next heartbeat tick after a transient item failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { teamRun, workspace, member } = await createFixture();
    const invocation = await createRunningInvocation({
      teamRunId: teamRun.id,
      workspaceId: workspace.id,
      memberId: member.id,
      lastHeartbeatAt: new Date(NOW.getTime() - 10_000),
    });
    expect(lockService.acquire(invocation.id, ['workspace:task:write'])).toBe(true);
    const messenger = createMessengerMock({ alive: false });
    messenger.hasActivePipeline.mockImplementationOnce(() => {
      throw new Error('temporary pipeline probe failure');
    });
    const reconciler = createService(messenger);
    const queuePump = { reconcileQueuedWork: vi.fn(async () => 0) };
    const heartbeat = new MemberHeartbeatScheduler({
      eventBus,
      sessionManager: messenger as unknown as SessionManagerInstance,
      reconciler,
      queuePump,
    });
    const heartbeatInternals = heartbeat as unknown as { tick(): Promise<void> };

    await heartbeatInternals.tick();
    await expect(prisma.agentInvocation.findUniqueOrThrow({ where: { id: invocation.id } })).resolves.toMatchObject({
      status: 'RUNNING',
    });

    await heartbeatInternals.tick();
    await expect(prisma.agentInvocation.findUniqueOrThrow({ where: { id: invocation.id } })).resolves.toMatchObject({
      status: 'FAILED',
    });
    expect(scheduler.releaseInvocationLocks).toHaveBeenCalledWith(invocation.id);
    expect(scheduler.startNextSessions).toHaveBeenCalledWith(teamRun.id);
    expect(queuePump.reconcileQueuedWork).toHaveBeenCalledTimes(2);
  });

  it('repairs a runtime half-completed terminal transition after the orphan scan idempotently', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { teamRun, workspace, member } = await createFixture();
    const messenger = createMessengerMock({ alive: false });
    const reconciler = createService(messenger);
    const orphanSpy = vi.spyOn(reconciler, 'reconcileOrphanInvocations');
    const terminalRecoverySpy = vi.spyOn(reconciler, 'reconcileIncompleteTerminalInvocations');
    const queuePump = { reconcileQueuedWork: vi.fn(async () => 0) };
    const heartbeat = new MemberHeartbeatScheduler({
      eventBus,
      sessionManager: messenger as unknown as SessionManagerInstance,
      reconciler,
      queuePump,
    });
    const heartbeatInternals = heartbeat as unknown as { tick(): Promise<void> };

    // Complete the one-time orphan scan before the runtime inconsistency exists.
    await heartbeatInternals.tick();
    expect(orphanSpy).toHaveBeenCalledTimes(1);
    expect(terminalRecoverySpy).toHaveBeenCalledTimes(1);

    const terminalInvocation = await createRunningInvocation({
      teamRunId: teamRun.id,
      workspaceId: workspace.id,
      memberId: member.id,
      status: 'FAILED',
    });
    const queuedWorkRequest = await prisma.workRequest.create({
      data: {
        teamRunId: teamRun.id,
        requesterType: 'user',
        targetMemberId: member.id,
        triggerMessageId: 'queued-after-half-terminal',
        instruction: 'Run after terminal repair',
        status: 'QUEUED',
      },
    });
    expect(lockService.acquire(terminalInvocation.id, ['workspace:task:write'])).toBe(true);
    scheduler.startNextSessions.mockImplementation(async () => {
      const repaired = await prisma.workRequest.findUniqueOrThrow({
        where: { id: terminalInvocation.workRequestId },
      });
      if (repaired.status !== 'FAILED') {
        throw new Error('terminal WorkRequest was not repaired before scheduling');
      }
      await prisma.workRequest.update({
        where: { id: queuedWorkRequest.id },
        data: { status: 'STARTED' },
      });
      await prisma.agentInvocation.create({
        data: {
          teamRunId: teamRun.id,
          workRequestId: queuedWorkRequest.id,
          memberId: member.id,
          workspaceId: workspace.id,
          status: 'RUNNING',
        },
      });
      return [];
    });
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER fail_work_request_terminal_sync
      BEFORE UPDATE OF status ON WorkRequest
      WHEN OLD.id = '${terminalInvocation.workRequestId}' AND NEW.status = 'FAILED'
      BEGIN
        SELECT RAISE(FAIL, 'temporary terminal sync failure');
      END
    `);

    await heartbeatInternals.tick();
    expect(orphanSpy).toHaveBeenCalledTimes(1);
    expect(terminalRecoverySpy).toHaveBeenCalledTimes(2);
    await expect(prisma.workRequest.findUniqueOrThrow({
      where: { id: terminalInvocation.workRequestId },
    })).resolves.toMatchObject({ status: 'STARTED' });
    expect(scheduler.startNextSessions).not.toHaveBeenCalled();

    await prisma.$executeRawUnsafe('DROP TRIGGER fail_work_request_terminal_sync');
    await heartbeatInternals.tick();
    expect(orphanSpy).toHaveBeenCalledTimes(1);
    expect(terminalRecoverySpy).toHaveBeenCalledTimes(3);
    await expect(prisma.workRequest.findUniqueOrThrow({
      where: { id: terminalInvocation.workRequestId },
    })).resolves.toMatchObject({ status: 'FAILED' });
    await expect(prisma.workRequest.findUniqueOrThrow({ where: { id: queuedWorkRequest.id } })).resolves.toMatchObject({
      status: 'STARTED',
    });
    expect(lockService.listLocks()).toEqual([]);
    expect(scheduler.releaseInvocationLocks).toHaveBeenCalledTimes(3);
    expect(scheduler.startNextSessions).toHaveBeenCalledTimes(1);

    await heartbeatInternals.tick();
    expect(orphanSpy).toHaveBeenCalledTimes(1);
    expect(terminalRecoverySpy).toHaveBeenCalledTimes(4);
    expect(scheduler.releaseInvocationLocks).toHaveBeenCalledTimes(3);
    expect(scheduler.startNextSessions).toHaveBeenCalledTimes(1);
    await expect(prisma.agentInvocation.count({ where: { workRequestId: queuedWorkRequest.id } })).resolves.toBe(1);
  });

  it('does not treat an old failed retry diagnostic as an incomplete terminal transition', async () => {
    const { teamRun, workspace, member } = await createFixture();
    const workRequest = await prisma.workRequest.create({
      data: {
        teamRunId: teamRun.id,
        requesterType: 'user',
        targetMemberId: member.id,
        triggerMessageId: 'active-retry-with-old-diagnostic',
        instruction: 'Continue the retry',
        status: 'STARTED',
      },
    });
    const oldSession = await prisma.session.create({
      data: {
        workspaceId: workspace.id,
        agentType: 'CODEX',
        prompt: 'old failed attempt',
        status: 'FAILED',
      },
    });
    await prisma.agentInvocation.create({
      data: {
        teamRunId: teamRun.id,
        workRequestId: workRequest.id,
        memberId: member.id,
        workspaceId: workspace.id,
        sessionId: oldSession.id,
        status: 'FAILED',
      },
    });
    const activeSession = await prisma.session.create({
      data: {
        workspaceId: workspace.id,
        agentType: 'CODEX',
        prompt: 'active retry',
        status: 'RUNNING',
      },
    });
    await prisma.agentInvocation.create({
      data: {
        teamRunId: teamRun.id,
        workRequestId: workRequest.id,
        memberId: member.id,
        workspaceId: workspace.id,
        sessionId: activeSession.id,
        status: 'RUNNING',
      },
    });
    const service = createService(createMessengerMock({ alive: true }));

    await service.reconcileIncompleteTerminalInvocations();

    await expect(prisma.workRequest.findUniqueOrThrow({ where: { id: workRequest.id } })).resolves.toMatchObject({
      status: 'STARTED',
    });
    expect(scheduler.releaseInvocationLocks).not.toHaveBeenCalled();
    expect(scheduler.startNextSessions).not.toHaveBeenCalled();
  });

  it('records a heartbeat timestamp for a running invocation', async () => {
    const { teamRun, workspace, member } = await createFixture();
    const invocation = await createRunningInvocation({
      teamRunId: teamRun.id,
      workspaceId: workspace.id,
      memberId: member.id,
    });
    const messenger = createMessengerMock({ alive: true });
    const service = createService(messenger);

    await service.recordHeartbeat(invocation.sessionId!);

    const reloaded = await prisma.agentInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(reloaded.lastHeartbeatAt?.toISOString()).toBe(NOW.toISOString());
  });
});
