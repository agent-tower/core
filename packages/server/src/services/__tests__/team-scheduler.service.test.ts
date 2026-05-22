import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type {
  IfBusyPolicy,
  TeamMemberCapabilities,
  WorkspacePolicy,
  WorkRequestStatus,
} from '@agent-tower/shared';
import { AgentType } from '../../types/index.js';
import { TeamLockService } from '../team-lock.service.js';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-team-scheduler-'));
const dbPath = path.join(testDir, 'test.db');
process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, '../../..');
const schemaPath = path.join(serverRoot, 'prisma/schema.prisma');

let TeamSchedulerService: typeof import('../team-scheduler.service.js').TeamSchedulerService;
let prisma: PrismaClient;
type TeamSchedulerServiceInstance = InstanceType<typeof import('../team-scheduler.service.js').TeamSchedulerService>;
let workRequestSequence = 0;
let createdWorkspaceSequence = 0;

const readOnlyCapabilities: TeamMemberCapabilities = {
  readRoom: true,
  postRoomMessage: true,
  mentionMembers: true,
  stopMemberWork: false,
  markReadyForReview: false,
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  readDiff: true,
  mergeWorkspace: false,
};

const writeCapabilities: TeamMemberCapabilities = {
  ...readOnlyCapabilities,
  writeFiles: true,
};

const commandCapabilities: TeamMemberCapabilities = {
  ...readOnlyCapabilities,
  runCommands: true,
};

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

async function createTask(title = 'Team scheduler task') {
  const project = await prisma.project.create({
    data: {
      name: `${title} project`,
      repoPath: testDir,
    },
  });

  const task = await prisma.task.create({
    data: {
      title,
      projectId: project.id,
    },
  });

  return { project, task };
}

async function createTeamRunFixture(options: {
  memberCapabilities?: TeamMemberCapabilities[];
  workspacePolicies?: WorkspacePolicy[];
  sessionPolicies?: Array<'new_per_request' | 'resume_last'>;
  withWorkspace?: boolean;
} = {}) {
  const { project, task } = await createTask();
  const teamRun = await prisma.teamRun.create({
    data: {
      taskId: task.id,
      mode: 'AUTO',
    },
  });

  const workspace = options.withWorkspace === false
    ? null
    : await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: `team-${teamRun.id}`,
        worktreePath: path.join(testDir, `workspace-${teamRun.id}`),
      },
    });

  const capabilities = options.memberCapabilities ?? [readOnlyCapabilities];
  const members = [];
  for (const [index, memberCapabilities] of capabilities.entries()) {
    members.push(await prisma.teamMember.create({
      data: {
        teamRunId: teamRun.id,
        presetId: null,
        name: `Member ${index + 1}`,
        aliases: stringifyJson([`member-${index + 1}`]),
        providerId: `provider-${index + 1}`,
        rolePrompt: `Role ${index + 1}`,
        capabilities: stringifyJson(memberCapabilities),
        workspacePolicy: options.workspacePolicies?.[index] ?? 'shared',
        triggerPolicy: 'MENTION_ONLY',
        sessionPolicy: options.sessionPolicies?.[index] ?? 'new_per_request',
        avatar: null,
      },
    }));
  }

  return { project, task, teamRun, workspace, members };
}

async function createWorkRequest(options: {
  teamRunId: string;
  targetMemberId: string;
  status?: WorkRequestStatus;
  ifBusy?: IfBusyPolicy;
  cancelQueued?: boolean;
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
      ifBusy: options.ifBusy ?? 'queue',
      cancelQueued: options.cancelQueued ?? false,
      status: options.status ?? 'QUEUED',
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, workRequestSequence++)),
    },
  });
}

function createProviderLookup() {
  return vi.fn((providerId: string) => ({
    id: providerId,
    name: providerId,
    agentType: AgentType.CODEX,
    env: {},
    config: {},
    isDefault: false,
  }));
}

function createWorkspaceServiceMock() {
  return {
    create: vi.fn(async (taskId: string) => {
      const sequence = createdWorkspaceSequence++;
      return prisma.workspace.create({
        data: {
          taskId,
          branchName: `team-shared-${sequence}`,
          worktreePath: path.join(testDir, `created-workspace-${sequence}`),
          status: 'ACTIVE',
        },
      });
    }),
  };
}

