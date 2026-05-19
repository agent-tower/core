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

async function createFixture(options: {
  taskStatus?: TaskStatus;
  memberCount?: number;
  teamRunMode?: 'AUTO' | 'CONFIRM';
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
        triggerPolicy: 'MENTION_ONLY',
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
