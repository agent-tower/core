import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { TaskStatus } from '../../types/index.js';
import { EventBus } from '../../core/event-bus.js';
import { TeamLockService } from '../team-lock.service.js';
import type { TeamReconcilerScheduler, TeamReconcilerSessionMessenger } from '../team-reconciler.service.js';
import type { TeamRunRouteDependencies } from '../../routes/team-runs.js';
import type { AgentInvocation, WorkRequest } from '@agent-tower/shared';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-team-reconciler-'));
const dbPath = path.join(testDir, 'test.db');
process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, '../../..');
const schemaPath = path.join(serverRoot, 'prisma/schema.prisma');

let prisma: PrismaClient;
let TeamReconcilerService: typeof import('../team-reconciler.service.js').TeamReconcilerService;
type TeamReconcilerServiceInstance = InstanceType<typeof import('../team-reconciler.service.js').TeamReconcilerService>;
let SessionManager: typeof import('../session-manager.js').SessionManager;
let TEAM_ROOM_REPLY_REMINDER: string;
let createMcpServer: typeof import('../../mcp/server.js').createMcpServer;
let teamRunRoutes: typeof import('../../routes/team-runs.js').teamRunRoutes;
let workRequestSequence = 0;
let gitRepoSequence = 0;

const TEAM_RUN_MISMATCH_ERROR = 'team_run_id does not match the current TeamRun session.';
const TEAM_RUN_ENV_KEYS = [
  'AGENT_TOWER_TEAM_RUN_ID',
  'AGENT_TOWER_MEMBER_ID',
  'AGENT_TOWER_INVOCATION_ID',
  'AGENT_TOWER_SESSION_ID',
] as const;

type RouteSchedulerMock = NonNullable<TeamRunRouteDependencies['scheduler']> & {
  startedTeamRunIds: string[];
};

type TeamRunEnvKey = typeof TEAM_RUN_ENV_KEYS[number];
type TeamRunEnvSnapshot = Record<TeamRunEnvKey, string | undefined>;

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

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function captureTeamRunEnv(): TeamRunEnvSnapshot {
  return TEAM_RUN_ENV_KEYS.reduce((snapshot, key) => ({
    ...snapshot,
    [key]: process.env[key],
  }), {} as TeamRunEnvSnapshot);
}

