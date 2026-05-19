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
    const { teamRun, members } = await createTeamRunFixture({
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
    const { teamRun, workspace, members } = await createTeamRunFixture({
      memberCapabilities: [writeCapabilities],
    });
    const request = await createWorkRequest({
      teamRunId: teamRun.id,
      targetMemberId: members[0]!.id,
    });
    expect(lockService.acquire('external-owner', [`workspace:${workspace!.id}:write`])).toBe(true);

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
});
