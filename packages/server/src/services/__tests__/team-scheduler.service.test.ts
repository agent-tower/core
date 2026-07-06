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
  TeamMemberQueueManagementPolicy,
  WorkspacePolicy,
  WorkRequestStatus,
} from '@agent-tower/shared';
import { AgentType, TaskStatus } from '../../types/index.js';
import { TEAM_ROOM_SYSTEM_SHARED_PROTOCOL } from '../../prompts/team-room-system-shared-protocol.js';
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

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function initGitRepo(repoPath: string): string {
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init']);
  git(repoPath, ['checkout', '-B', 'main']);
  git(repoPath, ['config', 'user.email', 'test@example.com']);
  git(repoPath, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# test\n');
  git(repoPath, ['add', 'README.md']);
  git(repoPath, ['commit', '-m', 'initial commit']);
  return git(repoPath, ['rev-parse', 'HEAD']).trim();
}

async function createTask(title = 'Team scheduler task', status = TaskStatus.TODO) {
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
      status,
    },
  });

  return { project, task };
}

async function createTeamRunFixture(options: {
  memberCapabilities?: TeamMemberCapabilities[];
  queueManagementPolicies?: TeamMemberQueueManagementPolicy[];
  workspacePolicies?: WorkspacePolicy[];
  sessionPolicies?: Array<'new_per_request' | 'resume_last'>;
  withWorkspace?: boolean;
  taskStatus?: TaskStatus;
} = {}) {
  const { project, task } = await createTask('Team scheduler task', options.taskStatus);
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
        queueManagementPolicy: options.queueManagementPolicies?.[index] ?? 'own_only',
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
  triggerMessageId?: string;
  target?: {
    targetKind: 'WORKSPACE_COMMIT';
    targetPurpose: 'REVIEW' | 'TEST';
    targetSourceWorkspaceId: string;
    targetSourceMemberId?: string | null;
    targetHeadSha: string;
    targetBranchName: string;
    targetPlanItemId?: string | null;
  };
}) {
  return prisma.workRequest.create({
    data: {
      teamRunId: options.teamRunId,
      requesterMemberId: null,
      requesterType: 'user',
      targetMemberId: options.targetMemberId,
      ...(options.target ?? {}),
      triggerMessageId: options.triggerMessageId ?? `message-${Math.random().toString(16).slice(2)}`,
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

function buildExpectedSessionPrompt(rolePrompt: string, instruction: string): string {
  return `${TEAM_ROOM_SYSTEM_SHARED_PROTOCOL}\n\n${rolePrompt}\n\nTask:\n${instruction}`;
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

  it('enforces requester member scope when approving WorkRequests', async () => {
    const { teamRun, members } = await createTeamRunFixture({
      memberCapabilities: [readOnlyCapabilities, readOnlyCapabilities, readOnlyCapabilities],
      queueManagementPolicies: ['own_only', 'team_pending', 'own_only'],
    });
    const ownRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'PENDING_APPROVAL',
    });
    const managerRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[2]!.id,
      status: 'PENDING_APPROVAL',
    });
    const forbiddenRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[2]!.id,
      status: 'PENDING_APPROVAL',
    });

    await expect(service.approveWorkRequest(ownRequest.id, {
      teamRunId: teamRun.id,
      requesterMemberId: members[0]!.id,
    })).resolves.toMatchObject({ status: 'QUEUED' });

    await expect(service.approveWorkRequest(managerRequest.id, {
      teamRunId: teamRun.id,
      requesterMemberId: members[1]!.id,
    })).resolves.toMatchObject({ status: 'QUEUED' });

    await expect(service.approveWorkRequest(forbiddenRequest.id, {
      teamRunId: teamRun.id,
      requesterMemberId: members[0]!.id,
    })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
    });
    await expect(prisma.workRequest.findUnique({ where: { id: forbiddenRequest.id } })).resolves.toMatchObject({
      status: 'PENDING_APPROVAL',
    });
  });

  it('does not approve a WorkRequest outside the scoped TeamRun', async () => {
    const first = await createTeamRunFixture();
    const second = await createTeamRunFixture();
    const request = await createWorkRequest({
      teamRunId: second.teamRun.id,
      targetMemberId: second.members[0]!.id,
      status: 'PENDING_APPROVAL',
    });

    await expect(service.approveWorkRequest(request.id, {
      teamRunId: first.teamRun.id,
      requesterMemberId: first.members[0]!.id,
    })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
    await expect(prisma.workRequest.findUnique({ where: { id: request.id } })).resolves.toMatchObject({
      status: 'PENDING_APPROVAL',
    });
  });

  it('enforces requester member scope when rejecting WorkRequests', async () => {
    const { teamRun, members } = await createTeamRunFixture({
      memberCapabilities: [readOnlyCapabilities, readOnlyCapabilities, readOnlyCapabilities],
      queueManagementPolicies: ['own_only', 'team_pending', 'own_only'],
    });
    const ownRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'PENDING_APPROVAL',
    });
    const managerRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[2]!.id,
      status: 'PENDING_APPROVAL',
    });
    const forbiddenRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[2]!.id,
      status: 'PENDING_APPROVAL',
    });

    await expect(service.rejectWorkRequest(ownRequest.id, {
      teamRunId: teamRun.id,
      requesterMemberId: members[0]!.id,
    })).resolves.toMatchObject({ status: 'REJECTED' });

    await expect(service.rejectWorkRequest(managerRequest.id, {
      teamRunId: teamRun.id,
      requesterMemberId: members[1]!.id,
    })).resolves.toMatchObject({ status: 'REJECTED' });

    await expect(service.rejectWorkRequest(forbiddenRequest.id, {
      teamRunId: teamRun.id,
      requesterMemberId: members[0]!.id,
    })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
    });
    await expect(prisma.workRequest.findUnique({ where: { id: forbiddenRequest.id } })).resolves.toMatchObject({
      status: 'PENDING_APPROVAL',
    });
  });

  it('does not start queued work for a deleted task', async () => {
    const { task, teamRun, members } = await createTeamRunFixture({ withWorkspace: false });
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'QUEUED',
    });
    await prisma.task.update({
      where: { id: task.id },
      data: { deletedAt: new Date() },
    });
    const workspaceService = createWorkspaceServiceMock();
    const sessionManager = createSessionManagerMock();
    service = new TeamSchedulerService(lockService, {
      workspaceService,
      sessionManager,
      getProviderById: createProviderLookup(),
    });

    await expect(service.planNext(teamRun.id)).resolves.toEqual([]);
    await expect(service.startNextSessions(teamRun.id)).resolves.toEqual([]);

    expect(workspaceService.create).not.toHaveBeenCalled();
    expect(sessionManager.create).not.toHaveBeenCalled();
    expect(lockService.listLocks()).toEqual([]);
    await expect(prisma.workRequest.findUnique({ where: { id: request.id } })).resolves.toMatchObject({
      status: 'QUEUED',
    });
    await expect(prisma.workspace.count({ where: { taskId: task.id } })).resolves.toBe(0);
    await expect(prisma.session.count()).resolves.toBe(0);
    await expect(prisma.agentInvocation.count({ where: { teamRunId: teamRun.id } })).resolves.toBe(0);
  });

  it('does not start queued work for removed TeamRun members', async () => {
    const { teamRun, members } = await createTeamRunFixture({ withWorkspace: false });
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'QUEUED',
    });
    await prisma.teamMember.update({
      where: { id: members[0]!.id },
      data: { membershipStatus: 'REMOVED' },
    });
    const workspaceService = createWorkspaceServiceMock();
    const sessionManager = createSessionManagerMock();
    service = new TeamSchedulerService(lockService, {
      workspaceService,
      sessionManager,
      getProviderById: createProviderLookup(),
    });

    await expect(service.planNext(teamRun.id)).resolves.toEqual([
      expect.objectContaining({
        workRequestId: request.id,
        memberId: members[0]!.id,
        canStart: false,
        blockedReason: 'member_not_found',
      }),
    ]);
    await expect(service.startNextSessions(teamRun.id)).resolves.toEqual([]);

    expect(workspaceService.create).not.toHaveBeenCalled();
    expect(sessionManager.create).not.toHaveBeenCalled();
    await expect(prisma.workRequest.findUnique({ where: { id: request.id } })).resolves.toMatchObject({
      status: 'QUEUED',
    });
    await expect(prisma.agentInvocation.count({ where: { teamRunId: teamRun.id } })).resolves.toBe(0);
  });

  it('rejects approving a WorkRequest for a deleted task', async () => {
    const { task, teamRun, members } = await createTeamRunFixture();
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'PENDING_APPROVAL',
    });
    await prisma.task.update({
      where: { id: task.id },
      data: { deletedAt: new Date() },
    });

    await expect(service.approveWorkRequestAndStartNext(request.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
    await expect(prisma.workRequest.findUnique({ where: { id: request.id } })).resolves.toMatchObject({
      status: 'PENDING_APPROVAL',
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

  it('rejects TeamRun WorkRequest cancellation without member scope', async () => {
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

    await expect(service.cancelWorkRequest(pending.id, undefined as any)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
    });
    await expect(service.cancelWorkRequest(queued.id, {} as any)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
    });
    await expect(prisma.workRequest.findMany({ where: { id: { in: [pending.id, queued.id] } } })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: pending.id, status: 'PENDING_APPROVAL' }),
        expect.objectContaining({ id: queued.id, status: 'QUEUED' }),
      ])
    );
  });

  it('allows a member to cancel their own pending or queued WorkRequest', async () => {
    const { teamRun, members } = await createTeamRunFixture();
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'QUEUED',
    });

    await expect(service.cancelWorkRequest(request.id, {
      teamRunId: teamRun.id,
      requesterMemberId: members[0]!.id,
    })).resolves.toMatchObject({ status: 'CANCELLED' });
  });

  it('allows members with team_pending queueManagementPolicy to cancel TeamRun queue requests for others', async () => {
    const { teamRun, members } = await createTeamRunFixture({
      memberCapabilities: [readOnlyCapabilities, readOnlyCapabilities],
      queueManagementPolicies: ['team_pending', 'own_only'],
    });
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[1]!.id,
      status: 'PENDING_APPROVAL',
    });

    await expect(service.cancelWorkRequest(request.id, {
      teamRunId: teamRun.id,
      requesterMemberId: members[0]!.id,
    })).resolves.toMatchObject({ status: 'CANCELLED' });
  });

  it('does not use stopMemberWork capability as queue cancellation permission', async () => {
    const { teamRun, members } = await createTeamRunFixture({
      memberCapabilities: [
        { ...readOnlyCapabilities, stopMemberWork: true },
        readOnlyCapabilities,
      ],
      queueManagementPolicies: ['own_only', 'own_only'],
    });
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[1]!.id,
      status: 'QUEUED',
    });

    await expect(service.cancelWorkRequest(request.id, {
      teamRunId: teamRun.id,
      requesterMemberId: members[0]!.id,
    })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
    });
    await expect(prisma.workRequest.findUnique({ where: { id: request.id } })).resolves.toMatchObject({
      status: 'QUEUED',
    });
  });

  it('rejects restricted cancellation for another member without queue management capability', async () => {
    const { teamRun, members } = await createTeamRunFixture({
      memberCapabilities: [readOnlyCapabilities, readOnlyCapabilities],
    });
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[1]!.id,
      status: 'QUEUED',
    });

    await expect(service.cancelWorkRequest(request.id, {
      teamRunId: teamRun.id,
      requesterMemberId: members[0]!.id,
    })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
    });
    await expect(prisma.workRequest.findUnique({ where: { id: request.id } })).resolves.toMatchObject({
      status: 'QUEUED',
    });
  });

  it('does not cancel a WorkRequest outside the bound TeamRun', async () => {
    const first = await createTeamRunFixture();
    const second = await createTeamRunFixture();
    const request = await createWorkRequest({
      teamRunId: second.teamRun.id,
      targetMemberId: second.members[0]!.id,
      status: 'QUEUED',
    });

    await expect(service.cancelWorkRequest(request.id, {
      teamRunId: first.teamRun.id,
      requesterMemberId: first.members[0]!.id,
    })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
    await expect(prisma.workRequest.findUnique({ where: { id: request.id } })).resolves.toMatchObject({
      status: 'QUEUED',
    });
  });

  it('requires requester member identity for TeamRun-scoped cancellation', async () => {
    const { teamRun, members } = await createTeamRunFixture();
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'QUEUED',
    });

    await expect(service.cancelWorkRequest(request.id, {
      teamRunId: teamRun.id,
    } as any)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
    });
    await expect(prisma.workRequest.findUnique({ where: { id: request.id } })).resolves.toMatchObject({
      status: 'QUEUED',
    });
  });

  it('does not cancel a started WorkRequest', async () => {
    const { teamRun, members } = await createTeamRunFixture();
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'STARTED',
    });

    await expect(service.cancelWorkRequest(request.id, {
      teamRunId: teamRun.id,
      requesterMemberId: members[0]!.id,
    })).rejects.toMatchObject({
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

    await expect(service.cancelWorkRequest(request.id, {
      teamRunId: teamRun.id,
      requesterMemberId: members[0]!.id,
    })).rejects.toMatchObject({
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

  it('starts dedicated members in child workspaces without shared workspace locks', async () => {
    const { workspace: mainWorkspace, teamRun, members } = await createTeamRunFixture({
      memberCapabilities: [writeCapabilities, writeCapabilities],
      workspacePolicies: ['dedicated', 'dedicated'],
    });
    const first = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
    });
    const second = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[1]!.id,
    });
    const childByMemberId = new Map<string, { id: string }>();
    const workspaceService = {
      create: vi.fn(),
      getOrCreateMainWorkspace: vi.fn(async () => mainWorkspace!),
      getOrCreateDedicatedWorkspace: vi.fn(async (_teamRunId: string, memberId: string) => {
        const existing = childByMemberId.get(memberId);
        if (existing) {
          return existing;
        }

        const workspace = await prisma.workspace.create({
          data: {
            taskId: teamRun.taskId,
            parentWorkspaceId: mainWorkspace!.id,
            ownerMemberId: memberId,
            branchName: `dedicated-${memberId.slice(0, 8)}`,
            worktreePath: path.join(testDir, `dedicated-${memberId}`),
            status: 'ACTIVE',
          },
        });
        childByMemberId.set(memberId, workspace);
        return workspace;
      }),
    };
    service = new TeamSchedulerService(lockService, {
      workspaceService,
      sessionManager: createSessionManagerMock(),
      getProviderById: createProviderLookup(),
    });

    await expect(service.planNext(teamRun.id)).resolves.toEqual([
      expect.objectContaining({
        workRequestId: first.id,
        canStart: true,
        lockKeys: [],
        workspaceId: null,
      }),
      expect.objectContaining({
        workRequestId: second.id,
        canStart: true,
        lockKeys: [],
        workspaceId: null,
      }),
    ]);

    const invocations = await service.startNextSessions(teamRun.id);

    expect(invocations).toHaveLength(2);
    expect(new Set(invocations.map((invocation) => invocation.workspaceId)).size).toBe(2);
    expect(new Set(invocations.map((invocation) => invocation.workRequestId))).toEqual(new Set([
      first.id,
      second.id,
    ]));
    expect(workspaceService.getOrCreateDedicatedWorkspace).toHaveBeenCalledTimes(2);
    expect(workspaceService.create).not.toHaveBeenCalled();
    expect(lockService.listLocks()).toEqual([]);
    const childWorkspaces = await prisma.workspace.findMany({
      where: { parentWorkspaceId: mainWorkspace!.id },
      orderBy: { ownerMemberId: 'asc' },
    });
    expect(childWorkspaces).toHaveLength(2);
    expect(new Set(childWorkspaces.map((workspace) => workspace.ownerMemberId))).toEqual(new Set([
      members[0]!.id,
      members[1]!.id,
    ]));
  });

  it('marks targeted review/test requests for non-dedicated members as failed', async () => {
    const { workspace: sourceWorkspace, teamRun, members } = await createTeamRunFixture({
      memberCapabilities: [commandCapabilities],
      workspacePolicies: ['shared'],
    });
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      target: {
        targetKind: 'WORKSPACE_COMMIT',
        targetPurpose: 'REVIEW',
        targetSourceWorkspaceId: sourceWorkspace!.id,
        targetHeadSha: 'a'.repeat(40),
        targetBranchName: sourceWorkspace!.branchName,
      },
    });
    const sessionManager = createSessionManagerMock();
    service = new TeamSchedulerService(lockService, {
      workspaceService: createWorkspaceServiceMock(),
      sessionManager,
      getProviderById: createProviderLookup(),
    });

    await expect(service.planNext(teamRun.id)).resolves.toEqual([
      expect.objectContaining({
        workRequestId: request.id,
        canStart: false,
        blockedReason: 'unsupported_workspace_policy',
      }),
    ]);

    const invocations = await service.startNextSessions(teamRun.id);

    expect(invocations).toEqual([]);
    expect(sessionManager.create).not.toHaveBeenCalled();
    const invocation = await prisma.agentInvocation.findFirst({ where: { workRequestId: request.id } });
    expect(invocation).toMatchObject({
      status: 'FAILED',
      targetSyncError: expect.stringContaining('workspacePolicy=dedicated'),
      targetKind: 'WORKSPACE_COMMIT',
      targetPurpose: 'REVIEW',
    });
    expect(invocation?.targetSyncError).toContain('workspacePolicy=shared');
    await expect(prisma.roomMessage.findFirst({ where: { senderInvocationId: invocation?.id ?? '' } })).resolves.toMatchObject({
      senderType: 'system',
      kind: 'system',
      content: expect.stringContaining('change this TeamMember instance to workspacePolicy=dedicated'),
      workRequestIds: JSON.stringify([request.id]),
    });
    await expect(prisma.workRequest.findUnique({ where: { id: request.id } })).resolves.toMatchObject({
      status: 'STARTED',
    });
  });

  it('syncs a targeted dedicated execution workspace to the target commit before starting', async () => {
    const repoPath = path.join(testDir, 'target-sync-success-repo');
    const targetSha = initGitRepo(repoPath);
    const { project, task } = await createTask('Target sync success task');
    await prisma.project.update({ where: { id: project.id }, data: { repoPath } });
    const teamRun = await prisma.teamRun.create({ data: { taskId: task.id, mode: 'AUTO' } });
    const mainWorkspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'main',
        baseBranch: 'main',
        worktreePath: repoPath,
        workingDir: repoPath,
        status: 'ACTIVE',
      },
    });
    await prisma.teamRun.update({ where: { id: teamRun.id }, data: { mainWorkspaceId: mainWorkspace.id } });
    const sourceWorkspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        parentWorkspaceId: mainWorkspace.id,
        ownerMemberId: null,
        branchName: 'source-delivery',
        baseBranch: 'main',
        worktreePath: repoPath,
        workingDir: repoPath,
        status: 'ACTIVE',
      },
    });
    const member = await prisma.teamMember.create({
      data: {
        teamRunId: teamRun.id,
        presetId: null,
        name: 'Tester',
        aliases: stringifyJson(['tester']),
        providerId: 'provider-1',
        rolePrompt: 'Test role',
        capabilities: stringifyJson(commandCapabilities),
        workspacePolicy: 'dedicated',
        triggerPolicy: 'MENTION_ONLY',
        sessionPolicy: 'new_per_request',
        queueManagementPolicy: 'own_only',
        avatar: null,
      },
    });
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: member.id,
      target: {
        targetKind: 'WORKSPACE_COMMIT',
        targetPurpose: 'TEST',
        targetSourceWorkspaceId: sourceWorkspace.id,
        targetHeadSha: targetSha,
        targetBranchName: sourceWorkspace.branchName,
        targetPlanItemId: 'plan-sync',
      },
    });
    const sessionManager = createSessionManagerMock();
    service = new TeamSchedulerService(lockService, {
      sessionManager,
      getProviderById: createProviderLookup(),
    });

    const invocations = await service.startNextSessions(teamRun.id);

    expect(invocations).toHaveLength(1);
    const invocation = await prisma.agentInvocation.findUniqueOrThrow({ where: { id: invocations[0]!.id } });
    expect(invocation).toMatchObject({
      workRequestId: request.id,
      targetKind: 'WORKSPACE_COMMIT',
      targetPurpose: 'TEST',
      targetSourceWorkspaceId: sourceWorkspace.id,
      targetHeadSha: targetSha,
      targetSyncStatus: 'SYNCED',
      targetSyncError: null,
      targetPlanItemId: 'plan-sync',
      targetPort: expect.any(Number),
      targetVitePort: expect.any(Number),
      targetE2EPort: expect.any(Number),
    });
    expect(invocation.targetExecutionBranch).toBe(`at/team/${teamRun.id.slice(0, 8)}/target/test-${member.id.slice(0, 8)}-${targetSha.slice(0, 12)}`);
    const executionWorkspace = await prisma.workspace.findUniqueOrThrow({ where: { id: invocation.workspaceId! } });
    expect(executionWorkspace.branchName).toBe(invocation.targetExecutionBranch);
    expect(git(executionWorkspace.worktreePath, ['rev-parse', 'HEAD']).trim()).toBe(targetSha);
    expect(sessionManager.create).toHaveBeenCalledWith(
      executionWorkspace.id,
      AgentType.CODEX,
      buildExpectedSessionPrompt(
        'Test role',
        [
          'Target sync success task',
          [
            'Target commit handoff:',
            '- purpose: TEST',
            `- sourceWorkspaceId: ${sourceWorkspace.id}`,
            `- targetHeadSha: ${targetSha}`,
            `- sourceBranch: ${sourceWorkspace.branchName}`,
            '- planItemId: plan-sync',
            '- The execution workspace is synced to targetHeadSha before this session starts.',
            '- Record review/test verdicts against sourceWorkspaceId with reviewed_sha=targetHeadSha.',
          ].join('\n'),
          'Work request summary:\nPlease do the work',
        ].join('\n\n')
      ),
      'DEFAULT',
      member.providerId
    );
  }, 15_000);

  it('fails targeted sync when the execution workspace is dirty', async () => {
    const repoPath = path.join(testDir, 'target-sync-dirty-repo');
    const targetSha = initGitRepo(repoPath);
    const { project, task } = await createTask('Target sync dirty task');
    await prisma.project.update({ where: { id: project.id }, data: { repoPath } });
    const teamRun = await prisma.teamRun.create({ data: { taskId: task.id, mode: 'AUTO' } });
    const mainWorkspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'main',
        baseBranch: 'main',
        worktreePath: repoPath,
        workingDir: repoPath,
        status: 'ACTIVE',
      },
    });
    await prisma.teamRun.update({ where: { id: teamRun.id }, data: { mainWorkspaceId: mainWorkspace.id } });
    const sourceWorkspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        parentWorkspaceId: mainWorkspace.id,
        ownerMemberId: null,
        branchName: 'source-delivery-dirty',
        baseBranch: 'main',
        worktreePath: repoPath,
        workingDir: repoPath,
        status: 'ACTIVE',
      },
    });
    const member = await prisma.teamMember.create({
      data: {
        teamRunId: teamRun.id,
        presetId: null,
        name: 'Reviewer',
        aliases: stringifyJson(['reviewer']),
        providerId: 'provider-1',
        rolePrompt: 'Review role',
        capabilities: stringifyJson(commandCapabilities),
        workspacePolicy: 'dedicated',
        triggerPolicy: 'MENTION_ONLY',
        sessionPolicy: 'new_per_request',
        queueManagementPolicy: 'own_only',
        avatar: null,
      },
    });
    const executionWorkspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        parentWorkspaceId: mainWorkspace.id,
        ownerMemberId: member.id,
        branchName: `at/team/${teamRun.id.slice(0, 8)}/member-${member.id.slice(0, 8)}`,
        baseBranch: mainWorkspace.branchName,
        worktreePath: await import('../../git/worktree.manager.js').then(async ({ WorktreeManager }) => {
          const manager = new WorktreeManager(repoPath);
          return manager.create(`at/team/${teamRun.id.slice(0, 8)}/member-${member.id.slice(0, 8)}`);
        }),
        status: 'ACTIVE',
      },
    });
    fs.writeFileSync(path.join(executionWorkspace.worktreePath, 'dirty.txt'), 'dirty');
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: member.id,
      target: {
        targetKind: 'WORKSPACE_COMMIT',
        targetPurpose: 'REVIEW',
        targetSourceWorkspaceId: sourceWorkspace.id,
        targetHeadSha: targetSha,
        targetBranchName: sourceWorkspace.branchName,
      },
    });
    const sessionManager = createSessionManagerMock();
    service = new TeamSchedulerService(lockService, {
      sessionManager,
      getProviderById: createProviderLookup(),
    });

    const invocations = await service.startNextSessions(teamRun.id);

    expect(invocations).toEqual([]);
    expect(sessionManager.create).not.toHaveBeenCalled();
    await expect(prisma.agentInvocation.findFirst({ where: { workRequestId: request.id } })).resolves.toMatchObject({
      workspaceId: executionWorkspace.id,
      status: 'FAILED',
      targetSyncStatus: 'FAILED',
      targetSyncError: expect.stringContaining('Execution workspace has uncommitted changes'),
    });
  }, 15_000);

  it('fails targeted sync when the target commit does not exist', async () => {
    const repoPath = path.join(testDir, 'target-sync-missing-sha-repo');
    initGitRepo(repoPath);
    const { project, task } = await createTask('Target sync missing sha task');
    await prisma.project.update({ where: { id: project.id }, data: { repoPath } });
    const teamRun = await prisma.teamRun.create({ data: { taskId: task.id, mode: 'AUTO' } });
    const mainWorkspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'main',
        baseBranch: 'main',
        worktreePath: repoPath,
        workingDir: repoPath,
        status: 'ACTIVE',
      },
    });
    await prisma.teamRun.update({ where: { id: teamRun.id }, data: { mainWorkspaceId: mainWorkspace.id } });
    const sourceWorkspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        parentWorkspaceId: mainWorkspace.id,
        ownerMemberId: null,
        branchName: 'source-delivery-missing',
        baseBranch: 'main',
        worktreePath: repoPath,
        workingDir: repoPath,
        status: 'ACTIVE',
      },
    });
    const member = await prisma.teamMember.create({
      data: {
        teamRunId: teamRun.id,
        presetId: null,
        name: 'Reviewer',
        aliases: stringifyJson(['reviewer']),
        providerId: 'provider-1',
        rolePrompt: 'Review role',
        capabilities: stringifyJson(commandCapabilities),
        workspacePolicy: 'dedicated',
        triggerPolicy: 'MENTION_ONLY',
        sessionPolicy: 'new_per_request',
        queueManagementPolicy: 'own_only',
        avatar: null,
      },
    });
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: member.id,
      target: {
        targetKind: 'WORKSPACE_COMMIT',
        targetPurpose: 'REVIEW',
        targetSourceWorkspaceId: sourceWorkspace.id,
        targetHeadSha: 'f'.repeat(40),
        targetBranchName: sourceWorkspace.branchName,
      },
    });
    const sessionManager = createSessionManagerMock();
    service = new TeamSchedulerService(lockService, {
      sessionManager,
      getProviderById: createProviderLookup(),
    });

    await expect(service.startNextSessions(teamRun.id)).resolves.toEqual([]);

    expect(sessionManager.create).not.toHaveBeenCalled();
    await expect(prisma.agentInvocation.findFirst({ where: { workRequestId: request.id } })).resolves.toMatchObject({
      status: 'FAILED',
      targetSyncStatus: 'FAILED',
      targetSyncError: expect.stringContaining('git cat-file -e'),
    });
  }, 15_000);

  it('records the dedicated child workspace for queued no-session invocations', async () => {
    const { workspace: mainWorkspace, teamRun, members } = await createTeamRunFixture({
      memberCapabilities: [writeCapabilities],
      workspacePolicies: ['dedicated'],
    });
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
    });
    const childWorkspace = await prisma.workspace.create({
      data: {
        taskId: teamRun.taskId,
        parentWorkspaceId: mainWorkspace!.id,
        ownerMemberId: members[0]!.id,
        branchName: 'dedicated-queued',
        worktreePath: path.join(testDir, 'dedicated-queued'),
        status: 'ACTIVE',
      },
    });
    const workspaceService = {
      create: vi.fn(),
      getOrCreateMainWorkspace: vi.fn(async () => mainWorkspace!),
      getOrCreateDedicatedWorkspace: vi.fn(async () => childWorkspace),
    };
    service = new TeamSchedulerService(lockService, {
      workspaceService,
      sessionManager: createSessionManagerMock(),
      getProviderById: createProviderLookup(),
    });

    const invocations = await service.startNext(teamRun.id);

    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      workRequestId: request.id,
      memberId: members[0]!.id,
      workspaceId: childWorkspace.id,
      sessionId: null,
      status: 'QUEUED',
    });
    expect(lockService.listLocks()).toEqual([]);
    expect(workspaceService.getOrCreateDedicatedWorkspace).toHaveBeenCalledWith(teamRun.id, members[0]!.id);
    await expect(prisma.agentInvocation.findUnique({ where: { id: invocations[0]!.id } })).resolves.toMatchObject({
      workspaceId: childWorkspace.id,
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
      buildExpectedSessionPrompt('Role 1', 'Team scheduler task\n\nWork request summary:\nImplement the shared work'),
      'DEFAULT',
      members[0]!.providerId
    );
    const prompt = sessionManager.create.mock.calls[0]?.[2] ?? '';
    expect(prompt.indexOf(TEAM_ROOM_SYSTEM_SHARED_PROTOCOL)).toBe(0);
    expect(prompt.indexOf('\n\nRole 1\n\nTask:\n')).toBe(TEAM_ROOM_SYSTEM_SHARED_PROTOCOL.length);
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

  it('builds session prompt attachment context from the trigger RoomMessage attachmentIds', async () => {
    const { task, teamRun, members } = await createTeamRunFixture({ withWorkspace: false });
    const attachment = await prisma.attachment.create({
      data: {
        originalName: 'reference.png',
        mimeType: 'image/png',
        sizeBytes: 256,
        storagePath: path.join(testDir, 'reference.png'),
        hash: 'scheduler-attachment-context-hash',
      },
    });
    const message = await prisma.roomMessage.create({
      data: {
        teamRunId: teamRun.id,
        senderType: 'user',
        kind: 'work_request',
        content: 'Use this reference',
        mentions: stringifyJson([{ memberId: members[0]!.id, label: 'Member 1' }]),
        workRequestIds: stringifyJson([]),
        artifactRefs: stringifyJson([]),
        attachmentIds: stringifyJson([attachment.id]),
      },
    });
    await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      instruction: 'Use this reference',
      triggerMessageId: message.id,
    });
    const workspaceService = createWorkspaceServiceMock();
    const sessionManager = createSessionManagerMock();
    service = new TeamSchedulerService(lockService, {
      workspaceService,
      sessionManager,
      getProviderById: createProviderLookup(),
    });

    await service.startNextSessions(teamRun.id);

    expect(workspaceService.create).toHaveBeenCalledWith(task.id);
    expect(sessionManager.create).toHaveBeenCalledWith(
      expect.any(String),
      AgentType.CODEX,
      buildExpectedSessionPrompt(
        'Role 1',
        `Team scheduler task\n\nTriggering room message:\nUse this reference\n\nAttachments:\n![reference.png](${attachment.storagePath})`
      ),
      'DEFAULT',
      members[0]!.providerId
    );
  });

  it('builds session prompt from full Task description when WorkRequest only stores a preview', async () => {
    const { task, teamRun, members } = await createTeamRunFixture({ withWorkspace: false });
    const longDescription = `Full task body\n${'diagnostic-log '.repeat(300)}`;
    await prisma.task.update({
      where: { id: task.id },
      data: {
        title: 'Short generated title',
        description: longDescription,
      },
    });
    const message = await prisma.roomMessage.create({
      data: {
        teamRunId: teamRun.id,
        senderType: 'user',
        kind: 'chat',
        content: 'Short generated title\n\nTask details preview: Full task body...',
        mentions: stringifyJson([]),
        workRequestIds: stringifyJson([]),
        artifactRefs: stringifyJson([]),
        attachmentIds: stringifyJson([]),
      },
    });
    await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      instruction: 'Short generated title\n\nFull details are stored on the task description.',
      triggerMessageId: message.id,
    });
    const sessionManager = createSessionManagerMock();
    service = new TeamSchedulerService(lockService, {
      workspaceService: createWorkspaceServiceMock(),
      sessionManager,
      getProviderById: createProviderLookup(),
    });

    await service.startNextSessions(teamRun.id);

    const prompt = sessionManager.create.mock.calls[0]?.[2] ?? '';
    expect(prompt).toContain('Short generated title');
    expect(prompt).toContain('Full task body');
    expect(prompt).toContain('diagnostic-log '.repeat(50).trim());
    expect(prompt).toContain('Work request summary:');
  });

  it('does not duplicate session prompt attachment context when the WorkRequest instruction already includes the storage path', async () => {
    const { task, teamRun, members } = await createTeamRunFixture({ withWorkspace: false });
    const attachment = await prisma.attachment.create({
      data: {
        originalName: 'reference.png',
        mimeType: 'image/png',
        sizeBytes: 256,
        storagePath: path.join(testDir, 'reference-dedup.png'),
        hash: 'scheduler-attachment-context-dedup-hash',
      },
    });
    const instruction = `Use this reference\n\n![reference.png](${attachment.storagePath})`;
    const message = await prisma.roomMessage.create({
      data: {
        teamRunId: teamRun.id,
        senderType: 'user',
        kind: 'work_request',
        content: instruction,
        mentions: stringifyJson([{ memberId: members[0]!.id, label: 'Member 1' }]),
        workRequestIds: stringifyJson([]),
        artifactRefs: stringifyJson([]),
        attachmentIds: stringifyJson([attachment.id]),
      },
    });
    await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      instruction,
      triggerMessageId: message.id,
    });
    const workspaceService = createWorkspaceServiceMock();
    const sessionManager = createSessionManagerMock();
    service = new TeamSchedulerService(lockService, {
      workspaceService,
      sessionManager,
      getProviderById: createProviderLookup(),
    });

    await service.startNextSessions(teamRun.id);

    expect(workspaceService.create).toHaveBeenCalledWith(task.id);
    expect(sessionManager.create).toHaveBeenCalledWith(
      expect.any(String),
      AgentType.CODEX,
      buildExpectedSessionPrompt(
        'Role 1',
        `Team scheduler task\n\nTriggering room message:\n${instruction}`
      ),
      'DEFAULT',
      members[0]!.providerId
    );
    expect(sessionManager.create.mock.calls[0]?.[2]).not.toContain('Attachments:');
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
      buildExpectedSessionPrompt('Role 1', 'Team scheduler task\n\nWork request summary:\nContinue with context'),
      'DEFAULT',
      members[0]!.providerId
    );
    expect(sessionManager.startFollowUp).toHaveBeenCalledWith(invocations[0]!.sessionId, previousSession.id);
    expect(sessionManager.start).not.toHaveBeenCalled();
    await expect(prisma.session.findUnique({ where: { id: invocations[0]!.sessionId! } })).resolves.toMatchObject({
      workspaceId: workspace!.id,
      providerId: members[0]!.providerId,
      prompt: buildExpectedSessionPrompt('Role 1', 'Team scheduler task\n\nWork request summary:\nContinue with context'),
      status: 'RUNNING',
    });
  });

  it('does not resume targeted requests across different targetHeadSha values', async () => {
    const { workspace, teamRun, members } = await createTeamRunFixture({
      sessionPolicies: ['resume_last'],
    });
    const previousRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'STARTED',
      target: {
        targetKind: 'WORKSPACE_COMMIT',
        targetPurpose: 'REVIEW',
        targetSourceWorkspaceId: workspace!.id,
        targetHeadSha: '1'.repeat(40),
        targetBranchName: workspace!.branchName,
      },
    });
    const previousSession = await prisma.session.create({
      data: {
        workspaceId: workspace!.id,
        agentType: AgentType.CODEX,
        providerId: members[0]!.providerId,
        prompt: 'previous prompt',
        status: 'COMPLETED',
        logSnapshot: JSON.stringify({ sessionId: 'agent-native-session-previous-target', entries: [] }),
      },
    });
    await prisma.agentInvocation.create({
      data: {
        teamRunId: teamRun.id,
        workRequestId: previousRequest.id,
        memberId: members[0]!.id,
        workspaceId: workspace!.id,
        sessionId: previousSession.id,
        targetKind: 'WORKSPACE_COMMIT',
        targetPurpose: 'REVIEW',
        targetSourceWorkspaceId: workspace!.id,
        targetHeadSha: '1'.repeat(40),
        targetBranchName: workspace!.branchName,
        targetSyncStatus: 'SYNCED',
        status: 'COMPLETED',
      },
    });
    const nextRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      instruction: 'Review a different target',
      target: {
        targetKind: 'WORKSPACE_COMMIT',
        targetPurpose: 'REVIEW',
        targetSourceWorkspaceId: workspace!.id,
        targetHeadSha: '2'.repeat(40),
        targetBranchName: workspace!.branchName,
      },
    });
    const sessionManager = createSessionManagerMock();
    service = new TeamSchedulerService(lockService, {
      workspaceService: {
        create: vi.fn(),
        getOrCreateDedicatedWorkspace: vi.fn(async () => workspace!),
        prepareTargetedExecutionWorkspace: vi.fn(async () => ({
          executionBranch: 'target-review-branch',
        })),
      },
      sessionManager,
      getProviderById: createProviderLookup(),
    });
    await prisma.teamMember.update({
      where: { id: members[0]!.id },
      data: { workspacePolicy: 'dedicated' },
    });

    const invocations = await service.startNextSessions(teamRun.id);

    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      workRequestId: nextRequest.id,
      targetHeadSha: '2'.repeat(40),
      targetSyncStatus: 'SYNCED',
    });
    expect(sessionManager.start).toHaveBeenCalledWith(invocations[0]!.sessionId);
    expect(sessionManager.startFollowUp).not.toHaveBeenCalled();
  });

  it('starts new_per_request members without resuming previous native context', async () => {
    const { workspace, teamRun, members } = await createTeamRunFixture({
      sessionPolicies: ['new_per_request'],
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
      },
    });
    const nextRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      instruction: 'Fresh request',
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
    expect(sessionManager.start).toHaveBeenCalledWith(invocations[0]!.sessionId);
    expect(sessionManager.startFollowUp).not.toHaveBeenCalled();
  });

  it('does not resume_last from a different member even when native context exists in the same workspace', async () => {
    const { workspace, teamRun, members } = await createTeamRunFixture({
      memberCapabilities: [readOnlyCapabilities, readOnlyCapabilities],
      sessionPolicies: ['resume_last', 'resume_last'],
    });
    const otherMemberRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[1]!.id,
      status: 'STARTED',
      instruction: 'Other member previous work',
    });
    const otherMemberSession = await prisma.session.create({
      data: {
        workspaceId: workspace!.id,
        agentType: AgentType.CODEX,
        providerId: members[1]!.providerId,
        prompt: 'other member prompt',
        status: 'COMPLETED',
        logSnapshot: JSON.stringify({ sessionId: 'agent-native-session-2', entries: [] }),
      },
    });
    await prisma.agentInvocation.create({
      data: {
        teamRunId: teamRun.id,
        workRequestId: otherMemberRequest.id,
        memberId: members[1]!.id,
        workspaceId: workspace!.id,
        sessionId: otherMemberSession.id,
        status: 'COMPLETED',
      },
    });
    const nextRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      instruction: 'Member 1 fresh work',
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
      status: 'RUNNING',
    });
    expect(sessionManager.start).toHaveBeenCalledWith(invocations[0]!.sessionId);
    expect(sessionManager.startFollowUp).not.toHaveBeenCalled();
  });

  it('resume_last only resumes native context from the same member in the selected workspace', async () => {
    const { task, workspace: selectedWorkspace, teamRun, members } = await createTeamRunFixture({
      sessionPolicies: ['resume_last'],
    });
    const otherWorkspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        parentWorkspaceId: selectedWorkspace!.id,
        branchName: 'other-workspace',
        worktreePath: path.join(testDir, 'other-workspace'),
        status: 'ACTIVE',
      },
    });
    const previousRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      status: 'STARTED',
      instruction: 'Previous work in another workspace',
    });
    const otherWorkspaceSession = await prisma.session.create({
      data: {
        workspaceId: otherWorkspace.id,
        agentType: AgentType.CODEX,
        providerId: members[0]!.providerId,
        prompt: 'previous prompt in other workspace',
        status: 'COMPLETED',
        logSnapshot: JSON.stringify({ sessionId: 'agent-native-session-other-workspace', entries: [] }),
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)),
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)),
      },
    });
    await prisma.agentInvocation.create({
      data: {
        teamRunId: teamRun.id,
        workRequestId: previousRequest.id,
        memberId: members[0]!.id,
        workspaceId: otherWorkspace.id,
        sessionId: otherWorkspaceSession.id,
        status: 'COMPLETED',
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)),
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)),
      },
    });
    const nextRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      instruction: 'Continue in selected workspace',
    });
    const sessionManager = createSessionManagerMock();
    service = new TeamSchedulerService(lockService, {
      workspaceService: createWorkspaceServiceMock(),
      sessionManager,
      getProviderById: createProviderLookup(),
    });

    const firstRun = await service.startNextSessions(teamRun.id);

    expect(firstRun).toHaveLength(1);
    expect(firstRun[0]).toMatchObject({
      workRequestId: nextRequest.id,
      workspaceId: selectedWorkspace!.id,
      status: 'RUNNING',
    });
    expect(sessionManager.start).toHaveBeenCalledWith(firstRun[0]!.sessionId);
    expect(sessionManager.startFollowUp).not.toHaveBeenCalled();

    await prisma.session.update({
      where: { id: firstRun[0]!.sessionId! },
      data: {
        status: 'COMPLETED',
        logSnapshot: JSON.stringify({ sessionId: 'agent-native-session-selected-workspace', entries: [] }),
      },
    });
    await prisma.agentInvocation.update({
      where: { id: firstRun[0]!.id },
      data: { status: 'COMPLETED' },
    });
    const followUpRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
      instruction: 'Continue again in selected workspace',
    });
    sessionManager.start.mockClear();
    sessionManager.startFollowUp.mockClear();

    const secondRun = await service.startNextSessions(teamRun.id);

    expect(secondRun).toHaveLength(1);
    expect(secondRun[0]).toMatchObject({
      workRequestId: followUpRequest.id,
      workspaceId: selectedWorkspace!.id,
      status: 'RUNNING',
    });
    expect(sessionManager.startFollowUp).toHaveBeenCalledWith(secondRun[0]!.sessionId, firstRun[0]!.sessionId);
    expect(sessionManager.start).not.toHaveBeenCalled();
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

  it('starts none-policy write and command members on the shared workspace without workspace locks', async () => {
    const { workspace, teamRun, members } = await createTeamRunFixture({
      memberCapabilities: [
        { ...writeCapabilities, runCommands: true },
        writeCapabilities,
      ],
      workspacePolicies: ['none', 'shared'],
    });
    const noneRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
    });
    const sharedRequest = await createWorkRequest({
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
    expect(new Set(invocations.map((invocation) => invocation.workRequestId))).toEqual(new Set([
      noneRequest.id,
      sharedRequest.id,
    ]));
    expect(lockService.listLocks()).toEqual([
      { key: `workspace:task:${teamRun.taskId}:write`, ownerId: invocations[1]!.id },
    ]);
  });

  it('keeps shared command locks on the stable task key after creating a real workspace', async () => {
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
      { key: `workspace:task:${task.id}:command`, ownerId: invocations[0]!.id },
    ]);
    await expect(prisma.workspace.count({ where: { taskId: task.id, status: 'ACTIVE' } })).resolves.toBe(1);
    await expect(prisma.workRequest.findUnique({ where: { id: second.id } })).resolves.toMatchObject({
      status: 'QUEUED',
    });
    await expect(service.startNextSessions(teamRun.id)).resolves.toEqual([]);
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

  it('marks a request failed and leaves no session or lock when a provider is missing', async () => {
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

    await expect(service.startNextSessions(teamRun.id)).resolves.toEqual([]);

    expect(workspaceService.create).not.toHaveBeenCalled();
    expect(sessionManager.create).not.toHaveBeenCalled();
    expect(lockService.listLocks()).toEqual([]);
    await expect(prisma.session.count()).resolves.toBe(0);
    await expect(prisma.agentInvocation.findFirst({ where: { workRequestId: request.id } })).resolves.toMatchObject({
      memberId: members[0]!.id,
      sessionId: null,
      status: 'FAILED',
    });
    await expect(prisma.workRequest.findUnique({ where: { id: request.id } })).resolves.toMatchObject({
      status: 'FAILED',
    });
    await expect(service.startNextSessions(teamRun.id)).resolves.toEqual([]);
  });

  it('advances an idle TeamRun to review when provider missing failures consume all queued work', async () => {
    const { task, teamRun, members } = await createTeamRunFixture({
      memberCapabilities: [writeCapabilities],
      withWorkspace: false,
      taskStatus: TaskStatus.IN_PROGRESS,
    });
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
    });
    service = new TeamSchedulerService(lockService, {
      workspaceService: createWorkspaceServiceMock(),
      sessionManager: createSessionManagerMock(),
      getProviderById: vi.fn(() => null),
    });

    await expect(service.startNextSessions(teamRun.id)).resolves.toEqual([]);

    await expect(prisma.workRequest.findUnique({ where: { id: request.id } })).resolves.toMatchObject({
      status: 'FAILED',
    });
    await expect(prisma.agentInvocation.findFirst({ where: { workRequestId: request.id } })).resolves.toMatchObject({
      status: 'FAILED',
      sessionId: null,
    });
    await expect(prisma.task.findUnique({ where: { id: task.id } })).resolves.toMatchObject({
      status: TaskStatus.IN_REVIEW,
    });
    await expect(prisma.teamRun.findUnique({ where: { id: teamRun.id } })).resolves.toMatchObject({
      reviewReason: 'TEAM_QUIESCENT',
    });
    expect(lockService.listLocks()).toEqual([]);
  });

  it('continues starting later queued work when an earlier request has a missing provider', async () => {
    const { teamRun, members } = await createTeamRunFixture({
      memberCapabilities: [writeCapabilities, readOnlyCapabilities],
      withWorkspace: false,
    });
    const missingProviderRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
    });
    const validProviderRequest = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[1]!.id,
    });
    const workspaceService = createWorkspaceServiceMock();
    const sessionManager = createSessionManagerMock();
    service = new TeamSchedulerService(lockService, {
      workspaceService,
      sessionManager,
      getProviderById: vi.fn((providerId: string) => (
        providerId === members[0]!.providerId
          ? null
          : {
            id: providerId,
            name: providerId,
            agentType: AgentType.CODEX,
            env: {},
            config: {},
            isDefault: false,
          }
      )),
    });

    const invocations = await service.startNextSessions(teamRun.id);

    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      workRequestId: validProviderRequest.id,
      memberId: members[1]!.id,
      status: 'RUNNING',
      sessionId: expect.any(String),
    });
    await expect(prisma.workRequest.findUnique({ where: { id: missingProviderRequest.id } })).resolves.toMatchObject({
      status: 'FAILED',
    });
    await expect(prisma.agentInvocation.findFirst({
      where: { workRequestId: missingProviderRequest.id },
    })).resolves.toMatchObject({
      memberId: members[0]!.id,
      sessionId: null,
      status: 'FAILED',
    });
    await expect(prisma.workRequest.findUnique({ where: { id: validProviderRequest.id } })).resolves.toMatchObject({
      status: 'STARTED',
    });
    expect(sessionManager.create).toHaveBeenCalledTimes(1);
    expect(lockService.listLocks()).toEqual([]);
  });

  it('marks invocation and session failed and releases locks when session start fails', async () => {
    const { task, teamRun, members } = await createTeamRunFixture({
      memberCapabilities: [writeCapabilities],
      withWorkspace: false,
      taskStatus: TaskStatus.IN_PROGRESS,
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
      status: 'FAILED',
    });
    await expect(prisma.task.findUnique({ where: { id: task.id } })).resolves.toMatchObject({
      status: TaskStatus.IN_REVIEW,
    });
    await expect(prisma.teamRun.findUnique({ where: { id: teamRun.id } })).resolves.toMatchObject({
      reviewReason: 'TEAM_QUIESCENT',
    });
    await expect(service.startNextSessions(teamRun.id)).resolves.toEqual([]);
    await expect(prisma.agentInvocation.count({ where: { workRequestId: request.id } })).resolves.toBe(1);
  });
});