function setTeamRunEnv(values: Partial<Record<TeamRunEnvKey, string | undefined>>) {
  for (const key of TEAM_RUN_ENV_KEYS) {
    if (!(key in values)) {
      continue;
    }
    const value = values[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function restoreTeamRunEnv(snapshot: TeamRunEnvSnapshot) {
  setTeamRunEnv(snapshot);
}

function getMcpToolText(result: unknown): string {
  const content = (result as { content?: unknown }).content as Array<{ type: string; text?: string }> | undefined;
  return content?.[0]?.type === 'text' ? content[0].text ?? '' : '';
}

function createSchedulerMock(lockService: TeamLockService): TeamReconcilerScheduler & {
  releaseInvocationLocks: ReturnType<typeof vi.fn>;
  startNextSessions: ReturnType<typeof vi.fn>;
} {
  return {
    releaseInvocationLocks: vi.fn((invocationId: string) => {
      lockService.releaseByOwner(invocationId);
    }),
    startNextSessions: vi.fn(async () => []),
  };
}

function createMessengerMock(): TeamReconcilerSessionMessenger & {
  sendMessage: ReturnType<typeof vi.fn>;
} {
  return {
    sendMessage: vi.fn(async () => null),
  };
}

function asWorkRequest(value: unknown): WorkRequest {
  return value as WorkRequest;
}

function asAgentInvocations(value: unknown): AgentInvocation[] {
  return value as AgentInvocation[];
}

function createGitRepoPath() {
  const repoPath = path.join(testDir, 'repos', `repo-${gitRepoSequence++}`);
  fs.mkdirSync(path.join(repoPath, '.git'), { recursive: true });
  return repoPath;
}

function createRouteSchedulerMock(): RouteSchedulerMock {
  const startedTeamRunIds: string[] = [];
  const scheduler = {
    startedTeamRunIds,
  } as RouteSchedulerMock;

  scheduler.startNextSessions = vi.fn(async (teamRunId: string) => {
    startedTeamRunIds.push(teamRunId);
    const workRequests = await prisma.workRequest.findMany({
      where: { teamRunId, status: 'QUEUED' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const invocations = [];

    for (const workRequest of workRequests) {
      await prisma.workRequest.update({
        where: { id: workRequest.id },
        data: { status: 'STARTED' },
      });
      invocations.push(await prisma.agentInvocation.create({
        data: {
          teamRunId,
          workRequestId: workRequest.id,
          memberId: workRequest.targetMemberId,
          workspaceId: null,
          sessionId: null,
          status: 'RUNNING',
        },
      }));
    }

    return asAgentInvocations(invocations);
  });
  scheduler.approveWorkRequestAndStartNext = vi.fn(async (workRequestId: string, _options?: unknown) => {
    const workRequest = await prisma.workRequest.update({
      where: { id: workRequestId },
      data: { status: 'QUEUED' },
    });
    const startedInvocations = await scheduler.startNextSessions(workRequest.teamRunId);
    return { workRequest: asWorkRequest(workRequest), startedInvocations };
  });
  scheduler.rejectWorkRequest = vi.fn(async (workRequestId: string, _options?: unknown) => prisma.workRequest.update({
    where: { id: workRequestId },
    data: { status: 'REJECTED' },
  }).then(asWorkRequest));
  scheduler.cancelWorkRequest = vi.fn(async (workRequestId: string, _options: unknown) => prisma.workRequest.update({
    where: { id: workRequestId },
    data: { status: 'CANCELLED' },
  }).then(asWorkRequest));
  scheduler.stopMemberWork = vi.fn(async () => ({
    stoppedSessionIds: [],
    cancelledInvocationIds: [],
    cancelledWorkRequestIds: [],
    startedInvocations: [],
  }));

  return scheduler;
}

async function createFixture(options: {
  taskStatus?: TaskStatus;
  memberCount?: number;
  teamRunMode?: 'AUTO' | 'CONFIRM';
  triggerPolicies?: Array<'MENTION_ONLY' | 'USER_MESSAGES'>;
  memberCapabilities?: Array<Partial<typeof capabilities>>;
} = {}) {
  const project = await prisma.project.create({
    data: {
      name: 'Team reconciler project',
      repoPath: createGitRepoPath(),
    },
  });
  const task = await prisma.task.create({
    data: {
      title: 'Team reconciler task',
      status: options.taskStatus ?? TaskStatus.IN_PROGRESS,
      projectId: project.id,
    },
  });
  const workspace = await prisma.workspace.create({
    data: {
      taskId: task.id,
      branchName: 'team-shared',
      worktreePath: testDir,
      status: 'ACTIVE',
    },
  });
  const teamRun = await prisma.teamRun.create({
    data: {
      taskId: task.id,
      mode: options.teamRunMode ?? 'AUTO',
    },
  });

  const members = [];
  for (let index = 0; index < (options.memberCount ?? 1); index += 1) {
    members.push(await prisma.teamMember.create({
      data: {
        teamRunId: teamRun.id,
        presetId: null,
        name: `Member ${index + 1}`,
        aliases: stringifyJson([`member-${index + 1}`]),
        providerId: `provider-${index + 1}`,
        rolePrompt: `Role ${index + 1}`,
        capabilities: stringifyJson({
          ...capabilities,
          ...(options.memberCapabilities?.[index] ?? {}),
        }),
        workspacePolicy: 'shared',
        triggerPolicy: options.triggerPolicies?.[index] ?? 'MENTION_ONLY',
        sessionPolicy: 'new_per_request',
        queueManagementPolicy: 'own_only',
        avatar: null,
      },
    }));
  }

  return { project, task, workspace, teamRun, members };
}

async function createMemberPreset(options: {
  name?: string;
  triggerPolicy?: 'MENTION_ONLY' | 'USER_MESSAGES';
} = {}) {
  const name = options.name ?? 'Leader';
  return prisma.memberPreset.create({
    data: {
      name,
      aliases: stringifyJson([name.toLowerCase()]),
      providerId: `provider-${name.toLowerCase()}`,
      rolePrompt: `${name} role`,
      capabilities: stringifyJson(capabilities),
      workspacePolicy: 'shared',
      triggerPolicy: options.triggerPolicy ?? 'USER_MESSAGES',
      sessionPolicy: 'new_per_request',
      queueManagementPolicy: 'own_only',
      avatar: null,
    },
  });
}

async function createWorkRequest(options: {
  teamRunId: string;
  targetMemberId: string;
  status?: string;
  instruction?: string;
}) {
  return prisma.workRequest.create({
    data: {
      teamRunId: options.teamRunId,
      requesterMemberId: null,
      requesterType: 'user',
      targetMemberId: options.targetMemberId,
      triggerMessageId: `message-${Math.random().toString(16).slice(2)}`,
      instruction: options.instruction ?? 'Please do the work',
      ifBusy: 'queue',
      cancelQueued: false,
      status: options.status ?? 'STARTED',
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, workRequestSequence++)),
    },
  });
}

async function createRunningInvocation(options: {
  teamRunId: string;
  workRequestId: string;
  memberId: string;
  workspaceId?: string | null;
  sessionId?: string;
  status?: string;
  roomReplyReminderCount?: number;
}) {
  const session = options.sessionId
    ? await prisma.session.findUniqueOrThrow({ where: { id: options.sessionId } })
    : await prisma.session.create({
      data: {
        workspaceId: options.workspaceId!,
        agentType: 'CODEX',
        providerId: 'provider-1',
        prompt: 'Do the work',
        status: 'COMPLETED',
      },
    });

  return prisma.agentInvocation.create({
    data: {
      teamRunId: options.teamRunId,
      workRequestId: options.workRequestId,
      memberId: options.memberId,
      workspaceId: options.workspaceId ?? session.workspaceId,
      sessionId: session.id,
      status: options.status ?? 'RUNNING',
      roomReplyReminderCount: options.roomReplyReminderCount ?? 0,
    },
  });
}

describe('TeamReconcilerService', () => {
  let lockService: TeamLockService;
  let scheduler: ReturnType<typeof createSchedulerMock>;
  let messenger: ReturnType<typeof createMessengerMock>;
  let eventBus: EventBus;
  let service: TeamReconcilerServiceInstance;

  beforeAll(async () => {
    execFileSync(
      'pnpm',
      ['exec', 'prisma', 'db', 'push', '--skip-generate', `--schema=${schemaPath}`],
      {
        cwd: serverRoot,
        env: { ...process.env, AGENT_TOWER_DATABASE_URL: `file:${dbPath}` },
        stdio: 'pipe',
      }
    );

    const utilsModule = await import('../../utils/index.js');
    const reconcilerModule = await import('../team-reconciler.service.js');
    const sessionManagerModule = await import('../session-manager.js');
    const mcpServerModule = await import('../../mcp/server.js');
    const teamRunRoutesModule = await import('../../routes/team-runs.js');
    prisma = utilsModule.prisma;
    TeamReconcilerService = reconcilerModule.TeamReconcilerService;
    SessionManager = sessionManagerModule.SessionManager;
    TEAM_ROOM_REPLY_REMINDER = reconcilerModule.TEAM_ROOM_REPLY_REMINDER;
    createMcpServer = mcpServerModule.createMcpServer;
    teamRunRoutes = teamRunRoutesModule.teamRunRoutes;
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    workRequestSequence = 0;
    lockService = new TeamLockService();
    scheduler = createSchedulerMock(lockService);
    messenger = createMessengerMock();
    eventBus = new EventBus();
    service = new TeamReconcilerService({
      scheduler,
      sessionMessenger: messenger,
      eventBus,
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, 0)),
      reminderDelaysMs: [1_000, 2_000, 4_000],
      maxRoomReplyReminders: 3,
      scheduleReminders: false,
    });

    await prisma.agentInvocation.deleteMany();
    await prisma.workRequest.deleteMany();
    await prisma.roomMessage.deleteMany();
    await prisma.teamMember.deleteMany();
    await prisma.teamRun.deleteMany();
    await prisma.teamTemplateMember.deleteMany();
    await prisma.teamTemplate.deleteMany();
    await prisma.memberPreset.deleteMany();
    await prisma.session.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.task.deleteMany();
    await prisma.project.deleteMany();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await prisma.$disconnect();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('marks invocation completed and releases locks when a RoomMessage exists for the invocation', async () => {
    const { workspace, teamRun, members } = await createFixture();
    const request = await createWorkRequest({ teamRunId: teamRun.id, targetMemberId: members[0]!.id });
    const invocation = await createRunningInvocation({
      teamRunId: teamRun.id,
      workRequestId: request.id,
      memberId: members[0]!.id,
      workspaceId: workspace.id,
    });
    expect(lockService.acquire(invocation.id, ['workspace:task:write'])).toBe(true);
    await prisma.roomMessage.create({
      data: {
        teamRunId: teamRun.id,
        senderType: 'agent',
        senderId: members[0]!.id,
        senderInvocationId: invocation.id,
        kind: 'chat',
        content: 'Implemented the change',
        mentions: '[]',
        workRequestIds: '[]',
        artifactRefs: '[]',
        attachmentIds: '[]',
      },
    });

    await service.handleSessionExit(invocation.sessionId!);

    await expect(prisma.agentInvocation.findUnique({ where: { id: invocation.id } })).resolves.toMatchObject({
      status: 'COMPLETED',
      nextRoomReplyReminderAt: null,
    });
    expect(scheduler.releaseInvocationLocks).toHaveBeenCalledWith(invocation.id);
    expect(lockService.listLocks()).toEqual([]);
    expect(scheduler.startNextSessions).toHaveBeenCalledWith(teamRun.id);
  });

  it('marks invocation waiting, increments reminder count, and sends a reminder when no RoomMessage exists', async () => {
    const { workspace, teamRun, members } = await createFixture();
    const request = await createWorkRequest({ teamRunId: teamRun.id, targetMemberId: members[0]!.id });
    const invocation = await createRunningInvocation({
      teamRunId: teamRun.id,
      workRequestId: request.id,
      memberId: members[0]!.id,
      workspaceId: workspace.id,
    });

    await service.handleSessionExit(invocation.sessionId!);

    const reloaded = await prisma.agentInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(reloaded.status).toBe('WAITING_ROOM_REPLY');
    expect(reloaded.roomReplyReminderCount).toBe(1);
    expect(reloaded.nextRoomReplyReminderAt?.toISOString()).toBe('2026-01-01T00:00:01.000Z');
    expect(messenger.sendMessage).toHaveBeenCalledWith(invocation.sessionId, TEAM_ROOM_REPLY_REMINDER);
    expect(scheduler.releaseInvocationLocks).not.toHaveBeenCalled();
  });

  it('does not send another reminder before the backoff time is due', async () => {
    const { workspace, teamRun, members } = await createFixture();
    const request = await createWorkRequest({ teamRunId: teamRun.id, targetMemberId: members[0]!.id });
    const invocation = await createRunningInvocation({
      teamRunId: teamRun.id,
      workRequestId: request.id,
      memberId: members[0]!.id,
      workspaceId: workspace.id,
      status: 'WAITING_ROOM_REPLY',
      roomReplyReminderCount: 1,
    });
    await prisma.agentInvocation.update({
      where: { id: invocation.id },
      data: { nextRoomReplyReminderAt: new Date(Date.UTC(2026, 0, 1, 0, 1, 0)) },
    });

    await service.reconcileInvocation(invocation.id);

    await expect(prisma.agentInvocation.findUnique({ where: { id: invocation.id } })).resolves.toMatchObject({
      status: 'WAITING_ROOM_REPLY',
      roomReplyReminderCount: 1,
    });
    expect(messenger.sendMessage).not.toHaveBeenCalled();
  });

  it('marks invocation failed and releases locks when max due reminders are reached without a RoomMessage', async () => {
    const { workspace, teamRun, members } = await createFixture();
    const request = await createWorkRequest({ teamRunId: teamRun.id, targetMemberId: members[0]!.id });
    const invocation = await createRunningInvocation({
      teamRunId: teamRun.id,
      workRequestId: request.id,
      memberId: members[0]!.id,
      workspaceId: workspace.id,
      status: 'WAITING_ROOM_REPLY',
      roomReplyReminderCount: 2,
    });
    await prisma.agentInvocation.update({
      where: { id: invocation.id },
      data: { nextRoomReplyReminderAt: new Date(Date.UTC(2025, 11, 31, 23, 59, 59)) },
    });
    expect(lockService.acquire(invocation.id, ['workspace:task:write'])).toBe(true);

    await expect(service.reconcileDueRoomReplyReminders()).resolves.toBe(1);
    await expect(prisma.agentInvocation.findUnique({ where: { id: invocation.id } })).resolves.toMatchObject({
      status: 'WAITING_ROOM_REPLY',
      roomReplyReminderCount: 3,
    });
    expect(messenger.sendMessage).toHaveBeenCalledTimes(1);
    expect(scheduler.releaseInvocationLocks).not.toHaveBeenCalled();

    await prisma.agentInvocation.update({
      where: { id: invocation.id },
      data: { nextRoomReplyReminderAt: new Date(Date.UTC(2025, 11, 31, 23, 59, 59)) },
    });
    await expect(service.reconcileDueRoomReplyReminders()).resolves.toBe(1);

    await expect(prisma.agentInvocation.findUnique({ where: { id: invocation.id } })).resolves.toMatchObject({
      status: 'FAILED',
      nextRoomReplyReminderAt: null,
    });
    expect(scheduler.releaseInvocationLocks).toHaveBeenCalledWith(invocation.id);
    expect(lockService.listLocks()).toEqual([]);
  });

  it('moves an idle TeamRun task from IN_PROGRESS to IN_REVIEW and writes reviewReason', async () => {
    const { workspace, task, teamRun, members } = await createFixture({ taskStatus: TaskStatus.IN_PROGRESS });
    const request = await createWorkRequest({ teamRunId: teamRun.id, targetMemberId: members[0]!.id });
    const invocation = await createRunningInvocation({
      teamRunId: teamRun.id,
      workRequestId: request.id,
      memberId: members[0]!.id,
      workspaceId: workspace.id,
    });
    await prisma.roomMessage.create({
      data: {
        teamRunId: teamRun.id,
        senderType: 'agent',
        senderId: members[0]!.id,
        senderInvocationId: invocation.id,
        kind: 'chat',
        content: 'Done',
        mentions: '[]',
        workRequestIds: '[]',
        artifactRefs: '[]',
        attachmentIds: '[]',
      },
    });
    const taskUpdates: Array<{ taskId: string; projectId: string; status: string }> = [];
    eventBus.on('task:updated', (payload) => taskUpdates.push(payload));

    await service.handleSessionExit(invocation.sessionId!);

    await expect(prisma.task.findUnique({ where: { id: task.id } })).resolves.toMatchObject({
      status: TaskStatus.IN_REVIEW,
    });
    await expect(prisma.teamRun.findUnique({ where: { id: teamRun.id } })).resolves.toMatchObject({
      reviewReason: 'TEAM_QUIESCENT',
    });
    expect(taskUpdates).toEqual([
      { taskId: task.id, projectId: expect.any(String), status: TaskStatus.IN_REVIEW },
    ]);
  });

  it('cancels invocation, releases locks, starts queued work, and advances idle TeamRun on session stop', async () => {
    const { workspace, task, teamRun, members } = await createFixture({ taskStatus: TaskStatus.IN_PROGRESS });
    const request = await createWorkRequest({ teamRunId: teamRun.id, targetMemberId: members[0]!.id });
    const invocation = await createRunningInvocation({
      teamRunId: teamRun.id,
      workRequestId: request.id,
      memberId: members[0]!.id,
      workspaceId: workspace.id,
      status: 'RUNNING',
    });
    await prisma.agentInvocation.update({
      where: { id: invocation.id },
      data: { nextRoomReplyReminderAt: new Date(Date.UTC(2026, 0, 1, 0, 1, 0)) },
    });
    expect(lockService.acquire(invocation.id, ['workspace:task:write'])).toBe(true);

    await expect(service.handleSessionStopped(invocation.sessionId!)).resolves.toBe(true);

    await expect(prisma.agentInvocation.findUnique({ where: { id: invocation.id } })).resolves.toMatchObject({
      status: 'CANCELLED',
      nextRoomReplyReminderAt: null,
    });
    expect(scheduler.releaseInvocationLocks).toHaveBeenCalledWith(invocation.id);
    expect(lockService.listLocks()).toEqual([]);
    expect(scheduler.startNextSessions).toHaveBeenCalledWith(teamRun.id);
    await expect(prisma.task.findUnique({ where: { id: task.id } })).resolves.toMatchObject({
      status: TaskStatus.IN_REVIEW,
    });
    await expect(prisma.teamRun.findUnique({ where: { id: teamRun.id } })).resolves.toMatchObject({
      reviewReason: 'TEAM_QUIESCENT',
    });
  });

  it('keeps stopped TeamRun out of review when queued work remains', async () => {
    const { workspace, task, teamRun, members } = await createFixture({
      taskStatus: TaskStatus.IN_PROGRESS,
      memberCount: 2,
    });
    const request = await createWorkRequest({ teamRunId: teamRun.id, targetMemberId: members[0]!.id });
    const invocation = await createRunningInvocation({
      teamRunId: teamRun.id,
      workRequestId: request.id,
      memberId: members[0]!.id,
      workspaceId: workspace.id,
      status: 'RUNNING',
    });
    await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[1]!.id,
      status: 'QUEUED',
    });

    await service.handleSessionStopped(invocation.sessionId!);

    await expect(prisma.agentInvocation.findUnique({ where: { id: invocation.id } })).resolves.toMatchObject({
      status: 'CANCELLED',
    });
    await expect(prisma.task.findUnique({ where: { id: task.id } })).resolves.toMatchObject({
      status: TaskStatus.IN_PROGRESS,
    });
    expect(scheduler.startNextSessions).toHaveBeenCalledWith(teamRun.id);
  });

  it('does not start queued work when a stopped session belongs to a deleted task', async () => {
    const { workspace, task, teamRun, members } = await createFixture({ taskStatus: TaskStatus.IN_PROGRESS });
    const request = await createWorkRequest({ teamRunId: teamRun.id, targetMemberId: members[0]!.id });
    const invocation = await createRunningInvocation({
      teamRunId: teamRun.id,
      workRequestId: request.id,
      memberId: members[0]!.id,
      workspaceId: workspace.id,
      status: 'RUNNING',
    });
    await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'QUEUED',
    });
    await prisma.task.update({
      where: { id: task.id },
      data: { deletedAt: new Date() },
    });
    expect(lockService.acquire(invocation.id, ['workspace:task:write'])).toBe(true);

    await expect(service.handleSessionStopped(invocation.sessionId!)).resolves.toBe(true);

    await expect(prisma.agentInvocation.findUnique({ where: { id: invocation.id } })).resolves.toMatchObject({
      status: 'CANCELLED',
      nextRoomReplyReminderAt: null,
    });
    expect(scheduler.releaseInvocationLocks).toHaveBeenCalledWith(invocation.id);
    expect(lockService.listLocks()).toEqual([]);
    expect(scheduler.startNextSessions).not.toHaveBeenCalled();
    await expect(prisma.task.findUnique({ where: { id: task.id } })).resolves.toMatchObject({
      status: TaskStatus.IN_PROGRESS,
    });
  });

  it.each([
    ['queued work request', async (teamRunId: string, memberId: string) => {
      await createWorkRequest({ teamRunId, targetMemberId: memberId, status: 'QUEUED' });
    }],
    ['pending approval work request', async (teamRunId: string, memberId: string) => {
      await createWorkRequest({ teamRunId, targetMemberId: memberId, status: 'PENDING_APPROVAL' });
    }],
    ['running invocation', async (teamRunId: string, memberId: string, workspaceId: string) => {
      const request = await createWorkRequest({ teamRunId, targetMemberId: memberId });
      await createRunningInvocation({ teamRunId, workRequestId: request.id, memberId, workspaceId, status: 'RUNNING' });
    }],
    ['waiting invocation', async (teamRunId: string, memberId: string, workspaceId: string) => {
      const request = await createWorkRequest({ teamRunId, targetMemberId: memberId });
      await createRunningInvocation({
        teamRunId,
        workRequestId: request.id,
        memberId,
        workspaceId,
        status: 'WAITING_ROOM_REPLY',
      });
    }],
  ])('does not move the task to review while the TeamRun still has %s', async (_caseName, arrange) => {
    const { workspace, task, teamRun, members } = await createFixture({
      taskStatus: TaskStatus.IN_PROGRESS,
      memberCount: 2,
    });
    const completedRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'STARTED',
    });
    await createRunningInvocation({
      teamRunId: teamRun.id,
      workRequestId: completedRequest.id,
      memberId: members[0]!.id,
      workspaceId: workspace.id,
      status: 'COMPLETED',
    });
    await arrange(teamRun.id, members[1]!.id, workspace.id);

    const advanced = await service.maybeAdvanceTeamRunToReview(teamRun.id);

    expect(advanced).toBe(false);
    await expect(prisma.task.findUnique({ where: { id: task.id } })).resolves.toMatchObject({
      status: TaskStatus.IN_PROGRESS,
    });
  });

  it('posts a room message from MCP env identity and creates WorkRequests through mentions', async () => {
    const previousTeamRunId = process.env.AGENT_TOWER_TEAM_RUN_ID;
    const previousMemberId = process.env.AGENT_TOWER_MEMBER_ID;
    const previousInvocationId = process.env.AGENT_TOWER_INVOCATION_ID;
    const { workspace, teamRun, members } = await createFixture({ memberCount: 2 });
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'STARTED',
    });
    const invocation = await createRunningInvocation({
      teamRunId: teamRun.id,
      workRequestId: request.id,
      memberId: members[0]!.id,
      workspaceId: workspace.id,
    });
    const app = Fastify({ logger: false });

    try {
      process.env.AGENT_TOWER_TEAM_RUN_ID = teamRun.id;
      process.env.AGENT_TOWER_MEMBER_ID = members[0]!.id;
      process.env.AGENT_TOWER_INVOCATION_ID = invocation.id;

      await app.register(teamRunRoutes, { prefix: '/api' });
      await app.listen({ port: 0, host: '127.0.0.1' });
      const address = app.server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Failed to start test server');
      }

      const server = await createMcpServer(`http://127.0.0.1:${address.port}`);
      const client = new Client({ name: 'team-room-test-client', version: '0.1.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: 'post_room_message',
        arguments: {
          content: 'Implemented the parser and please review it',
          mentions: [{ memberId: members[1]!.id }],
        },
      });
      await client.close();
      await server.close();

      expect(result.isError).not.toBe(true);
      const resultContent = result.content as Array<{ type: string; text?: string }>;
      const messageText = resultContent[0]?.type === 'text' ? resultContent[0].text ?? '' : '';
      const message = JSON.parse(messageText) as { id: string; senderInvocationId: string; senderType: string };
      expect(message).toMatchObject({
        senderType: 'agent',
        senderInvocationId: invocation.id,
      });

      await expect(prisma.roomMessage.findUnique({ where: { id: message.id } })).resolves.toMatchObject({
        senderType: 'agent',
        senderId: members[0]!.id,
        senderInvocationId: invocation.id,
      });
      let createdRequestId = '';
      await vi.waitFor(async () => {
        const createdRequest = await prisma.workRequest.findFirst({
          where: {
            teamRunId: teamRun.id,
            triggerMessageId: message.id,
            targetMemberId: members[1]!.id,
          },
        });
        expect(createdRequest).toMatchObject({
          requesterType: 'agent',
          requesterMemberId: members[0]!.id,
          status: 'STARTED',
        });
        createdRequestId = createdRequest!.id;
      });
      await vi.waitFor(async () => {
        await expect(prisma.agentInvocation.findFirst({
          where: { workRequestId: createdRequestId },
        })).resolves.toMatchObject({
          memberId: members[1]!.id,
          sessionId: null,
          status: 'FAILED',
        });
      });
    } finally {
      if (previousTeamRunId === undefined) {
        delete process.env.AGENT_TOWER_TEAM_RUN_ID;
      } else {
        process.env.AGENT_TOWER_TEAM_RUN_ID = previousTeamRunId;
      }
      if (previousMemberId === undefined) {
        delete process.env.AGENT_TOWER_MEMBER_ID;
      } else {
        process.env.AGENT_TOWER_MEMBER_ID = previousMemberId;
      }
      if (previousInvocationId === undefined) {
        delete process.env.AGENT_TOWER_INVOCATION_ID;
      } else {
        process.env.AGENT_TOWER_INVOCATION_ID = previousInvocationId;
      }
      await app.close();
    }
  });

  it('returns RoomMessage previews in REST/MCP lists and full content from detail endpoints', async () => {
    const previousEnv = captureTeamRunEnv();
    const { workspace, teamRun, members } = await createFixture({ memberCount: 1 });
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'STARTED',
    });
    const invocation = await createRunningInvocation({
      teamRunId: teamRun.id,
      workRequestId: request.id,
      memberId: members[0]!.id,
      workspaceId: workspace.id,
    });
    const longContent = `Long Team Room detail\n${'visible detail '.repeat(80)}`;
    const earlierMessage = await prisma.roomMessage.create({
      data: {
        teamRunId: teamRun.id,
        senderType: 'user',
        senderId: members[0]!.id,
        senderInvocationId: null,
        kind: 'chat',
        visibility: 'PUBLIC',
        content: 'Earlier visible message',
        mentions: stringifyJson([]),
        artifactRefs: stringifyJson([]),
        attachmentIds: stringifyJson([]),
        workRequestIds: stringifyJson([]),
      },
    });
    const roomMessage = await prisma.roomMessage.create({
      data: {
        teamRunId: teamRun.id,
        senderType: 'user',
        senderId: null,
        senderInvocationId: null,
        kind: 'chat',
        visibility: 'PUBLIC',
        content: longContent,
        mentions: stringifyJson([]),
        artifactRefs: stringifyJson([]),
        attachmentIds: stringifyJson([]),
        workRequestIds: stringifyJson([]),
      },
    });
    await prisma.roomMessage.update({
      where: { id: earlierMessage.id },
      data: { createdAt: new Date('2026-01-01T00:00:00.000Z') },
    });
    await prisma.roomMessage.update({
      where: { id: roomMessage.id },
      data: { createdAt: new Date('2026-01-01T00:00:01.000Z') },
    });
    const agentMessage = await prisma.roomMessage.create({
      data: {
        teamRunId: teamRun.id,
        senderType: 'agent',
        senderId: members[0]!.id,
        senderInvocationId: invocation.id,
        kind: 'review',
        visibility: 'PUBLIC',
        content: 'Agent review summary',
        mentions: stringifyJson([]),
        artifactRefs: stringifyJson([]),
        attachmentIds: stringifyJson([]),
        workRequestIds: stringifyJson(['work-request-from-agent-message']),
      },
    });
    await prisma.roomMessage.update({
      where: { id: agentMessage.id },
      data: { createdAt: new Date('2026-01-01T00:00:02.000Z') },
    });
    const app = Fastify({ logger: false });

    try {
      setTeamRunEnv({
        AGENT_TOWER_TEAM_RUN_ID: teamRun.id,
        AGENT_TOWER_MEMBER_ID: members[0]!.id,
        AGENT_TOWER_INVOCATION_ID: invocation.id,
        AGENT_TOWER_SESSION_ID: undefined,
      });

      await app.register(teamRunRoutes, { prefix: '/api' });
      await app.listen({ port: 0, host: '127.0.0.1' });
      const address = app.server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Failed to start test server');
      }

      const restListResponse = await app.inject({
        method: 'GET',
        url: `/api/team-runs/${teamRun.id}/messages`,
        headers: { 'x-agent-tower-invocation-id': invocation.id },
      });
      expect(restListResponse.statusCode).toBe(200);
      const restList = restListResponse.json() as Array<{
        id: string;
        content: string;
        contentPreview: string;
        contentMode: 'preview' | 'full';
        fullContentAvailable: boolean;
        isTruncated: boolean;
      }>;
      expect(restList[0]).toMatchObject({
        id: earlierMessage.id,
        contentMode: 'full',
        fullContentAvailable: false,
        isTruncated: false,
      });
      expect(restList[1]).toMatchObject({
        id: roomMessage.id,
        contentMode: 'preview',
        fullContentAvailable: true,
        isTruncated: true,
      });
      expect(restList[1]!.content).toBe(restList[1]!.contentPreview);
      expect(restList[1]!.content).not.toBe(longContent);

      const limitedRestListResponse = await app.inject({
        method: 'GET',
        url: `/api/team-runs/${teamRun.id}/messages?limit=1`,
        headers: { 'x-agent-tower-invocation-id': invocation.id },
      });
      expect(limitedRestListResponse.statusCode).toBe(200);
      expect((limitedRestListResponse.json() as Array<{ id: string }>).map((message) => message.id)).toEqual([
        agentMessage.id,
      ]);

      const restDetailResponse = await app.inject({
        method: 'GET',
        url: `/api/team-runs/${teamRun.id}/messages/${roomMessage.id}`,
        headers: { 'x-agent-tower-invocation-id': invocation.id },
      });
      expect(restDetailResponse.statusCode).toBe(200);
      expect(restDetailResponse.json()).toMatchObject({
        id: roomMessage.id,
        content: longContent,
        contentPreview: restList[1]!.contentPreview,
        contentMode: 'full',
        fullContentAvailable: false,
        isTruncated: true,
      });

      const server = await createMcpServer(`http://127.0.0.1:${address.port}`);
      const client = new Client({ name: 'team-room-detail-test-client', version: '0.1.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const listResult = await client.callTool({
          name: 'list_room_messages',
          arguments: {},
        });
        expect(listResult.isError).not.toBe(true);
        const mcpList = JSON.parse(getMcpToolText(listResult)) as Array<{
          id: string;
          createdAt: string;
          kind: string;
          sender: {
            type: string;
            memberId?: string;
            name?: string;
          };
          content: string;
          fullContentAvailable: boolean;
          mentions: unknown[];
          workRequestIds?: string[];
          teamRunId?: string;
          senderId?: string | null;
          senderInvocationId?: string | null;
          visibility?: string;
          contentPreview?: string;
          contentMode?: string;
          isTruncated?: boolean;
          participants?: unknown[];
          recipientMemberIds?: string[];
          participantMemberIds?: string[];
        }>;
        expect(mcpList[0]).toMatchObject({
          id: earlierMessage.id,
          kind: 'chat',
          sender: {
            type: 'user',
            memberId: members[0]!.id,
            name: members[0]!.name,
          },
          content: 'Earlier visible message',
          fullContentAvailable: false,
          mentions: [],
        });
        expect(mcpList[0]).not.toHaveProperty('teamRunId');
        expect(mcpList[0]).not.toHaveProperty('senderId');
        expect(mcpList[0]).not.toHaveProperty('senderInvocationId');
        expect(mcpList[0]).not.toHaveProperty('visibility');
        expect(mcpList[0]).not.toHaveProperty('contentPreview');
        expect(mcpList[0]).not.toHaveProperty('contentMode');
        expect(mcpList[0]).not.toHaveProperty('isTruncated');
        expect(mcpList[0]).not.toHaveProperty('participants');
        expect(mcpList[0]).not.toHaveProperty('recipientMemberIds');
        expect(mcpList[0]).not.toHaveProperty('participantMemberIds');
        expect(mcpList[1]).toMatchObject({
          id: roomMessage.id,
          kind: 'chat',
          sender: { type: 'user' },
          fullContentAvailable: true,
          mentions: [],
        });
        expect(mcpList[1]!.content).toBe(restList[1]!.contentPreview);
        expect(mcpList[1]!.content).not.toBe(longContent);
        expect(mcpList[2]).toMatchObject({
          id: agentMessage.id,
          kind: 'review',
          sender: {
            type: 'agent',
            memberId: members[0]!.id,
            name: members[0]!.name,
          },
          content: 'Agent review summary',
          fullContentAvailable: false,
          mentions: [],
          workRequestIds: ['work-request-from-agent-message'],
        });
        expect(mcpList[2]).not.toHaveProperty('senderInvocationId');

        const limitedListResult = await client.callTool({
          name: 'list_room_messages',
          arguments: {
            limit: 1,
          },
        });
        expect(limitedListResult.isError).not.toBe(true);
        expect((JSON.parse(getMcpToolText(limitedListResult)) as Array<{ id: string }>).map((message) => message.id)).toEqual([
          agentMessage.id,
        ]);

        const detailResult = await client.callTool({
          name: 'get_room_message',
          arguments: {
            message_id: roomMessage.id,
          },
        });
        expect(detailResult.isError).not.toBe(true);
        expect(JSON.parse(getMcpToolText(detailResult))).toMatchObject({
          id: roomMessage.id,
          content: longContent,
          contentPreview: restList[1]!.contentPreview,
          contentMode: 'full',
          fullContentAvailable: false,
          isTruncated: true,
        });
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      restoreTeamRunEnv(previousEnv);
      await app.close();
    }
  });

  it('posts a room message from MCP workspace context identity when MCP env identity is missing', async () => {
    const previousTeamRunId = process.env.AGENT_TOWER_TEAM_RUN_ID;
    const previousMemberId = process.env.AGENT_TOWER_MEMBER_ID;
    const previousInvocationId = process.env.AGENT_TOWER_INVOCATION_ID;
    const previousSessionId = process.env.AGENT_TOWER_SESSION_ID;
    const { workspace, teamRun, members } = await createFixture({ memberCount: 2 });
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'STARTED',
    });
    const invocation = await createRunningInvocation({
      teamRunId: teamRun.id,
      workRequestId: request.id,
      memberId: members[0]!.id,
      workspaceId: workspace.id,
      status: 'RUNNING',
    });
    const contextWorktreePath = fs.realpathSync(workspace.worktreePath);
    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { worktreePath: contextWorktreePath },
    });
    const app = Fastify({ logger: false });

    try {
      delete process.env.AGENT_TOWER_TEAM_RUN_ID;
      delete process.env.AGENT_TOWER_MEMBER_ID;
      delete process.env.AGENT_TOWER_INVOCATION_ID;
      delete process.env.AGENT_TOWER_SESSION_ID;

      await app.register((await import('../../routes/system.js')).systemRoutes, { prefix: '/api' });
      await app.register(teamRunRoutes, { prefix: '/api' });
      await app.listen({ port: 0, host: '127.0.0.1' });
      const address = app.server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Failed to start test server');
      }

      const previousCwd = process.cwd();
      let server;
      try {
        process.chdir(contextWorktreePath);
        server = await createMcpServer(`http://127.0.0.1:${address.port}`);
      } finally {
        process.chdir(previousCwd);
      }
      const client = new Client({ name: 'team-room-context-test-client', version: '0.1.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: 'post_room_message',
        arguments: {
          content: 'Implemented through context identity',
          mentions: [{ memberId: members[1]!.id }],
        },
      });
      await client.close();
      await server.close();

      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      const resultContent = result.content as Array<{ type: string; text?: string }>;
      const messageText = resultContent[0]?.type === 'text' ? resultContent[0].text ?? '' : '';
      const message = JSON.parse(messageText) as { id: string; senderInvocationId: string; senderType: string };
      expect(message).toMatchObject({
        senderType: 'agent',
        senderInvocationId: invocation.id,
      });

      await expect(prisma.roomMessage.findUnique({ where: { id: message.id } })).resolves.toMatchObject({
        senderType: 'agent',
        senderId: members[0]!.id,
        senderInvocationId: invocation.id,
      });
      let createdRequestId = '';
      await vi.waitFor(async () => {
        const createdRequest = await prisma.workRequest.findFirst({
          where: {
            teamRunId: teamRun.id,
            triggerMessageId: message.id,
            targetMemberId: members[1]!.id,
          },
        });
        expect(createdRequest).toMatchObject({
          requesterType: 'agent',
          requesterMemberId: members[0]!.id,
          status: 'STARTED',
        });
        createdRequestId = createdRequest!.id;
      });
      await vi.waitFor(async () => {
        await expect(prisma.agentInvocation.findFirst({
          where: { workRequestId: createdRequestId },
        })).resolves.toMatchObject({
          memberId: members[1]!.id,
          sessionId: null,
          status: 'FAILED',
        });
      });
    } finally {
      if (previousTeamRunId === undefined) {
        delete process.env.AGENT_TOWER_TEAM_RUN_ID;
      } else {
        process.env.AGENT_TOWER_TEAM_RUN_ID = previousTeamRunId;
      }
      if (previousMemberId === undefined) {
        delete process.env.AGENT_TOWER_MEMBER_ID;
      } else {
        process.env.AGENT_TOWER_MEMBER_ID = previousMemberId;
      }
      if (previousInvocationId === undefined) {
        delete process.env.AGENT_TOWER_INVOCATION_ID;
      } else {
        process.env.AGENT_TOWER_INVOCATION_ID = previousInvocationId;
      }
      if (previousSessionId === undefined) {
        delete process.env.AGENT_TOWER_SESSION_ID;
      } else {
        process.env.AGENT_TOWER_SESSION_ID = previousSessionId;
      }
      await app.close();
    }
  });

  it('lists TeamRun members through MCP without exposing role prompts', async () => {
    const previousEnv = captureTeamRunEnv();
    const { workspace, teamRun, members } = await createFixture({ memberCount: 2 });
    const runningRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'STARTED',
    });
    await createRunningInvocation({
      teamRunId: teamRun.id,
      workRequestId: runningRequest.id,
      memberId: members[0]!.id,
      workspaceId: workspace.id,
      status: 'RUNNING',
    });
    const app = Fastify({ logger: false });

    try {
      setTeamRunEnv({
        AGENT_TOWER_TEAM_RUN_ID: teamRun.id,
        AGENT_TOWER_MEMBER_ID: members[0]!.id,
        AGENT_TOWER_INVOCATION_ID: undefined,
        AGENT_TOWER_SESSION_ID: undefined,
      });

      await app.register(teamRunRoutes, { prefix: '/api' });
      await app.listen({ port: 0, host: '127.0.0.1' });
      const address = app.server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Failed to start test server');
      }

      const server = await createMcpServer(`http://127.0.0.1:${address.port}`);
      const client = new Client({ name: 'team-member-test-client', version: '0.1.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: 'list_team_members',
        arguments: {},
      });
      await client.close();
      await server.close();

      expect(result.isError).not.toBe(true);
      const resultContent = result.content as Array<{ type: string; text?: string }>;
      const text = resultContent[0]?.type === 'text' ? resultContent[0].text ?? '' : '';
      const payload = JSON.parse(text) as {
        teamRunId: string;
        currentMemberId: string | null;
        members: Array<Record<string, unknown>>;
      };

      expect(payload).toMatchObject({
        teamRunId: teamRun.id,
        currentMemberId: members[0]!.id,
      });
      expect(payload.members).toHaveLength(2);
      expect(payload.members[0]).toMatchObject({
        id: members[0]!.id,
        name: 'Member 1',
        aliases: ['member-1'],
        status: 'RUNNING',
        workspacePolicy: 'shared',
        triggerPolicy: 'MENTION_ONLY',
        sessionPolicy: 'new_per_request',
        providerId: 'provider-1',
      });
      expect(payload.members[0]?.capabilities).toMatchObject({
        writeFiles: true,
        runCommands: false,
        mentionMembers: true,
      });
      expect(payload.members[0]).not.toHaveProperty('rolePrompt');
      expect(payload.members[0]).not.toHaveProperty('avatar');
      expect(payload.members[0]).not.toHaveProperty('createdAt');
      expect(payload.members[0]).not.toHaveProperty('updatedAt');
      expect(payload.members[0]).not.toHaveProperty('presetId');
    } finally {
      restoreTeamRunEnv(previousEnv);
      await app.close();
    }
  });

  it('rejects explicit mismatched team_run_id in bound MCP TeamRun tools', async () => {
    const previousEnv = captureTeamRunEnv();
    const { workspace, teamRun, members } = await createFixture({ memberCount: 1 });
    const other = await createFixture({ memberCount: 1 });
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'STARTED',
    });
    const invocation = await createRunningInvocation({
      teamRunId: teamRun.id,
      workRequestId: request.id,
      memberId: members[0]!.id,
      workspaceId: workspace.id,
    });
    const routeScheduler = createRouteSchedulerMock();
    const app = Fastify({ logger: false });

    try {
      setTeamRunEnv({
        AGENT_TOWER_TEAM_RUN_ID: teamRun.id,
        AGENT_TOWER_MEMBER_ID: members[0]!.id,
        AGENT_TOWER_INVOCATION_ID: invocation.id,
        AGENT_TOWER_SESSION_ID: undefined,
      });

      await app.register(teamRunRoutes, { prefix: '/api', scheduler: routeScheduler });
      await app.listen({ port: 0, host: '127.0.0.1' });
      const address = app.server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Failed to start test server');
      }

      const server = await createMcpServer(`http://127.0.0.1:${address.port}`);
      const client = new Client({ name: 'team-run-mismatch-test-client', version: '0.1.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const cases = [
          {
            name: 'post_room_message',
            arguments: {
              team_run_id: other.teamRun.id,
              content: 'This should be rejected before reaching the API',
            },
          },
          {
            name: 'list_room_messages',
            arguments: {
              team_run_id: other.teamRun.id,
            },
          },
          {
            name: 'list_team_members',
            arguments: {
              team_run_id: other.teamRun.id,
            },
          },
          {
            name: 'list_member_work_requests',
            arguments: {
              team_run_id: other.teamRun.id,
            },
          },
          {
            name: 'stop_member_work',
            arguments: {
              team_run_id: other.teamRun.id,
              member_id: other.members[0]!.id,
              cancel_queued: true,
            },
          },
          {
            name: 'cancel_work_request',
            arguments: {
              team_run_id: other.teamRun.id,
              work_request_id: request.id,
            },
          },
        ];

        for (const toolCall of cases) {
          const result = await client.callTool(toolCall);
          expect(result.isError, toolCall.name).toBe(true);
          expect(getMcpToolText(result), toolCall.name).toContain(TEAM_RUN_MISMATCH_ERROR);
        }
      } finally {
        await client.close();
        await server.close();
      }

      await expect(prisma.roomMessage.count()).resolves.toBe(0);
      expect(routeScheduler.stopMemberWork).not.toHaveBeenCalled();
    } finally {
      restoreTeamRunEnv(previousEnv);
      await app.close();
    }
  });

  it('forbids REST member queue impersonation from another agent invocation', async () => {
    const { workspace, teamRun, members } = await createFixture({
      memberCount: 3,
      teamRunMode: 'CONFIRM',
    });
    const recipient = members[1]!;
    const observer = members[2]!;
    const observerRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: observer.id,
      status: 'STARTED',
    });
    const observerInvocation = await createRunningInvocation({
      teamRunId: teamRun.id,
      workRequestId: observerRequest.id,
      memberId: observer.id,
      workspaceId: workspace.id,
    });
    const app = Fastify({ logger: false });

    try {
      await app.register(teamRunRoutes, { prefix: '/api' });

      const privateMessageResponse = await app.inject({
        method: 'POST',
        url: `/api/team-runs/${teamRun.id}/private-messages`,
        payload: {
          content: 'Hidden private queue preview',
          recipientMemberIds: [recipient.id],
        },
      });
      expect(privateMessageResponse.statusCode).toBe(201);

      const hostQueueResponse = await app.inject({
        method: 'GET',
        url: `/api/team-runs/${teamRun.id}/members/${recipient.id}/work-requests`,
      });
      expect(hostQueueResponse.statusCode).toBe(200);
      expect(hostQueueResponse.body).toContain('Hidden private queue preview');

      const spoofedQueueResponse = await app.inject({
        method: 'GET',
        url: `/api/team-runs/${teamRun.id}/members/${recipient.id}/work-requests`,
        headers: {
          'x-agent-tower-invocation-id': observerInvocation.id,
        },
      });
      expect(spoofedQueueResponse.statusCode).toBe(403);
      expect(spoofedQueueResponse.json()).toMatchObject({ code: 'FORBIDDEN' });
      expect(spoofedQueueResponse.body).not.toContain('Hidden private queue preview');

      const ownQueueResponse = await app.inject({
        method: 'GET',
        url: `/api/team-runs/${teamRun.id}/members/${observer.id}/work-requests`,
        headers: {
          'x-agent-tower-invocation-id': observerInvocation.id,
        },
      });
      expect(ownQueueResponse.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('derives REST private message agent sender from invocation header and rejects host agent spoofing', async () => {
    const { workspace, teamRun, members } = await createFixture({
      memberCount: 3,
      teamRunMode: 'CONFIRM',
    });
    const actualSender = members[0]!;
    const forgedSender = members[1]!;
    const recipient = members[2]!;
    const senderRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: actualSender.id,
      status: 'STARTED',
    });
    const senderInvocation = await createRunningInvocation({
      teamRunId: teamRun.id,
      workRequestId: senderRequest.id,
      memberId: actualSender.id,
      workspaceId: workspace.id,
    });
    const app = Fastify({ logger: false });

    try {
      await app.register(teamRunRoutes, { prefix: '/api' });

      const forgedAgentResponse = await app.inject({
        method: 'POST',
        url: `/api/team-runs/${teamRun.id}/private-messages`,
        headers: {
          'x-agent-tower-invocation-id': senderInvocation.id,
        },
        payload: {
          content: 'Forged sender should be ignored',
          recipientMemberIds: [recipient.id],
          senderType: 'agent',
          senderId: forgedSender.id,
          senderInvocationId: 'forged-invocation-id',
        },
      });
      expect(forgedAgentResponse.statusCode).toBe(201);
      const forgedAgentMessage = forgedAgentResponse.json() as {
        id: string;
        senderType: string;
        senderId: string | null;
        senderInvocationId: string | null;
        workRequestIds: string[];
      };
      expect(forgedAgentMessage).toMatchObject({
        senderType: 'agent',
        senderId: actualSender.id,
        senderInvocationId: senderInvocation.id,
      });
      await expect(prisma.roomMessage.findUnique({ where: { id: forgedAgentMessage.id } })).resolves.toMatchObject({
        senderType: 'agent',
        senderId: actualSender.id,
        senderInvocationId: senderInvocation.id,
      });
      await expect(prisma.workRequest.findUnique({
        where: { id: forgedAgentMessage.workRequestIds[0]! },
      })).resolves.toMatchObject({
        requesterType: 'agent',
        requesterMemberId: actualSender.id,
      });

      const hostAgentSpoofResponse = await app.inject({
        method: 'POST',
        url: `/api/team-runs/${teamRun.id}/private-messages`,
        payload: {
          content: 'Host cannot spoof agent sender',
          recipientMemberIds: [recipient.id],
          senderType: 'agent',
          senderId: actualSender.id,
        },
      });
      expect(hostAgentSpoofResponse.statusCode).toBe(400);
      expect(hostAgentSpoofResponse.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
      await expect(prisma.roomMessage.findMany({
        where: { teamRunId: teamRun.id, content: 'Host cannot spoof agent sender' },
      })).resolves.toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('preserves REST user private message senderId for member visibility without leaking to non-participants', async () => {
    const { workspace, teamRun, members } = await createFixture({
      memberCount: 3,
      teamRunMode: 'CONFIRM',
    });
    const sender = members[0]!;
    const recipient = members[1]!;
    const observer = members[2]!;
    const senderRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: sender.id,
      status: 'STARTED',
    });
    const senderInvocation = await createRunningInvocation({
      teamRunId: teamRun.id,
      workRequestId: senderRequest.id,
      memberId: sender.id,
      workspaceId: workspace.id,
    });
    const recipientRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: recipient.id,
      status: 'STARTED',
    });
    const recipientInvocation = await createRunningInvocation({
      teamRunId: teamRun.id,
      workRequestId: recipientRequest.id,
      memberId: recipient.id,
      workspaceId: workspace.id,
    });
    const observerRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: observer.id,
      status: 'STARTED',
    });
    const observerInvocation = await createRunningInvocation({
      teamRunId: teamRun.id,
      workRequestId: observerRequest.id,
      memberId: observer.id,
      workspaceId: workspace.id,
    });
    const app = Fastify({ logger: false });

    try {
      await app.register(teamRunRoutes, { prefix: '/api' });

      const response = await app.inject({
        method: 'POST',
        url: `/api/team-runs/${teamRun.id}/private-messages`,
        payload: {
          content: 'Host user sent private message',
          recipientMemberIds: [recipient.id],
          senderType: 'user',
          senderId: sender.id,
        },
      });
      expect(response.statusCode).toBe(201);
      const message = response.json() as {
        id: string;
        senderType: string;
        senderId: string | null;
        senderInvocationId: string | null;
        participantMemberIds: string[];
        recipientMemberIds: string[];
        workRequestIds: string[];
      };
      expect(message).toMatchObject({
        senderType: 'user',
        senderId: sender.id,
        senderInvocationId: null,
        recipientMemberIds: [recipient.id],
      });
      expect(new Set(message.participantMemberIds)).toEqual(new Set([sender.id, recipient.id]));

      const hostMessagesResponse = await app.inject({
        method: 'GET',
        url: `/api/team-runs/${teamRun.id}/messages`,
      });
      expect(hostMessagesResponse.statusCode).toBe(200);
      expect(hostMessagesResponse.body).toContain('Host user sent private message');

      const senderMessagesResponse = await app.inject({
        method: 'GET',
        url: `/api/team-runs/${teamRun.id}/messages`,
        headers: {
          'x-agent-tower-invocation-id': senderInvocation.id,
        },
      });
      expect(senderMessagesResponse.statusCode).toBe(200);
      expect(senderMessagesResponse.body).toContain('Host user sent private message');

      const recipientMessagesResponse = await app.inject({
        method: 'GET',
        url: `/api/team-runs/${teamRun.id}/messages`,
        headers: {
          'x-agent-tower-invocation-id': recipientInvocation.id,
        },
      });
      expect(recipientMessagesResponse.statusCode).toBe(200);
      expect(recipientMessagesResponse.body).toContain('Host user sent private message');

      const observerMessagesResponse = await app.inject({
        method: 'GET',
        url: `/api/team-runs/${teamRun.id}/messages`,
        headers: {
          'x-agent-tower-invocation-id': observerInvocation.id,
        },
      });
      expect(observerMessagesResponse.statusCode).toBe(200);
      expect(observerMessagesResponse.body).not.toContain('Host user sent private message');

      const observerQueueResponse = await app.inject({
        method: 'GET',
        url: `/api/team-runs/${teamRun.id}/members/${observer.id}/work-requests`,
        headers: {
          'x-agent-tower-invocation-id': observerInvocation.id,
        },
      });
      expect(observerQueueResponse.statusCode).toBe(200);
      expect(observerQueueResponse.body).not.toContain('Host user sent private message');

      await expect(prisma.workRequest.findUnique({
        where: { id: message.workRequestIds[0]! },
      })).resolves.toMatchObject({
        requesterType: 'user',
        requesterMemberId: null,
        targetMemberId: recipient.id,
        instruction: 'Host user sent private message',
      });
    } finally {
      await app.close();
    }
  });

  it('normalizes REST system private message senderId without granting sender visibility', async () => {
    const { workspace, teamRun, members } = await createFixture({
      memberCount: 3,
      teamRunMode: 'CONFIRM',
    });
    const sender = members[0]!;
    const recipient = members[1]!;
    const observer = members[2]!;
    const senderRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: sender.id,
      status: 'STARTED',
    });
    const senderInvocation = await createRunningInvocation({
      teamRunId: teamRun.id,
      workRequestId: senderRequest.id,
      memberId: sender.id,
      workspaceId: workspace.id,
    });
    const recipientRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: recipient.id,
      status: 'STARTED',
    });
    const recipientInvocation = await createRunningInvocation({
      teamRunId: teamRun.id,
      workRequestId: recipientRequest.id,
      memberId: recipient.id,
      workspaceId: workspace.id,
    });
    const observerRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: observer.id,
      status: 'STARTED',
    });
    const observerInvocation = await createRunningInvocation({
      teamRunId: teamRun.id,
      workRequestId: observerRequest.id,
      memberId: observer.id,
      workspaceId: workspace.id,
    });
    const app = Fastify({ logger: false });

    try {
      await app.register(teamRunRoutes, { prefix: '/api' });

      const response = await app.inject({
        method: 'POST',
        url: `/api/team-runs/${teamRun.id}/private-messages`,
        payload: {
          content: 'System sent private message',
          recipientMemberIds: [recipient.id],
          senderType: 'system',
          senderId: sender.id,
          senderInvocationId: senderInvocation.id,
        },
      });
      expect(response.statusCode).toBe(201);
      const message = response.json() as {
        id: string;
        senderType: string;
        senderId: string | null;
        senderInvocationId: string | null;
        participantMemberIds: string[];
        recipientMemberIds: string[];
        workRequestIds: string[];
      };
      expect(message).toMatchObject({
        senderType: 'system',
        senderId: null,
        senderInvocationId: null,
        recipientMemberIds: [recipient.id],
      });
      expect(message.participantMemberIds).toEqual([recipient.id]);

      await expect(prisma.roomMessage.findUnique({
        where: { id: message.id },
        include: { participants: true },
      })).resolves.toMatchObject({
        senderType: 'system',
        senderId: null,
        senderInvocationId: null,
        participants: [
          expect.objectContaining({
            memberId: recipient.id,
            role: 'recipient',
          }),
        ],
      });

      const hostMessagesResponse = await app.inject({
        method: 'GET',
        url: `/api/team-runs/${teamRun.id}/messages`,
      });
      expect(hostMessagesResponse.statusCode).toBe(200);
      expect(hostMessagesResponse.body).toContain('System sent private message');

      const senderMessagesResponse = await app.inject({
        method: 'GET',
        url: `/api/team-runs/${teamRun.id}/messages`,
        headers: {
          'x-agent-tower-invocation-id': senderInvocation.id,
        },
      });
      expect(senderMessagesResponse.statusCode).toBe(200);
      expect(senderMessagesResponse.body).not.toContain('System sent private message');

      const recipientMessagesResponse = await app.inject({
        method: 'GET',
        url: `/api/team-runs/${teamRun.id}/messages`,
        headers: {
          'x-agent-tower-invocation-id': recipientInvocation.id,
        },
      });
      expect(recipientMessagesResponse.statusCode).toBe(200);
      expect(recipientMessagesResponse.body).toContain('System sent private message');

      const observerMessagesResponse = await app.inject({
        method: 'GET',
        url: `/api/team-runs/${teamRun.id}/messages`,
        headers: {
          'x-agent-tower-invocation-id': observerInvocation.id,
        },
      });
      expect(observerMessagesResponse.statusCode).toBe(200);
      expect(observerMessagesResponse.body).not.toContain('System sent private message');

      await expect(prisma.workRequest.findUnique({
        where: { id: message.workRequestIds[0]! },
      })).resolves.toMatchObject({
        requesterType: 'system',
        requesterMemberId: null,
        targetMemberId: recipient.id,
        instruction: 'System sent private message',
      });
    } finally {
      await app.close();
    }
  });

  it('enforces MCP Team Room capabilities for listing and private messages', async () => {
    const previousEnv = captureTeamRunEnv();
    const noRead = await createFixture({
      memberCount: 2,
      memberCapabilities: [{ readRoom: false }],
    });
    const noPost = await createFixture({
      memberCount: 2,
      memberCapabilities: [{ postRoomMessage: false }],
    });
    const noMention = await createFixture({
      memberCount: 2,
      memberCapabilities: [{ mentionMembers: false }],
    });
    const noReadRequest = await createWorkRequest({
      teamRunId: noRead.teamRun.id,
      targetMemberId: noRead.members[0]!.id,
      status: 'STARTED',
    });
    const noReadInvocation = await createRunningInvocation({
      teamRunId: noRead.teamRun.id,
      workRequestId: noReadRequest.id,
      memberId: noRead.members[0]!.id,
      workspaceId: noRead.workspace.id,
    });
    const noPostRequest = await createWorkRequest({
      teamRunId: noPost.teamRun.id,
      targetMemberId: noPost.members[0]!.id,
      status: 'STARTED',
    });
    const noPostInvocation = await createRunningInvocation({
      teamRunId: noPost.teamRun.id,
      workRequestId: noPostRequest.id,
      memberId: noPost.members[0]!.id,
      workspaceId: noPost.workspace.id,
    });
    const noMentionRequest = await createWorkRequest({
      teamRunId: noMention.teamRun.id,
      targetMemberId: noMention.members[0]!.id,
      status: 'STARTED',
    });
    const noMentionInvocation = await createRunningInvocation({
      teamRunId: noMention.teamRun.id,
      workRequestId: noMentionRequest.id,
      memberId: noMention.members[0]!.id,
      workspaceId: noMention.workspace.id,
    });
    const app = Fastify({ logger: false });

    try {
      await app.register(teamRunRoutes, { prefix: '/api' });
      await app.listen({ port: 0, host: '127.0.0.1' });
      const address = app.server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Failed to start test server');
      }
      const baseUrl = `http://127.0.0.1:${address.port}`;

      async function callToolForCurrentMember(fixture: {
        teamRun: { id: string };
        members: Array<{ id: string }>;
      }, invocationId: string, toolCall: { name: string; arguments: Record<string, unknown> }) {
        setTeamRunEnv({
          AGENT_TOWER_TEAM_RUN_ID: fixture.teamRun.id,
          AGENT_TOWER_MEMBER_ID: fixture.members[0]!.id,
          AGENT_TOWER_INVOCATION_ID: invocationId,
          AGENT_TOWER_SESSION_ID: undefined,
        });
        const server = await createMcpServer(baseUrl);
        const client = new Client({ name: `${toolCall.name}-capability-test-client`, version: '0.1.0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        try {
          return await client.callTool(toolCall);
        } finally {
          await client.close();
          await server.close();
        }
      }

      const listResult = await callToolForCurrentMember(noRead, noReadInvocation.id, {
        name: 'list_room_messages',
        arguments: {},
      });
      expect(listResult.isError).toBe(true);
      expect(getMcpToolText(listResult)).toContain('readRoom');

      const getMessageResult = await callToolForCurrentMember(noRead, noReadInvocation.id, {
        name: 'get_room_message',
        arguments: {
          message_id: 'room-message-1',
        },
      });
      expect(getMessageResult.isError).toBe(true);
      expect(getMcpToolText(getMessageResult)).toContain('readRoom');

      const noPostResult = await callToolForCurrentMember(noPost, noPostInvocation.id, {
        name: 'post_private_message',
        arguments: {
          recipient_member_ids: [noPost.members[1]!.id],
          content: 'Cannot post without postRoomMessage',
        },
      });
      expect(noPostResult.isError).toBe(true);
      expect(getMcpToolText(noPostResult)).toContain('postRoomMessage');

      const noMentionResult = await callToolForCurrentMember(noMention, noMentionInvocation.id, {
        name: 'post_private_message',
        arguments: {
          recipient_member_ids: [noMention.members[1]!.id],
          content: 'Cannot trigger private work without mentionMembers',
        },
      });
      expect(noMentionResult.isError).toBe(true);
      expect(getMcpToolText(noMentionResult)).toContain('mentionMembers');

      const noStopResult = await callToolForCurrentMember(noRead, noReadInvocation.id, {
        name: 'stop_member_work',
        arguments: {
          member_id: noRead.members[1]!.id,
          cancel_queued: true,
        },
      });
      expect(noStopResult.isError).toBe(true);
      expect(getMcpToolText(noStopResult)).toContain('stopMemberWork');

      await expect(prisma.roomMessage.count({
        where: {
          content: {
            in: [
              'Cannot post without postRoomMessage',
              'Cannot trigger private work without mentionMembers',
            ],
          },
        },
      })).resolves.toBe(0);
    } finally {
      restoreTeamRunEnv(previousEnv);
      await app.close();
    }
  });

  it('lists and cancels current member queued WorkRequests through MCP', async () => {
    const previousEnv = captureTeamRunEnv();
    const { teamRun, members } = await createFixture({ memberCount: 2 });
    const triggerMessage = await prisma.roomMessage.create({
      data: {
        teamRunId: teamRun.id,
        senderType: 'user',
        senderId: null,
        senderInvocationId: null,
        kind: 'chat',
        content: 'Please handle this queued request',
        mentions: '[]',
        workRequestIds: '[]',
        artifactRefs: '[]',
        attachmentIds: '[]',
      },
    });
    const ownRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'QUEUED',
      instruction: 'Own queued request',
    });
    await prisma.workRequest.update({
      where: { id: ownRequest.id },
      data: { triggerMessageId: triggerMessage.id },
    });
    const otherRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[1]!.id,
      status: 'QUEUED',
      instruction: 'Other queued request',
    });
    const ownPendingApproval = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'PENDING_APPROVAL',
      instruction: 'Own pending approval',
    });
    const ownPendingRejection = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'PENDING_APPROVAL',
      instruction: 'Own pending rejection',
    });
    const otherPendingApproval = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[1]!.id,
      status: 'PENDING_APPROVAL',
      instruction: 'Other pending approval',
    });
    const app = Fastify({ logger: false });

    try {
      setTeamRunEnv({
        AGENT_TOWER_TEAM_RUN_ID: teamRun.id,
        AGENT_TOWER_MEMBER_ID: members[0]!.id,
        AGENT_TOWER_INVOCATION_ID: undefined,
        AGENT_TOWER_SESSION_ID: undefined,
      });

      await app.register(teamRunRoutes, { prefix: '/api' });
      await app.listen({ port: 0, host: '127.0.0.1' });
      const address = app.server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Failed to start test server');
      }

      const server = await createMcpServer(`http://127.0.0.1:${address.port}`);
      const client = new Client({ name: 'team-run-queue-test-client', version: '0.1.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const listResult = await client.callTool({
          name: 'list_member_work_requests',
          arguments: {},
        });
        expect(listResult.isError, getMcpToolText(listResult)).not.toBe(true);
        const queue = JSON.parse(getMcpToolText(listResult)) as {
          currentMemberId: string;
          queueManagementPolicy: string;
          canManageTeamRunQueue: boolean;
          workRequests: Array<{
            id: string;
            targetMemberId: string;
            targetMember: { id: string; name: string; label: string } | null;
            triggerMessage: { contentPreview: string };
          }>;
        };
        expect(queue).toMatchObject({
          currentMemberId: members[0]!.id,
          queueManagementPolicy: 'own_only',
          canManageTeamRunQueue: false,
        });
        expect(queue.workRequests).toHaveLength(1);
        expect(queue.workRequests[0]).toMatchObject({
          id: ownRequest.id,
          targetMemberId: members[0]!.id,
          targetMember: {
            id: members[0]!.id,
            name: members[0]!.name,
            label: members[0]!.name,
          },
          triggerMessage: { contentPreview: 'Please handle this queued request' },
        });

        const cancelResult = await client.callTool({
          name: 'cancel_work_request',
          arguments: { work_request_id: ownRequest.id },
        });
        expect(cancelResult.isError, getMcpToolText(cancelResult)).not.toBe(true);
        expect(JSON.parse(getMcpToolText(cancelResult))).toMatchObject({
          id: ownRequest.id,
          status: 'CANCELLED',
        });

        const forbiddenCancel = await client.callTool({
          name: 'cancel_work_request',
          arguments: { work_request_id: otherRequest.id },
        });
        expect(forbiddenCancel.isError).toBe(true);
        expect(getMcpToolText(forbiddenCancel)).toContain('FORBIDDEN');
        await expect(prisma.workRequest.findUnique({ where: { id: otherRequest.id } })).resolves.toMatchObject({
          status: 'QUEUED',
        });

        const approveResult = await client.callTool({
          name: 'approve_work_request',
          arguments: { work_request_id: ownPendingApproval.id },
        });
        expect(approveResult.isError, getMcpToolText(approveResult)).not.toBe(true);
        expect(JSON.parse(getMcpToolText(approveResult)).workRequest).toMatchObject({
          id: ownPendingApproval.id,
          status: 'QUEUED',
        });

        const rejectResult = await client.callTool({
          name: 'reject_work_request',
          arguments: { work_request_id: ownPendingRejection.id },
        });
        expect(rejectResult.isError, getMcpToolText(rejectResult)).not.toBe(true);
        expect(JSON.parse(getMcpToolText(rejectResult))).toMatchObject({
          id: ownPendingRejection.id,
          status: 'REJECTED',
        });

        const forbiddenApprove = await client.callTool({
          name: 'approve_work_request',
          arguments: { work_request_id: otherPendingApproval.id },
        });
        expect(forbiddenApprove.isError).toBe(true);
        expect(getMcpToolText(forbiddenApprove)).toContain('FORBIDDEN');
      } finally {
        await client.close();
        await server.close();
      }

      await expect(prisma.workRequest.findUnique({ where: { id: ownRequest.id } })).resolves.toMatchObject({
        status: 'CANCELLED',
      });
      await expect(prisma.workRequest.findUnique({ where: { id: otherRequest.id } })).resolves.toMatchObject({
        status: 'STARTED',
      });
      await expect(prisma.workRequest.findUnique({ where: { id: ownPendingRejection.id } })).resolves.toMatchObject({
        status: 'REJECTED',
      });
      await expect(prisma.workRequest.findUnique({ where: { id: otherPendingApproval.id } })).resolves.toMatchObject({
        status: 'PENDING_APPROVAL',
      });
    } finally {
      restoreTeamRunEnv(previousEnv);
      await app.close();
    }
  });

  it('posts MCP room messages as user when bound TeamRun identity is partial', async () => {
    const previousEnv = captureTeamRunEnv();
    const { teamRun, members } = await createFixture({ memberCount: 2 });
    const app = Fastify({ logger: false });

    try {
      setTeamRunEnv({
        AGENT_TOWER_TEAM_RUN_ID: teamRun.id,
        AGENT_TOWER_MEMBER_ID: members[0]!.id,
        AGENT_TOWER_INVOCATION_ID: undefined,
        AGENT_TOWER_SESSION_ID: undefined,
      });

      await app.register(teamRunRoutes, { prefix: '/api' });
      await app.listen({ port: 0, host: '127.0.0.1' });
      const address = app.server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Failed to start test server');
      }

      const server = await createMcpServer(`http://127.0.0.1:${address.port}`);
      const client = new Client({ name: 'team-run-partial-identity-test-client', version: '0.1.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

      await server.connect(serverTransport);
      await client.connect(clientTransport);
      let messageId: string;
      try {
        const result = await client.callTool({
          name: 'post_room_message',
          arguments: {
            content: 'Partial identity should not be sent as agent',
          },
        });

        expect(result.isError, getMcpToolText(result)).not.toBe(true);
        const message = JSON.parse(getMcpToolText(result)) as {
          id: string;
          senderType: string;
          senderId: string | null;
          senderInvocationId: string | null;
        };
        messageId = message.id;
        expect(message).toMatchObject({
          senderType: 'user',
          senderId: null,
          senderInvocationId: null,
        });
      } finally {
        await client.close();
        await server.close();
      }

      await expect(prisma.roomMessage.findUnique({ where: { id: messageId! } })).resolves.toMatchObject({
        senderType: 'user',
        senderId: null,
        senderInvocationId: null,
      });
    } finally {
      restoreTeamRunEnv(previousEnv);
      await app.close();
    }
  });

  it('enforces requester member scope for REST WorkRequest cancellation', async () => {
    const { teamRun, members } = await createFixture({ memberCount: 3 });
    await prisma.teamMember.update({
      where: { id: members[2]!.id },
      data: { queueManagementPolicy: 'team_pending' },
    });
    const ownQueued = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'QUEUED',
      instruction: 'Own queued request',
    });
    const otherQueued = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[1]!.id,
      status: 'QUEUED',
      instruction: 'Other queued request',
    });
    const managerQueued = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[1]!.id,
      status: 'QUEUED',
      instruction: 'Manager cancellable request',
    });
    const app = Fastify({ logger: false });

    try {
      await app.register(teamRunRoutes, { prefix: '/api' });

      const anonymousCancel = await app.inject({
        method: 'POST',
        url: `/api/team-runs/work-requests/${ownQueued.id}/cancel`,
        payload: {},
      });
      expect(anonymousCancel.statusCode).toBe(400);
      expect(anonymousCancel.json()).toMatchObject({ code: 'VALIDATION_ERROR' });

      const ownCancel = await app.inject({
        method: 'POST',
        url: `/api/team-runs/work-requests/${ownQueued.id}/cancel`,
        payload: {
          teamRunId: teamRun.id,
          requesterMemberId: members[0]!.id,
        },
      });
      expect(ownCancel.statusCode).toBe(200);
      expect(ownCancel.json()).toMatchObject({ id: ownQueued.id, status: 'CANCELLED' });

      const forbiddenCancel = await app.inject({
        method: 'POST',
        url: `/api/team-runs/work-requests/${otherQueued.id}/cancel`,
        payload: {
          teamRunId: teamRun.id,
          requesterMemberId: members[0]!.id,
        },
      });
      expect(forbiddenCancel.statusCode).toBe(403);
      expect(forbiddenCancel.json()).toMatchObject({ code: 'FORBIDDEN' });

      const managerCancel = await app.inject({
        method: 'POST',
        url: `/api/team-runs/work-requests/${managerQueued.id}/cancel`,
        payload: {
          teamRunId: teamRun.id,
          requesterMemberId: members[2]!.id,
        },
      });
      expect(managerCancel.statusCode).toBe(200);
      expect(managerCancel.json()).toMatchObject({ id: managerQueued.id, status: 'CANCELLED' });

      await expect(prisma.workRequest.findUnique({ where: { id: otherQueued.id } })).resolves.toMatchObject({
        status: 'QUEUED',
      });
    } finally {
      await app.close();
    }
  });

  it('passes requester member scope for REST WorkRequest approval and rejection', async () => {
    const { teamRun, members } = await createFixture({ memberCount: 2, teamRunMode: 'CONFIRM' });
    const ownPending = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'PENDING_APPROVAL',
      instruction: 'Own approval',
    });
    const otherPending = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[1]!.id,
      status: 'PENDING_APPROVAL',
      instruction: 'Other rejection',
    });
    const routeScheduler = createRouteSchedulerMock();
    const app = Fastify({ logger: false });

    try {
      await app.register(teamRunRoutes, { prefix: '/api', scheduler: routeScheduler });

      const approve = await app.inject({
        method: 'POST',
        url: `/api/team-runs/work-requests/${ownPending.id}/approve`,
        payload: {
          teamRunId: teamRun.id,
          requesterMemberId: members[0]!.id,
        },
      });
      expect(approve.statusCode).toBe(200);
      expect(routeScheduler.approveWorkRequestAndStartNext).toHaveBeenCalledWith(ownPending.id, {
        teamRunId: teamRun.id,
        requesterMemberId: members[0]!.id,
      });

      const reject = await app.inject({
        method: 'POST',
        url: `/api/team-runs/work-requests/${otherPending.id}/reject`,
        payload: {
          teamRunId: teamRun.id,
          requesterMemberId: members[0]!.id,
        },
      });
      expect(reject.statusCode).toBe(200);
      expect(routeScheduler.rejectWorkRequest).toHaveBeenCalledWith(otherPending.id, {
        teamRunId: teamRun.id,
        requesterMemberId: members[0]!.id,
      });
    } finally {
      await app.close();
    }
  });

  it('does not soft-remove a member when active stop fails during removal', async () => {
    const { workspace, teamRun, members } = await createFixture({ memberCount: 2 });
    const activeRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'STARTED',
      instruction: 'Active work',
    });
    const queuedRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'QUEUED',
      instruction: 'Queued work',
    });
    await createRunningInvocation({
      teamRunId: teamRun.id,
      workRequestId: activeRequest.id,
      memberId: members[0]!.id,
      workspaceId: workspace.id,
      status: 'RUNNING',
    });
    const routeScheduler = createRouteSchedulerMock();
    routeScheduler.stopMemberWork = vi.fn(async () => {
      throw new Error('stop failed');
    });
    const app = Fastify({ logger: false });

    try {
      await app.register(teamRunRoutes, { prefix: '/api', scheduler: routeScheduler });

      const response = await app.inject({
        method: 'POST',
        url: `/api/team-runs/${teamRun.id}/members/${members[0]!.id}/remove`,
        payload: {
          stopActive: true,
          cancelQueued: true,
        },
      });

      expect(response.statusCode).toBe(500);
      expect(routeScheduler.stopMemberWork).toHaveBeenCalledWith(teamRun.id, members[0]!.id, {
        cancelQueued: true,
      });
      await expect(prisma.teamMember.findUnique({ where: { id: members[0]!.id } })).resolves.toMatchObject({
        membershipStatus: 'ACTIVE',
        status: 'IDLE',
      });
      await expect(prisma.workRequest.findUnique({ where: { id: queuedRequest.id } })).resolves.toMatchObject({
        status: 'QUEUED',
      });
      await expect(prisma.agentInvocation.count({
        where: {
          teamRunId: teamRun.id,
          memberId: members[0]!.id,
          status: 'RUNNING',
        },
      })).resolves.toBe(1);
    } finally {
      await app.close();
    }
  });

  it('auto-starts USER_MESSAGES work when a user posts an unmentioned room message', async () => {
    const { teamRun, members } = await createFixture({
      memberCount: 2,
      teamRunMode: 'AUTO',
      triggerPolicies: ['USER_MESSAGES', 'MENTION_ONLY'],
    });
    const routeScheduler = createRouteSchedulerMock();
    const startedTeamRunIds: string[] = [];
    routeScheduler.startNextSessions = vi.fn(async (teamRunId: string) => {
      startedTeamRunIds.push(teamRunId);
      return await new Promise<AgentInvocation[]>(() => {});
    });
    const app = Fastify({ logger: false });

    try {
      await app.register(teamRunRoutes, { prefix: '/api', scheduler: routeScheduler });

      const response = await app.inject({
        method: 'POST',
        url: `/api/team-runs/${teamRun.id}/messages`,
        payload: {
          content: '普通用户消息',
          senderType: 'user',
        },
      });

      expect(response.statusCode).toBe(201);
      const message = response.json() as { id: string; workRequestIds: string[]; mentions: unknown[] };
      expect(message.mentions).toEqual([]);
      expect(message.workRequestIds).toHaveLength(1);
      expect(routeScheduler.startNextSessions).not.toHaveBeenCalled();

      await expect(prisma.workRequest.findUnique({ where: { id: message.workRequestIds[0]! } })).resolves.toMatchObject({
        targetMemberId: members[0]!.id,
        instruction: '普通用户消息',
        status: 'QUEUED',
      });
      await expect(prisma.agentInvocation.count({
        where: {
          teamRunId: teamRun.id,
          memberId: members[0]!.id,
        },
      })).resolves.toBe(0);

      await vi.waitFor(() => {
        expect(routeScheduler.startNextSessions).toHaveBeenCalledWith(teamRun.id);
        expect(startedTeamRunIds).toEqual([teamRun.id]);
      });
    } finally {
      await app.close();
    }
  });

  it('creates an initial Team Room message without WorkRequests for unmentioned MENTION_ONLY members', async () => {
    const project = await prisma.project.create({
      data: {
        name: 'Initial message project',
        repoPath: createGitRepoPath(),
      },
    });
    const task = await prisma.task.create({
      data: {
        title: 'Build CSV import',
        description: 'Parse uploaded files and show validation errors.',
        projectId: project.id,
      },
    });
    const implementerPreset = await createMemberPreset({ name: 'Implementer', triggerPolicy: 'MENTION_ONLY' });
    const reviewerPreset = await createMemberPreset({ name: 'Reviewer', triggerPolicy: 'MENTION_ONLY' });
    const routeScheduler = createRouteSchedulerMock();
    const app = Fastify({ logger: false });

    try {
      await app.register(teamRunRoutes, { prefix: '/api', scheduler: routeScheduler });

      const response = await app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/team-runs`,
        payload: {
          mode: 'AUTO',
          memberPresetIds: [implementerPreset.id, reviewerPreset.id],
        },
      });

      expect(response.statusCode).toBe(201);
      const teamRun = response.json() as {
        id: string;
        members: Array<{ id: string; name: string }>;
        messages: Array<{ id: string; content: string; senderType: string; kind: string; mentions: unknown[]; workRequestIds: string[] }>;
        workRequests: Array<{ id: string; targetMemberId: string; instruction: string; status: string }>;
      };
      const initialContent = 'Build CSV import\n\nParse uploaded files and show validation errors.';
      expect(teamRun.messages).toHaveLength(1);
      expect(teamRun.messages[0]).toMatchObject({
        senderType: 'user',
        kind: 'chat',
        content: initialContent,
        mentions: [],
        workRequestIds: [],
      });
      expect(teamRun.workRequests).toEqual([]);

      const messagesResponse = await app.inject({
        method: 'GET',
        url: `/api/team-runs/${teamRun.id}/messages`,
      });
      expect(messagesResponse.statusCode).toBe(200);
      const messages = messagesResponse.json() as Array<{ id: string; content: string; mentions: unknown[]; workRequestIds: string[] }>;
      expect(messages).toEqual([
        expect.objectContaining({
          id: teamRun.messages[0]!.id,
          content: initialContent,
          mentions: [],
          workRequestIds: [],
        }),
      ]);

      const workRequestsResponse = await app.inject({
        method: 'GET',
        url: `/api/team-runs/${teamRun.id}/work-requests`,
      });
      expect(workRequestsResponse.statusCode).toBe(200);
      const workRequests = workRequestsResponse.json() as Array<{
        id: string;
        targetMemberId: string;
        instruction: string;
      }>;
      expect(workRequests).toEqual([]);
      await expect(prisma.roomMessage.count({ where: { teamRunId: teamRun.id } })).resolves.toBe(1);
      await expect(prisma.workRequest.count({ where: { teamRunId: teamRun.id } })).resolves.toBe(0);
      expect(routeScheduler.startNextSessions).not.toHaveBeenCalled();
      await expect(prisma.agentInvocation.count({ where: { teamRunId: teamRun.id } })).resolves.toBe(0);
    } finally {
      await app.close();
    }
  });

  it('creates USER_MESSAGES WorkRequests from a title-only initial message and auto-starts it', async () => {
    const project = await prisma.project.create({
      data: {
        name: 'Title-only project',
        repoPath: createGitRepoPath(),
      },
    });
    const task = await prisma.task.create({
      data: {
        title: 'Investigate slow dashboard',
        projectId: project.id,
      },
    });
    const preset = await createMemberPreset({ name: 'Leader', triggerPolicy: 'USER_MESSAGES' });
    const routeScheduler = createRouteSchedulerMock();
    const app = Fastify({ logger: false });

    try {
      await app.register(teamRunRoutes, { prefix: '/api', scheduler: routeScheduler });

      const response = await app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/team-runs`,
        payload: {
          mode: 'AUTO',
          memberPresetIds: [preset.id],
        },
      });

      expect(response.statusCode).toBe(201);
      const teamRun = response.json() as {
        id: string;
        messages: Array<{ content: string; workRequestIds: string[] }>;
        workRequests: Array<{ id: string; instruction: string; status: string }>;
      };
      expect(teamRun.messages).toHaveLength(1);
      expect(teamRun.messages[0]).toMatchObject({
        content: 'Investigate slow dashboard',
        workRequestIds: [teamRun.workRequests[0]!.id],
      });
      expect(teamRun.workRequests[0]).toMatchObject({
        instruction: 'Investigate slow dashboard',
        status: 'QUEUED',
      });

      await vi.waitFor(() => {
        expect(routeScheduler.startNextSessions).toHaveBeenCalledWith(teamRun.id);
      });
    } finally {
      await app.close();
    }
  });

  it('creates an initial WorkRequest only for a mentioned MENTION_ONLY member', async () => {
    const project = await prisma.project.create({
      data: {
        name: 'Mentioned initial message project',
        repoPath: createGitRepoPath(),
      },
    });
    const task = await prisma.task.create({
      data: {
        title: 'Investigate import failures',
        description: 'Please @Reviewer check the error handling.',
        projectId: project.id,
      },
    });
    const implementerPreset = await createMemberPreset({ name: 'Implementer', triggerPolicy: 'MENTION_ONLY' });
    const reviewerPreset = await createMemberPreset({ name: 'Reviewer', triggerPolicy: 'MENTION_ONLY' });
    const routeScheduler = createRouteSchedulerMock();
    const app = Fastify({ logger: false });

    try {
      await app.register(teamRunRoutes, { prefix: '/api', scheduler: routeScheduler });

      const response = await app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/team-runs`,
        payload: {
          mode: 'AUTO',
          memberPresetIds: [implementerPreset.id, reviewerPreset.id],
        },
      });

      expect(response.statusCode).toBe(201);
      const teamRun = response.json() as {
        id: string;
        members: Array<{ id: string; name: string }>;
        messages: Array<{ content: string; mentions: Array<{ memberId: string; label?: string }>; workRequestIds: string[] }>;
        workRequests: Array<{ id: string; targetMemberId: string; instruction: string; status: string }>;
      };
      const reviewer = teamRun.members.find((member) => member.name === 'Reviewer');
      const implementer = teamRun.members.find((member) => member.name === 'Implementer');
      const initialContent = 'Investigate import failures\n\nPlease @Reviewer check the error handling.';

      expect(reviewer).toBeDefined();
      expect(implementer).toBeDefined();
      expect(teamRun.messages).toHaveLength(1);
      expect(teamRun.messages[0]).toMatchObject({
        content: initialContent,
        mentions: [{ memberId: reviewer!.id, label: 'Reviewer' }],
      });
      expect(teamRun.workRequests).toEqual([
        expect.objectContaining({
          id: teamRun.messages[0]!.workRequestIds[0],
          targetMemberId: reviewer!.id,
          instruction: initialContent,
          status: 'QUEUED',
        }),
      ]);
      expect(teamRun.workRequests[0]!.targetMemberId).not.toBe(implementer!.id);

      await vi.waitFor(() => {
        expect(routeScheduler.startNextSessions).toHaveBeenCalledWith(teamRun.id);
      });
      await expect(prisma.agentInvocation.count({ where: { teamRunId: teamRun.id } })).resolves.toBe(1);
    } finally {
      await app.close();
    }
  });

  it('matches initial @mention tokens exactly instead of matching name prefixes', async () => {
    const project = await prisma.project.create({
      data: {
        name: 'Mention prefix project',
        repoPath: createGitRepoPath(),
      },
    });
    const task = await prisma.task.create({
      data: {
        title: 'Route QA review',
        description: 'Please @QA-Lead verify the release notes.',
        projectId: project.id,
      },
    });
    const qaPreset = await createMemberPreset({ name: 'QA', triggerPolicy: 'MENTION_ONLY' });
    const qaLeadPreset = await createMemberPreset({ name: 'QA-Lead', triggerPolicy: 'MENTION_ONLY' });
    const routeScheduler = createRouteSchedulerMock();
    const app = Fastify({ logger: false });

    try {
      await app.register(teamRunRoutes, { prefix: '/api', scheduler: routeScheduler });

      const response = await app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/team-runs`,
        payload: {
          mode: 'AUTO',
          memberPresetIds: [qaPreset.id, qaLeadPreset.id],
        },
      });

      expect(response.statusCode).toBe(201);
      const teamRun = response.json() as {
        id: string;
        members: Array<{ id: string; name: string }>;
        messages: Array<{ mentions: Array<{ memberId: string; label?: string }>; workRequestIds: string[] }>;
        workRequests: Array<{ id: string; targetMemberId: string }>;
      };
      const qa = teamRun.members.find((member) => member.name === 'QA');
      const qaLead = teamRun.members.find((member) => member.name === 'QA-Lead');

      expect(qa).toBeDefined();
      expect(qaLead).toBeDefined();
      expect(teamRun.messages[0]!.mentions).toEqual([{ memberId: qaLead!.id, label: 'QA-Lead' }]);
      expect(teamRun.workRequests).toEqual([
        expect.objectContaining({
          id: teamRun.messages[0]!.workRequestIds[0],
          targetMemberId: qaLead!.id,
        }),
      ]);
      expect(teamRun.workRequests[0]!.targetMemberId).not.toBe(qa!.id);
    } finally {
      await app.close();
    }
  });

  it('does not create initial WorkRequests for ambiguous @mention aliases', async () => {
    const project = await prisma.project.create({
      data: {
        name: 'Ambiguous mention project',
        repoPath: createGitRepoPath(),
      },
    });
    const task = await prisma.task.create({
      data: {
        title: 'Review ambiguous owner',
        description: 'Please @reviewer check this.',
        projectId: project.id,
      },
    });
    const firstPreset = await createMemberPreset({ name: 'Frontend Reviewer', triggerPolicy: 'MENTION_ONLY' });
    const secondPreset = await createMemberPreset({ name: 'Backend Reviewer', triggerPolicy: 'MENTION_ONLY' });
    await prisma.memberPreset.updateMany({
      where: { id: { in: [firstPreset.id, secondPreset.id] } },
      data: { aliases: stringifyJson(['reviewer']) },
    });
    const routeScheduler = createRouteSchedulerMock();
    const app = Fastify({ logger: false });

    try {
      await app.register(teamRunRoutes, { prefix: '/api', scheduler: routeScheduler });

      const response = await app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/team-runs`,
        payload: {
          mode: 'AUTO',
          memberPresetIds: [firstPreset.id, secondPreset.id],
        },
      });

      expect(response.statusCode).toBe(201);
      const teamRun = response.json() as {
        id: string;
        messages: Array<{ mentions: unknown[]; workRequestIds: string[] }>;
        workRequests: unknown[];
      };
      expect(teamRun.messages[0]).toMatchObject({
        mentions: [],
        workRequestIds: [],
      });
      expect(teamRun.workRequests).toEqual([]);
      await expect(prisma.workRequest.count({ where: { teamRunId: teamRun.id } })).resolves.toBe(0);
      expect(routeScheduler.startNextSessions).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('does not fall back to USER_MESSAGES when initial @mention aliases are ambiguous', async () => {
    const project = await prisma.project.create({
      data: {
        name: 'Mixed ambiguous mention project',
        repoPath: createGitRepoPath(),
      },
    });
    const task = await prisma.task.create({
      data: {
        title: 'Route ambiguous review',
        description: 'Please @reviewer decide who owns this.',
        projectId: project.id,
      },
    });
    const firstPreset = await createMemberPreset({ name: 'Frontend Reviewer', triggerPolicy: 'MENTION_ONLY' });
    const secondPreset = await createMemberPreset({ name: 'Backend Reviewer', triggerPolicy: 'MENTION_ONLY' });
    const observerPreset = await createMemberPreset({ name: 'Observer', triggerPolicy: 'USER_MESSAGES' });
    await prisma.memberPreset.updateMany({
      where: { id: { in: [firstPreset.id, secondPreset.id] } },
      data: { aliases: stringifyJson(['reviewer']) },
    });
    const routeScheduler = createRouteSchedulerMock();
    const app = Fastify({ logger: false });

    try {
      await app.register(teamRunRoutes, { prefix: '/api', scheduler: routeScheduler });

      const response = await app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/team-runs`,
        payload: {
          mode: 'AUTO',
          memberPresetIds: [firstPreset.id, secondPreset.id, observerPreset.id],
        },
      });

      expect(response.statusCode).toBe(201);
      const teamRun = response.json() as {
        id: string;
        messages: Array<{ mentions: unknown[]; workRequestIds: string[] }>;
        workRequests: unknown[];
      };
      expect(teamRun.messages[0]).toMatchObject({
        mentions: [],
        workRequestIds: [],
      });
      expect(teamRun.workRequests).toEqual([]);
      await expect(prisma.workRequest.count({ where: { teamRunId: teamRun.id } })).resolves.toBe(0);
      expect(routeScheduler.startNextSessions).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects creating a TeamRun for a blank-title task before writing TeamRun data', async () => {
    const project = await prisma.project.create({
      data: {
        name: 'Blank title project',
        repoPath: createGitRepoPath(),
      },
    });
    const task = await prisma.task.create({
      data: {
        title: '   ',
        projectId: project.id,
      },
    });
    const preset = await createMemberPreset({ name: 'Leader', triggerPolicy: 'USER_MESSAGES' });
    const routeScheduler = createRouteSchedulerMock();
    const app = Fastify({ logger: false });

    try {
      await app.register(teamRunRoutes, { prefix: '/api', scheduler: routeScheduler });

      const response = await app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/team-runs`,
        payload: {
          mode: 'AUTO',
          memberPresetIds: [preset.id],
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(routeScheduler.startNextSessions).not.toHaveBeenCalled();
      await expect(prisma.teamRun.count({ where: { taskId: task.id } })).resolves.toBe(0);
      await expect(prisma.roomMessage.count()).resolves.toBe(0);
      await expect(prisma.workRequest.count()).resolves.toBe(0);
    } finally {
      await app.close();
    }
  });

  it('rolls back TeamRun creation when initial WorkRequest creation fails and allows retry', async () => {
    const project = await prisma.project.create({
      data: {
        name: 'Atomic TeamRun project',
        repoPath: createGitRepoPath(),
      },
    });
    const task = await prisma.task.create({
      data: {
        title: 'Start atomically',
        projectId: project.id,
      },
    });
    const preset = await createMemberPreset({ name: 'Implementer', triggerPolicy: 'USER_MESSAGES' });
    const routeScheduler = createRouteSchedulerMock();
    const originalTransaction = prisma.$transaction.bind(prisma);
    const transactionSpy = vi.spyOn(prisma, '$transaction');
    transactionSpy.mockImplementationOnce(async (arg: any, ...rest: any[]) => {
      if (typeof arg !== 'function') {
        return originalTransaction(arg, ...rest);
      }

      return originalTransaction(async (tx: any) => {
        const failingTx = new Proxy(tx, {
          get(target, property, receiver) {
            if (property !== 'workRequest') {
              return Reflect.get(target, property, receiver);
            }

            const delegate = Reflect.get(target, property, receiver);
            return new Proxy(delegate, {
              get(delegateTarget, delegateProperty, delegateReceiver) {
                if (delegateProperty === 'create') {
                  return async () => {
                    throw new Error('injected initial WorkRequest failure');
                  };
                }
                return Reflect.get(delegateTarget, delegateProperty, delegateReceiver);
              },
            });
          },
        });

        return arg(failingTx);
      }, ...rest);
    });
    const app = Fastify({ logger: false });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await app.register(teamRunRoutes, { prefix: '/api', scheduler: routeScheduler });

      const failedResponse = await app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/team-runs`,
        payload: {
          mode: 'AUTO',
          memberPresetIds: [preset.id],
        },
      });

      expect(failedResponse.statusCode).toBe(500);
      expect(routeScheduler.startNextSessions).not.toHaveBeenCalled();
      await expect(prisma.teamRun.count({ where: { taskId: task.id } })).resolves.toBe(0);
      await expect(prisma.teamMember.count()).resolves.toBe(0);
      await expect(prisma.roomMessage.count()).resolves.toBe(0);
      await expect(prisma.workRequest.count()).resolves.toBe(0);

      const retryResponse = await app.inject({
        method: 'POST',
        url: `/api/tasks/${task.id}/team-runs`,
        payload: {
          mode: 'AUTO',
          memberPresetIds: [preset.id],
        },
      });

      expect(retryResponse.statusCode).toBe(201);
      const teamRun = retryResponse.json() as {
        id: string;
        messages: Array<{ workRequestIds: string[] }>;
        workRequests: Array<{ id: string; status: string }>;
      };
      expect(teamRun.messages[0]!.workRequestIds).toEqual([teamRun.workRequests[0]!.id]);
      expect(teamRun.workRequests[0]).toMatchObject({ status: 'QUEUED' });
      await vi.waitFor(() => {
        expect(routeScheduler.startNextSessions).toHaveBeenCalledWith(teamRun.id);
      });
    } finally {
      consoleErrorSpy.mockRestore();
      await app.close();
    }
  });

  it('SessionManager.stop routes TeamRun sessions through the reconciler', async () => {
    const { workspace, teamRun, members } = await createFixture();
    const request = await createWorkRequest({ teamRunId: teamRun.id, targetMemberId: members[0]!.id });
    const session = await prisma.session.create({
      data: {
        workspaceId: workspace.id,
        agentType: 'CODEX',
        providerId: 'provider-1',
        prompt: 'Do the work',
        status: 'RUNNING',
      },
    });
    const invocation = await createRunningInvocation({
      teamRunId: teamRun.id,
      workRequestId: request.id,
      memberId: members[0]!.id,
      workspaceId: workspace.id,
      sessionId: session.id,
      status: 'RUNNING',
    });
    const manager = new SessionManager(new EventBus(), service);

    await expect(manager.stop(session.id)).resolves.toMatchObject({ id: session.id });

    await expect(prisma.session.findUnique({ where: { id: session.id } })).resolves.toMatchObject({
      status: 'CANCELLED',
    });
    await expect(prisma.agentInvocation.findUnique({ where: { id: invocation.id } })).resolves.toMatchObject({
      status: 'CANCELLED',
      nextRoomReplyReminderAt: null,
    });
    expect(scheduler.releaseInvocationLocks).toHaveBeenCalledWith(invocation.id);
    expect(scheduler.startNextSessions).toHaveBeenCalledWith(teamRun.id);
  });

  it('SessionManager.stop can skip TeamRun reconciliation for cleanup', async () => {
    const { workspace, teamRun, members } = await createFixture({ taskStatus: TaskStatus.IN_PROGRESS });
    const request = await createWorkRequest({ teamRunId: teamRun.id, targetMemberId: members[0]!.id });
    const session = await prisma.session.create({
      data: {
        workspaceId: workspace.id,
        agentType: 'CODEX',
        providerId: 'provider-1',
        prompt: 'TeamRun work',
        status: 'RUNNING',
      },
    });
    const invocation = await createRunningInvocation({
      teamRunId: teamRun.id,
      workRequestId: request.id,
      memberId: members[0]!.id,
      workspaceId: workspace.id,
      sessionId: session.id,
      status: 'RUNNING',
    });
    await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'QUEUED',
    });
    const manager = new SessionManager(new EventBus(), service);

    await expect(manager.stop(session.id, { skipTeamRunReconcile: true })).resolves.toMatchObject({ id: session.id });

    await expect(prisma.session.findUnique({ where: { id: session.id } })).resolves.toMatchObject({
      status: 'CANCELLED',
    });
    await expect(prisma.agentInvocation.findUnique({ where: { id: invocation.id } })).resolves.toMatchObject({
      status: 'RUNNING',
    });
    expect(scheduler.releaseInvocationLocks).not.toHaveBeenCalled();
    expect(scheduler.startNextSessions).not.toHaveBeenCalled();
  });

  it('SessionManager.stop leaves solo sessions without TeamRun reconciliation', async () => {
    const { workspace } = await createFixture();
    const session = await prisma.session.create({
      data: {
        workspaceId: workspace.id,
        agentType: 'CODEX',
        providerId: 'provider-1',
        prompt: 'Solo work',
        status: 'RUNNING',
      },
    });
    const manager = new SessionManager(new EventBus(), service);

    await expect(manager.stop(session.id)).resolves.toMatchObject({ id: session.id });

    await expect(prisma.session.findUnique({ where: { id: session.id } })).resolves.toMatchObject({
      status: 'CANCELLED',
    });
    expect(scheduler.releaseInvocationLocks).not.toHaveBeenCalled();
    expect(scheduler.startNextSessions).not.toHaveBeenCalled();
    await expect(prisma.agentInvocation.count()).resolves.toBe(0);
  });
});