function createSessionManagerMock(options: { failStart?: boolean } = {}) {
  return {
    create: vi.fn(async (
      workspaceId: string,
      agentType: AgentType,
      prompt: string,
      variant = 'DEFAULT',
      providerId?: string
    ) => prisma.session.create({
      data: {
        workspaceId,
        agentType,
        variant,
        providerId: providerId ?? null,
        prompt,
        status: 'PENDING',
      },
    })),
    start: vi.fn(async (sessionId: string) => {
      if (options.failStart) {
        throw new Error('session start failed');
      }

      return prisma.session.update({
        where: { id: sessionId },
        data: { status: 'RUNNING' },
      });
    }),
    startFollowUp: vi.fn(async (sessionId: string) => {
      if (options.failStart) {
        throw new Error('session start failed');
      }

      return prisma.session.update({
        where: { id: sessionId },
        data: { status: 'RUNNING' },
      });
    }),
    stop: vi.fn(async (sessionId: string) => prisma.session.update({
      where: { id: sessionId },
      data: { status: 'CANCELLED' },
    })),
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('TeamSchedulerService', () => {
  let service: TeamSchedulerServiceInstance;
  let lockService: TeamLockService;

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

    const serviceModule = await import('../team-scheduler.service.js');
    const utilsModule = await import('../../utils/index.js');
    TeamSchedulerService = serviceModule.TeamSchedulerService;
    prisma = utilsModule.prisma;
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    workRequestSequence = 0;
    createdWorkspaceSequence = 0;
    lockService = new TeamLockService();
    service = new TeamSchedulerService(lockService);
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

  it('approves a pending WorkRequest into the queue', async () => {
    const { teamRun, members } = await createTeamRunFixture();
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'PENDING_APPROVAL',
    });

    const approved = await service.approveWorkRequest(request.id);

    expect(approved.status).toBe('QUEUED');
  });

  it('approves a pending WorkRequest and immediately starts eligible queued work', async () => {
    const { teamRun, members } = await createTeamRunFixture({ withWorkspace: false });
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'PENDING_APPROVAL',
    });
    service = new TeamSchedulerService(lockService, {
      workspaceService: createWorkspaceServiceMock(),
      sessionManager: createSessionManagerMock(),
      getProviderById: createProviderLookup(),
    });

    const result = await service.approveWorkRequestAndStartNext(request.id);

    expect(result.workRequest).toMatchObject({
      id: request.id,
      status: 'QUEUED',
    });
    expect(result.startedInvocations).toHaveLength(1);
    expect(result.startedInvocations[0]).toMatchObject({
      teamRunId: teamRun.id,
      workRequestId: request.id,
      memberId: members[0]!.id,
      status: 'RUNNING',
      sessionId: expect.any(String),
    });
    await expect(prisma.workRequest.findUnique({ where: { id: request.id } })).resolves.toMatchObject({
      status: 'STARTED',
    });
  });

  it('returns a clear error when approving a non-pending WorkRequest', async () => {
    const { teamRun, members } = await createTeamRunFixture();
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'QUEUED',
    });

    await expect(service.approveWorkRequest(request.id)).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
      statusCode: 400,
    });
  });

  it('rejects a pending WorkRequest', async () => {
    const { teamRun, members } = await createTeamRunFixture();
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'PENDING_APPROVAL',
    });

    const rejected = await service.rejectWorkRequest(request.id);

    expect(rejected.status).toBe('REJECTED');
  });

  it('returns a clear error when rejecting a non-pending WorkRequest', async () => {
    const { teamRun, members } = await createTeamRunFixture();
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'QUEUED',
    });

    await expect(service.rejectWorkRequest(request.id)).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
      statusCode: 400,
    });
  });

  it('cancels pending and queued WorkRequests', async () => {
    const { teamRun, members } = await createTeamRunFixture();
    const pending = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'PENDING_APPROVAL',
    });
    const queued = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'QUEUED',
    });

    await expect(service.cancelWorkRequest(pending.id)).resolves.toMatchObject({ status: 'CANCELLED' });
    await expect(service.cancelWorkRequest(queued.id)).resolves.toMatchObject({ status: 'CANCELLED' });
  });

  it('does not cancel a started WorkRequest', async () => {
    const { teamRun, members } = await createTeamRunFixture();
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'STARTED',
    });

    await expect(service.cancelWorkRequest(request.id)).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
      statusCode: 400,
    });
  });

  it('does not let a stale cancel overwrite a WorkRequest that was started before the conditional write', async () => {
    const { teamRun, members } = await createTeamRunFixture();
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'QUEUED',
    });
    const originalTransaction = prisma.$transaction.bind(prisma);
    const transactionSpy = vi.spyOn(prisma, '$transaction');
    transactionSpy.mockImplementationOnce(async (arg: any, ...rest: any[]) => {
      await prisma.workRequest.update({
        where: { id: request.id },
        data: { status: 'STARTED' },
      });
      return originalTransaction(arg, ...rest);
    });

    await expect(service.cancelWorkRequest(request.id)).rejects.toMatchObject({
      code: 'INVALID_STATE_TRANSITION',
      statusCode: 400,
      message: expect.stringContaining('STARTED'),
    });
    await expect(prisma.workRequest.findUnique({ where: { id: request.id } })).resolves.toMatchObject({
      status: 'STARTED',
    });
  });

  it('starts queued work by creating a queued AgentInvocation without workspace or session creation', async () => {
    const { teamRun, members } = await createTeamRunFixture({ withWorkspace: false });
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'QUEUED',
    });
    const workspaceCountBefore = await prisma.workspace.count();
    const sessionCountBefore = await prisma.session.count();

    const invocations = await service.startNext(teamRun.id);

    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      teamRunId: teamRun.id,
      workRequestId: request.id,
      memberId: members[0]!.id,
      workspaceId: null,
      sessionId: null,
      status: 'QUEUED',
    });
    await expect(prisma.workRequest.findUnique({ where: { id: request.id } })).resolves.toMatchObject({
      status: 'STARTED',
    });
    await expect(prisma.workspace.count()).resolves.toBe(workspaceCountBefore);
    await expect(prisma.session.count()).resolves.toBe(sessionCountBefore);
  });

  it('does not start new work for a member with an active invocation', async () => {
    const { teamRun, members } = await createTeamRunFixture();
    await prisma.agentInvocation.create({
      data: {
        teamRunId: teamRun.id,
        workRequestId: 'existing-work-request',
        memberId: members[0]!.id,
        status: 'RUNNING',
      },
    });
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
    });

    await expect(service.startNext(teamRun.id)).resolves.toEqual([]);
    await expect(prisma.workRequest.findUnique({ where: { id: request.id } })).resolves.toMatchObject({
      status: 'QUEUED',
    });
  });

  it('starts only one queued WorkRequest for the same member in a single batch', async () => {
    const { teamRun, members } = await createTeamRunFixture();
    const first = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      instruction: 'First',
    });
    const second = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      instruction: 'Second',
    });

    const invocations = await service.startNext(teamRun.id);

    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.workRequestId).toBe(first.id);
    await expect(prisma.workRequest.findUnique({ where: { id: first.id } })).resolves.toMatchObject({
      status: 'STARTED',
    });
    await expect(prisma.workRequest.findUnique({ where: { id: second.id } })).resolves.toMatchObject({
      status: 'QUEUED',
    });
  });

  it('does not double-start a read-only member during concurrent startNext calls', async () => {
    const { teamRun, members } = await createTeamRunFixture();
    const first = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      instruction: 'First',
    });
    const second = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      instruction: 'Second',
    });

    const anotherService = new TeamSchedulerService(lockService);
    await Promise.all([
      service.startNext(teamRun.id),
      anotherService.startNext(teamRun.id),
    ]);

    await expect(prisma.agentInvocation.count({
      where: {
        teamRunId: teamRun.id,
        memberId: members[0]!.id,
        status: { in: ['QUEUED', 'RUNNING', 'SESSION_ENDED', 'WAITING_ROOM_REPLY'] },
      },
    })).resolves.toBe(1);
    const reloaded = await prisma.workRequest.findMany({
      where: { id: { in: [first.id, second.id] } },
      orderBy: { createdAt: 'asc' },
    });
    expect(reloaded.map((request) => request.status).sort()).toEqual(['QUEUED', 'STARTED']);
  });

  it('starts only one member when two members need the shared workspace write lock', async () => {
    const { task, teamRun, members } = await createTeamRunFixture({
      memberCapabilities: [writeCapabilities, writeCapabilities],
    });
    const first = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
    });
    const second = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[1]!.id,
    });

    const invocations = await service.startNext(teamRun.id);

    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.workRequestId).toBe(first.id);
    await expect(prisma.workRequest.findUnique({ where: { id: first.id } })).resolves.toMatchObject({
      status: 'STARTED',
    });
    await expect(prisma.workRequest.findUnique({ where: { id: second.id } })).resolves.toMatchObject({
      status: 'QUEUED',
    });
    expect(lockService.listLocks()).toEqual([
      { key: `workspace:task:${task.id}:write`, ownerId: invocations[0]!.id },
    ]);
  });

  it('uses a task proxy lock for shared write work when no active workspace exists', async () => {
    const { task, teamRun, members } = await createTeamRunFixture({
      memberCapabilities: [writeCapabilities, writeCapabilities],
      withWorkspace: false,
    });
    const first = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
    });
    const second = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[1]!.id,
    });
    const workspaceCountBefore = await prisma.workspace.count();
    const sessionCountBefore = await prisma.session.count();

    const invocations = await service.startNext(teamRun.id);

    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      workRequestId: first.id,
      workspaceId: null,
      sessionId: null,
      status: 'QUEUED',
    });
    expect(lockService.listLocks()).toEqual([
      { key: `workspace:task:${task.id}:write`, ownerId: invocations[0]!.id },
    ]);
    await expect(prisma.workRequest.findUnique({ where: { id: first.id } })).resolves.toMatchObject({
      status: 'STARTED',
    });
    await expect(prisma.workRequest.findUnique({ where: { id: second.id } })).resolves.toMatchObject({
      status: 'QUEUED',
    });
    await expect(prisma.workspace.count()).resolves.toBe(workspaceCountBefore);
    await expect(prisma.session.count()).resolves.toBe(sessionCountBefore);
  });

  it('uses a task proxy lock for shared command work when no active workspace exists', async () => {
    const { task, teamRun, members } = await createTeamRunFixture({
      memberCapabilities: [commandCapabilities, commandCapabilities],
      withWorkspace: false,
    });
    const first = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
    });
    const second = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[1]!.id,
    });
    const workspaceCountBefore = await prisma.workspace.count();
    const sessionCountBefore = await prisma.session.count();

    const invocations = await service.startNext(teamRun.id);

    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      workRequestId: first.id,
      workspaceId: null,
      sessionId: null,
      status: 'QUEUED',
    });
    expect(lockService.listLocks()).toEqual([
      { key: `workspace:task:${task.id}:command`, ownerId: invocations[0]!.id },
    ]);
    await expect(prisma.workRequest.findUnique({ where: { id: first.id } })).resolves.toMatchObject({
      status: 'STARTED',
    });
    await expect(prisma.workRequest.findUnique({ where: { id: second.id } })).resolves.toMatchObject({
      status: 'QUEUED',
    });
    await expect(prisma.workspace.count()).resolves.toBe(workspaceCountBefore);
    await expect(prisma.session.count()).resolves.toBe(sessionCountBefore);
  });

  it('starts read-only work for different members in parallel', async () => {
    const { teamRun, members } = await createTeamRunFixture({
      memberCapabilities: [readOnlyCapabilities, readOnlyCapabilities],
    });
    await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
    });
    await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[1]!.id,
    });

    const invocations = await service.startNext(teamRun.id);

    expect(invocations).toHaveLength(2);
    await expect(prisma.workRequest.count({
      where: { teamRunId: teamRun.id, status: 'STARTED' },
    })).resolves.toBe(2);
  });

  it('leaves work queued when an external owner holds the required lock', async () => {
    const { task, teamRun, members } = await createTeamRunFixture({
      memberCapabilities: [writeCapabilities],
    });
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
    });
    expect(lockService.acquire('external-owner', [`workspace:task:${task.id}:write`])).toBe(true);

    await expect(service.startNext(teamRun.id)).resolves.toEqual([]);
    await expect(prisma.agentInvocation.count()).resolves.toBe(0);
    await expect(prisma.workRequest.findUnique({ where: { id: request.id } })).resolves.toMatchObject({
      status: 'QUEUED',
    });
  });

  it('releases acquired locks when invocation creation fails', async () => {
    const { teamRun, members } = await createTeamRunFixture({
      memberCapabilities: [writeCapabilities],
    });
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
    });
    const transactionSpy = vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error('transaction failed'));

    await expect(service.startNext(teamRun.id)).rejects.toThrow('transaction failed');

    transactionSpy.mockRestore();
    expect(lockService.listLocks().filter((lock) => lock.ownerId.startsWith('pending:'))).toEqual([]);
    expect(lockService.listLocks()).toEqual([]);
    await expect(prisma.agentInvocation.count()).resolves.toBe(0);
    await expect(prisma.workRequest.findUnique({ where: { id: request.id } })).resolves.toMatchObject({
      status: 'QUEUED',
    });
  });

  it('marks cancel_current_and_start plans as requiring a future stop integration', async () => {
    const { teamRun, members } = await createTeamRunFixture();
    await prisma.agentInvocation.create({
      data: {
        teamRunId: teamRun.id,
        workRequestId: 'existing-work-request',
        memberId: members[0]!.id,
        status: 'RUNNING',
      },
    });
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      ifBusy: 'cancel_current_and_start',
    });

    await expect(service.planNext(teamRun.id)).resolves.toEqual([
      expect.objectContaining({
        workRequestId: request.id,
        canStart: false,
        blockedReason: 'member_busy',
        requiresStopCurrent: true,
      }),
    ]);
  });

  it('leaves dedicated workspace members blocked because dedicated startup is reserved', async () => {
    const { teamRun, members } = await createTeamRunFixture({
      workspacePolicies: ['dedicated'],
    });
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
    });

    await expect(service.planNext(teamRun.id)).resolves.toEqual([
      expect.objectContaining({
        workRequestId: request.id,
        canStart: false,
        blockedReason: 'unsupported_workspace_policy',
      }),
    ]);
    await expect(service.startNext(teamRun.id)).resolves.toEqual([]);
    await expect(prisma.agentInvocation.count()).resolves.toBe(0);
    await expect(prisma.workRequest.findUnique({ where: { id: request.id } })).resolves.toMatchObject({
      status: 'QUEUED',
    });
  });

  it('cancels only queued requests for the same member when cancelQueued is set', async () => {
    const { teamRun, members } = await createTeamRunFixture();
    const first = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      cancelQueued: true,
    });
    const second = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
    });
    const started = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'STARTED',
    });

    await service.startNext(teamRun.id);

    await expect(prisma.workRequest.findUnique({ where: { id: first.id } })).resolves.toMatchObject({
      status: 'STARTED',
    });
    await expect(prisma.workRequest.findUnique({ where: { id: second.id } })).resolves.toMatchObject({
      status: 'CANCELLED',
    });
    await expect(prisma.workRequest.findUnique({ where: { id: started.id } })).resolves.toMatchObject({
      status: 'STARTED',
    });
  });

  it('starts a shared member by creating the task shared workspace, session, and running invocation', async () => {
    const { task, teamRun, members } = await createTeamRunFixture({ withWorkspace: false });
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      instruction: 'Implement the shared work',
    });
    const workspaceService = createWorkspaceServiceMock();
    const sessionManager = createSessionManagerMock();
    service = new TeamSchedulerService(lockService, {
      workspaceService,
      sessionManager,
      getProviderById: createProviderLookup(),
    });

    const invocations = await service.startNextSessions(teamRun.id);

    expect(workspaceService.create).toHaveBeenCalledWith(task.id);
    expect(sessionManager.create).toHaveBeenCalledWith(
      invocations[0]!.workspaceId,
      AgentType.CODEX,
      'Role 1\n\nTask:\nImplement the shared work',
      'DEFAULT',
      members[0]!.providerId
    );
    expect(sessionManager.start).toHaveBeenCalledWith(invocations[0]!.sessionId);
    expect(sessionManager.startFollowUp).not.toHaveBeenCalled();
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      teamRunId: teamRun.id,
      workRequestId: request.id,
      memberId: members[0]!.id,
      workspaceId: expect.any(String),
      sessionId: expect.any(String),
      status: 'RUNNING',
    });
    await expect(prisma.workRequest.findUnique({ where: { id: request.id } })).resolves.toMatchObject({
      status: 'STARTED',
    });
    await expect(prisma.session.findUnique({ where: { id: invocations[0]!.sessionId! } })).resolves.toMatchObject({
      workspaceId: invocations[0]!.workspaceId,
      providerId: members[0]!.providerId,
      status: 'RUNNING',
    });
  });

  it('starts resume_last members with executor resume context while keeping a new Tower session and invocation', async () => {
    const { workspace, teamRun, members } = await createTeamRunFixture({
      sessionPolicies: ['resume_last'],
    });
    const previousRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'STARTED',
      instruction: 'Previous work',
    });
    const previousSession = await prisma.session.create({
      data: {
        workspaceId: workspace!.id,
        agentType: AgentType.CODEX,
        providerId: members[0]!.providerId,
        prompt: 'previous prompt',
        status: 'COMPLETED',
        logSnapshot: JSON.stringify({ sessionId: 'agent-native-session-1', entries: [] }),
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)),
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)),
      },
    });
    await prisma.agentInvocation.create({
      data: {
        teamRunId: teamRun.id,
        workRequestId: previousRequest.id,
        memberId: members[0]!.id,
        workspaceId: workspace!.id,
        sessionId: previousSession.id,
        status: 'COMPLETED',
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)),
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)),
      },
    });
    const nextRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      instruction: 'Continue with context',
    });
    const sessionManager = createSessionManagerMock();
    service = new TeamSchedulerService(lockService, {
      workspaceService: createWorkspaceServiceMock(),
      sessionManager,
      getProviderById: createProviderLookup(),
    });

    const invocations = await service.startNextSessions(teamRun.id);

    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      workRequestId: nextRequest.id,
      memberId: members[0]!.id,
      sessionId: expect.any(String),
      status: 'RUNNING',
    });
    expect(invocations[0]!.sessionId).not.toBe(previousSession.id);
    expect(sessionManager.create).toHaveBeenCalledWith(
      workspace!.id,
      AgentType.CODEX,
      'Role 1\n\nTask:\nContinue with context',
      'DEFAULT',
      members[0]!.providerId
    );
    expect(sessionManager.startFollowUp).toHaveBeenCalledWith(invocations[0]!.sessionId, previousSession.id);
    expect(sessionManager.start).not.toHaveBeenCalled();
    await expect(prisma.session.findUnique({ where: { id: invocations[0]!.sessionId! } })).resolves.toMatchObject({
      workspaceId: workspace!.id,
      providerId: members[0]!.providerId,
      prompt: 'Role 1\n\nTask:\nContinue with context',
      status: 'RUNNING',
    });
  });

  it('falls back to a normal session start for resume_last members without previous native context', async () => {
    const { teamRun, members } = await createTeamRunFixture({
      sessionPolicies: ['resume_last'],
    });
    await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      instruction: 'Fresh work',
    });
    const sessionManager = createSessionManagerMock();
    service = new TeamSchedulerService(lockService, {
      workspaceService: createWorkspaceServiceMock(),
      sessionManager,
      getProviderById: createProviderLookup(),
    });

    const invocations = await service.startNextSessions(teamRun.id);

    expect(invocations).toHaveLength(1);
    expect(sessionManager.start).toHaveBeenCalledWith(invocations[0]!.sessionId);
    expect(sessionManager.startFollowUp).not.toHaveBeenCalled();
  });

  it('stops member work by cancelling no-session active work, queued requests, and releasing locks', async () => {
    const { task, workspace, teamRun, members } = await createTeamRunFixture({
      memberCapabilities: [writeCapabilities, writeCapabilities],
    });
    const activeRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'STARTED',
    });
    const activeInvocation = await prisma.agentInvocation.create({
      data: {
        teamRunId: teamRun.id,
        workRequestId: activeRequest.id,
        memberId: members[0]!.id,
        workspaceId: workspace!.id,
        sessionId: null,
        status: 'QUEUED',
      },
    });
    expect(lockService.acquire(activeInvocation.id, [`workspace:task:${task.id}:write`])).toBe(true);
    const pending = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'PENDING_APPROVAL',
    });
    const queued = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'QUEUED',
    });
    const otherMemberQueued = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[1]!.id,
      status: 'QUEUED',
    });
    service = new TeamSchedulerService(lockService, {
      workspaceService: createWorkspaceServiceMock(),
      sessionManager: createSessionManagerMock(),
      getProviderById: createProviderLookup(),
    });

    const result = await service.stopMemberWork(teamRun.id, members[0]!.id, { cancelQueued: true });

    expect(result.stoppedSessionIds).toEqual([]);
    expect(result.cancelledInvocationIds).toEqual([activeInvocation.id]);
    expect(new Set(result.cancelledWorkRequestIds)).toEqual(new Set([
      activeRequest.id,
      pending.id,
      queued.id,
    ]));
    expect(result.startedInvocations).toHaveLength(1);
    expect(result.startedInvocations[0]).toMatchObject({
      workRequestId: otherMemberQueued.id,
      memberId: members[1]!.id,
      status: 'RUNNING',
    });
    expect(lockService.listLocks()).toEqual([
      { key: `workspace:task:${task.id}:write`, ownerId: result.startedInvocations[0]!.id },
    ]);
    await expect(prisma.agentInvocation.findUnique({ where: { id: activeInvocation.id } })).resolves.toMatchObject({
      status: 'CANCELLED',
      nextRoomReplyReminderAt: null,
    });
    const reloadedRequests = await prisma.workRequest.findMany({
      where: { id: { in: [activeRequest.id, pending.id, queued.id, otherMemberQueued.id] } },
      orderBy: { createdAt: 'asc' },
    });
    expect(reloadedRequests.map((request) => [request.id, request.status])).toEqual([
      [activeRequest.id, 'CANCELLED'],
      [pending.id, 'CANCELLED'],
      [queued.id, 'CANCELLED'],
      [otherMemberQueued.id, 'STARTED'],
    ]);
  });

  it('stops session-backed member work through SessionManager.stop and then starts queued work', async () => {
    const { task, workspace, teamRun, members } = await createTeamRunFixture({
      memberCapabilities: [writeCapabilities, writeCapabilities],
    });
    const activeRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'STARTED',
    });
    const session = await prisma.session.create({
      data: {
        workspaceId: workspace!.id,
        agentType: AgentType.CODEX,
        providerId: members[0]!.providerId,
        prompt: 'Do active work',
        status: 'RUNNING',
      },
    });
    const activeInvocation = await prisma.agentInvocation.create({
      data: {
        teamRunId: teamRun.id,
        workRequestId: activeRequest.id,
        memberId: members[0]!.id,
        workspaceId: workspace!.id,
        sessionId: session.id,
        status: 'WAITING_ROOM_REPLY',
        roomReplyReminderCount: 1,
        nextRoomReplyReminderAt: new Date(Date.UTC(2026, 0, 1, 0, 1, 0)),
      },
    });
    expect(lockService.acquire(activeInvocation.id, [`workspace:task:${task.id}:write`])).toBe(true);
    const nextRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[1]!.id,
      status: 'QUEUED',
    });
    const sessionManager = createSessionManagerMock();
    sessionManager.stop.mockImplementation(async (sessionId: string) => {
      await prisma.agentInvocation.update({
        where: { id: activeInvocation.id },
        data: {
          status: 'CANCELLED',
          nextRoomReplyReminderAt: null,
        },
      });
      lockService.releaseByOwner(activeInvocation.id);
      return prisma.session.update({
        where: { id: sessionId },
        data: { status: 'CANCELLED' },
      });
    });
    service = new TeamSchedulerService(lockService, {
      workspaceService: createWorkspaceServiceMock(),
      sessionManager,
      getProviderById: createProviderLookup(),
    });

    const result = await service.stopMemberWork(teamRun.id, members[0]!.id);

    expect(sessionManager.stop).toHaveBeenCalledWith(session.id);
    expect(result.stoppedSessionIds).toEqual([session.id]);
    expect(result.cancelledInvocationIds).toEqual([]);
    expect(result.cancelledWorkRequestIds).toEqual([]);
    expect(result.startedInvocations).toHaveLength(1);
    expect(result.startedInvocations[0]).toMatchObject({
      workRequestId: nextRequest.id,
      memberId: members[1]!.id,
      status: 'RUNNING',
    });
    await expect(prisma.session.findUnique({ where: { id: session.id } })).resolves.toMatchObject({
      status: 'CANCELLED',
    });
    await expect(prisma.agentInvocation.findUnique({ where: { id: activeInvocation.id } })).resolves.toMatchObject({
      status: 'CANCELLED',
      nextRoomReplyReminderAt: null,
    });
    expect(lockService.listLocks()).toEqual([
      { key: `workspace:task:${task.id}:write`, ownerId: result.startedInvocations[0]!.id },
    ]);
  });

  it('does not start queued work when stopping a member with no active invocation and no queue cancellation', async () => {
    const { teamRun, members } = await createTeamRunFixture({
      memberCapabilities: [readOnlyCapabilities, readOnlyCapabilities],
    });
    const otherMemberQueued = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[1]!.id,
      status: 'QUEUED',
    });
    service = new TeamSchedulerService(lockService, {
      workspaceService: createWorkspaceServiceMock(),
      sessionManager: createSessionManagerMock(),
      getProviderById: createProviderLookup(),
    });

    const result = await service.stopMemberWork(teamRun.id, members[0]!.id);

    expect(result).toEqual({
      stoppedSessionIds: [],
      cancelledInvocationIds: [],
      cancelledWorkRequestIds: [],
      startedInvocations: [],
    });
    await expect(prisma.workRequest.findUnique({ where: { id: otherMemberQueued.id } })).resolves.toMatchObject({
      status: 'QUEUED',
    });
    await expect(prisma.agentInvocation.count({ where: { teamRunId: teamRun.id } })).resolves.toBe(0);
    expect(lockService.listLocks()).toEqual([]);
  });

  it('starts none-policy members in the shared workspace without workspace write or command locks', async () => {
    const { workspace, teamRun, members } = await createTeamRunFixture({
      memberCapabilities: [commandCapabilities, readOnlyCapabilities],
      workspacePolicies: ['none', 'shared'],
    });
    const noneRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
    });
    await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[1]!.id,
    });
    const sessionManager = createSessionManagerMock();
    service = new TeamSchedulerService(lockService, {
      workspaceService: createWorkspaceServiceMock(),
      sessionManager,
      getProviderById: createProviderLookup(),
    });

    const invocations = await service.startNextSessions(teamRun.id);

    expect(invocations).toHaveLength(2);
    expect(invocations.map((invocation) => invocation.workspaceId)).toEqual([workspace!.id, workspace!.id]);
    expect(lockService.listLocks()).toEqual([]);

    const sameMemberRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
    });
    await expect(service.startNextSessions(teamRun.id)).resolves.toEqual([]);
    await expect(prisma.workRequest.findUnique({ where: { id: noneRequest.id } })).resolves.toMatchObject({
      status: 'STARTED',
    });
    await expect(prisma.workRequest.findUnique({ where: { id: sameMemberRequest.id } })).resolves.toMatchObject({
      status: 'QUEUED',
    });
  });

  it('keeps shared writer locks on the stable task key after creating a real workspace', async () => {
    const { task, teamRun, members } = await createTeamRunFixture({
      memberCapabilities: [writeCapabilities, writeCapabilities],
      withWorkspace: false,
    });
    const first = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
    });
    const second = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[1]!.id,
    });
    service = new TeamSchedulerService(lockService, {
      workspaceService: createWorkspaceServiceMock(),
      sessionManager: createSessionManagerMock(),
      getProviderById: createProviderLookup(),
    });

    const invocations = await service.startNextSessions(teamRun.id);

    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      workRequestId: first.id,
      workspaceId: expect.any(String),
      status: 'RUNNING',
    });
    expect(lockService.listLocks()).toEqual([
      { key: `workspace:task:${task.id}:write`, ownerId: invocations[0]!.id },
    ]);
    await expect(prisma.workspace.count({ where: { taskId: task.id, status: 'ACTIVE' } })).resolves.toBe(1);
    await expect(prisma.workRequest.findUnique({ where: { id: second.id } })).resolves.toMatchObject({
      status: 'QUEUED',
    });
    await expect(service.startNextSessions(teamRun.id)).resolves.toEqual([]);
  });

  it('deduplicates shared workspace creation across concurrent different-member session starts', async () => {
    const { task, teamRun, members } = await createTeamRunFixture({
      memberCapabilities: [readOnlyCapabilities, readOnlyCapabilities],
      withWorkspace: false,
    });
    const first = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
    });
    const second = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[1]!.id,
    });
    const creationGate = createDeferred<void>();
    let createStarted = false;
    const workspaceService = {
      create: vi.fn(async (taskId: string) => {
        createStarted = true;
        await creationGate.promise;
        return prisma.workspace.create({
          data: {
            taskId,
            branchName: 'team-shared-concurrent',
            worktreePath: path.join(testDir, 'created-workspace-concurrent'),
            status: 'ACTIVE',
          },
        });
      }),
    };
    const sessionManager = createSessionManagerMock();
    const firstService = new TeamSchedulerService(lockService, {
      workspaceService,
      sessionManager,
      getProviderById: createProviderLookup(),
    });
    const secondService = new TeamSchedulerService(lockService, {
      workspaceService,
      sessionManager,
      getProviderById: createProviderLookup(),
    });

    const firstStart = firstService.startNextSessions(teamRun.id);
    await waitForCondition(() => createStarted);
    const secondStart = secondService.startNextSessions(teamRun.id);

    creationGate.resolve();

    const started = (await Promise.all([firstStart, secondStart])).flat();

    expect(started).toHaveLength(2);
    expect(new Set(started.map((invocation) => invocation.workRequestId))).toEqual(new Set([first.id, second.id]));
    const workspaceIds = started.map((invocation) => invocation.workspaceId);
    expect(new Set(workspaceIds).size).toBe(1);
    expect(workspaceIds[0]).toEqual(expect.any(String));
    expect(workspaceService.create).toHaveBeenCalledTimes(1);
    await expect(prisma.workspace.count({ where: { taskId: task.id, status: 'ACTIVE' } })).resolves.toBe(1);
    const sessions = await prisma.session.findMany({
      where: { id: { in: started.map((invocation) => invocation.sessionId!) } },
      orderBy: { createdAt: 'asc' },
    });
    expect(sessions).toHaveLength(2);
    expect(new Set(sessions.map((session) => session.workspaceId))).toEqual(new Set([workspaceIds[0]!]));
    expect(lockService.listLocks()).toEqual([]);
  });

  it('fails clearly and leaves no session or lock when a provider is missing', async () => {
    const { teamRun, members } = await createTeamRunFixture({
      memberCapabilities: [writeCapabilities],
      withWorkspace: false,
    });
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
    });
    const workspaceService = createWorkspaceServiceMock();
    const sessionManager = createSessionManagerMock();
    service = new TeamSchedulerService(lockService, {
      workspaceService,
      sessionManager,
      getProviderById: vi.fn(() => null),
    });

    await expect(service.startNextSessions(teamRun.id)).rejects.toMatchObject({
      code: 'PROVIDER_NOT_FOUND',
      message: `Provider not found: ${members[0]!.providerId}`,
    });

    expect(workspaceService.create).not.toHaveBeenCalled();
    expect(sessionManager.create).not.toHaveBeenCalled();
    expect(lockService.listLocks()).toEqual([]);
    await expect(prisma.session.count()).resolves.toBe(0);
    await expect(prisma.agentInvocation.count()).resolves.toBe(0);
    await expect(prisma.workRequest.findUnique({ where: { id: request.id } })).resolves.toMatchObject({
      status: 'QUEUED',
    });
  });

  it('marks invocation and session failed and releases locks when session start fails', async () => {
    const { teamRun, members } = await createTeamRunFixture({
      memberCapabilities: [writeCapabilities],
      withWorkspace: false,
    });
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
    });
    service = new TeamSchedulerService(lockService, {
      workspaceService: createWorkspaceServiceMock(),
      sessionManager: createSessionManagerMock({ failStart: true }),
      getProviderById: createProviderLookup(),
    });

    await expect(service.startNextSessions(teamRun.id)).rejects.toThrow('session start failed');

    expect(lockService.listLocks()).toEqual([]);
    const invocation = await prisma.agentInvocation.findFirstOrThrow({
      where: { workRequestId: request.id },
    });
    expect(invocation).toMatchObject({
      status: 'FAILED',
      workspaceId: expect.any(String),
      sessionId: expect.any(String),
    });
    await expect(prisma.session.findUnique({ where: { id: invocation.sessionId! } })).resolves.toMatchObject({
      status: 'FAILED',
    });
    await expect(prisma.workRequest.findUnique({ where: { id: request.id } })).resolves.toMatchObject({
      status: 'STARTED',
    });
    await expect(service.startNextSessions(teamRun.id)).resolves.toEqual([]);
    await expect(prisma.agentInvocation.count({ where: { workRequestId: request.id } })).resolves.toBe(1);
  });
});
