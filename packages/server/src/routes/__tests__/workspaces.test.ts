import { execFileSync } from 'node:child_process';
import Fastify from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { RuntimeType } from '@agent-tower/shared';
import { WorkspaceKind } from '../../types/index.js';
import type { WorkspaceSetupProgressPayload } from '@agent-tower/shared/socket';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-workspace-routes-'));
const dbPath = path.join(testDir, 'test.db');
process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;
process.env.AGENT_TOWER_DATA_DIR = path.join(testDir, 'data');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, '../../..');
const schemaPath = path.join(serverRoot, 'prisma/schema.prisma');

let prisma: PrismaClient;
let workspaceRoutes: typeof import('../workspaces.js').workspaceRoutes;
let projectRoutes: typeof import('../projects.js').projectRoutes;
let WorkspaceService: typeof import('../../services/workspace.service.js').WorkspaceService;

async function buildTestApp() {
  const app = Fastify();
  await app.register(workspaceRoutes, { prefix: '/api' });
  await app.register(projectRoutes, { prefix: '/api/projects' });
  return app;
}

async function createBranchSettingsFixture() {
  const repoPath = fs.mkdtempSync(path.join(testDir, 'branch-settings-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Branch Settings Test');
  git('config', 'user.email', 'branch-settings@example.test');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repoPath, 'base.txt'), 'base\n');
  git('add', '.');
  git('commit', '-m', 'initial');
  const mainHead = git('rev-parse', 'HEAD');
  git('checkout', '-b', 'develop');
  fs.writeFileSync(path.join(repoPath, 'develop.txt'), 'develop\n');
  git('add', '.');
  git('commit', '-m', 'advance develop');
  git('checkout', 'main');
  const worktreePath = path.join(repoPath, 'task-worktree');
  git('worktree', 'add', '-b', 'feature/settings', worktreePath, 'main');
  const worktreeGit = (...args: string[]) => execFileSync('git', args, { cwd: worktreePath, encoding: 'utf8', stdio: 'pipe' }).trim();
  fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'feature\n');
  worktreeGit('add', '.');
  worktreeGit('commit', '-m', 'feature');
  const project = await prisma.project.create({ data: { name: 'Branch settings', repoPath } });
  const task = await prisma.task.create({ data: { title: 'Change merge target', projectId: project.id, status: 'IN_REVIEW' } });
  const workspace = await prisma.workspace.create({ data: {
    taskId: task.id, branchName: 'feature/settings', baseBranch: 'main', worktreePath,
    workingDir: worktreePath, status: 'ACTIVE', commitMessage: 'old generated message',
  } });
  return { project, task, workspace, git, worktreeGit, mainHead };
}

