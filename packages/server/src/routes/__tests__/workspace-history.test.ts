import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentType, WorkspaceKind } from '@agent-tower/shared';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-workspace-history-'));
process.env.AGENT_TOWER_DATABASE_URL = `file:${path.join(testDir, 'test.db')}`;
process.env.AGENT_TOWER_DATA_DIR = path.join(testDir, 'data');
const serverRoot = fileURLToPath(new URL('../../../', import.meta.url));

let prisma: typeof import('../../utils/index.js').prisma;
let WorkspaceService: typeof import('../../services/workspace.service.js').WorkspaceService;
let TaskService: typeof import('../../services/task.service.js').TaskService;
let TaskCleanupService: typeof import('../../services/task-cleanup.service.js').TaskCleanupService;
let container: typeof import('../../core/container.js');
let stores: typeof import('../../output/index.js').sessionMsgStoreManager;

const snapshot = {
  entries: [
    { id: 'user-1', entryType: 'user_message', content: 'Keep this task history' },
    { id: 'tool-1', entryType: 'tool_use', content: 'Read source', toolName: 'read_file' },
    { id: 'assistant-1', entryType: 'assistant_message', content: 'The work is complete.' },
  ],
  seq: 3,
};

async function buildApp() {
  const app = Fastify();
  await app.register((await import('../workspaces.js')).workspaceRoutes, { prefix: '/api' });
  await app.register((await import('../sessions.js')).sessionRoutes, { prefix: '/api' });
  return app;
}

async function fixture(kind: WorkspaceKind = WorkspaceKind.WORKTREE) {
  const repoPath = path.join(testDir, randomUUID());
  fs.mkdirSync(repoPath);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe', encoding: 'utf8' }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'History Test');
  git('config', 'user.email', 'history@example.test');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repoPath, 'source.txt'), 'project files must survive\n');
  git('add', '.');
  git('commit', '-m', 'initial');
  const project = await prisma.project.create({ data: { name: 'History', repoPath } });
  const task = await prisma.task.create({ data: { projectId: project.id, title: 'Retain history', status: 'DONE' } });
  const workspace = await new WorkspaceService().create(task.id, { workspaceKind: kind, reuseInactive: false });
  const session = await prisma.session.create({ data: {
    workspaceId: workspace.id, agentType: 'CODEX', prompt: 'Keep this task history', status: 'COMPLETED',
    logSnapshot: JSON.stringify(snapshot),
  } });
  await prisma.conversationTurn.create({ data: { sessionId: session.id, message: 'Keep this task history', status: 'COMPLETED' } });
  return { project, task, workspace, session, git };
}

