import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { SessionManager } from '../session-manager.js';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-task-service-'));
const dbPath = path.join(testDir, 'test.db');
process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, '../../..');
const schemaPath = path.join(serverRoot, 'prisma/schema.prisma');

let TaskService: typeof import('../task.service.js').TaskService;
let EventBus: typeof import('../../core/event-bus.js').EventBus;
let prisma: PrismaClient;

describe('TaskService', () => {
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

    const serviceModule = await import('../task.service.js');
    const eventBusModule = await import('../../core/event-bus.js');
    const utilsModule = await import('../../utils/index.js');
    TaskService = serviceModule.TaskService;
    EventBus = eventBusModule.EventBus;
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

  it('rejects creating a task with a blank title', async () => {
    const service = new TaskService(new EventBus(), {} as SessionManager);
    const project = await prisma.project.create({
      data: {
        name: 'Task validation project',
        repoPath: testDir,
      },
    });

    await expect(service.create(project.id, { title: '   ' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
    });
    await expect(prisma.task.count()).resolves.toBe(0);
  });

  it('trims task titles when creating tasks', async () => {
    const service = new TaskService(new EventBus(), {} as SessionManager);
    const project = await prisma.project.create({
      data: {
        name: 'Task trim project',
        repoPath: testDir,
      },
    });

    const task = await service.create(project.id, { title: '  Ship TeamRun startup  ' });

    expect(task.title).toBe('Ship TeamRun startup');
  });
});
