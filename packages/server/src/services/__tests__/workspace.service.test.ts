import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { TeamLockService } from '../team-lock.service.js';
import { WorkspaceKind } from '../../types/index.js';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-workspace-service-'));
const dbPath = path.join(testDir, 'test.db');
process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;

const {
  createWorktreeMock,
  ensureWorktreeExistsMock,
  removeWorktreeMock,
  deleteBranchIfSafeMock,
  mergeWorktreeMock,
  mergeIntoWorktreeMock,
  isWorktreeCleanMock,
  getGitOperationStatusMock,
  execGitMock,
} = vi.hoisted(() => ({
  createWorktreeMock: vi.fn(),
  ensureWorktreeExistsMock: vi.fn(),
  removeWorktreeMock: vi.fn(),
  deleteBranchIfSafeMock: vi.fn(),
  mergeWorktreeMock: vi.fn(),
    mergeIntoWorktreeMock: vi.fn(),
    isWorktreeCleanMock: vi.fn(),
  getGitOperationStatusMock: vi.fn(),
  execGitMock: vi.fn(),
}));

vi.mock('../../git/worktree.manager.js', () => ({
  WorktreeManager: vi.fn().mockImplementation(function () {
    return {
      create: createWorktreeMock,
      ensureWorktreeExists: ensureWorktreeExistsMock,
      remove: removeWorktreeMock,
      deleteBranchIfSafe: deleteBranchIfSafeMock,
      getDiff: vi.fn(),
      rebase: vi.fn(),
      getGitOperationStatus: getGitOperationStatusMock,
      abortOperation: vi.fn(),
      merge: mergeWorktreeMock,
      mergeIntoWorktree: mergeIntoWorktreeMock,
      isWorktreeClean: isWorktreeCleanMock,
      prune: vi.fn(),
    };
  }),
}));

vi.mock('../../git/git-cli.js', () => ({
  execGit: execGitMock,
  MergeConflictError: class MergeConflictError extends Error {},
}));

execGitMock.mockImplementation(async (_repoPath: string, args: string[]) => {
    if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) {
      return 'main\n';
    }
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      return 'child-head-sha\n';
    }
    if (args[0] === 'status') {
      return '';
    }
    return '';
});

vi.mock('../copy-files.service.js', () => ({
  copyProjectFiles: vi.fn(),
}));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, '../../..');
const schemaPath = path.join(serverRoot, 'prisma/schema.prisma');

let prisma: PrismaClient;
let WorkspaceService: typeof import('../workspace.service.js').WorkspaceService;
let gitRepoCounter = 0;

function createGitRepoPath(label: string) {
  const repoPath = path.join(testDir, 'repos', `${label}-${gitRepoCounter++}`);
  fs.mkdirSync(path.join(repoPath, '.git'), { recursive: true });
  return repoPath;
}

