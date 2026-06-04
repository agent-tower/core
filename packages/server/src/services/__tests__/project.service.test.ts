import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { TaskStatus } from '../../types/index.js';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-project-service-'));
const dbPath = path.join(testDir, 'test.db');
process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, '../../..');
const schemaPath = path.join(serverRoot, 'prisma/schema.prisma');

let ProjectService: typeof import('../project.service.js').ProjectService;
let prisma: PrismaClient;

describe('ProjectService', () => {
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

    const serviceModule = await import('../project.service.js');
    const utilsModule = await import('../../utils/index.js');
    ProjectService = serviceModule.ProjectService;
    prisma = utilsModule.prisma;
  });

  beforeEach(async () => {
    await prisma.task.deleteMany();
    await prisma.project.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('excludes deleted tasks from project detail taskStats', async () => {
    const service = new ProjectService();
    const project = await prisma.project.create({
      data: {
        name: 'Project stats',
        repoPath: testDir,
      },
    });
    await prisma.task.createMany({
      data: [
        { title: 'Visible todo', projectId: project.id, status: TaskStatus.TODO },
        { title: 'Visible review', projectId: project.id, status: TaskStatus.IN_REVIEW },
        { title: 'Deleted done', projectId: project.id, status: TaskStatus.DONE, deletedAt: new Date() },
      ],
    });

    const detail = await service.findById(project.id);

    expect(detail.taskStats).toEqual({
      total: 2,
      todo: 1,
      inProgress: 0,
      inReview: 1,
      done: 0,
    });
  });
});
