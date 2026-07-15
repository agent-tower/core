import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { TeamMemberCapabilities } from '@agent-tower/shared';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-team-queue-recovery-'));
const dbPath = path.join(testDir, 'test.db');
process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, '../../..');
const schemaPath = path.join(serverRoot, 'prisma/schema.prisma');

let prisma: PrismaClient;
let AgentType: typeof import('../../types/index.js').AgentType;
let WorkspaceService: typeof import('../workspace.service.js').WorkspaceService;
let TeamSchedulerService: typeof import('../team-scheduler.service.js').TeamSchedulerService;
let TeamLockService: typeof import('../team-lock.service.js').TeamLockService;
let MemberHeartbeatScheduler: typeof import('../member-heartbeat-scheduler.js').MemberHeartbeatScheduler;

const writeCapabilities: TeamMemberCapabilities = {
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

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function initGitRepo(name: string): string {
  const repoPath = path.join(testDir, name);
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init']);
  git(repoPath, ['checkout', '-B', 'main']);
  git(repoPath, ['config', 'user.email', 'test@example.com']);
  git(repoPath, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# queue recovery\n');
  git(repoPath, ['add', 'README.md']);
  git(repoPath, ['commit', '-m', 'initial commit']);
  return repoPath;
}

async function createTeamRunFixture(options: { repoName: string; mode?: 'AUTO' | 'CONFIRM' }) {
  const repoPath = initGitRepo(options.repoName);
  const project = await prisma.project.create({
    data: {
      name: options.repoName,
      repoPath,
      mainBranch: 'main',
    },
  });
  const task = await prisma.task.create({
    data: {
      projectId: project.id,
      title: 'Queue recovery integration',
      status: 'IN_PROGRESS',
    },
  });
  const teamRun = await prisma.teamRun.create({
    data: {
      taskId: task.id,
      mode: options.mode ?? 'AUTO',
    },
  });
  const member = await prisma.teamMember.create({
    data: {
      teamRunId: teamRun.id,
      name: 'Implementation member',
      aliases: JSON.stringify(['implementer']),
      providerId: 'fake-provider',
      rolePrompt: 'Implement the assigned change.',
      capabilities: JSON.stringify(writeCapabilities),
      workspacePolicy: 'dedicated',
      triggerPolicy: 'MENTION_ONLY',
      sessionPolicy: 'new_per_request',
      queueManagementPolicy: 'own_only',
    },
  });

  return { repoPath, project, task, teamRun, member };
}

async function createQueuedWorkRequest(teamRunId: string, targetMemberId: string, suffix: string) {
  return prisma.workRequest.create({
    data: {
      teamRunId,
      requesterType: 'user',
      targetMemberId,
      triggerMessageId: `message-${suffix}`,
      instruction: `Run integration request ${suffix}`,
      status: 'QUEUED',
    },
  });
}

function createFakeSessionManager(options: { failFirstStart?: boolean } = {}) {
  let startAttempts = 0;
  const activeProcesses = new Set<string>();
  const manager = {
    create: vi.fn(async (
      workspaceId: string,
      agentType: string,
      prompt: string,
      variant = 'DEFAULT',
      providerId?: string,
    ) => prisma.session.create({
      data: {
        workspaceId,
        agentType,
        prompt,
        variant,
        providerId: providerId ?? null,
        status: 'PENDING',
      },
    })),
    start: vi.fn(async (sessionId: string) => {
      startAttempts += 1;
      if (options.failFirstStart && startAttempts === 1) {
        throw new Error('transient fake executor start failure');
      }
      activeProcesses.add(sessionId);
      return prisma.session.update({
        where: { id: sessionId },
        data: { status: 'RUNNING' },
      });
    }),
  };

  return { manager, activeProcesses };
}

function createProviderLookup() {
  return vi.fn(() => ({
    id: 'fake-provider',
    name: 'Controlled fake provider',
    agentType: AgentType.CODEX,
    env: {},
    config: {},
    isDefault: false,
  }));
}

async function clearDatabase(): Promise<void> {
  await prisma.agentInvocation.deleteMany();
  await prisma.workRequest.deleteMany();
  await prisma.roomMessage.deleteMany();
  await prisma.teamMember.deleteMany();
  await prisma.teamRun.deleteMany();
  await prisma.session.deleteMany();
  await prisma.workspace.deleteMany();
  await prisma.task.deleteMany();
  await prisma.project.deleteMany();
}

describe('TeamRun queued work recovery integration', () => {
  beforeAll(async () => {
    execFileSync(
      'pnpm',
      ['exec', 'prisma', 'db', 'push', '--skip-generate', `--schema=${schemaPath}`],
      {
        cwd: serverRoot,
        env: { ...process.env, AGENT_TOWER_DATABASE_URL: `file:${dbPath}` },
        stdio: 'pipe',
      },
    );

    const [utilsModule, typesModule, workspaceModule, schedulerModule, lockModule, heartbeatModule] = await Promise.all([
      import('../../utils/index.js'),
      import('../../types/index.js'),
      import('../workspace.service.js'),
      import('../team-scheduler.service.js'),
      import('../team-lock.service.js'),
      import('../member-heartbeat-scheduler.js'),
    ]);
    prisma = utilsModule.prisma;
    AgentType = typesModule.AgentType;
    WorkspaceService = workspaceModule.WorkspaceService;
    TeamSchedulerService = schedulerModule.TeamSchedulerService;
    TeamLockService = lockModule.TeamLockService;
    MemberHeartbeatScheduler = heartbeatModule.MemberHeartbeatScheduler;
  });

  beforeEach(async () => {
    await clearDatabase();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await prisma.$disconnect();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('reopens a MERGED dedicated workspace from current main and starts the next invocation', async () => {
    const { teamRun, member } = await createTeamRunFixture({ repoName: 'merged-next-round' });
    const workspaceService = new WorkspaceService(new TeamLockService());
    const mainWorkspace = await workspaceService.getOrCreateMainWorkspace(teamRun.id);
    const dedicatedWorkspace = await workspaceService.getOrCreateDedicatedWorkspace(teamRun.id, member.id);
    const initialHead = git(dedicatedWorkspace.worktreePath, ['rev-parse', 'HEAD']);

    fs.writeFileSync(path.join(mainWorkspace.worktreePath, 'round-two.txt'), 'latest TeamRun main\n');
    git(mainWorkspace.worktreePath, ['add', 'round-two.txt']);
    git(mainWorkspace.worktreePath, ['commit', '-m', 'advance TeamRun main']);
    const currentMainHead = git(mainWorkspace.worktreePath, ['rev-parse', 'HEAD']);
    expect(currentMainHead).not.toBe(initialHead);

    await prisma.workspace.update({
      where: { id: dedicatedWorkspace.id },
      data: { status: 'MERGED', commitMessage: 'previous round merged' },
    });
    const request = await createQueuedWorkRequest(teamRun.id, member.id, 'merged-next-round');
    const fakeSessions = createFakeSessionManager();
    const scheduler = new TeamSchedulerService(new TeamLockService(), {
      workspaceService,
      sessionManager: fakeSessions.manager,
      getProviderById: createProviderLookup(),
    });

    const started = await scheduler.startNextSessions(teamRun.id);

    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      workRequestId: request.id,
      memberId: member.id,
      workspaceId: dedicatedWorkspace.id,
      status: 'RUNNING',
      sessionId: expect.any(String),
    });
    expect(git(dedicatedWorkspace.worktreePath, ['rev-parse', 'HEAD'])).toBe(currentMainHead);
    await expect(prisma.workspace.findUniqueOrThrow({ where: { id: dedicatedWorkspace.id } })).resolves.toMatchObject({
      status: 'ACTIVE',
      baseBranch: mainWorkspace.branchName,
      commitMessage: null,
    });
    await expect(prisma.workRequest.findUniqueOrThrow({ where: { id: request.id } })).resolves.toMatchObject({
      status: 'STARTED',
    });
    await expect(prisma.agentInvocation.count({ where: { workRequestId: request.id } })).resolves.toBe(1);
    await expect(prisma.session.count({ where: { workspaceId: dedicatedWorkspace.id, status: 'RUNNING' } })).resolves.toBe(1);
    expect(fakeSessions.activeProcesses.size).toBe(1);
  });

  it('recovers a transient executor start failure on a later heartbeat tick without duplicate live work', async () => {
    let now = new Date(Date.UTC(2026, 0, 2, 0, 0, 0));
    const { teamRun, member } = await createTeamRunFixture({ repoName: 'heartbeat-retry' });
    const request = await createQueuedWorkRequest(teamRun.id, member.id, 'heartbeat-retry');
    const lockService = new TeamLockService();
    const fakeSessions = createFakeSessionManager({ failFirstStart: true });
    const scheduler = new TeamSchedulerService(lockService, {
      workspaceService: new WorkspaceService(lockService),
      sessionManager: fakeSessions.manager,
      getProviderById: createProviderLookup(),
      now: () => now,
    });

    await expect(scheduler.startNextSessions(teamRun.id)).resolves.toEqual([]);
    await expect(prisma.workRequest.findUniqueOrThrow({ where: { id: request.id } })).resolves.toMatchObject({
      status: 'QUEUED',
      startAttemptCount: 1,
      lastStartError: expect.stringContaining('transient fake executor start failure'),
      nextStartRetryAt: new Date(now.getTime() + 1_000),
    });
    await expect(prisma.agentInvocation.count({ where: { workRequestId: request.id } })).resolves.toBe(1);
    expect(fakeSessions.activeProcesses.size).toBe(0);
    expect(lockService.listLocks()).toEqual([]);

    const reconciler = {
      reconcileOrphanInvocations: vi.fn(async () => undefined),
      reconcileIncompleteTerminalInvocations: vi.fn(async () => undefined),
      reconcileStalledInvocations: vi.fn(async () => undefined),
      reconcileDueRoomReplyReminders: vi.fn(async () => 0),
    };
    const heartbeat = new MemberHeartbeatScheduler({
      eventBus: {} as never,
      sessionManager: fakeSessions.manager as never,
      reconciler: reconciler as never,
      queuePump: scheduler,
    });
    const heartbeatInternals = heartbeat as unknown as { tick(): Promise<void> };

    now = new Date(now.getTime() + 1_000);
    await heartbeatInternals.tick();

    await expect(prisma.workRequest.findUniqueOrThrow({ where: { id: request.id } })).resolves.toMatchObject({
      status: 'STARTED',
      startAttemptCount: 1,
      lastStartError: null,
      nextStartRetryAt: null,
    });
    await expect(prisma.agentInvocation.count({ where: { workRequestId: request.id } })).resolves.toBe(2);
    await expect(prisma.agentInvocation.count({
      where: { workRequestId: request.id, status: { in: ['QUEUED', 'RUNNING', 'SESSION_ENDED', 'WAITING_ROOM_REPLY'] } },
    })).resolves.toBe(1);
    await expect(prisma.session.count({ where: { workspace: { task: { teamRun: { id: teamRun.id } } }, status: 'RUNNING' } })).resolves.toBe(1);
    expect(fakeSessions.manager.start).toHaveBeenCalledTimes(2);
    expect(fakeSessions.activeProcesses.size).toBe(1);
    expect(lockService.listLocks()).toEqual([]);
  });
});