async function createTask(title = 'Workspace service task') {
    const project = await prisma.project.create({
      data: {
        name: `${title} project`,
        repoPath: createGitRepoPath(title.replace(/\W+/g, '-')),
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

async function createTeamRunWithMember(options: { workspacePolicy?: string } = {}) {
  const { project, task } = await createTask();
  const teamRun = await prisma.teamRun.create({
    data: {
      taskId: task.id,
      mode: 'AUTO',
    },
  });
  const member = await prisma.teamMember.create({
    data: {
      teamRunId: teamRun.id,
      presetId: null,
      name: 'Member 1',
      aliases: '["member-1"]',
      providerId: 'provider-1',
      rolePrompt: 'Role 1',
      capabilities: '{}',
      workspacePolicy: options.workspacePolicy ?? 'dedicated',
      triggerPolicy: 'MENTION_ONLY',
      sessionPolicy: 'new_per_request',
      avatar: null,
    },
  });

  return { project, task, teamRun, member };
}

async function addTeamMember(teamRunId: string, overrides: {
  name?: string;
  capabilities?: Record<string, unknown>;
} = {}) {
  const suffix = Math.random().toString(36).slice(2, 8);
  return prisma.teamMember.create({
    data: {
      teamRunId,
      presetId: null,
      name: overrides.name ?? `Member ${suffix}`,
      aliases: JSON.stringify([`member-${suffix}`]),
      providerId: `provider-${suffix}`,
      rolePrompt: `Role ${suffix}`,
      capabilities: JSON.stringify(overrides.capabilities ?? {}),
      workspacePolicy: 'dedicated',
      triggerPolicy: 'MENTION_ONLY',
      sessionPolicy: 'new_per_request',
      avatar: null,
    },
  });
}

async function createTeamRunChildMergeFixture(options: {
  mergerCapabilities?: Record<string, unknown>;
  reviewVerdict?: 'APPROVED' | 'CHANGES_REQUESTED';
  reviewSha?: string;
  reviewerIsOwner?: boolean;
  childStatus?: string;
} = {}) {
  const { task, teamRun, member: owner } = await createTeamRunWithMember();
  await prisma.task.update({
    where: { id: task.id },
    data: { status: 'IN_REVIEW' },
  });
  const reviewer = options.reviewerIsOwner
    ? owner
    : await addTeamMember(teamRun.id, { name: 'Reviewer', capabilities: { readDiff: true } });
  const merger = await addTeamMember(teamRun.id, {
    name: 'Merger',
    capabilities: options.mergerCapabilities ?? { mergeWorkspace: true },
  });
  const mainWorkspace = await prisma.workspace.create({
    data: {
      taskId: task.id,
      branchName: 'team-main',
      baseBranch: 'main',
      worktreePath: path.join(testDir, 'team-main'),
      status: 'ACTIVE',
    },
  });
  await prisma.teamRun.update({
    where: { id: teamRun.id },
    data: { mainWorkspaceId: mainWorkspace.id },
  });
  const childWorkspace = await prisma.workspace.create({
    data: {
      taskId: task.id,
      parentWorkspaceId: mainWorkspace.id,
      ownerMemberId: owner.id,
      branchName: 'dedicated-child',
      baseBranch: mainWorkspace.branchName,
      worktreePath: path.join(testDir, 'dedicated-child'),
      status: options.childStatus ?? 'ACTIVE',
    },
  });
  const request = await prisma.workRequest.create({
    data: {
      teamRunId: teamRun.id,
      requesterMemberId: null,
      requesterType: 'user',
      targetMemberId: merger.id,
      triggerMessageId: await createRoomMessageId(teamRun.id),
      instruction: 'merge workspace',
      status: 'STARTED',
    },
  });
  const invocation = await prisma.agentInvocation.create({
    data: {
      teamRunId: teamRun.id,
      workRequestId: request.id,
      memberId: merger.id,
      workspaceId: mainWorkspace.id,
      status: 'RUNNING',
    },
  });

  if (options.reviewVerdict) {
    await prisma.workspaceVerdict.create({
      data: {
        workspaceId: childWorkspace.id,
        teamRunId: teamRun.id,
        kind: 'REVIEW',
        verdict: options.reviewVerdict,
        reviewedSha: options.reviewSha ?? 'child-head-sha',
        reviewerMemberId: reviewer.id,
        reason: 'reviewed',
        sequence: 1,
      },
    });
  }

  return { task, teamRun, owner, reviewer, merger, mainWorkspace, childWorkspace, invocation };
}

async function createMergeInvocation(teamRunId: string, memberId: string, workspaceId: string) {
  const request = await prisma.workRequest.create({
    data: {
      teamRunId,
      requesterMemberId: null,
      requesterType: 'user',
      targetMemberId: memberId,
      triggerMessageId: await createRoomMessageId(teamRunId),
      instruction: 'merge workspace',
      status: 'STARTED',
    },
  });

  return prisma.agentInvocation.create({
    data: {
      teamRunId,
      workRequestId: request.id,
      memberId,
      workspaceId,
      status: 'RUNNING',
    },
  });
}

async function createRoomMessageId(teamRunId: string): Promise<string> {
  const message = await prisma.roomMessage.create({
    data: {
      teamRunId,
      senderType: 'user',
      senderId: null,
      senderInvocationId: null,
      kind: 'chat',
      content: 'trigger',
      mentions: '[]',
    },
  });
  return message.id;
}

function mockCreatedWorktreePath(branchName: string) {
  const worktreePath = path.join(testDir, 'created-worktrees', branchName);
  fs.mkdirSync(path.join(worktreePath, '.git'), { recursive: true });
  return worktreePath;
}

function mockRestoredWorktreePath(branchName: string) {
  const worktreePath = path.join(testDir, 'restored-worktrees', branchName);
  fs.mkdirSync(path.join(worktreePath, '.git'), { recursive: true });
  return worktreePath;
}

describe('WorkspaceService TeamRun workspace lifecycle', () => {
  let service: InstanceType<typeof WorkspaceService>;

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
    const serviceModule = await import('../workspace.service.js');
    prisma = utilsModule.prisma;
    WorkspaceService = serviceModule.WorkspaceService;
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    execGitMock.mockImplementation(async (_repoPath: string, args: string[]) => {
      if (args[0] === 'rev-parse' && args.includes('--abbrev-ref')) {
        return 'main\n';
      }
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return 'child-head-sha\n';
      }
      if (args[0] === 'status') {
        return '';
      }
      return '';
    });
    createWorktreeMock.mockImplementation(async (branchName: string) => mockCreatedWorktreePath(branchName));
    ensureWorktreeExistsMock.mockImplementation(async (branchName: string) => mockRestoredWorktreePath(branchName));
    isWorktreeCleanMock.mockResolvedValue(true);
    removeWorktreeMock.mockImplementation(async (worktreePath: string) => ({
      status: 'removed',
      path: worktreePath,
      managed: true,
    }));
    deleteBranchIfSafeMock.mockImplementation(async (branchName: string) => ({
      status: 'deleted',
      branchName,
    }));
    mergeWorktreeMock.mockResolvedValue({ sha: 'root-merge-sha', taskBranch: 'team-main' });
    mergeIntoWorktreeMock.mockResolvedValue({
      sha: 'child-merge-sha',
      sourceBranch: 'dedicated-child',
      targetBranch: 'team-main',
    });
    getGitOperationStatusMock.mockResolvedValue({
      operation: 'idle',
      conflictedFiles: [],
      conflictOp: null,
      ahead: 1,
      behind: 0,
      hasUncommittedChanges: false,
      uncommittedCount: 0,
      untrackedCount: 0,
    });
    service = new WorkspaceService();

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

  it('creates a main-directory workspace without creating a git worktree', async () => {
    const { project, task } = await createTask('main directory workspace task');

    const workspace = await service.create(task.id, {
      workspaceKind: WorkspaceKind.MAIN_DIRECTORY,
    });

    expect(workspace).toMatchObject({
      taskId: task.id,
      workspaceKind: WorkspaceKind.MAIN_DIRECTORY,
      workingDir: project.repoPath,
      worktreePath: '',
      branchName: '',
      status: 'ACTIVE',
    });
    expect(createWorktreeMock).not.toHaveBeenCalled();
    expect(ensureWorktreeExistsMock).not.toHaveBeenCalled();
  });

  it('omits session prompt and logSnapshot from workspace task lists', async () => {
    const { task } = await createTask('workspace session summary task');
    const workspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'summary-workspace',
        worktreePath: path.join(testDir, 'summary-workspace'),
        status: 'ACTIVE',
      },
    });
    await prisma.session.create({
      data: {
        workspaceId: workspace.id,
        agentType: 'CODEX',
        prompt: `large prompt ${'x'.repeat(1000)}`,
        logSnapshot: `large snapshot ${'y'.repeat(1000)}`,
        status: 'COMPLETED',
      },
    });

    const workspaces = await service.findByTaskId(task.id);

    expect(workspaces[0]?.sessions).toHaveLength(1);
    expect(workspaces[0]?.sessions?.[0]).toMatchObject({
      agentType: 'CODEX',
      status: 'COMPLETED',
    });
    expect(workspaces[0]?.sessions?.[0]).not.toHaveProperty('prompt');
    expect(workspaces[0]?.sessions?.[0]).not.toHaveProperty('logSnapshot');
  });

  it('rejects worktree lifecycle git operations for main-directory workspaces', async () => {
    const { task } = await createTask('main directory git operations task');
    const workspace = await service.create(task.id, {
      workspaceKind: WorkspaceKind.MAIN_DIRECTORY,
    });

    await expect(service.getDiff(workspace.id)).rejects.toMatchObject({
      code: 'WORKSPACE_GIT_UNAVAILABLE',
    });
    await expect(service.merge(workspace.id)).rejects.toMatchObject({
      code: 'WORKSPACE_GIT_UNAVAILABLE',
    });
    await expect(service.rebase(workspace.id)).rejects.toMatchObject({
      code: 'WORKSPACE_GIT_UNAVAILABLE',
    });

    expect(await service.getGitStatus(workspace.id)).toMatchObject({
      operation: 'idle',
      conflictedFiles: [],
      ahead: 0,
      behind: 0,
      hasUncommittedChanges: false,
    });
  });

  it('rejects worktree workspace creation for non-git projects', async () => {
    const repoPath = fs.mkdtempSync(path.join(testDir, 'local-only-project-'));
    const project = await prisma.project.create({
      data: {
        name: 'Local-only project',
        repoPath,
      },
    });
    const task = await prisma.task.create({
      data: {
        title: 'Local-only task',
        projectId: project.id,
      },
    });

    await expect(service.create(task.id, {
      workspaceKind: WorkspaceKind.WORKTREE,
    })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(createWorktreeMock).not.toHaveBeenCalled();
  });

  it('rejects worktree workspace creation for Git repositories without commits', async () => {
    const repoPath = fs.mkdtempSync(path.join(testDir, 'empty-git-project-'));
    fs.mkdirSync(path.join(repoPath, '.git'), { recursive: true });
    execGitMock.mockImplementation(async (_repoPath: string, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'HEAD') {
        throw new Error('HEAD does not exist');
      }
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
        return 'true\n';
      }
      return '';
    });
    const project = await prisma.project.create({
      data: {
        name: 'Empty Git project',
        repoPath,
      },
    });
    const task = await prisma.task.create({
      data: {
        title: 'Empty Git task',
        projectId: project.id,
      },
    });

    await expect(service.create(task.id, {
      workspaceKind: WorkspaceKind.WORKTREE,
    })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: expect.stringContaining('has no commits'),
    });
    expect(createWorktreeMock).not.toHaveBeenCalled();
  });

  it('rejects git-status for non-git main-directory workspaces', async () => {
    const repoPath = fs.mkdtempSync(path.join(testDir, 'local-git-status-project-'));
    const project = await prisma.project.create({
      data: {
        name: 'Local git-status project',
        repoPath,
      },
    });
    const task = await prisma.task.create({
      data: {
        title: 'Local git-status task',
        projectId: project.id,
      },
    });
    const workspace = await service.create(task.id, {
      workspaceKind: WorkspaceKind.MAIN_DIRECTORY,
    });

    await expect(service.getGitStatus(workspace.id)).rejects.toMatchObject({
      code: 'WORKSPACE_GIT_UNAVAILABLE',
    });
  });

  it('creates and binds a main workspace without reusing child or inactive task workspaces', async () => {
    const { task, teamRun, member } = await createTeamRunWithMember();
    const inactiveRoot = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'inactive-root',
        worktreePath: '',
        status: 'HIBERNATED',
        hibernatedAt: new Date(),
      },
    });
    await prisma.workspace.create({
      data: {
        taskId: task.id,
        parentWorkspaceId: inactiveRoot.id,
        ownerMemberId: member.id,
        branchName: 'child-active',
        worktreePath: path.join(testDir, 'child-active'),
        status: 'ACTIVE',
      },
    });
    await prisma.teamRun.update({
      where: { id: teamRun.id },
      data: { mainWorkspaceId: inactiveRoot.id },
    });

    const mainWorkspace = await service.getOrCreateMainWorkspace(teamRun.id);

    expect(mainWorkspace.id).not.toBe(inactiveRoot.id);
    expect(mainWorkspace.parentWorkspaceId).toBeNull();
    expect(mainWorkspace.ownerMemberId).toBeNull();
    expect(mainWorkspace.status).toBe('ACTIVE');
    expect(mainWorkspace.branchName).toMatch(new RegExp(`^at/team/${teamRun.id.slice(0, 8)}/main/`));
    expect(createWorktreeMock).toHaveBeenCalledTimes(1);
    expect(ensureWorktreeExistsMock).not.toHaveBeenCalledWith('inactive-root');
    await expect(prisma.teamRun.findUnique({ where: { id: teamRun.id } })).resolves.toMatchObject({
      mainWorkspaceId: mainWorkspace.id,
    });
  });

  it('does not bind an orphan dedicated child as the TeamRun main workspace', async () => {
    const { task, teamRun, member } = await createTeamRunWithMember();
    const orphanPath = path.join(testDir, 'orphan-child');
    fs.mkdirSync(path.join(orphanPath, '.git'), { recursive: true });
    const orphanChild = await prisma.workspace.create({
      data: {
        taskId: task.id,
        parentWorkspaceId: null,
        ownerMemberId: member.id,
        branchName: 'orphan-child',
        worktreePath: orphanPath,
        status: 'ACTIVE',
      },
    });
    await prisma.teamRun.update({
      where: { id: teamRun.id },
      data: { mainWorkspaceId: orphanChild.id },
    });

    const mainWorkspace = await service.getOrCreateMainWorkspace(teamRun.id);

    expect(mainWorkspace.id).not.toBe(orphanChild.id);
    expect(mainWorkspace.parentWorkspaceId).toBeNull();
    expect(mainWorkspace.ownerMemberId).toBeNull();
    expect(mainWorkspace.status).toBe('ACTIVE');
    expect(mainWorkspace.branchName).toMatch(new RegExp(`^at/team/${teamRun.id.slice(0, 8)}/main/`));
    expect(createWorktreeMock).toHaveBeenCalledTimes(1);
    await expect(prisma.teamRun.findUnique({ where: { id: teamRun.id } })).resolves.toMatchObject({
      mainWorkspaceId: mainWorkspace.id,
    });
  });

  it('reuses an active root workspace as the TeamRun main workspace', async () => {
    const { task, teamRun } = await createTeamRunWithMember();
    const rootPath = path.join(testDir, 'active-root');
    fs.mkdirSync(path.join(rootPath, '.git'), { recursive: true });
    const activeRoot = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'active-root',
        worktreePath: rootPath,
        status: 'ACTIVE',
      },
    });

    const mainWorkspace = await service.getOrCreateMainWorkspace(teamRun.id);

    expect(mainWorkspace.id).toBe(activeRoot.id);
    expect(createWorktreeMock).not.toHaveBeenCalled();
    expect(ensureWorktreeExistsMock).not.toHaveBeenCalled();
    await expect(prisma.teamRun.findUnique({ where: { id: teamRun.id } })).resolves.toMatchObject({
      mainWorkspaceId: activeRoot.id,
    });
  });

  it('creates and reuses a dedicated child workspace for the same main workspace and member', async () => {
    const { teamRun, member } = await createTeamRunWithMember();

    const first = await service.getOrCreateDedicatedWorkspace(teamRun.id, member.id);
    const second = await service.getOrCreateDedicatedWorkspace(teamRun.id, member.id);
    const reloadedTeamRun = await prisma.teamRun.findUniqueOrThrow({ where: { id: teamRun.id } });
    const mainWorkspace = await prisma.workspace.findUniqueOrThrow({
      where: { id: reloadedTeamRun.mainWorkspaceId ?? '' },
    });

    expect(first.id).toBe(second.id);
    expect(first.parentWorkspaceId).toBe(reloadedTeamRun.mainWorkspaceId);
    expect(first.ownerMemberId).toBe(member.id);
    expect(first.baseBranch).toBe(mainWorkspace.branchName);
    expect(first.branchName).toMatch(new RegExp(`^at/team/${teamRun.id.slice(0, 8)}/member-${member.id.slice(0, 8)}/`));
    expect(createWorktreeMock).toHaveBeenCalledWith(first.branchName, mainWorkspace.branchName);
    await expect(prisma.workspace.count({
      where: {
        parentWorkspaceId: reloadedTeamRun.mainWorkspaceId,
        ownerMemberId: member.id,
      },
    })).resolves.toBe(1);
  });

  it('reactivates a hibernated dedicated child workspace', async () => {
    const { task, teamRun, member } = await createTeamRunWithMember();
    const mainWorkspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'team-main',
        worktreePath: path.join(testDir, 'team-main'),
        status: 'ACTIVE',
      },
    });
    await prisma.teamRun.update({
      where: { id: teamRun.id },
      data: { mainWorkspaceId: mainWorkspace.id },
    });
    const child = await prisma.workspace.create({
      data: {
        taskId: task.id,
        parentWorkspaceId: mainWorkspace.id,
        ownerMemberId: member.id,
        branchName: 'dedicated-child',
        worktreePath: '',
        status: 'HIBERNATED',
        hibernatedAt: new Date(),
      },
    });

    const workspace = await service.getOrCreateDedicatedWorkspace(teamRun.id, member.id);

    expect(workspace.id).toBe(child.id);
    expect(workspace.status).toBe('ACTIVE');
    expect(workspace.hibernatedAt).toBeNull();
    expect(workspace.worktreePath).toBe(mockRestoredWorktreePath('dedicated-child'));
    expect(ensureWorktreeExistsMock).toHaveBeenCalledWith('dedicated-child');
    expect(createWorktreeMock).not.toHaveBeenCalledWith(expect.stringContaining('member-'));
  });

  it('resets a merged dedicated workspace to the latest TeamRun main HEAD before reactivating it', async () => {
    const { task, teamRun, member } = await createTeamRunWithMember();
    const mainWorktreePath = path.join(testDir, 'merged-reset-main');
    fs.mkdirSync(path.join(mainWorktreePath, '.git'), { recursive: true });
    const mainWorkspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'team-main-latest',
        worktreePath: mainWorktreePath,
        workingDir: mainWorktreePath,
        status: 'ACTIVE',
      },
    });
    await prisma.teamRun.update({
      where: { id: teamRun.id },
      data: { mainWorkspaceId: mainWorkspace.id },
    });
    const child = await prisma.workspace.create({
      data: {
        taskId: task.id,
        parentWorkspaceId: mainWorkspace.id,
        ownerMemberId: member.id,
        branchName: 'member-merged',
        baseBranch: 'team-main-old',
        worktreePath: path.join(testDir, 'old-member-worktree'),
        workingDir: path.join(testDir, 'old-member-worktree'),
        status: 'MERGED',
        commitMessage: 'previous round',
      },
    });
    const restoredPath = mockRestoredWorktreePath(child.branchName);
    ensureWorktreeExistsMock.mockResolvedValue(restoredPath);
    execGitMock.mockImplementation(async (cwd: string, args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return cwd === mainWorktreePath ? 'latest-main-head\n' : 'latest-main-head\n';
      }
      return '';
    });

    const workspace = await service.getOrCreateDedicatedWorkspace(teamRun.id, member.id);

    expect(workspace).toMatchObject({
      id: child.id,
      status: 'ACTIVE',
      baseBranch: mainWorkspace.branchName,
      worktreePath: restoredPath,
      workingDir: restoredPath,
      commitMessage: null,
    });
    expect(isWorktreeCleanMock).toHaveBeenCalledTimes(2);
    expect(execGitMock).toHaveBeenCalledWith(mainWorktreePath, ['rev-parse', 'HEAD']);
    expect(execGitMock).toHaveBeenCalledWith(restoredPath, ['reset', '--hard', 'latest-main-head']);
    expect(execGitMock).toHaveBeenCalledWith(restoredPath, ['rev-parse', 'HEAD']);
  });

  it('does not overwrite a dirty merged dedicated workspace when starting a new round', async () => {
    const { task, teamRun, member } = await createTeamRunWithMember();
    const mainWorktreePath = path.join(testDir, 'dirty-reset-main');
    fs.mkdirSync(path.join(mainWorktreePath, '.git'), { recursive: true });
    const mainWorkspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'team-main',
        worktreePath: mainWorktreePath,
        status: 'ACTIVE',
      },
    });
    await prisma.teamRun.update({ where: { id: teamRun.id }, data: { mainWorkspaceId: mainWorkspace.id } });
    const child = await prisma.workspace.create({
      data: {
        taskId: task.id,
        parentWorkspaceId: mainWorkspace.id,
        ownerMemberId: member.id,
        branchName: 'dirty-member-merged',
        worktreePath: path.join(testDir, 'dirty-member-merged'),
        status: 'MERGED',
      },
    });
    isWorktreeCleanMock.mockResolvedValue(false);

    await expect(service.getOrCreateDedicatedWorkspace(teamRun.id, member.id)).rejects.toMatchObject({
      code: 'MERGED_WORKSPACE_DIRTY',
    });
    await expect(prisma.workspace.findUnique({ where: { id: child.id } })).resolves.toMatchObject({
      status: 'MERGED',
    });
    expect(execGitMock).not.toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['reset']));
  });

  it('clears workingDir on hibernate and restores it on reactivate', async () => {
    const { task } = await createTask('hibernate working dir sync task');
    const workspace = await service.create(task.id, { branchName: 'hibernate-sync' });

    expect(workspace.worktreePath).toBe(mockCreatedWorktreePath('hibernate-sync'));
    expect(workspace.workingDir).toBe(workspace.worktreePath);

    await service.hibernate(workspace.id);

    const hibernated = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
    expect(hibernated.status).toBe('HIBERNATED');
    expect(hibernated.worktreePath).toBe('');
    expect(hibernated.workingDir).toBe('');

    const reactivated = await service.reactivate(workspace.id);
    const restoredPath = mockRestoredWorktreePath('hibernate-sync');

    expect(reactivated.status).toBe('ACTIVE');
    expect(reactivated.worktreePath).toBe(restoredPath);
    expect(reactivated.workingDir).toBe(restoredPath);
  });

  it('cleans up a worktree when the task is deleted during workspace creation', async () => {
    const { project, task } = await createTask('workspace create deleted race');
    let createdPath = '';
    createWorktreeMock.mockImplementationOnce(async (branchName: string) => {
      createdPath = mockCreatedWorktreePath(branchName);
      await prisma.task.update({
        where: { id: task.id },
        data: { deletedAt: new Date() },
      });
      return createdPath;
    });

    await expect(service.create(task.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });

    expect(removeWorktreeMock).toHaveBeenCalledWith(createdPath);
    expect(deleteBranchIfSafeMock).toHaveBeenCalledWith(expect.stringMatching(/^at\//), {
      protectedBranches: [project.mainBranch, 'main'],
    });
    await expect(prisma.workspace.count({ where: { taskId: task.id } })).resolves.toBe(0);
  });

  it('warns when deleted-task worktree compensation returns unsafe statuses', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { task } = await createTask('workspace compensation warning task');
    let createdPath = '';
    createWorktreeMock.mockImplementationOnce(async (branchName: string) => {
      createdPath = mockCreatedWorktreePath(branchName);
      await prisma.task.update({
        where: { id: task.id },
        data: { deletedAt: new Date() },
      });
      return createdPath;
    });
    removeWorktreeMock.mockResolvedValueOnce({
      status: 'unregistered',
      path: createdPath,
      managed: true,
    });
    deleteBranchIfSafeMock.mockImplementationOnce(async (branchName: string) => ({
      status: 'checked_out',
      branchName,
      reason: 'branch is checked out at a raced worktree',
    }));

    await expect(service.create(task.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unregistered or unsafe to remove'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('branch is checked out at a raced worktree'));
    warnSpy.mockRestore();
  });

  it('does not reactivate a hibernated workspace for a deleted task', async () => {
    const { task } = await createTask('deleted reactivate task');
    await prisma.task.update({
      where: { id: task.id },
      data: { deletedAt: new Date() },
    });
    const workspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'deleted-hibernated',
        worktreePath: '',
        status: 'HIBERNATED',
        hibernatedAt: new Date(),
      },
    });

    await expect(service.reactivate(workspace.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });

    expect(ensureWorktreeExistsMock).not.toHaveBeenCalled();
  });

  it('cleans up a restored worktree when the task is deleted during reactivation', async () => {
    const { task } = await createTask('reactivate deleted race');
    const workspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'reactivate-race',
        worktreePath: '',
        status: 'HIBERNATED',
        hibernatedAt: new Date(),
      },
    });
    let restoredPath = '';
    ensureWorktreeExistsMock.mockImplementationOnce(async (branchName: string) => {
      restoredPath = mockRestoredWorktreePath(branchName);
      await prisma.task.update({
        where: { id: task.id },
        data: { deletedAt: new Date() },
      });
      return restoredPath;
    });

    await expect(service.reactivate(workspace.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });

    expect(removeWorktreeMock).toHaveBeenCalledWith(restoredPath);
    await expect(prisma.workspace.findUnique({ where: { id: workspace.id } })).resolves.toMatchObject({
      status: 'HIBERNATED',
      worktreePath: '',
    });
  });

  it('merges a dedicated child into the TeamRun main workspace without marking the task DONE', async () => {
    const { task, teamRun, member } = await createTeamRunWithMember();
    await prisma.task.update({
      where: { id: task.id },
      data: { status: 'IN_REVIEW' },
    });
    const mainWorkspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'team-main',
        baseBranch: 'main',
        worktreePath: path.join(testDir, 'team-main'),
        status: 'ACTIVE',
      },
    });
    await prisma.teamRun.update({
      where: { id: teamRun.id },
      data: { mainWorkspaceId: mainWorkspace.id },
    });
    const childWorkspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        parentWorkspaceId: mainWorkspace.id,
        ownerMemberId: member.id,
        branchName: 'dedicated-child',
        baseBranch: mainWorkspace.branchName,
        worktreePath: path.join(testDir, 'dedicated-child'),
        status: 'ACTIVE',
      },
    });
    const reviewer = await addTeamMember(teamRun.id, { name: 'Reviewer', capabilities: { readDiff: true } });
    const merger = await addTeamMember(teamRun.id, { name: 'Merger', capabilities: { mergeWorkspace: true } });
    const invocation = await createMergeInvocation(teamRun.id, merger.id, mainWorkspace.id);
    await prisma.workspaceVerdict.create({
      data: {
        workspaceId: childWorkspace.id,
        teamRunId: teamRun.id,
        kind: 'REVIEW',
        verdict: 'APPROVED',
        reviewedSha: 'child-head-sha',
        reviewerMemberId: reviewer.id,
        reason: 'approved',
      },
    });

    const sha = await service.merge(childWorkspace.id, {
      commitMessage: 'merge child',
      lockOwnerId: invocation.id,
      invocationId: invocation.id,
    });

    expect(sha).toBe('child-merge-sha');
    expect(mergeIntoWorktreeMock).toHaveBeenCalledWith(
      childWorkspace.worktreePath,
      mainWorkspace.worktreePath,
      { commitMessage: 'merge child' },
    );
    expect(mergeWorktreeMock).not.toHaveBeenCalled();
    await expect(prisma.workspace.findUnique({ where: { id: childWorkspace.id } })).resolves.toMatchObject({
      status: 'MERGED',
    });
    await expect(prisma.task.findUnique({ where: { id: task.id } })).resolves.toMatchObject({
      status: 'IN_REVIEW',
    });
  });

  it('rejects child merge when the parent workspace has an active write session', async () => {
    const { task, teamRun, member } = await createTeamRunWithMember();
    const mainWorkspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'team-main',
        worktreePath: path.join(testDir, 'team-main'),
        status: 'ACTIVE',
      },
    });
    await prisma.teamRun.update({
      where: { id: teamRun.id },
      data: { mainWorkspaceId: mainWorkspace.id },
    });
    const childWorkspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        parentWorkspaceId: mainWorkspace.id,
        ownerMemberId: member.id,
        branchName: 'dedicated-child',
        worktreePath: path.join(testDir, 'dedicated-child'),
        status: 'ACTIVE',
      },
    });
    const reviewer = await addTeamMember(teamRun.id, { name: 'Reviewer', capabilities: { readDiff: true } });
    const merger = await addTeamMember(teamRun.id, { name: 'Merger', capabilities: { mergeWorkspace: true } });
    const invocation = await createMergeInvocation(teamRun.id, merger.id, mainWorkspace.id);
    await prisma.workspaceVerdict.create({
      data: {
        workspaceId: childWorkspace.id,
        teamRunId: teamRun.id,
        kind: 'REVIEW',
        verdict: 'APPROVED',
        reviewedSha: 'child-head-sha',
        reviewerMemberId: reviewer.id,
        reason: 'approved',
      },
    });
    await prisma.session.create({
      data: {
        workspaceId: mainWorkspace.id,
        agentType: 'CODEX',
        prompt: 'write on main',
        status: 'RUNNING',
      },
    });

    await expect(service.merge(childWorkspace.id, {
      lockOwnerId: invocation.id,
      invocationId: invocation.id,
    })).rejects.toMatchObject({
      code: 'PARENT_WORKSPACE_HAS_ACTIVE_SESSION',
    });
    expect(mergeIntoWorktreeMock).not.toHaveBeenCalled();
  });

  it('rejects TeamRun dedicated child merge without an approved review', async () => {
    const { childWorkspace, invocation } = await createTeamRunChildMergeFixture();

    await expect(service.merge(childWorkspace.id, {
      lockOwnerId: invocation.id,
      invocationId: invocation.id,
    })).rejects.toMatchObject({
      code: 'REVIEW_REQUIRED',
      statusCode: 409,
    });
    expect(mergeIntoWorktreeMock).not.toHaveBeenCalled();
  });

  it('rejects TeamRun dedicated child merge when the approved review SHA is stale', async () => {
    const { childWorkspace, invocation } = await createTeamRunChildMergeFixture({
      reviewVerdict: 'APPROVED',
      reviewSha: 'old-sha',
    });

    await expect(service.merge(childWorkspace.id, {
      lockOwnerId: invocation.id,
      invocationId: invocation.id,
    })).rejects.toMatchObject({
      code: 'REVIEW_STALE',
      statusCode: 409,
    });
    expect(mergeIntoWorktreeMock).not.toHaveBeenCalled();
  });

  it('rejects TeamRun dedicated child merge when the latest review requests changes', async () => {
    const { teamRun, childWorkspace, invocation, reviewer } = await createTeamRunChildMergeFixture({
      reviewVerdict: 'APPROVED',
    });
    const sameCreatedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    await prisma.workspaceVerdict.updateMany({
      where: {
        workspaceId: childWorkspace.id,
        kind: 'REVIEW',
        verdict: 'APPROVED',
      },
      data: {
        createdAt: sameCreatedAt,
        sequence: 1,
      },
    });
    await prisma.workspaceVerdict.create({
      data: {
        workspaceId: childWorkspace.id,
        teamRunId: teamRun.id,
        kind: 'REVIEW',
        verdict: 'CHANGES_REQUESTED',
        reviewedSha: 'child-head-sha',
        reviewerMemberId: reviewer.id,
        reason: 'needs changes',
        createdAt: sameCreatedAt,
        sequence: 2,
      },
    });

    await expect(service.merge(childWorkspace.id, {
      lockOwnerId: invocation.id,
      invocationId: invocation.id,
    })).rejects.toMatchObject({
      code: 'REVIEW_REQUIRED',
      statusCode: 409,
    });
    expect(mergeIntoWorktreeMock).not.toHaveBeenCalled();
  });

  it('rejects ACTIVE TeamRun dedicated child merge when the invocation identity is missing', async () => {
    const { childWorkspace } = await createTeamRunChildMergeFixture({
      reviewVerdict: 'APPROVED',
    });

    await expect(service.merge(childWorkspace.id)).rejects.toMatchObject({
      code: 'TEAM_RUN_MERGE_INVOCATION_REQUIRED',
      statusCode: 403,
    });
    expect(mergeIntoWorktreeMock).not.toHaveBeenCalled();
  });

  it('rejects ACTIVE TeamRun dedicated child merge when the invocation identity is invalid', async () => {
    const { childWorkspace } = await createTeamRunChildMergeFixture({
      reviewVerdict: 'APPROVED',
    });

    await expect(service.merge(childWorkspace.id, {
      lockOwnerId: 'missing-invocation',
      invocationId: 'missing-invocation',
    })).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
    });
    expect(mergeIntoWorktreeMock).not.toHaveBeenCalled();
  });

  it('rejects TeamRun dedicated child merge when the owner approved their own workspace', async () => {
    const { childWorkspace, invocation } = await createTeamRunChildMergeFixture({
      reviewVerdict: 'APPROVED',
      reviewerIsOwner: true,
    });

    await expect(service.merge(childWorkspace.id, {
      lockOwnerId: invocation.id,
      invocationId: invocation.id,
    })).rejects.toMatchObject({
      code: 'SELF_REVIEW_FORBIDDEN',
      statusCode: 409,
    });
    expect(mergeIntoWorktreeMock).not.toHaveBeenCalled();
  });

  it('rejects TeamRun dedicated child merge when the owner has active work', async () => {
    const { teamRun, owner, childWorkspace, invocation } = await createTeamRunChildMergeFixture({
      reviewVerdict: 'APPROVED',
    });
    const ownerRequest = await prisma.workRequest.create({
      data: {
        teamRunId: teamRun.id,
        requesterMemberId: null,
        requesterType: 'user',
        targetMemberId: owner.id,
        triggerMessageId: await createRoomMessageId(teamRun.id),
        instruction: 'continue writing',
        status: 'STARTED',
      },
    });
    await prisma.agentInvocation.create({
      data: {
        teamRunId: teamRun.id,
        workRequestId: ownerRequest.id,
        memberId: owner.id,
        workspaceId: childWorkspace.id,
        status: 'RUNNING',
      },
    });

    await expect(service.merge(childWorkspace.id, {
      lockOwnerId: invocation.id,
      invocationId: invocation.id,
    })).rejects.toMatchObject({
      code: 'OWNER_HAS_ACTIVE_INVOCATION',
      statusCode: 409,
    });
    expect(mergeIntoWorktreeMock).not.toHaveBeenCalled();
  });

  it('rejects TeamRun dedicated child merge when the parent has active write sessions after review passes', async () => {
    const { mainWorkspace, childWorkspace, invocation } = await createTeamRunChildMergeFixture({
      reviewVerdict: 'APPROVED',
    });
    await prisma.session.create({
      data: {
        workspaceId: mainWorkspace.id,
        agentType: 'CODEX',
        prompt: 'write on parent',
        status: 'RUNNING',
      },
    });

    await expect(service.merge(childWorkspace.id, {
      lockOwnerId: invocation.id,
      invocationId: invocation.id,
    })).rejects.toMatchObject({
      code: 'PARENT_WORKSPACE_HAS_ACTIVE_SESSION',
      statusCode: 409,
    });
    expect(mergeIntoWorktreeMock).not.toHaveBeenCalled();
  });

  it('rejects TeamRun dedicated child merge for an invocation without mergeWorkspace capability', async () => {
    const { childWorkspace, invocation } = await createTeamRunChildMergeFixture({
      mergerCapabilities: { mergeWorkspace: false },
      reviewVerdict: 'APPROVED',
    });

    await expect(service.merge(childWorkspace.id, {
      lockOwnerId: invocation.id,
      invocationId: invocation.id,
    })).rejects.toMatchObject({
      code: 'TEAM_RUN_MEMBER_CAPABILITY_REQUIRED',
      statusCode: 403,
    });
    expect(mergeIntoWorktreeMock).not.toHaveBeenCalled();
  });

  it('returns idempotent success when a TeamRun dedicated child workspace is already merged', async () => {
    const { childWorkspace, invocation } = await createTeamRunChildMergeFixture({
      childStatus: 'MERGED',
    });

    const sha = await service.merge(childWorkspace.id, {
      lockOwnerId: invocation.id,
      invocationId: invocation.id,
    });

    expect(sha).toBe('child-head-sha');
    expect(mergeIntoWorktreeMock).not.toHaveBeenCalled();
  });

  it('lists mergeable TeamRun workspaces with review, activity, and behind warnings', async () => {
    const { teamRun, childWorkspace } = await createTeamRunChildMergeFixture({
      reviewVerdict: 'APPROVED',
    });
    getGitOperationStatusMock.mockResolvedValueOnce({
      operation: 'idle',
      conflictedFiles: [],
      conflictOp: null,
      ahead: 2,
      behind: 1,
      hasUncommittedChanges: false,
      uncommittedCount: 0,
      untrackedCount: 0,
    });

    const response = await service.listTeamRunMergeableWorkspaces(teamRun.id);

    expect(response).toMatchObject({
      teamRunId: teamRun.id,
      taskId: childWorkspace.taskId,
      workspaces: [
        expect.objectContaining({
          workspaceId: childWorkspace.id,
          headSha: 'child-head-sha',
          mergeReady: true,
          latestReview: expect.objectContaining({
            verdict: 'APPROVED',
            reviewedSha: 'child-head-sha',
            matchesHead: true,
            isSelfReview: false,
          }),
          git: expect.objectContaining({
            aheadOfMain: 2,
            behindMain: 1,
            clean: true,
          }),
          blockers: [
            expect.objectContaining({
              code: 'BEHIND_MAIN',
              severity: 'WARNING',
            }),
          ],
        }),
      ],
    });
  });

  it('reports readiness blockers for stale reviews, owner activity, and parent activity', async () => {
    const { teamRun, owner, childWorkspace, mainWorkspace } = await createTeamRunChildMergeFixture({
      reviewVerdict: 'APPROVED',
      reviewSha: 'old-sha',
    });
    const ownerRequest = await prisma.workRequest.create({
      data: {
        teamRunId: teamRun.id,
        requesterMemberId: null,
        requesterType: 'user',
        targetMemberId: owner.id,
        triggerMessageId: await createRoomMessageId(teamRun.id),
        instruction: 'continue writing',
        status: 'STARTED',
      },
    });
    await prisma.agentInvocation.create({
      data: {
        teamRunId: teamRun.id,
        workRequestId: ownerRequest.id,
        memberId: owner.id,
        workspaceId: childWorkspace.id,
        status: 'RUNNING',
      },
    });
    await prisma.session.create({
      data: {
        workspaceId: mainWorkspace.id,
        agentType: 'CODEX',
        prompt: 'write on parent',
        status: 'RUNNING',
      },
    });

    const response = await service.listTeamRunMergeableWorkspaces(teamRun.id);
    const item = response.workspaces[0]!;

    expect(item.mergeReady).toBe(false);
    expect(item.blockers.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      'REVIEW_STALE',
      'OWNER_HAS_ACTIVE_INVOCATION',
      'PARENT_WORKSPACE_HAS_ACTIVE_SESSION',
    ]));
  });

  it('dry-runs batch member merges without changing workspace state', async () => {
    const { teamRun, childWorkspace, invocation, merger } = await createTeamRunChildMergeFixture({
      reviewVerdict: 'APPROVED',
    });

    const result = await service.mergeTeamRunMembers(teamRun.id, {
      invocationId: invocation.id,
      requesterMemberId: merger.id,
      dryRun: true,
    });

    expect(result.summary).toMatchObject({
      requested: 1,
      considered: 1,
      wouldMerge: 1,
      merged: 0,
    });
    expect(result.results[0]).toMatchObject({
      workspaceId: childWorkspace.id,
      status: 'WOULD_MERGE',
    });
    expect(mergeIntoWorktreeMock).not.toHaveBeenCalled();
    await expect(prisma.workspace.findUnique({ where: { id: childWorkspace.id } })).resolves.toMatchObject({
      status: 'ACTIVE',
    });
  });

  it('treats an explicit empty workspaceIds batch request as an empty no-op', async () => {
    const { teamRun, childWorkspace, invocation, merger } = await createTeamRunChildMergeFixture({
      reviewVerdict: 'APPROVED',
    });

    const result = await service.mergeTeamRunMembers(teamRun.id, {
      invocationId: invocation.id,
      requesterMemberId: merger.id,
      workspaceIds: [],
    });

    expect(result.summary).toMatchObject({
      requested: 0,
      considered: 0,
      merged: 0,
      skipped: 0,
      conflicts: 0,
      failed: 0,
    });
    expect(result.requestedWorkspaceIds).toEqual([]);
    expect(result.results).toEqual([]);
    expect(mergeIntoWorktreeMock).not.toHaveBeenCalled();
    await expect(prisma.workspace.findUnique({ where: { id: childWorkspace.id } })).resolves.toMatchObject({
      status: 'ACTIVE',
    });
  });

  it('batch merge defaults to only merge-ready member workspaces', async () => {
    const { teamRun, childWorkspace, invocation, merger, mainWorkspace } = await createTeamRunChildMergeFixture({
      reviewVerdict: 'APPROVED',
    });
    const blockedOwner = await addTeamMember(teamRun.id, { name: 'Blocked owner' });
    const blockedWorkspace = await prisma.workspace.create({
      data: {
        taskId: childWorkspace.taskId,
        parentWorkspaceId: mainWorkspace.id,
        ownerMemberId: blockedOwner.id,
        branchName: 'blocked-child',
        baseBranch: mainWorkspace.branchName,
        worktreePath: path.join(testDir, 'blocked-child'),
        status: 'ACTIVE',
      },
    });

    const result = await service.mergeTeamRunMembers(teamRun.id, {
      invocationId: invocation.id,
      requesterMemberId: merger.id,
    });

    expect(result.summary).toMatchObject({
      requested: 2,
      considered: 2,
      merged: 1,
      skipped: 1,
    });
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        workspaceId: childWorkspace.id,
        status: 'MERGED',
        sha: 'child-merge-sha',
      }),
      expect.objectContaining({
        workspaceId: blockedWorkspace.id,
        status: 'SKIPPED',
        code: 'REVIEW_REQUIRED',
      }),
    ]));
    expect(mergeIntoWorktreeMock).toHaveBeenCalledTimes(1);
  });

  it('batch merge returns idempotent results for already merged workspaces', async () => {
    const { teamRun, childWorkspace, invocation, merger } = await createTeamRunChildMergeFixture({
      childStatus: 'MERGED',
    });

    const result = await service.mergeTeamRunMembers(teamRun.id, {
      invocationId: invocation.id,
      requesterMemberId: merger.id,
    });

    expect(result.summary).toMatchObject({
      requested: 1,
      considered: 1,
      alreadyMerged: 1,
      merged: 0,
    });
    expect(result.results[0]).toMatchObject({
      workspaceId: childWorkspace.id,
      status: 'ALREADY_MERGED',
      sha: 'child-head-sha',
    });
    expect(mergeIntoWorktreeMock).not.toHaveBeenCalled();
  });

  it('rejects batch member merge when invocation lacks mergeWorkspace capability', async () => {
    const { teamRun, invocation, merger } = await createTeamRunChildMergeFixture({
      mergerCapabilities: { mergeWorkspace: false },
      reviewVerdict: 'APPROVED',
    });

    await expect(service.mergeTeamRunMembers(teamRun.id, {
      invocationId: invocation.id,
      requesterMemberId: merger.id,
    })).rejects.toMatchObject({
      code: 'TEAM_RUN_MEMBER_CAPABILITY_REQUIRED',
      statusCode: 403,
    });
    expect(mergeIntoWorktreeMock).not.toHaveBeenCalled();
  });

  it('continues batch member merge after per-workspace failure', async () => {
    const { teamRun, childWorkspace, invocation, merger, mainWorkspace } = await createTeamRunChildMergeFixture({
      reviewVerdict: 'APPROVED',
    });
    const secondOwner = await addTeamMember(teamRun.id, { name: 'Second owner' });
    const secondWorkspace = await prisma.workspace.create({
      data: {
        taskId: childWorkspace.taskId,
        parentWorkspaceId: mainWorkspace.id,
        ownerMemberId: secondOwner.id,
        branchName: 'second-child',
        baseBranch: mainWorkspace.branchName,
        worktreePath: path.join(testDir, 'second-child'),
        status: 'ACTIVE',
      },
    });
    await prisma.workspaceVerdict.create({
      data: {
        workspaceId: secondWorkspace.id,
        teamRunId: teamRun.id,
        kind: 'REVIEW',
        verdict: 'APPROVED',
        reviewedSha: 'child-head-sha',
        reviewerMemberId: merger.id,
        reason: 'approved',
        sequence: 1,
      },
    });
    mergeIntoWorktreeMock
      .mockRejectedValueOnce(Object.assign(new Error('git failed'), { code: 'GIT_ERROR' }))
      .mockResolvedValueOnce({
        sha: 'second-merge-sha',
        sourceBranch: 'second-child',
        targetBranch: 'team-main',
      });

    const result = await service.mergeTeamRunMembers(teamRun.id, {
      invocationId: invocation.id,
      requesterMemberId: merger.id,
    });

    expect(result.summary).toMatchObject({
      requested: 2,
      considered: 2,
      failed: 1,
      merged: 1,
    });
    expect(result.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        workspaceId: childWorkspace.id,
        status: 'FAILED',
        code: 'GIT_ERROR',
      }),
      expect.objectContaining({
        workspaceId: secondWorkspace.id,
        status: 'MERGED',
        sha: 'second-merge-sha',
      }),
    ]));
    expect(mergeIntoWorktreeMock).toHaveBeenCalledTimes(2);
  });

  it('returns conflict item details from batch member merge', async () => {
    const { teamRun, childWorkspace, invocation, merger } = await createTeamRunChildMergeFixture({
      reviewVerdict: 'APPROVED',
    });
    const conflictError = Object.assign(new Error('Merge conflict in files: file.txt'), {
      name: 'MergeConflictError',
      code: 'MERGE_CONFLICT',
      conflictedFiles: ['file.txt'],
      sourceBranch: childWorkspace.branchName,
      targetBranch: 'team-main',
      sourceWorkspaceId: childWorkspace.id,
      targetWorkspaceId: 'main-workspace',
    });
    mergeIntoWorktreeMock.mockRejectedValueOnce(conflictError);

    const result = await service.mergeTeamRunMembers(teamRun.id, {
      invocationId: invocation.id,
      requesterMemberId: merger.id,
      stopOnConflict: true,
    });

    expect(result.summary).toMatchObject({
      conflicts: 1,
      merged: 0,
    });
    expect(result.results[0]).toMatchObject({
      workspaceId: childWorkspace.id,
      status: 'CONFLICT',
      code: 'MERGE_CONFLICT',
      conflictedFiles: ['file.txt'],
    });
  });

  it('releases the target workspace merge lock after batch member merge failure', async () => {
    const lockService = new TeamLockService();
    service = new WorkspaceService(lockService);
    const { teamRun, invocation, merger } = await createTeamRunChildMergeFixture({
      reviewVerdict: 'APPROVED',
    });
    mergeIntoWorktreeMock.mockRejectedValueOnce(Object.assign(new Error('git failed'), { code: 'GIT_ERROR' }));

    await service.mergeTeamRunMembers(teamRun.id, {
      invocationId: invocation.id,
      requesterMemberId: merger.id,
    });

    expect(lockService.listLocks()).toEqual([]);
  });

  it('reuses an existing target workspace merge lock held by the same invocation', async () => {
    const lockService = new TeamLockService();
    service = new WorkspaceService(lockService);
    const { teamRun, mainWorkspace, childWorkspace, invocation, merger } = await createTeamRunChildMergeFixture({
      reviewVerdict: 'APPROVED',
    });
    const lockKey = `workspace:${mainWorkspace.id}:merge`;
    expect(lockService.acquire(invocation.id, [lockKey])).toBe(true);

    const result = await service.mergeTeamRunMembers(teamRun.id, {
      invocationId: invocation.id,
      requesterMemberId: merger.id,
    });

    expect(result.results[0]).toMatchObject({
      workspaceId: childWorkspace.id,
      status: 'MERGED',
    });
    expect(lockService.isHeldBy(invocation.id, lockKey)).toBe(true);
    lockService.release(invocation.id, [lockKey]);
  });

  it('does not block a TeamRun member merge when a different target workspace is locked', async () => {
    const lockService = new TeamLockService();
    service = new WorkspaceService(lockService);
    const { teamRun, childWorkspace, invocation, merger } = await createTeamRunChildMergeFixture({
      reviewVerdict: 'APPROVED',
    });
    const unrelatedLockKey = 'workspace:other-task-main:merge';
    expect(lockService.acquire('other-task-owner', [unrelatedLockKey])).toBe(true);

    const result = await service.mergeTeamRunMembers(teamRun.id, {
      invocationId: invocation.id,
      requesterMemberId: merger.id,
    });

    expect(result.results[0]).toMatchObject({
      workspaceId: childWorkspace.id,
      status: 'MERGED',
    });
    expect(lockService.isHeldBy('other-task-owner', unrelatedLockKey)).toBe(true);
    lockService.release('other-task-owner', [unrelatedLockKey]);
  });

  it('rejects a TeamRun member merge when its target workspace is locked by another owner', async () => {
    const lockService = new TeamLockService();
    service = new WorkspaceService(lockService);
    const { teamRun, mainWorkspace, invocation, merger } = await createTeamRunChildMergeFixture({
      reviewVerdict: 'APPROVED',
    });
    const lockKey = `workspace:${mainWorkspace.id}:merge`;
    expect(lockService.acquire('other-merge-owner', [lockKey])).toBe(true);

    await expect(service.mergeTeamRunMembers(teamRun.id, {
      invocationId: invocation.id,
      requesterMemberId: merger.id,
    })).rejects.toMatchObject({
      code: 'WORKSPACE_MERGE_LOCKED',
    });
    expect(mergeIntoWorktreeMock).not.toHaveBeenCalled();
  });

  it('records workspace review and test verdicts for the current HEAD', async () => {
    const { teamRun, childWorkspace } = await createTeamRunChildMergeFixture();
    const reviewer = await addTeamMember(teamRun.id, {
      name: 'Review And Test',
      capabilities: { readDiff: true, runCommands: true },
    });

    const review = await service.recordVerdict(childWorkspace.id, {
      kind: 'REVIEW',
      verdict: 'APPROVED',
      reviewedSha: 'child-head-sha',
      reviewerMemberId: reviewer.id,
      reason: 'looks good',
    });
    const test = await service.recordVerdict(childWorkspace.id, {
      kind: 'TEST',
      verdict: 'PASSED',
      reviewedSha: 'child-head-sha',
      reviewerMemberId: reviewer.id,
      reason: 'unit tests passed',
    });

    expect(review).toMatchObject({
      workspaceId: childWorkspace.id,
      kind: 'REVIEW',
      verdict: 'APPROVED',
      reviewedSha: 'child-head-sha',
      reviewerMemberId: reviewer.id,
      sequence: 1,
    });
    expect(test).toMatchObject({
      workspaceId: childWorkspace.id,
      kind: 'TEST',
      verdict: 'PASSED',
      reviewedSha: 'child-head-sha',
      reviewerMemberId: reviewer.id,
      sequence: 1,
    });
    await expect(service.listVerdicts(childWorkspace.id)).resolves.toHaveLength(2);
  });

  it('resolves targeted invocation identity for verdicts recorded on the source workspace', async () => {
    const { teamRun, mainWorkspace, childWorkspace } = await createTeamRunChildMergeFixture();
    const reviewer = await addTeamMember(teamRun.id, {
      name: 'Targeted Reviewer',
      capabilities: { readDiff: true },
    });
    const executionWorkspace = await prisma.workspace.create({
      data: {
        taskId: childWorkspace.taskId,
        parentWorkspaceId: mainWorkspace.id,
        ownerMemberId: reviewer.id,
        branchName: 'targeted-review-execution',
        baseBranch: childWorkspace.branchName,
        worktreePath: path.join(testDir, 'targeted-review-execution'),
        status: 'ACTIVE',
      },
    });
    const request = await prisma.workRequest.create({
      data: {
        teamRunId: teamRun.id,
        requesterMemberId: null,
        requesterType: 'user',
        targetMemberId: reviewer.id,
        targetKind: 'WORKSPACE_COMMIT',
        targetPurpose: 'REVIEW',
        targetSourceWorkspaceId: childWorkspace.id,
        targetHeadSha: 'child-head-sha',
        targetBranchName: childWorkspace.branchName,
        triggerMessageId: await createRoomMessageId(teamRun.id),
        instruction: 'review target commit',
        status: 'STARTED',
      },
    });
    const invocation = await prisma.agentInvocation.create({
      data: {
        teamRunId: teamRun.id,
        workRequestId: request.id,
        memberId: reviewer.id,
        workspaceId: executionWorkspace.id,
        targetKind: 'WORKSPACE_COMMIT',
        targetPurpose: 'REVIEW',
        targetSourceWorkspaceId: childWorkspace.id,
        targetHeadSha: 'child-head-sha',
        targetBranchName: childWorkspace.branchName,
        targetSyncStatus: 'SYNCED',
        status: 'RUNNING',
      },
    });

    const identity = await service.resolveInvocationMemberForWorkspace(childWorkspace.id, invocation.id);
    expect(identity).toMatchObject({
      teamRunId: teamRun.id,
      memberId: reviewer.id,
      invocationId: invocation.id,
    });

    const review = await service.recordVerdict(childWorkspace.id, {
      kind: 'REVIEW',
      verdict: 'APPROVED',
      reviewedSha: 'child-head-sha',
      reviewerMemberId: identity!.memberId,
      reason: 'target commit reviewed',
    });

    expect(review).toMatchObject({
      workspaceId: childWorkspace.id,
      kind: 'REVIEW',
      verdict: 'APPROVED',
      reviewedSha: 'child-head-sha',
      reviewerMemberId: reviewer.id,
    });
  });

  it('rejects targeted workspace verdicts when the source workspace HEAD moved past targetHeadSha', async () => {
    const { teamRun, mainWorkspace, childWorkspace } = await createTeamRunChildMergeFixture();
    const reviewer = await addTeamMember(teamRun.id, {
      name: 'Stale Target Reviewer',
      capabilities: { readDiff: true },
    });
    const executionWorkspace = await prisma.workspace.create({
      data: {
        taskId: childWorkspace.taskId,
        parentWorkspaceId: mainWorkspace.id,
        ownerMemberId: reviewer.id,
        branchName: 'stale-target-execution',
        baseBranch: childWorkspace.branchName,
        worktreePath: path.join(testDir, 'stale-target-execution'),
        status: 'ACTIVE',
      },
    });
    const request = await prisma.workRequest.create({
      data: {
        teamRunId: teamRun.id,
        requesterMemberId: null,
        requesterType: 'user',
        targetMemberId: reviewer.id,
        targetKind: 'WORKSPACE_COMMIT',
        targetPurpose: 'REVIEW',
        targetSourceWorkspaceId: childWorkspace.id,
        targetHeadSha: 'old-target-sha',
        targetBranchName: childWorkspace.branchName,
        triggerMessageId: await createRoomMessageId(teamRun.id),
        instruction: 'review old target',
        status: 'STARTED',
      },
    });
    const invocation = await prisma.agentInvocation.create({
      data: {
        teamRunId: teamRun.id,
        workRequestId: request.id,
        memberId: reviewer.id,
        workspaceId: executionWorkspace.id,
        targetKind: 'WORKSPACE_COMMIT',
        targetPurpose: 'REVIEW',
        targetSourceWorkspaceId: childWorkspace.id,
        targetHeadSha: 'old-target-sha',
        targetBranchName: childWorkspace.branchName,
        targetSyncStatus: 'SYNCED',
        status: 'RUNNING',
      },
    });
    const identity = await service.resolveInvocationMemberForWorkspace(childWorkspace.id, invocation.id);

    await expect(service.recordVerdict(childWorkspace.id, {
      kind: 'REVIEW',
      verdict: 'APPROVED',
      reviewedSha: 'child-head-sha',
      reviewerMemberId: identity!.memberId,
      expectedTargetHeadSha: identity!.targetHeadSha,
    })).rejects.toMatchObject({
      code: 'TARGET_VERDICT_STALE',
      statusCode: 409,
    });
  });

  it('rejects targeted workspace verdicts when reviewedSha differs from targetHeadSha', async () => {
    const { teamRun, mainWorkspace, childWorkspace } = await createTeamRunChildMergeFixture();
    const reviewer = await addTeamMember(teamRun.id, {
      name: 'Target Mismatch Reviewer',
      capabilities: { readDiff: true },
    });
    const executionWorkspace = await prisma.workspace.create({
      data: {
        taskId: childWorkspace.taskId,
        parentWorkspaceId: mainWorkspace.id,
        ownerMemberId: reviewer.id,
        branchName: 'target-mismatch-execution',
        baseBranch: childWorkspace.branchName,
        worktreePath: path.join(testDir, 'target-mismatch-execution'),
        status: 'ACTIVE',
      },
    });
    const request = await prisma.workRequest.create({
      data: {
        teamRunId: teamRun.id,
        requesterMemberId: null,
        requesterType: 'user',
        targetMemberId: reviewer.id,
        targetKind: 'WORKSPACE_COMMIT',
        targetPurpose: 'REVIEW',
        targetSourceWorkspaceId: childWorkspace.id,
        targetHeadSha: 'child-head-sha',
        targetBranchName: childWorkspace.branchName,
        triggerMessageId: await createRoomMessageId(teamRun.id),
        instruction: 'review target',
        status: 'STARTED',
      },
    });
    const invocation = await prisma.agentInvocation.create({
      data: {
        teamRunId: teamRun.id,
        workRequestId: request.id,
        memberId: reviewer.id,
        workspaceId: executionWorkspace.id,
        targetKind: 'WORKSPACE_COMMIT',
        targetPurpose: 'REVIEW',
        targetSourceWorkspaceId: childWorkspace.id,
        targetHeadSha: 'child-head-sha',
        targetBranchName: childWorkspace.branchName,
        targetSyncStatus: 'SYNCED',
        status: 'RUNNING',
      },
    });
    const identity = await service.resolveInvocationMemberForWorkspace(childWorkspace.id, invocation.id);

    await expect(service.recordVerdict(childWorkspace.id, {
      kind: 'REVIEW',
      verdict: 'APPROVED',
      reviewedSha: 'different-sha',
      reviewerMemberId: identity!.memberId,
      expectedTargetHeadSha: identity!.targetHeadSha,
    })).rejects.toMatchObject({
      code: 'TARGET_VERDICT_SHA_MISMATCH',
      statusCode: 409,
    });
  });

  it('rejects workspace verdicts when the submitted SHA does not match HEAD', async () => {
    const { childWorkspace, reviewer } = await createTeamRunChildMergeFixture();

    await expect(service.recordVerdict(childWorkspace.id, {
      kind: 'REVIEW',
      verdict: 'APPROVED',
      reviewedSha: 'old-sha',
      reviewerMemberId: reviewer.id,
    })).rejects.toMatchObject({
      code: 'WORKSPACE_VERDICT_SHA_MISMATCH',
      statusCode: 409,
    });
  });

  it('rejects workspace verdicts when the current member lacks the required capability', async () => {
    const { teamRun, childWorkspace } = await createTeamRunChildMergeFixture();
    const memberWithoutReview = await addTeamMember(teamRun.id, {
      name: 'No Review Capability',
      capabilities: { runCommands: true },
    });
    const memberWithoutTest = await addTeamMember(teamRun.id, {
      name: 'No Test Capability',
      capabilities: { readDiff: true },
    });

    await expect(service.recordVerdict(childWorkspace.id, {
      kind: 'REVIEW',
      verdict: 'APPROVED',
      reviewedSha: 'child-head-sha',
      reviewerMemberId: memberWithoutReview.id,
    })).rejects.toMatchObject({
      code: 'TEAM_RUN_MEMBER_CAPABILITY_REQUIRED',
      statusCode: 403,
    });
    await expect(service.recordVerdict(childWorkspace.id, {
      kind: 'TEST',
      verdict: 'PASSED',
      reviewedSha: 'child-head-sha',
      reviewerMemberId: memberWithoutTest.id,
    })).rejects.toMatchObject({
      code: 'TEAM_RUN_MEMBER_CAPABILITY_REQUIRED',
      statusCode: 403,
    });
  });

  it('rejects final TeamRun main workspace merge while dedicated children are not final', async () => {
    const { task, teamRun, member } = await createTeamRunWithMember();
    await prisma.task.update({
      where: { id: task.id },
      data: { status: 'IN_REVIEW' },
    });
    const mainWorkspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'team-main',
        baseBranch: 'main',
        worktreePath: path.join(testDir, 'team-main'),
        status: 'ACTIVE',
      },
    });
    await prisma.teamRun.update({
      where: { id: teamRun.id },
      data: { mainWorkspaceId: mainWorkspace.id },
    });
    await prisma.workspace.create({
      data: {
        taskId: task.id,
        parentWorkspaceId: mainWorkspace.id,
        ownerMemberId: member.id,
        branchName: 'dedicated-child',
        baseBranch: mainWorkspace.branchName,
        worktreePath: path.join(testDir, 'dedicated-child'),
        status: 'ACTIVE',
      },
    });

    await expect(service.merge(mainWorkspace.id)).rejects.toMatchObject({
      code: 'TEAM_RUN_CHILD_WORKSPACES_NOT_FINAL',
    });
    expect(mergeWorktreeMock).not.toHaveBeenCalled();
    await expect(prisma.task.findUnique({ where: { id: task.id } })).resolves.toMatchObject({
      status: 'IN_REVIEW',
    });
  });

  it('rejects final merge from a non-main root workspace on a TeamRun task', async () => {
    const { task, teamRun, member } = await createTeamRunWithMember();
    await prisma.task.update({
      where: { id: task.id },
      data: { status: 'IN_REVIEW' },
    });
    const mainWorkspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'team-main',
        baseBranch: 'main',
        worktreePath: path.join(testDir, 'team-main'),
        status: 'ACTIVE',
      },
    });
    await prisma.teamRun.update({
      where: { id: teamRun.id },
      data: { mainWorkspaceId: mainWorkspace.id },
    });
    await prisma.workspace.create({
      data: {
        taskId: task.id,
        parentWorkspaceId: mainWorkspace.id,
        ownerMemberId: member.id,
        branchName: 'dedicated-child',
        baseBranch: mainWorkspace.branchName,
        worktreePath: path.join(testDir, 'dedicated-child'),
        status: 'ACTIVE',
      },
    });
    const extraRootWorkspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'extra-root',
        baseBranch: 'main',
        worktreePath: path.join(testDir, 'extra-root'),
        status: 'ACTIVE',
      },
    });

    await expect(service.merge(extraRootWorkspace.id)).rejects.toMatchObject({
      code: 'TEAM_RUN_NON_MAIN_WORKSPACE_FINAL_MERGE_FORBIDDEN',
    });
    expect(mergeWorktreeMock).not.toHaveBeenCalled();
    await expect(prisma.task.findUnique({ where: { id: task.id } })).resolves.toMatchObject({
      status: 'IN_REVIEW',
    });
  });

  it('rejects final TeamRun main workspace merge when ownerless children are not final', async () => {
    const { task, teamRun } = await createTeamRunWithMember();
    await prisma.task.update({
      where: { id: task.id },
      data: { status: 'IN_REVIEW' },
    });
    const mainWorkspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'team-main',
        baseBranch: 'main',
        worktreePath: path.join(testDir, 'team-main'),
        status: 'ACTIVE',
      },
    });
    await prisma.teamRun.update({
      where: { id: teamRun.id },
      data: { mainWorkspaceId: mainWorkspace.id },
    });
    await prisma.workspace.createMany({
      data: [
        {
          taskId: task.id,
          parentWorkspaceId: mainWorkspace.id,
          ownerMemberId: null,
          branchName: 'ownerless-active-child',
          baseBranch: mainWorkspace.branchName,
          worktreePath: path.join(testDir, 'ownerless-active-child'),
          status: 'ACTIVE',
        },
        {
          taskId: task.id,
          parentWorkspaceId: mainWorkspace.id,
          ownerMemberId: null,
          branchName: 'ownerless-hibernated-child',
          baseBranch: mainWorkspace.branchName,
          worktreePath: '',
          status: 'HIBERNATED',
          hibernatedAt: new Date(),
        },
      ],
    });

    await expect(service.merge(mainWorkspace.id)).rejects.toMatchObject({
      code: 'TEAM_RUN_CHILD_WORKSPACES_NOT_FINAL',
    });
    expect(mergeWorktreeMock).not.toHaveBeenCalled();
    await expect(prisma.task.findUnique({ where: { id: task.id } })).resolves.toMatchObject({
      status: 'IN_REVIEW',
    });
  });

  it('marks the task DONE only after the TeamRun main workspace final merge succeeds', async () => {
    const { task, teamRun, member } = await createTeamRunWithMember();
    await prisma.task.update({
      where: { id: task.id },
      data: { status: 'IN_REVIEW' },
    });
    const mainWorkspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'team-main',
        baseBranch: 'main',
        worktreePath: path.join(testDir, 'team-main'),
        status: 'ACTIVE',
      },
    });
    await prisma.teamRun.update({
      where: { id: teamRun.id },
      data: { mainWorkspaceId: mainWorkspace.id },
    });
    await prisma.workspace.create({
      data: {
        taskId: task.id,
        parentWorkspaceId: mainWorkspace.id,
        ownerMemberId: member.id,
        branchName: 'dedicated-child',
        baseBranch: mainWorkspace.branchName,
        worktreePath: path.join(testDir, 'dedicated-child'),
        status: 'MERGED',
      },
    });

    const sha = await service.merge(mainWorkspace.id, 'final merge');

    expect(sha).toBe('root-merge-sha');
    expect(mergeWorktreeMock).toHaveBeenCalledWith(
      mainWorkspace.worktreePath,
      'main',
      { commitMessage: 'final merge' },
    );
    await expect(prisma.workspace.findUnique({ where: { id: mainWorkspace.id } })).resolves.toMatchObject({
      status: 'MERGED',
    });
    await expect(prisma.task.findUnique({ where: { id: task.id } })).resolves.toMatchObject({
      status: 'DONE',
    });
  });

  it('locks the project main worktree only during a root workspace merge', async () => {
    const lockService = new TeamLockService();
    const lockedService = new WorkspaceService(lockService);
    const { project, task } = await createTask('locked merge task');
    const workspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'locked-main',
        baseBranch: 'main',
        worktreePath: path.join(testDir, 'locked-main'),
        status: 'ACTIVE',
      },
    });

    const lockKey = `project:${project.id}:main-worktree:merge`;
    expect(lockService.acquire('external-owner', [lockKey])).toBe(true);
    await expect(lockedService.merge(workspace.id)).rejects.toMatchObject({
      code: 'PROJECT_MERGE_LOCKED',
    });

    const sha = await lockedService.merge(workspace.id, { lockOwnerId: 'external-owner' });
    expect(sha).toBe('root-merge-sha');
    expect(lockService.isHeldBy('external-owner', lockKey)).toBe(true);
    lockService.release('external-owner', [lockKey]);
  });

  it('releases the project main worktree lock when a root workspace merge fails', async () => {
    const lockService = new TeamLockService();
    const lockedService = new WorkspaceService(lockService);
    const { task } = await createTask('failed root merge task');
    const workspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'failed-root-merge',
        baseBranch: 'main',
        worktreePath: path.join(testDir, 'failed-root-merge'),
        status: 'ACTIVE',
      },
    });
    mergeWorktreeMock.mockRejectedValueOnce(new Error('git merge failed'));

    await expect(lockedService.merge(workspace.id)).rejects.toThrow('git merge failed');

    expect(lockService.listLocks()).toEqual([]);
  });

  it('cleans up stale managed worktree records and deletes their branches', async () => {
    const { project, task } = await createTask('cleanup stale workspace task');
    await prisma.task.update({
      where: { id: task.id },
      data: { status: 'DONE' },
    });
    const workspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'at/12345678',
        worktreePath: path.join(project.repoPath, '..', '.worktrees', 'at', '12345678'),
        status: 'MERGED',
      },
    });
    removeWorktreeMock.mockResolvedValueOnce({
      status: 'stale_removed',
      path: workspace.worktreePath,
      managed: true,
    });

    const cleaned = await service.cleanup();

    expect(cleaned).toBe(1);
    expect(removeWorktreeMock).toHaveBeenCalledWith(workspace.worktreePath);
    expect(deleteBranchIfSafeMock).toHaveBeenCalledWith(workspace.branchName, {
      protectedBranches: [project.mainBranch, workspace.baseBranch],
    });
    await expect(prisma.workspace.findUnique({ where: { id: workspace.id } })).resolves.toBeNull();
  });

  it('cleans up stale managed TeamRun nested worktree records', async () => {
    const { project, task, teamRun } = await createTeamRunWithMember();
    await prisma.task.update({
      where: { id: task.id },
      data: { status: 'DONE' },
    });
    const workspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: `at/team/${teamRun.id.slice(0, 8)}/main/87654321`,
        worktreePath: path.join(
          project.repoPath,
          '..',
          '.worktrees',
          'at',
          'team',
          teamRun.id.slice(0, 8),
          'main',
          '87654321',
        ),
        status: 'MERGED',
      },
    });
    removeWorktreeMock.mockResolvedValueOnce({
      status: 'stale_removed',
      path: workspace.worktreePath,
      managed: true,
    });

    const cleaned = await service.cleanup();

    expect(cleaned).toBe(1);
    expect(removeWorktreeMock).toHaveBeenCalledWith(workspace.worktreePath);
    expect(deleteBranchIfSafeMock).toHaveBeenCalledWith(workspace.branchName, {
      protectedBranches: [project.mainBranch, workspace.baseBranch],
    });
    await expect(prisma.workspace.findUnique({ where: { id: workspace.id } })).resolves.toBeNull();
  });

  it('keeps non-managed unregistered worktree records for retry', async () => {
    const { task } = await createTask('cleanup unmanaged workspace task');
    await prisma.task.update({
      where: { id: task.id },
      data: { status: 'DONE' },
    });
    const workspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'at/unmanaged',
        worktreePath: path.join(testDir, 'outside-managed-worktree'),
        status: 'MERGED',
      },
    });
    removeWorktreeMock.mockResolvedValueOnce({
      status: 'unregistered',
      path: workspace.worktreePath,
      managed: false,
    });

    const cleaned = await service.cleanup();

    expect(cleaned).toBe(0);
    await expect(prisma.workspace.findUnique({ where: { id: workspace.id } })).resolves.toMatchObject({
      id: workspace.id,
    });
  });

  it('keeps managed unregistered ancestor worktree records for retry', async () => {
    const { project, task, teamRun } = await createTeamRunWithMember();
    await prisma.task.update({
      where: { id: task.id },
      data: { status: 'DONE' },
    });
    const ancestorPath = path.join(project.repoPath, '..', '.worktrees', 'at', 'team', teamRun.id.slice(0, 8));
    const workspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: `at/team/${teamRun.id.slice(0, 8)}`,
        worktreePath: ancestorPath,
        status: 'MERGED',
      },
    });
    removeWorktreeMock.mockResolvedValueOnce({
      status: 'unregistered',
      path: ancestorPath,
      managed: true,
    });

    const cleaned = await service.cleanup();

    expect(cleaned).toBe(0);
    expect(deleteBranchIfSafeMock).not.toHaveBeenCalledWith(workspace.branchName, expect.anything());
    await expect(prisma.workspace.findUnique({ where: { id: workspace.id } })).resolves.toMatchObject({
      id: workspace.id,
    });
  });

  it('does not cleanup active workspaces', async () => {
    const { task } = await createTask('cleanup active workspace task');
    await prisma.task.update({
      where: { id: task.id },
      data: { status: 'DONE' },
    });
    await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'at/active',
        worktreePath: path.join(testDir, 'active-worktree'),
        status: 'ACTIVE',
      },
    });

    const cleaned = await service.cleanup();

    expect(cleaned).toBe(0);
    expect(removeWorktreeMock).not.toHaveBeenCalled();
  });
});
