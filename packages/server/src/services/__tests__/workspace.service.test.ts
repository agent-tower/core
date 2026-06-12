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
  execGitMock,
  refreshWorkspaceGitWatcherMock,
  unwatchWorkspaceGitWatcherMock,
} = vi.hoisted(() => ({
  createWorktreeMock: vi.fn(),
  ensureWorktreeExistsMock: vi.fn(),
  removeWorktreeMock: vi.fn(),
  deleteBranchIfSafeMock: vi.fn(),
  mergeWorktreeMock: vi.fn(),
  mergeIntoWorktreeMock: vi.fn(),
  execGitMock: vi.fn(),
  refreshWorkspaceGitWatcherMock: vi.fn(async () => undefined),
  unwatchWorkspaceGitWatcherMock: vi.fn(),
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
      getGitOperationStatus: vi.fn(),
      abortOperation: vi.fn(),
      merge: mergeWorktreeMock,
      mergeIntoWorktree: mergeIntoWorktreeMock,
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
    if (args[0] === 'status') {
      return '';
    }
    return '';
});

vi.mock('../copy-files.service.js', () => ({
  copyProjectFiles: vi.fn(),
}));

vi.mock('../../core/container.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/container.js')>();
  return {
    ...actual,
    getWorkspaceGitWatcherService: vi.fn(() => ({
      refreshWorkspace: refreshWorkspaceGitWatcherMock,
      unwatchWorkspace: unwatchWorkspaceGitWatcherMock,
      start: vi.fn(),
      stop: vi.fn(),
    })),
  };
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, '../../..');
const schemaPath = path.join(serverRoot, 'prisma/schema.prisma');

let prisma: PrismaClient;
let WorkspaceService: typeof import('../workspace.service.js').WorkspaceService;

async function createTask(title = 'Workspace service task') {
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
      if (args[0] === 'status') {
        return '';
      }
      return '';
    });
    createWorktreeMock.mockImplementation(async (branchName: string) => mockCreatedWorktreePath(branchName));
    ensureWorktreeExistsMock.mockImplementation(async (branchName: string) => mockRestoredWorktreePath(branchName));
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

    const sha = await service.merge(childWorkspace.id, 'merge child');

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
    await prisma.session.create({
      data: {
        workspaceId: mainWorkspace.id,
        agentType: 'CODEX',
        prompt: 'write on main',
        status: 'RUNNING',
      },
    });

    await expect(service.merge(childWorkspace.id)).rejects.toMatchObject({
      code: 'PARENT_WORKSPACE_HAS_ACTIVE_SESSION',
    });
    expect(mergeIntoWorktreeMock).not.toHaveBeenCalled();
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

  it('uses the shared project merge lock and allows the current invocation owner to merge', async () => {
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

    expect(lockService.acquire('external-owner', [`project:${project.id}:merge`])).toBe(true);
    await expect(lockedService.merge(workspace.id)).rejects.toMatchObject({
      code: 'PROJECT_MERGE_LOCKED',
    });

    const sha = await lockedService.merge(workspace.id, { lockOwnerId: 'external-owner' });
    expect(sha).toBe('root-merge-sha');
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
