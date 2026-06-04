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
});
