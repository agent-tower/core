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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, '../../..');
const schemaPath = path.join(serverRoot, 'prisma/schema.prisma');

let prisma: PrismaClient;
let workspaceRoutes: typeof import('../workspaces.js').workspaceRoutes;
let WorkspaceService: typeof import('../../services/workspace.service.js').WorkspaceService;

async function buildTestApp() {
  const app = Fastify();
  await app.register(workspaceRoutes, { prefix: '/api' });
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
