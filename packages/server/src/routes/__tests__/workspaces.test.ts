import { execFileSync } from 'node:child_process';
import Fastify from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { WorkspaceKind } from '../../types/index.js';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-workspace-routes-'));
const dbPath = path.join(testDir, 'test.db');
process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, '../../..');
const schemaPath = path.join(serverRoot, 'prisma/schema.prisma');

let prisma: PrismaClient;
let workspaceRoutes: typeof import('../workspaces.js').workspaceRoutes;

async function buildTestApp() {
  const app = Fastify();
  await app.register(workspaceRoutes);
  return app;
}

describe('workspace routes', () => {
  beforeAll(async () => {
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
    const utilsModule = await import('../../utils/index.js');
    workspaceRoutes = routeModule.workspaceRoutes;
    prisma = utilsModule.prisma;
  });

  beforeEach(async () => {
    await prisma.session.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.task.deleteMany();
    await prisma.project.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    fs.rmSync(testDir, { recursive: true, force: true });
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
        url: `/workspaces/${workspace.id}/git-status`,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: 'WORKSPACE_GIT_UNAVAILABLE',
      });
    } finally {
      await app.close();
    }
  });
});
