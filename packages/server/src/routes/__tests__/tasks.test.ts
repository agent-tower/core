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

  it('accepts long single-input task content and stores it as title plus description', async () => {
    const project = await prisma.project.create({
      data: {
        name: 'Task route long input project',
        repoPath: testDir,
      },
    });
    const longInput = `Analyze API logs\n${'request failed '.repeat(300)}`;
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
        description: longInput,
      });
      const stored = await prisma.task.findFirstOrThrow({ where: { projectId: project.id } });
      expect(stored.title).toBe('Analyze API logs');
      expect(stored.description).toBe(longInput);
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
