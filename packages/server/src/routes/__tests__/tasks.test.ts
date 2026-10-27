import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-tasks-route-'));
const dbPath = path.join(testDir, 'test.db');
process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;
process.env.AGENT_TOWER_DATA_DIR = testDir;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, '../../..');
const schemaPath = path.join(serverRoot, 'prisma/schema.prisma');

let taskRoutes: typeof import('../tasks.js').taskRoutes;
let prisma: PrismaClient;

async function buildTestApp() {
  const app = Fastify();
  await app.register(taskRoutes, { prefix: '/api' });
  return app;
}

describe('task routes', () => {
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

    const routeModule = await import('../tasks.js');
    const utilsModule = await import('../../utils/index.js');
    taskRoutes = routeModule.taskRoutes;
    prisma = utilsModule.prisma;
  });

  beforeEach(async () => {
    await prisma.taskCleanupJob.deleteMany();
    await prisma.session.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.task.deleteMany();
    await prisma.project.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('preserves the parent relation through HTTP and rejects a stale deletion scope', async () => {
    const project = await prisma.project.create({ data: { name: 'Subtasks', repoPath: testDir } });
    const parent = await prisma.task.create({ data: { title: 'Parent', projectId: project.id } });
    const app = await buildTestApp();
    try {
      const created = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/tasks`,
        payload: { title: 'Child', parentTaskId: parent.id, baseBranch: null } });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ parentTaskId: parent.id, baseBranch: null });
      const children = await app.inject({ method: 'GET', url: `/api/tasks/${parent.id}/subtasks?limit=1` });
      expect(children.json()).toMatchObject({ total: 1, data: [expect.objectContaining({ id: created.json().id, parentTaskId: parent.id })] });
      const detail = await app.inject({ method: 'GET', url: `/api/tasks/${parent.id}` });
      expect(detail.json().subtaskCount).toBe(1);
      const refused = await app.inject({ method: 'DELETE', url: `/api/tasks/${parent.id}?expectedSubtaskCount=0` });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().code).toBe('TASK_DELETE_SCOPE_CHANGED');
      expect(await prisma.task.count({ where: { deletedAt: null } })).toBe(2);
      expect(await prisma.taskCleanupJob.count()).toBe(0);
      const grandchild = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/tasks`,
        payload: { title: 'Grandchild', parentTaskId: created.json().id, baseBranch: null } });
      expect(grandchild.statusCode).toBe(201);
      expect(grandchild.json().ancestorIds).toEqual([parent.id, created.json().id]);
      const tooDeep = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/tasks`,
        payload: { title: 'Fourth level', parentTaskId: grandchild.json().id, baseBranch: null } });
      expect(tooDeep.statusCode).toBe(400);
      const scope = await app.inject({ method: 'GET', url: `/api/tasks/${parent.id}/deletion-scope` });
      expect(scope.json()).toEqual({ descendantCount: 2 });
      const stale = await app.inject({ method: 'DELETE', url: `/api/tasks/${parent.id}?expectedSubtaskCount=1` });
      expect(stale.statusCode).toBe(409);
      expect(await prisma.task.count({ where: { deletedAt: null } })).toBe(3);

    } finally { await app.close(); }
  });

  it('enforces the three-level limit through the MCP handler and its real HTTP client', async () => {
    const project = await prisma.project.create({ data: { name: 'MCP hierarchy', repoPath: testDir } });
    const parent = await prisma.task.create({ data: { title: 'Root', projectId: project.id } });
    const app = await buildTestApp();
    const { registerTaskTools } = await import('../../mcp/tools/tasks.js');
    const { AgentTowerClient } = await import('../../mcp/http-client.js');
    const { CreateTaskInput } = await import('../../mcp/types.js');
    const handlers = new Map<string, (input: any) => Promise<any>>();
    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      registerTaskTools({ tool: (name: string, _description: string, _schema: unknown, handler: (input: any) => Promise<any>) => handlers.set(name, handler) } as any, new AgentTowerClient(address));
      const create = async (parentId: string) => handlers.get('create_task')!(CreateTaskInput.parse({
        project_id: project.id, title: 'Nested through MCP', parent_task_id: parentId, base_branch: null,
      }));
      const child = await create(parent.id);
      expect(child.isError).toBeUndefined();
      const childId = JSON.parse(child.content[0].text).id;
      const grandchild = await create(childId);
      expect(grandchild.isError).toBeUndefined();
      expect(JSON.parse(grandchild.content[0].text).ancestorIds).toEqual([parent.id, childId]);
      const fourth = await create(JSON.parse(grandchild.content[0].text).id);
      expect(fourth.isError).toBe(true);
      expect(fourth.content[0].text).toContain('at most three levels');
      expect(await prisma.task.count()).toBe(3);
    } finally { await app.close(); }
  });

  it('rejects creating a task with an all-whitespace title before writing it', async () => {
    const project = await prisma.project.create({
      data: {
        name: 'Task route validation project',
        repoPath: testDir,
      },
    });
    const app = await buildTestApp();

    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/tasks`,
        payload: {
          title: '   ',
          description: '测试内容',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: 'VALIDATION_ERROR',
        details: [expect.objectContaining({ field: 'title' })],
      });
      await expect(prisma.task.count({ where: { projectId: project.id } })).resolves.toBe(0);
    } finally {
      await app.close();
    }
  });

  it('filters deleted tasks from project task lists', async () => {
    const project = await prisma.project.create({
      data: {
        name: 'Task route list project',
        repoPath: testDir,
      },
    });
    await prisma.task.create({
      data: {
        title: 'Visible task',
        projectId: project.id,
      },
    });
    await prisma.task.create({
      data: {
        title: 'Hidden task',
        projectId: project.id,
        deletedAt: new Date(),
      },
    });
    const app = await buildTestApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/projects/${project.id}/tasks`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        total: 1,
        data: [expect.objectContaining({ title: 'Visible task' })],
      });
    } finally {
      await app.close();
    }
  });

  it('accepts and returns the task base branch through creation and detail endpoints', async () => {
    const repoPath = fs.mkdtempSync(path.join(testDir, 'task-base-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
    git('init', '-b', 'main');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial');
    git('branch', 'develop');
    const project = await prisma.project.create({ data: { name: 'Task base route', repoPath } });
    const app = await buildTestApp();
    try {
      const created = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/tasks`, payload: { title: 'From develop', baseBranch: 'develop' } });
      expect(created.statusCode).toBe(201);
      expect(created.json().baseBranch).toBe('develop');
      const detail = await app.inject({ method: 'GET', url: `/api/tasks/${created.json().id}` });
      expect(detail.json().baseBranch).toBe('develop');
      const missing = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/tasks`, payload: { title: 'Missing', baseBranch: 'missing' } });
      expect(missing.statusCode).toBe(400);
      expect(missing.json().code).toBe('INVALID_BASE_BRANCH');
      expect(await prisma.task.count({ where: { projectId: project.id } })).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('returns one compact board response across active projects', async () => {
    const firstProject = await prisma.project.create({
      data: { name: 'Board project one', repoPath: testDir },
    });
    const secondProject = await prisma.project.create({
      data: { name: 'Board project two', repoPath: testDir },
    });
    const archivedProject = await prisma.project.create({
      data: { name: 'Archived board project', repoPath: testDir, archivedAt: new Date() },
    });
    const visibleTask = await prisma.task.create({
      data: {
        title: `Board task ${'x'.repeat(300)}`,
        description: `Full body ${'y'.repeat(1000)}`,
        projectId: firstProject.id,
      },
    });
    await prisma.task.create({ data: { title: 'Second project task', projectId: secondProject.id } });
    await prisma.task.create({ data: { title: 'Archived task', projectId: archivedProject.id } });
    await prisma.task.create({
      data: { title: 'Deleted task', projectId: firstProject.id, deletedAt: new Date() },
    });
    const inactiveWorkspace = await prisma.workspace.create({
      data: {
        taskId: visibleTask.id,
        branchName: 'old-branch',
        worktreePath: path.join(testDir, 'old-workspace'),
        workingDir: path.join(testDir, 'old-workspace'),
        status: 'MERGED',
      },
    });
    const activeWorkspace = await prisma.workspace.create({
      data: {
        taskId: visibleTask.id,
        branchName: 'active-branch',
        baseBranch: 'main',
        worktreePath: path.join(testDir, 'active-workspace'),
        workingDir: path.join(testDir, 'active-workspace'),
        status: 'ACTIVE',
      },
    });
    await prisma.session.create({
      data: {
        workspaceId: inactiveWorkspace.id,
        agentType: 'CODEX',
        prompt: 'inactive',
        status: 'RUNNING',
      },
    });
    await prisma.session.create({
      data: {
        workspaceId: activeWorkspace.id,
        agentType: 'CLAUDE_CODE',
        prompt: 'older',
        status: 'COMPLETED',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    await prisma.session.create({
      data: {
        workspaceId: activeWorkspace.id,
        agentType: 'CODEX',
        prompt: 'latest',
        status: 'RUNNING',
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    });
    const app = await buildTestApp();

    try {
      const response = await app.inject({ method: 'GET', url: '/api/task-board' });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.total).toBe(2);
      const item = json.data.find((candidate: { id: string }) => candidate.id === visibleTask.id);
      expect(item).toMatchObject({
        id: visibleTask.id,
        projectId: firstProject.id,
        preferredWorkspace: {
          branchName: 'active-branch',
        },
        latestAgentType: 'CODEX',
        hasRunningSession: true,
      });
      expect(item.title.length).toBeLessThanOrEqual(200);
      expect(typeof item.updatedAt).toBe('number');
      expect(item.titlePreview).toBeUndefined();
      expect(item.latestSession).toBeUndefined();
      expect(item.preferredWorkspace.id).toBeUndefined();
      expect(item.preferredWorkspace.status).toBeUndefined();
      expect(item.description).toBeUndefined();
      expect(item.project).toBeUndefined();
      expect(item.workspaces).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('filters the compact board by project', async () => {
    const firstProject = await prisma.project.create({
      data: { name: 'Filtered board project one', repoPath: testDir },
    });
    const secondProject = await prisma.project.create({
      data: { name: 'Filtered board project two', repoPath: testDir },
    });
    const expectedTask = await prisma.task.create({
      data: { title: 'Expected board task', projectId: firstProject.id },
    });
    await prisma.task.create({ data: { title: 'Other board task', projectId: secondProject.id } });
    const app = await buildTestApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/task-board?projectId=${firstProject.id}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        total: 1,
        data: [expect.objectContaining({ id: expectedTask.id, projectId: firstProject.id })],
      });
    } finally {
      await app.close();
    }
  });

  it('orders in-review tasks by priority before position', async () => {
    const project = await prisma.project.create({
      data: { name: 'Priority board project', repoPath: testDir },
    });
    const normal = await prisma.task.create({
      data: { title: 'Normal review', projectId: project.id, status: 'IN_REVIEW', priority: 0, position: 1 },
    });
    const urgent = await prisma.task.create({
      data: { title: 'Urgent review', projectId: project.id, status: 'IN_REVIEW', priority: 2, position: 3 },
    });
    const high = await prisma.task.create({
      data: { title: 'High review', projectId: project.id, status: 'IN_REVIEW', priority: 1, position: 2 },
    });
    const app = await buildTestApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/task-board?projectId=${project.id}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().data.map((task: { id: string }) => task.id)).toEqual([
        urgent.id,
        high.id,
        normal.id,
      ]);
      expect(response.json().data.map((task: { priority: number }) => task.priority)).toEqual([2, 1, 0]);
    } finally {
      await app.close();
    }
  });

  it('accepts long single-input task content and stores the unconsumed body as description', async () => {
    const project = await prisma.project.create({
      data: {
        name: 'Task route long input project',
        repoPath: testDir,
      },
    });
    const body = 'request failed '.repeat(300);
    const longInput = `Analyze API logs\n${body}`;
    const app = await buildTestApp();

    try {
      const response = await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/tasks`,
        payload: {
          title: longInput,
        },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        title: 'Analyze API logs',
        description: body,
      });
      const stored = await prisma.task.findFirstOrThrow({ where: { projectId: project.id } });
      expect(stored.title).toBe('Analyze API logs');
      expect(stored.description).toBe(body);
    } finally {
      await app.close();
    }
  });

  it('accepts long update input without storing it in Task.title', async () => {
    const project = await prisma.project.create({
      data: {
        name: 'Task route long update project',
        repoPath: testDir,
      },
    });
    const task = await prisma.task.create({
      data: {
        projectId: project.id,
        title: 'Original title',
        description: 'Existing body',
      },
    });
    const longInput = `Updated logs\n${'stacktrace '.repeat(300)}`;
    const app = await buildTestApp();

    try {
      const response = await app.inject({
        method: 'PUT',
        url: `/api/tasks/${task.id}`,
        payload: {
          title: longInput,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        title: 'Updated logs',
      });
      const stored = await prisma.task.findUniqueOrThrow({ where: { id: task.id } });
      expect(stored.title).toBe('Updated logs');
      expect(stored.description).toContain(longInput);
      expect(stored.description).toContain('Existing body');
    } finally {
      await app.close();
    }
  });

  it('omits full task descriptions from project task lists', async () => {
    const project = await prisma.project.create({
      data: {
        name: 'Task route summary project',
        repoPath: testDir,
      },
    });
    await prisma.task.create({
      data: {
        title: `Historical title ${'x'.repeat(1000)}`,
        description: `Huge body ${'y'.repeat(1000)}`,
        projectId: project.id,
      },
    });
    const app = await buildTestApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/projects/${project.id}/tasks`,
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.data[0].title.length).toBeLessThanOrEqual(200);
      expect(json.data[0].description).toBeUndefined();
      expect(json.data[0].contentPreview).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it('returns task summary without full description and exposes full body on demand', async () => {
    const project = await prisma.project.create({
      data: {
        name: 'Task route body project',
        repoPath: testDir,
      },
    });
    const hugeDescription = `Huge body ${'diagnostic '.repeat(400)}`;
    const task = await prisma.task.create({
      data: {
        title: 'Body summary task',
        description: hugeDescription,
        projectId: project.id,
      },
    });
    const app = await buildTestApp();

    try {
      const summaryResponse = await app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}`,
      });
      expect(summaryResponse.statusCode).toBe(200);
      const summary = summaryResponse.json();
      expect(summary.title).toBe('Body summary task');
      expect(summary.description).toBeUndefined();
      expect(summary.contentPreview).toBeUndefined();

      const bodyResponse = await app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}/body`,
      });
      expect(bodyResponse.statusCode).toBe(200);
      expect(bodyResponse.json()).toMatchObject({
        taskId: task.id,
        title: 'Body summary task',
        body: hugeDescription,
        bodySource: 'description',
        prompt: `Body summary task\n\n${hugeDescription}`,
      });
    } finally {
      await app.close();
    }
  });

  it('returns historical oversized title as full body when description is empty', async () => {
    const project = await prisma.project.create({
      data: {
        name: 'Task route historical title project',
        repoPath: testDir,
      },
    });
    const historicalTitle = `Historical pasted logs\n${'legacy-line '.repeat(400)}`;
    const task = await prisma.task.create({
      data: {
        title: historicalTitle,
        projectId: project.id,
      },
    });
    const app = await buildTestApp();

    try {
      const summaryResponse = await app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}`,
      });
      expect(summaryResponse.statusCode).toBe(200);
      expect(summaryResponse.json().title.length).toBeLessThanOrEqual(200);
      expect(summaryResponse.json().description).toBeUndefined();

      const bodyResponse = await app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}/body`,
      });
      expect(bodyResponse.statusCode).toBe(200);
      expect(bodyResponse.json()).toMatchObject({
        taskId: task.id,
        body: historicalTitle,
        bodySource: 'historical_title',
        prompt: historicalTitle,
      });
    } finally {
      await app.close();
    }
  });
});
