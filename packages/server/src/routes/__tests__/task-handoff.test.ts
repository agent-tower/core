import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { TASK_HANDOFF_MAX_LENGTH } from '@agent-tower/shared';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-handoff-'));
process.env.AGENT_TOWER_DATABASE_URL = `file:${path.join(testDir, 'test.db')}`;
process.env.AGENT_TOWER_DATA_DIR = testDir;
const serverRoot = fileURLToPath(new URL('../../../', import.meta.url));
let prisma: PrismaClient;
let taskRoutes: typeof import('../tasks.js').taskRoutes;
let accessAuthHook: typeof import('../../middleware/access-auth.js').accessAuthHook;
let createAgentApiCredential: typeof import('../../utils/agent-api-credential.js').createAgentApiCredential;
let taskId: string;
let projectId: string;

async function appForTest() {
  const app = Fastify();
  app.addHook('onRequest', accessAuthHook);
  await app.register(taskRoutes, { prefix: '/api' });
  return app;
}

describe('task handoff HTTP and persistence', () => {
  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', `--schema=${path.join(serverRoot, 'prisma/schema.prisma')}`], {
      cwd: serverRoot, env: process.env, stdio: 'pipe',
    });
    ({ prisma } = await import('../../utils/index.js'));
    ({ taskRoutes } = await import('../tasks.js'));
    ({ accessAuthHook } = await import('../../middleware/access-auth.js'));
    ({ createAgentApiCredential } = await import('../../utils/agent-api-credential.js'));
  });
  beforeEach(async () => {
    await prisma.agentInvocation.deleteMany();
    await prisma.teamMember.deleteMany();
    await prisma.teamRun.deleteMany();
    await prisma.session.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.task.deleteMany();
    await prisma.project.deleteMany();
    const project = await prisma.project.create({ data: { name: 'Handoff', repoPath: testDir } });
    const task = await prisma.task.create({ data: { title: 'Implement feature', projectId: project.id } });
    taskId = task.id;
    projectId = project.id;
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('initializes, edits literal Markdown, deletes, and keeps summaries out of task metadata', async () => {
    const app = await appForTest();
    try {
      const url = `/api/tasks/${taskId}/handoff`;
      expect((await app.inject({ url })).json()).toEqual({ taskId, content: '' });
      const content = '## 进度\r\n- 待验证 🧪\n- 下一步：测试';
      expect((await app.inject({ method: 'PATCH', url, payload: { oldString: '', newString: content } })).json()).toEqual({ taskId, content });
      const replacement = '$& $1 $` $\'\n- 已验证 ✅';
      const result = await app.inject({ method: 'PATCH', url, payload: { oldString: '- 待验证 🧪', newString: replacement } });
      const expected = '## 进度\r\n' + replacement + '\n- 下一步：测试';
      expect(result.json()).toEqual({ taskId, content: expected });
      expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).handoff).toBe(expected);
      for (const path of [`/api/tasks/${taskId}`, `/api/projects/${projectId}/tasks`, '/api/task-board']) {
        expect((await app.inject({ url: path })).body).not.toContain('"handoff":');
      }
      const renamed = await app.inject({ method: 'PUT', url: `/api/tasks/${taskId}`, payload: { title: 'Renamed' } });
      expect(renamed.json()).not.toHaveProperty('handoff');
      expect((await app.inject({ method: 'PATCH', url, payload: { oldString: expected, newString: '' } })).json()).toEqual({ taskId, content: '' });
    } finally { await app.close(); }
  });

  it.each([
    ['Existing', '', 'HANDOFF_NOT_EMPTY'],
    ['Existing', 'missing', 'HANDOFF_TEXT_NOT_FOUND'],
    ['same\nsame', 'same', 'HANDOFF_TEXT_AMBIGUOUS'],
    ['aaa', 'aa', 'HANDOFF_TEXT_AMBIGUOUS'],
  ])('rejects unsafe replacement in %s without changing the note', async (content, oldString, code) => {
    await prisma.task.update({ where: { id: taskId }, data: { handoff: content } });
    const app = await appForTest();
    try {
      const result = await app.inject({ method: 'PATCH', url: `/api/tasks/${taskId}/handoff`, payload: { oldString, newString: 'replacement' } });
      expect(result.statusCode).toBe(409);
      expect(result.json().code).toBe(code);
      expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).handoff).toBe(content);
    } finally { await app.close(); }
  });

  it('admits only one competing edit and bounds the resulting note', async () => {
    const app = await appForTest();
    try {
      const url = `/api/tasks/${taskId}/handoff`;
      const results = await Promise.all(['first', 'second'].map(newString => app.inject({ method: 'PATCH', url, payload: { oldString: '', newString } })));
      expect(results.map(r => r.statusCode).sort()).toEqual([200, 409]);
      const winner = results.find(r => r.statusCode === 200)!.json().content;
      expect((await app.inject({ url })).json().content).toBe(winner);
      await prisma.task.update({ where: { id: taskId }, data: { handoff: 'a'.repeat(TASK_HANDOFF_MAX_LENGTH - 1) + 'b' } });
      const tooLarge = await app.inject({ method: 'PATCH', url, payload: { oldString: 'b', newString: 'bb' } });
      expect(tooLarge.statusCode).toBe(400);
      expect(tooLarge.json().code).toBe('HANDOFF_TOO_LARGE');
    } finally { await app.close(); }
  });

  it('binds managed Agents to their task even when workspaces use the same directory', async () => {
    const other = await prisma.task.create({ data: { title: 'Other', projectId } });
    const workspace = await prisma.workspace.create({ data: { taskId, branchName: 'at/test', worktreePath: testDir, workspaceKind: 'MAIN_DIRECTORY' } });
    const session = await prisma.session.create({ data: { workspaceId: workspace.id, agentType: 'CODEX', prompt: 'work' } });
    const credential = createAgentApiCredential({ sessionId: session.id, invocationId: null });
    const headers = { 'x-agent-tower-agent-credential': credential };
    const app = await appForTest();
    try {
      expect((await app.inject({ url: `/api/tasks/${taskId}/handoff`, headers })).statusCode).toBe(200);
      const write = await app.inject({ method: 'PATCH', url: `/api/tasks/${taskId}/handoff`, headers, payload: { oldString: '', newString: 'Agent note' } });
      expect(write.statusCode).toBe(200);
      for (const method of ['GET', 'PATCH'] as const) {
        const response = await app.inject({ method, url: `/api/tasks/${other.id}/handoff`, headers, ...(method === 'PATCH' ? { payload: { oldString: '', newString: 'Forbidden' } } : {}) });
        expect(response.statusCode).toBe(403);
        expect(response.json().code).toBe('HANDOFF_ACCESS_DENIED');
      }
      await prisma.session.update({ where: { id: session.id }, data: { purpose: 'COMMIT_MSG' } });
      expect((await app.inject({ url: `/api/tasks/${taskId}/handoff`, headers })).statusCode).toBe(403);
    } finally { await app.close(); }
  });

  it('keeps archived notes readable and refuses writes or deleted tasks', async () => {
    await prisma.task.update({ where: { id: taskId }, data: { handoff: 'Keep this' } });
    await prisma.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
    const app = await appForTest();
    try {
      const url = `/api/tasks/${taskId}/handoff`;
      expect((await app.inject({ url })).json().content).toBe('Keep this');
      expect((await app.inject({ method: 'PATCH', url, payload: { oldString: 'Keep this', newString: '' } })).statusCode).toBe(400);
      await prisma.task.update({ where: { id: taskId }, data: { deletedAt: new Date() } });
      expect((await app.inject({ url })).statusCode).toBe(404);
    } finally { await app.close(); }
  });

  it('rejects cross-origin browser writes when the access password is disabled', async () => {
    const app = await appForTest();
    try {
      const response = await app.inject({ method: 'PATCH', url: `/api/tasks/${taskId}/handoff`,
        headers: { origin: 'https://unrelated.example' }, payload: { oldString: '', newString: 'Wrong origin' } });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('ACCESS_AUTH_CSRF_REJECTED');
      expect((await prisma.task.findUniqueOrThrow({ where: { id: taskId } })).handoff).toBeNull();
    } finally { await app.close(); }
  });

  it('requires the bound TeamRun invocation and an active member', async () => {
    const team = await prisma.teamRun.create({ data: { taskId, mode: 'SHARED' } });
    const member = await prisma.teamMember.create({ data: { teamRunId: team.id, name: 'Worker', aliases: '[]', providerId: 'test', rolePrompt: '', capabilities: '{}', workspacePolicy: 'shared', triggerPolicy: 'mention' } });
    const workspace = await prisma.workspace.create({ data: { taskId, branchName: 'at/team', worktreePath: testDir } });
    const session = await prisma.session.create({ data: { workspaceId: workspace.id, agentType: 'CODEX', prompt: 'work' } });
    const invocation = await prisma.agentInvocation.create({ data: { teamRunId: team.id, memberId: member.id, workRequestId: 'test-request', workspaceId: workspace.id, sessionId: session.id, status: 'RUNNING' } });
    const app = await appForTest();
    const read = (invocationId: string | null) => app.inject({ url: `/api/tasks/${taskId}/handoff`, headers: {
      'x-agent-tower-agent-credential': createAgentApiCredential({ sessionId: session.id, invocationId }),
    } });
    try {
      expect((await read(null)).statusCode).toBe(403);
      expect((await read(invocation.id)).statusCode).toBe(200);
      await prisma.teamMember.update({ where: { id: member.id }, data: { membershipStatus: 'REMOVED' } });
      expect((await read(invocation.id)).statusCode).toBe(403);
      await prisma.teamMember.update({ where: { id: member.id }, data: { membershipStatus: 'ACTIVE' } });
      await prisma.agentInvocation.update({ where: { id: invocation.id }, data: { dispatchRevokedAt: new Date() } });
      expect((await read(invocation.id)).statusCode).toBe(403);
    } finally { await app.close(); }
  });
});
