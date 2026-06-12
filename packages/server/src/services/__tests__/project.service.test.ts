import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
    await prisma.session.deleteMany();
    await prisma.workspace.deleteMany();
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

  it('unwatches active workspaces before archiving them', async () => {
    const unwatchWorkspaceMock = vi.fn();
    const service = new ProjectService({ unwatchWorkspace: unwatchWorkspaceMock });
    const project = await prisma.project.create({
      data: {
        name: 'Project archive watcher cleanup',
        repoPath: testDir,
      },
    });
    const task = await prisma.task.create({
      data: {
        title: 'Archive watcher task',
        projectId: project.id,
      },
    });
    const activeWorkspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'at/archive-active',
        baseBranch: 'main',
        worktreePath: path.join(testDir, '.worktrees', 'at', 'archive-active'),
        workingDir: path.join(testDir, '.worktrees', 'at', 'archive-active'),
        status: 'ACTIVE',
      },
    });
    const abandonedWorkspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'at/archive-abandoned',
        baseBranch: 'main',
        worktreePath: path.join(testDir, '.worktrees', 'at', 'archive-abandoned'),
        workingDir: path.join(testDir, '.worktrees', 'at', 'archive-abandoned'),
        status: 'ABANDONED',
      },
    });

    await service.archive(project.id);

    expect(unwatchWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(unwatchWorkspaceMock).toHaveBeenCalledWith(activeWorkspace.id);
    expect(unwatchWorkspaceMock).not.toHaveBeenCalledWith(abandonedWorkspace.id);
    await expect(prisma.workspace.findUnique({ where: { id: activeWorkspace.id } })).resolves.toMatchObject({
      status: 'ABANDONED',
    });
  });

  it('unwatches active workspaces before deleting archived repo paths', async () => {
    const unwatchWorkspaceMock = vi.fn();
    const service = new ProjectService({ unwatchWorkspace: unwatchWorkspaceMock });
    const repoPath = fs.mkdtempSync(path.join(testDir, 'archive-delete-repo-'));
    const worktreePath = path.join(testDir, 'archive-delete-worktree');
    fs.mkdirSync(worktreePath, { recursive: true });
    const project = await prisma.project.create({
      data: {
        name: 'Project delete repo watcher cleanup',
        repoPath,
      },
    });
    const task = await prisma.task.create({
      data: {
        title: 'Archive delete repo watcher task',
        projectId: project.id,
      },
    });
    const activeWorkspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'at/archive-delete-active',
        baseBranch: 'main',
        worktreePath,
        workingDir: worktreePath,
        status: 'ACTIVE',
      },
    });

    await service.archive(project.id, { deleteRepo: true });

    expect(unwatchWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(unwatchWorkspaceMock).toHaveBeenCalledWith(activeWorkspace.id);
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(fs.existsSync(repoPath)).toBe(false);
    await expect(prisma.workspace.findUnique({ where: { id: activeWorkspace.id } })).resolves.toMatchObject({
      status: 'ABANDONED',
      worktreePath: '',
      workingDir: '',
    });
  });
});