describe('workspace history survives resource cleanup', () => {
  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate'], {
      cwd: serverRoot, env: process.env, stdio: 'pipe',
    });
    prisma = (await import('../../utils/index.js')).prisma;
    WorkspaceService = (await import('../../services/workspace.service.js')).WorkspaceService;
    TaskService = (await import('../../services/task.service.js')).TaskService;
    TaskCleanupService = (await import('../../services/task-cleanup.service.js')).TaskCleanupService;
    container = await import('../../core/container.js');
    stores = (await import('../../output/index.js')).sessionMsgStoreManager;
  });

  afterAll(async () => {
    await container?.destroyApplicationProcesses();
    await prisma?.$disconnect();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it.each([
    { kind: WorkspaceKind.WORKTREE, operation: 'cleanup', status: 'MERGED' },
    { kind: WorkspaceKind.WORKTREE, operation: 'cleanup', status: 'ABANDONED' },
    { kind: WorkspaceKind.WORKTREE, operation: 'delete', status: 'ACTIVE' },
    { kind: WorkspaceKind.MAIN_DIRECTORY, operation: 'cleanup', status: 'ABANDONED' },
    { kind: WorkspaceKind.MAIN_DIRECTORY, operation: 'delete', status: 'ACTIVE' },
  ])('$operation $kind $status keeps durable logs until task deletion', async ({ kind, operation, status }) => {
    const { project, task, workspace, session, git } = await fixture(kind);
    await prisma.workspace.update({ where: { id: workspace.id }, data: { status } });
    let app = await buildApp();
    try {
      const cleanup = await app.inject(operation === 'cleanup'
        ? { method: 'POST', url: '/api/system/cleanup' }
        : { method: 'DELETE', url: `/api/workspaces/${workspace.id}` });
      expect(cleanup.statusCode, cleanup.body).toBe(operation === 'cleanup' ? 200 : 204);
      const historical = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
      expect(historical).toMatchObject({ worktreePath: '', workingDir: '', cleanedAt: expect.any(Date) });
      expect(fs.existsSync(path.join(project.repoPath, 'source.txt'))).toBe(true);
      if (kind === WorkspaceKind.WORKTREE) expect(fs.existsSync(workspace.worktreePath)).toBe(false);
      expect(await prisma.conversationTurn.count({ where: { sessionId: session.id } })).toBe(1);
      expect(await new WorkspaceService().cleanup()).toBe(0);

      // Reopen HTTP and SQLite with no in-memory log store: history must come from disk.
      await app.close();
      stores.delete(session.id);
      await prisma.$disconnect();
      app = await buildApp();
      const list = await app.inject({ method: 'GET', url: `/api/tasks/${task.id}/workspaces` });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: workspace.id, sessions: expect.arrayContaining([expect.objectContaining({ id: session.id })]) }),
      ]));
      const logs = await app.inject({ method: 'GET', url: `/api/sessions/${session.id}/logs` });
      expect(logs.statusCode).toBe(200);
      expect(logs.json()).toEqual(snapshot);
      for (const action of ['start', 'message']) {
        const response = await app.inject({ method: 'POST', url: `/api/sessions/${session.id}/${action}`, payload: { message: 'continue' } });
        expect(response.statusCode, response.body).toBe(409);
        expect(response.json().code).toBe('WORKSPACE_NOT_ACTIVE');
      }
      await expect(container.getSessionManager().create(workspace.id, AgentType.CODEX, 'continue'))
        .rejects.toMatchObject({ code: 'WORKSPACE_NOT_ACTIVE' });
      await expect(container.getSessionManager().start(session.id)).rejects.toMatchObject({ code: 'WORKSPACE_NOT_ACTIVE' });

      // Starting again allocates a usable workspace and keeps the old conversation.
      const next = await new WorkspaceService().create(task.id, { workspaceKind: kind, reuseInactive: true });
      expect(next.id).not.toBe(workspace.id);
      expect(fs.existsSync(next.workingDir)).toBe(true);
      expect((await app.inject({ method: 'GET', url: `/api/sessions/${session.id}/logs` })).json()).toEqual(snapshot);

      // A reclaimed name may now belong to unrelated work. Task deletion must not delete it again.
      if (kind === WorkspaceKind.WORKTREE) git('branch', workspace.branchName, 'main');

      const manager = container.getSessionManager();
      const background = container.getWorkspaceBackgroundService();
      await new TaskService(container.getEventBus(), manager, undefined, background).delete(task.id);
      await new TaskCleanupService(manager, background).processDueJobs();
      expect(await prisma.task.findUnique({ where: { id: task.id } })).toBeNull();
      expect(await prisma.session.findUnique({ where: { id: session.id } })).toBeNull();
      expect(await prisma.conversationTurn.count({ where: { sessionId: session.id } })).toBe(0);
      expect((await app.inject({ method: 'GET', url: `/api/sessions/${session.id}/logs` })).statusCode).toBe(404);
      expect(fs.existsSync(path.join(project.repoPath, 'source.txt'))).toBe(true);
      if (kind === WorkspaceKind.WORKTREE) expect(git('rev-parse', `refs/heads/${workspace.branchName}`)).toBe(git('rev-parse', 'main'));
    } finally {
      await app.close();
    }
  });

  it('keeps TeamRun room messages, workspace links and member sessions after cleanup', async () => {
    const { task, workspace, session, git } = await fixture();
    const team = await prisma.teamRun.create({ data: { taskId: task.id, mainWorkspaceId: workspace.id, mode: 'AUTO' } });
    const message = await prisma.roomMessage.create({ data: { teamRunId: team.id, senderType: 'USER', kind: 'MESSAGE', content: 'Team history', mentions: '[]' } });
    const member = await prisma.teamMember.create({ data: {
      teamRunId: team.id, name: 'Member', aliases: '[]', providerId: 'unused-provider', rolePrompt: 'Implement',
      capabilities: '{}', workspacePolicy: 'dedicated', triggerPolicy: 'MENTION_ONLY', sessionPolicy: 'new_per_request',
    } });
    const child = await new WorkspaceService().getOrCreateDedicatedWorkspace(team.id, member.id);
    const memberSession = await prisma.session.create({ data: { workspaceId: child.id, agentType: 'CODEX', prompt: 'member work', status: 'COMPLETED', logSnapshot: JSON.stringify(snapshot) } });
    await new WorkspaceService().delete(child.id);
    git('branch', child.branchName, 'main');
    const rebuilt = await new WorkspaceService().getOrCreateDedicatedWorkspace(team.id, member.id);
    expect(rebuilt).toMatchObject({ id: child.id, status: 'ACTIVE', cleanedAt: null });
    expect(rebuilt.branchName).not.toBe(child.branchName);
    expect(git('rev-parse', child.branchName)).toBe(git('rev-parse', 'main'));
    await prisma.workspace.updateMany({ where: { taskId: task.id }, data: { status: 'MERGED' } });
    expect(await new WorkspaceService().cleanup()).toBe(2);
    expect((await prisma.teamRun.findUniqueOrThrow({ where: { id: team.id } })).mainWorkspaceId).toBe(workspace.id);
    expect(await prisma.roomMessage.findUnique({ where: { id: message.id } })).not.toBeNull();
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: child.id } })).parentWorkspaceId).toBe(workspace.id);
    const app = await buildApp();
    try {
      for (const id of [session.id, memberSession.id]) {
        stores.delete(id);
        const logs = await app.inject({ method: 'GET', url: `/api/sessions/${id}/logs` });
        expect(logs.statusCode).toBe(200);
        expect(logs.json()).toEqual(snapshot);
      }
    } finally {
      await app.close();
    }
  });
});