describe('workspace routes', () => {
  beforeAll(async () => {
    fs.closeSync(fs.openSync(dbPath, 'a'));
    execFileSync(
      'pnpm',
      ['exec', 'prisma', 'db', 'push', '--skip-generate', `--schema=${schemaPath}`],
      {
        cwd: serverRoot,
        env: { ...process.env, AGENT_TOWER_DATABASE_URL: `file:${dbPath}` },
        stdio: 'pipe',
      },
    );

    const routeModule = await import('../workspaces.js');
    const workspaceServiceModule = await import('../../services/workspace.service.js');
    const utilsModule = await import('../../utils/index.js');
    workspaceRoutes = routeModule.workspaceRoutes;
    projectRoutes = (await import('../projects.js')).projectRoutes;
    WorkspaceService = workspaceServiceModule.WorkspaceService;
    prisma = utilsModule.prisma;
  });

  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.task.deleteMany();
    await prisma.project.deleteMany();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('changes the project default for new worktrees and preserves existing and legacy workspace targets', async () => {
    const { project, task, workspace, git, worktreeGit, mainHead } = await createBranchSettingsFixture();
    const legacyWorkspace = await prisma.workspace.create({ data: {
      taskId: task.id, branchName: 'legacy-task', worktreePath: '', baseBranch: null, status: 'HIBERNATED',
    } });
    const app = await buildTestApp();
    try {
      const previousHead = worktreeGit('rev-parse', 'HEAD');
      const response = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}`, payload: { mainBranch: 'develop' } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().mainBranch).toBe('develop');
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })).baseBranch).toBe('main');
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id: legacyWorkspace.id } })).baseBranch).toBe('main');
      expect(worktreeGit('rev-parse', 'HEAD')).toBe(previousHead);
      expect(git('branch', '--show-current')).toBe('main');

      const newTask = await prisma.task.create({ data: { projectId: project.id, title: 'Use the new default' } });
      const created = await app.inject({ method: 'POST', url: `/api/tasks/${newTask.id}/workspaces`, payload: {} });
      expect(created.statusCode, created.body).toBe(201);
      expect(created.json().baseBranch).toBe('develop');
      expect(git('rev-parse', created.json().branchName)).toBe(git('rev-parse', 'develop'));
      expect(git('rev-parse', created.json().branchName)).not.toBe(mainHead);

      // Member workspaces keep their explicit parent branch, independently of the project default.
      const child = await new WorkspaceService().create(task.id, {
        parentWorkspaceId: workspace.id, startPoint: workspace.branchName, reuseInactive: false,
      });
      expect(child.baseBranch).toBe(workspace.branchName);
      expect(git('rev-parse', child.branchName)).toBe(previousHead);
      const options = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/workspace-branches` });
      expect(options.json().mainBranch).toBe('develop');
      expect(options.json().workspaces.some((item: { id: string }) => item.id === child.id)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('returns every local branch and sees newly created branches on the next request', async () => {
    const { project, git, mainHead } = await createBranchSettingsFixture();
    const branches = Array.from({ length: 1200 }, (_, index) => `feature/branch-${String(index).padStart(4, '0')}`);
    execFileSync('git', ['update-ref', '--stdin'], {
      cwd: project.repoPath, input: branches.map((branch) => `create refs/heads/${branch} ${mainHead}`).join('\n') + '\n', stdio: ['pipe', 'pipe', 'pipe'],
    });
    const app = await buildTestApp();
    try {
      const response = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/workspace-branches` });
      expect(response.statusCode).toBe(200);
      expect(response.json().branches).toEqual([...branches, 'develop', 'feature/settings', 'main'].sort());
      git('branch', 'release/newest');
      const refreshed = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/workspace-branches` });
      expect(refreshed.json().branches).toHaveLength(branches.length + 4);
      expect(refreshed.json().branches).toContain('release/newest');
    } finally {
      await app.close();
    }
  });

  it('rejects missing, remote-only and tag defaults without changing the saved default', async () => {
    const { project, task, git, mainHead } = await createBranchSettingsFixture();
    git('update-ref', 'refs/remotes/origin/remote-only', mainHead);
    git('tag', 'tag-only');
    const app = await buildTestApp();
    try {
      for (const mainBranch of ['', 'missing', 'origin/remote-only', 'tag-only', 'main~1']) {
        const response = await app.inject({ method: 'PUT', url: `/api/projects/${project.id}`, payload: { mainBranch } });
        expect(response.statusCode, response.body).toBe(400);
      }
      expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).mainBranch).toBe('main');
      const count = await prisma.workspace.count();
      await prisma.project.update({ where: { id: project.id }, data: { mainBranch: 'missing' } });
      const created = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/workspaces`, payload: {} });
      expect(created.statusCode).toBe(400);
      expect(created.json().code).toBe('INVALID_BASE_BRANCH');
      expect(await prisma.workspace.count()).toBe(count);
    } finally {
      await app.close();
    }
  });

  it('rejects foreign-origin owner operations before Git execution or context issuance', async () => {
    const merge = vi.spyOn(WorkspaceService.prototype, 'merge'); const rebase = vi.spyOn(WorkspaceService.prototype, 'rebase');
    const app = await buildTestApp();
    try {
      for (const action of ['merge', 'rebase']) {
        const response = await app.inject({ method: 'POST', url: `/api/workspaces/unused/${action}`, headers: { origin: 'https://foreign.example' }, payload: {} });
        expect(response.statusCode).toBe(403);
      }
      expect(merge).not.toHaveBeenCalled(); expect(rebase).not.toHaveBeenCalled();
    } finally { merge.mockRestore(); rebase.mockRestore(); await app.close() }
  });

  it('seals real rebase conflict details and live Git status into scoped system instructions', async () => {
    const { project, workspace, git, worktreeGit } = await createBranchSettingsFixture();
    fs.appendFileSync(path.join(project.repoPath, '.git/info/exclude'), '\ntask-worktree/\n');
    git('checkout', 'develop'); fs.writeFileSync(path.join(project.repoPath, 'base.txt'), 'target change\n'); git('add', 'base.txt'); git('commit', '-m', 'target conflict'); git('checkout', 'main');
    fs.writeFileSync(path.join(workspace.worktreePath, 'base.txt'), 'source change\n'); worktreeGit('add', '.'); worktreeGit('commit', '-m', 'source conflict');
    await prisma.workspace.update({ where: { id: workspace.id }, data: { baseBranch: 'develop' } });
    const receiver = await prisma.session.create({ data: { workspaceId: workspace.id, agentType: 'CURSOR_AGENT', prompt: 'resolve' } });
    const app = await buildTestApp();
    try {
      const response = await app.inject({ method: 'POST', url: `/api/workspaces/${workspace.id}/rebase` });
      expect(response.statusCode).toBe(409);
      const details = response.json(); expect(details).toMatchObject({ conflictOp: 'REBASE', sourceWorkspaceId: workspace.id, targetWorkspaceId: workspace.id, sourceBranch: 'feature/settings', targetBranch: 'develop', conflictedFiles: ['base.txt'] });
      expect(details.resolutionContextToken).toEqual(expect.any(String));
      const { resolveConflictInstructions } = await import('../../services/conflict-resolution-context.js');
      const instructions = await prisma.$transaction(tx => resolveConflictInstructions(tx, details.resolutionContextToken, receiver.id, 'owner'));
      expect(instructions).toContain(JSON.stringify(workspace.worktreePath)); expect(instructions).toContain('rebase --continue');
      const status = await app.inject({ url: `/api/workspaces/${workspace.id}/git-status` });
      expect(status.statusCode).toBe(200);
      expect(await prisma.$transaction(tx => resolveConflictInstructions(tx, status.json().resolutionContextToken, receiver.id, 'owner'))).toContain('base.txt');
      const gitModule = await import('../../git/git-cli.js'); const readOnly = vi.spyOn(gitModule, 'execGit');
      try {
        expect(await prisma.$transaction(tx => resolveConflictInstructions(tx, undefined, receiver.id, 'owner'))).toContain('rebase --continue');
        expect(readOnly.mock.calls.every(([, args]) => !['merge', 'rebase', 'reset', 'checkout', 'add', 'commit'].includes(args[0]))).toBe(true);
      } finally { readOnly.mockRestore() }
      const unaccepted = details.resolutionContextToken.split('.');
      await expect(prisma.$transaction(tx => resolveConflictInstructions(tx, `${unaccepted[0]}.lost-process-key`, receiver.id, 'owner'))).rejects.toMatchObject({ code: 'CONFLICT_CONTEXT_INVALID' });
    } finally { await app.close(); }
  }, 15_000);

  it('seals a real cross-worktree no_ff merge conflict even after Git abort removes the live conflict state', async () => {
    const { project, task, workspace, git, worktreeGit } = await createBranchSettingsFixture();
    fs.appendFileSync(path.join(project.repoPath, '.git/info/exclude'), '\ntask-worktree/\n');
    fs.writeFileSync(path.join(project.repoPath, 'base.txt'), 'target change\n'); git('add', 'base.txt'); git('commit', '-m', 'target conflict');
    fs.writeFileSync(path.join(workspace.worktreePath, 'base.txt'), 'source change\n'); worktreeGit('add', '.'); worktreeGit('commit', '-m', 'source conflict');
    const target = await prisma.workspace.create({ data: { taskId: task.id, branchName: 'main', worktreePath: project.repoPath, workingDir: project.repoPath } });
    await prisma.workspace.update({ where: { id: workspace.id }, data: { parentWorkspaceId: target.id } });
    const receiver = await prisma.session.create({ data: { workspaceId: workspace.id, agentType: 'CURSOR_AGENT', prompt: 'resolve' } });
    const app = await buildTestApp();
    try {
      const response = await app.inject({ method: 'POST', url: `/api/workspaces/${workspace.id}/merge`, payload: {} });
      expect({ status: response.statusCode, body: response.json() }).toMatchObject({ status: 409, body: { mergeAborted: true } });
      const details = response.json(); expect(details).toMatchObject({ mergeAborted: true, mergeStrategy: 'no_ff', sourceWorkspaceId: workspace.id, targetWorkspaceId: target.id, conflictedFiles: ['base.txt'] });
      expect(git('status', '--porcelain')).toBe('');
      const { resolveConflictInstructions } = await import('../../services/conflict-resolution-context.js');
      const instructions = await prisma.$transaction(tx => resolveConflictInstructions(tx, details.resolutionContextToken, receiver.id, 'owner'));
      expect(instructions).toContain(JSON.stringify(project.repoPath)); expect(instructions).toContain('already aborted'); expect(instructions).toContain("merge --no-ff -- 'feature/settings'");
      const gitModule = await import('../../git/git-cli.js'); const readOnly = vi.spyOn(gitModule, 'execGit');
      try {
        await expect(prisma.$transaction(tx => resolveConflictInstructions(tx, undefined, receiver.id, 'owner'))).rejects.toMatchObject({ code: 'CONFLICT_CONTEXT_INVALID', message: expect.stringContaining('explicitly run the original Git operation again') });
        expect(readOnly.mock.calls.every(([, args]) => !['merge', 'rebase', 'reset', 'checkout', 'add', 'commit'].includes(args[0]))).toBe(true);
        expect(git('status', '--porcelain')).toBe('');
      } finally { readOnly.mockRestore() }
    } finally { await app.close(); }
  }, 15_000);

  it('seals real project-directory squash conflicts when the target advances after preflight and abort cannot clear squash state', async () => {
    const { project, workspace, git, worktreeGit } = await createBranchSettingsFixture();
    fs.appendFileSync(path.join(project.repoPath, '.git/info/exclude'), '\ntask-worktree/\n');
    fs.writeFileSync(path.join(workspace.worktreePath, 'base.txt'), 'source change\n'); worktreeGit('add', '.'); worktreeGit('commit', '-m', 'source conflict');
    const { WorktreeManager } = await import('../../git/worktree.manager.js');
    const preflight = WorktreeManager.prototype.getBranchStatus;
    const race = vi.spyOn(WorktreeManager.prototype, 'getBranchStatus').mockImplementation(async function (this: InstanceType<typeof WorktreeManager>, ...args) {
      const result = await preflight.apply(this, args);
      if (result.behind === 0) {
        fs.writeFileSync(path.join(project.repoPath, 'base.txt'), 'target advanced after preflight\n'); git('add', 'base.txt'); git('commit', '-m', 'concurrent target update');
      }
      return result;
    });
    const receiver = await prisma.session.create({ data: { workspaceId: workspace.id, agentType: 'CURSOR_AGENT', prompt: 'resolve' } });
    const app = await buildTestApp();
    try {
      const response = await app.inject({ method: 'POST', url: `/api/workspaces/${workspace.id}/merge`, payload: {} });
      expect(response.statusCode).toBe(409);
      const details = response.json(); expect(details).toMatchObject({ mergeAborted: false, mergeStrategy: 'squash', sourceWorkspaceId: workspace.id, targetWorktreePath: project.repoPath });
      expect(details.targetWorkspaceId).toBeUndefined(); expect(git('diff', '--name-only', '--diff-filter=U')).toBe('base.txt');
      const { resolveConflictInstructions } = await import('../../services/conflict-resolution-context.js');
      const instructions = await prisma.$transaction(tx => resolveConflictInstructions(tx, details.resolutionContextToken, receiver.id, 'owner'));
      expect(instructions).toContain('"targetKind":"PROJECT"'); expect(instructions).toContain('"mergeStrategy":"squash"');
      expect(instructions).toContain('was not aborted'); expect(instructions).toContain(' commit'); expect(instructions).not.toContain('reproduce the original');
    } finally { race.mockRestore(); await app.close() }
  }, 15_000);

  it('changes the saved base branch without moving HEAD, then rebases and merges into the chosen branch', async () => {
    const { project, task, workspace, git, worktreeGit, mainHead } = await createBranchSettingsFixture();
    const app = await buildTestApp();
    try {
      const options = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/workspace-branches` });
      expect(options.statusCode).toBe(200);
      expect(options.json()).toMatchObject({
        mainBranch: 'main', branches: ['develop', 'feature/settings', 'main'],
        workspaces: [{ id: workspace.id, taskId: task.id, taskTitle: task.title, baseBranch: 'main' }],
      });
      const previousHead = worktreeGit('rev-parse', 'HEAD');
      const response = await app.inject({
        method: 'PATCH', url: `/api/workspaces/${workspace.id}/base-branch`,
        payload: { baseBranch: 'develop', expectedBaseBranch: 'main' },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ id: workspace.id, baseBranch: 'develop' });
      expect(worktreeGit('rev-parse', 'HEAD')).toBe(previousHead);
      expect(git('branch', '--show-current')).toBe('main');
      expect(await prisma.workspace.findUnique({ where: { id: workspace.id } })).toMatchObject({ baseBranch: 'develop', commitMessage: null });
      const status = await app.inject({ method: 'GET', url: `/api/workspaces/${workspace.id}/git-status` });
      expect(status.json()).toMatchObject({ ahead: 1, behind: 1 });
      const rebase = await app.inject({ method: 'POST', url: `/api/workspaces/${workspace.id}/rebase` });
      expect(rebase.statusCode, rebase.body).toBe(200);
      expect(worktreeGit('merge-base', 'HEAD', 'develop')).toBe(git('rev-parse', 'develop'));
      const merge = await app.inject({ method: 'POST', url: `/api/workspaces/${workspace.id}/merge`, payload: { commitMessage: 'merge into develop' } });
      expect(merge.statusCode, merge.body).toBe(200);
      expect(git('rev-parse', 'develop')).toBe(merge.json().sha);
      expect(git('rev-parse', 'main')).toBe(mainHead);
    } finally {
      await app.close();
    }
  }, 20_000);

  it('rejects missing, self, revision and stale branch selections without changing the saved branch', async () => {
    const { workspace } = await createBranchSettingsFixture();
    const app = await buildTestApp();
    try {
      for (const baseBranch of ['missing', workspace.branchName, 'HEAD', 'origin/develop', 'develop~1']) {
        const response = await app.inject({ method: 'PATCH', url: `/api/workspaces/${workspace.id}/base-branch`, payload: { baseBranch, expectedBaseBranch: 'main' } });
        expect(response.statusCode, response.body).toBe(400);
        expect(response.json().code).toBe('INVALID_BASE_BRANCH');
      }
      const stale = await app.inject({ method: 'PATCH', url: `/api/workspaces/${workspace.id}/base-branch`, payload: { baseBranch: 'develop', expectedBaseBranch: null } });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().code).toBe('WORKSPACE_BASE_BRANCH_CHANGED');
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })).baseBranch).toBe('main');
    } finally {
      await app.close();
    }
  });

  it('blocks active agents and unfinished Git operations', async () => {
    const { workspace, worktreeGit } = await createBranchSettingsFixture();
    const app = await buildTestApp();
    try {
      const session = await prisma.session.create({ data: { workspaceId: workspace.id, agentType: 'CODEX', prompt: 'work', status: 'RUNNING' } });
      const save = () => app.inject({ method: 'PATCH', url: `/api/workspaces/${workspace.id}/base-branch`, payload: { baseBranch: 'develop', expectedBaseBranch: 'main' } });
      const busy = await save();
      expect(busy.statusCode).toBe(409);
      expect(busy.json().code).toBe('WORKSPACE_BASE_BRANCH_BUSY');
      await prisma.session.delete({ where: { id: session.id } });
      fs.writeFileSync(worktreeGit('rev-parse', '--git-path', 'MERGE_HEAD'), `${worktreeGit('rev-parse', 'develop')}\n`);
      const inProgress = await save();
      expect(inProgress.statusCode).toBe(409);
      expect(inProgress.json().code).toBe('WORKSPACE_GIT_OPERATION_IN_PROGRESS');
      expect((await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })).baseBranch).toBe('main');
    } finally {
      await app.close();
    }
  });

  it('excludes managed, inactive and main-directory workspaces and refuses updates to them', async () => {
    const { project, task, workspace } = await createBranchSettingsFixture();
    const app = await buildTestApp();
    try {
      for (const [data, code] of [
        [{ parentWorkspaceId: workspace.id }, 'WORKSPACE_BASE_BRANCH_MANAGED'],
        [{ status: 'HIBERNATED' }, 'INVALID_WORKSPACE_STATE'],
        [{ workspaceKind: WorkspaceKind.MAIN_DIRECTORY }, 'WORKSPACE_GIT_UNAVAILABLE'],
      ] as const) {
        const other = await prisma.workspace.create({ data: { taskId: task.id, branchName: `other-${code}`, worktreePath: workspace.worktreePath, baseBranch: 'main', ...data } });
        const response = await app.inject({ method: 'PATCH', url: `/api/workspaces/${other.id}/base-branch`, payload: { baseBranch: 'develop', expectedBaseBranch: 'main' } });
        expect(response.statusCode, response.body).toBeGreaterThanOrEqual(400);
        expect(response.json().code).toBe(code);
      }
      const options = await app.inject({ method: 'GET', url: `/api/projects/${project.id}/workspace-branches` });
      expect(options.json().workspaces.map((item: { id: string }) => item.id)).toEqual([workspace.id]);
      await prisma.task.update({ where: { id: task.id }, data: { deletedAt: new Date() } });
      const deleted = await app.inject({ method: 'PATCH', url: `/api/workspaces/${workspace.id}/base-branch`, payload: { baseBranch: 'develop', expectedBaseBranch: 'main' } });
      expect(deleted.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('rejects unrelated branch histories and archived projects', async () => {
    const { project, workspace, git } = await createBranchSettingsFixture();
    git('checkout', '--orphan', 'unrelated');
    git('commit', '-m', 'unrelated root');
    git('checkout', 'main');
    const app = await buildTestApp();
    try {
      const response = await app.inject({ method: 'PATCH', url: `/api/workspaces/${workspace.id}/base-branch`, payload: { baseBranch: 'unrelated', expectedBaseBranch: 'main' } });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe('BASE_BRANCH_UNRELATED');
      await prisma.project.update({ where: { id: project.id }, data: { archivedAt: new Date() } });
      const archived = await app.inject({ method: 'PATCH', url: `/api/workspaces/${workspace.id}/base-branch`, payload: { baseBranch: 'develop', expectedBaseBranch: 'main' } });
      expect(archived.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('validates update payloads and reserves branch settings for users', async () => {
    const app = await buildTestApp();
    app.addHook('onRequest', async (request) => {
      if (request.headers['x-test-agent']) request.agentTowerAuthKind = 'agent';
    });
    try {
      for (const payload of [{ baseBranch: '' }, { baseBranch: 'develop' }, { baseBranch: 'develop', expectedBaseBranch: 'main', extra: true }]) {
        const response = await app.inject({ method: 'PATCH', url: '/api/workspaces/missing/base-branch', payload });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('VALIDATION_ERROR');
      }
      const agent = await app.inject({ method: 'PATCH', url: '/api/workspaces/missing/base-branch', headers: { 'x-test-agent': 'true' }, payload: { baseBranch: 'develop', expectedBaseBranch: 'main' } });
      expect(agent.statusCode).toBe(403);
      expect(agent.json().code).toBe('WORKSPACE_BASE_BRANCH_USER_ONLY');
    } finally {
      await app.close();
    }
  });

  it('returns session runtimeType so task detail can offer same-type Provider switching', async () => {
    const repoPath = fs.mkdtempSync(path.join(testDir, 'runtime-route-project-'));
    const project = await prisma.project.create({
      data: { name: 'Runtime route project', repoPath },
    });
    const task = await prisma.task.create({
      data: { title: 'Runtime route task', projectId: project.id },
    });
    const workspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'runtime-route',
        worktreePath: repoPath,
        status: 'ACTIVE',
        sessions: {
          create: [
            { agentType: 'CODEX', runtimeType: RuntimeType.ACP, providerId: 'codex-acp-primary', prompt: 'run', status: 'RUNNING' },
            { agentType: 'CODEX', runtimeType: RuntimeType.CLI, providerId: 'codex-cli', prompt: 'run', status: 'RUNNING' },
          ],
        },
      },
      include: { sessions: true },
    });
    const app = await buildTestApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}/workspaces`,
      });

      expect(response.statusCode).toBe(200);
      const payload = response.json() as Array<{ id: string; sessions: Array<{ id: string; runtimeType?: string }> }>;
      const sessions = payload.find(item => item.id === workspace.id)?.sessions ?? [];
      const acpSession = workspace.sessions.find(session => session.runtimeType === RuntimeType.ACP);
      const cliSession = workspace.sessions.find(session => session.runtimeType === RuntimeType.CLI);

      expect(sessions.find(session => session.id === acpSession?.id)?.runtimeType).toBe(RuntimeType.ACP);
      expect(sessions.find(session => session.id === cliSession?.id)?.runtimeType).toBe(RuntimeType.CLI);
    } finally {
      await app.close();
    }
  });

  it('returns git unavailable for non-git main-directory workspace status', async () => {
    const repoPath = fs.mkdtempSync(path.join(testDir, 'local-route-project-'));
    const project = await prisma.project.create({
      data: {
        name: 'Local route project',
        repoPath,
      },
    });
    const task = await prisma.task.create({
      data: {
        title: 'Local route task',
        projectId: project.id,
      },
    });
    const workspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        workspaceKind: WorkspaceKind.MAIN_DIRECTORY,
        branchName: 'main-directory',
        worktreePath: repoPath,
        workingDir: repoPath,
        status: 'ACTIVE',
      },
    });
    const app = await buildTestApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/workspaces/${workspace.id}/git-status`,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: 'WORKSPACE_GIT_UNAVAILABLE',
      });
    } finally {
      await app.close();
    }
  });

  it('forwards explicit background service confirmation to the merge service', async () => {
    const resolveIdentity = vi.spyOn(
      WorkspaceService.prototype,
      'resolveInvocationMemberForWorkspace',
    ).mockResolvedValue(null);
    const merge = vi.spyOn(WorkspaceService.prototype, 'merge').mockResolvedValue('merge-sha');
    const app = await buildTestApp();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/workspaces/workspace-1/merge',
        payload: {
          commitMessage: 'fix: merge safely',
          stopActiveServices: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(merge).toHaveBeenCalledWith('workspace-1', expect.objectContaining({
        commitMessage: 'fix: merge safely',
        stopActiveServices: true,
      }));
    } finally {
      await app.close();
      merge.mockRestore();
      resolveIdentity.mockRestore();
    }
  });

  it('restores setup progress through REST after the running event has already been emitted', async () => {
    const repoPath = fs.mkdtempSync(path.join(testDir, 'setup-route-project-'));
    execFileSync('git', ['init', '-b', 'main', repoPath], { stdio: 'pipe' });
    fs.writeFileSync(path.join(repoPath, 'README.md'), 'Setup progress test\n');
    execFileSync('git', ['-C', repoPath, 'add', '.']);
    execFileSync('git', ['-C', repoPath, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'], { stdio: 'pipe' });
    const setupScript = 'node -e "console.log(\'setup-ok\'); setTimeout(() => {}, 400)"';
    const project = await prisma.project.create({ data: { name: 'Setup route project', repoPath, mainBranch: 'main', setupScript } });
    const task = await prisma.task.create({ data: { title: 'Setup route task', projectId: project.id } });
    const { getEventBus } = await import('../../core/container.js');
    const events: WorkspaceSetupProgressPayload[] = [];
    let finish!: () => void;
    const completed = new Promise<void>(resolve => { finish = resolve; });
    const onProgress = (payload: WorkspaceSetupProgressPayload) => {
      if (payload.taskId !== task.id) return;
      events.push(payload);
      if (payload.status === 'completed') finish();
    };
    getEventBus().on('workspace:setup_progress', onProgress);
    const app = await buildTestApp();
    try {
      await new WorkspaceService().create(task.id, {});
      expect(events[0]?.status).toBe('running');
      const running = await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/setup-progress` });
      expect(running.statusCode).toBe(200);
      expect(running.json()).toEqual([expect.objectContaining({ status: 'running', currentCommand: setupScript, updatedAt: expect.any(Number) })]);
      await completed;
      const finished = await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/setup-progress` });
      expect(finished.json()).toEqual([expect.objectContaining({ status: 'completed', output: expect.stringContaining('setup-ok') })]);
      expect(events[1].updatedAt).toBeGreaterThan(events[0].updatedAt);

      await prisma.task.update({ where: { id: task.id }, data: { deletedAt: new Date() } });
      const deleted = await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/setup-progress` });
      expect(deleted.statusCode).toBe(404);
    } finally {
      await completed;
      getEventBus().off('workspace:setup_progress', onProgress);
      await app.close();
    }
  });
});
