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
  scheduler.approveWorkRequestAndStartNext = vi.fn(async (workRequestId: string) => {
    const workRequest = await prisma.workRequest.update({
      where: { id: workRequestId },
      data: { status: 'QUEUED' },
    });
    const startedInvocations = await scheduler.startNextSessions(workRequest.teamRunId);
    return { workRequest: asWorkRequest(workRequest), startedInvocations };
  });
  scheduler.rejectWorkRequest = vi.fn(async (workRequestId: string) => prisma.workRequest.update({
    where: { id: workRequestId },
    data: { status: 'REJECTED' },
  }).then(asWorkRequest));
  scheduler.cancelWorkRequest = vi.fn(async (workRequestId: string) => prisma.workRequest.update({
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
} = {}) {
  const project = await prisma.project.create({
    data: {
      name: 'Team reconciler project',
      repoPath: testDir,
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
        capabilities: stringifyJson(capabilities),
        workspacePolicy: 'shared',
        triggerPolicy: options.triggerPolicies?.[index] ?? 'MENTION_ONLY',
        sessionPolicy: 'new_per_request',
        avatar: null,
      },
    }));
  }

  return { project, task, workspace, teamRun, members };
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
      await expect(prisma.workRequest.findFirst({
        where: {
          teamRunId: teamRun.id,
          triggerMessageId: message.id,
          targetMemberId: members[1]!.id,
        },
      })).resolves.toMatchObject({
        requesterType: 'agent',
        requesterMemberId: members[0]!.id,
        status: 'QUEUED',
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
      await expect(prisma.workRequest.findFirst({
        where: {
          teamRunId: teamRun.id,
          triggerMessageId: message.id,
          targetMemberId: members[1]!.id,
        },
      })).resolves.toMatchObject({
        requesterType: 'agent',
        requesterMemberId: members[0]!.id,
        status: 'QUEUED',
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
    const previousTeamRunId = process.env.AGENT_TOWER_TEAM_RUN_ID;
    const previousMemberId = process.env.AGENT_TOWER_MEMBER_ID;
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
      process.env.AGENT_TOWER_TEAM_RUN_ID = teamRun.id;
      process.env.AGENT_TOWER_MEMBER_ID = members[0]!.id;

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
            name: 'stop_member_work',
            arguments: {
              team_run_id: other.teamRun.id,
              member_id: other.members[0]!.id,
              cancel_queued: true,
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

  it('auto-starts USER_MESSAGES work when a user posts an unmentioned room message', async () => {
    const { teamRun, members } = await createFixture({
      memberCount: 2,
      teamRunMode: 'AUTO',
      triggerPolicies: ['USER_MESSAGES', 'MENTION_ONLY'],
    });
    const routeScheduler = createRouteSchedulerMock();
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
      expect(routeScheduler.startNextSessions).toHaveBeenCalledWith(teamRun.id);
      expect(routeScheduler.startedTeamRunIds).toEqual([teamRun.id]);

      await expect(prisma.workRequest.findUnique({ where: { id: message.workRequestIds[0]! } })).resolves.toMatchObject({
        targetMemberId: members[0]!.id,
        instruction: '普通用户消息',
        status: 'STARTED',
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
