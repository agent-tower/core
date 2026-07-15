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

  it('creates a non-git project directory as a local project', async () => {
    const service = new ProjectService();
    const projectPath = fs.mkdtempSync(path.join(testDir, 'local-project-'));
    fs.writeFileSync(path.join(projectPath, 'README.md'), 'local project\n', 'utf-8');

    const project = await service.create({
      name: 'Local project',
      repoPath: projectPath,
    });

    expect(project).toMatchObject({
      name: 'Local project',
      repoPath: projectPath,
      repoRemoteUrl: null,
      isGitRepo: false,
    });
    expect(fs.existsSync(path.join(projectPath, '.git'))).toBe(false);
  });

  it('refreshes Git capability after a local project is initialized manually', async () => {
    const service = new ProjectService();
    const projectPath = fs.mkdtempSync(path.join(testDir, 'manual-git-project-'));
    const project = await service.create({
      name: 'Manual Git project',
      repoPath: projectPath,
    });

    expect(project).toMatchObject({
      isGitRepo: false,
      worktreeReady: false,
      reason: 'NO_GIT',
    });

    execFileSync('git', ['init'], { cwd: projectPath, stdio: 'pipe' });

    await expect(service.refreshGitCapability(project.id)).resolves.toMatchObject({
      isGitRepo: true,
      worktreeReady: false,
      reason: 'NO_HEAD',
    });

    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectPath, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: projectPath, stdio: 'pipe' });
    fs.writeFileSync(path.join(projectPath, 'README.md'), 'ready\n', 'utf-8');
    execFileSync('git', ['add', 'README.md'], { cwd: projectPath, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: projectPath, stdio: 'pipe' });

    await expect(service.refreshGitCapability(project.id)).resolves.toMatchObject({
      isGitRepo: true,
      worktreeReady: true,
      reason: 'READY',
    });
  });

  it('initializes an empty directory as Git when requested', async () => {
    const service = new ProjectService();
    const projectPath = fs.mkdtempSync(path.join(testDir, 'initializable-project-'));

    const project = await service.create({
      name: 'Initializable project',
      repoPath: projectPath,
      initEmptyRepo: true,
    });

    expect(project).toMatchObject({
      name: 'Initializable project',
      repoPath: projectPath,
      isGitRepo: true,
    });
    expect(fs.existsSync(path.join(projectPath, '.git'))).toBe(true);
  });

  it('restores an archived project to a non-git project directory', async () => {
    const service = new ProjectService();
    const oldPath = fs.mkdtempSync(path.join(testDir, 'restore-old-'));
    const nextPath = fs.mkdtempSync(path.join(testDir, 'restore-local-'));
    fs.writeFileSync(path.join(nextPath, 'notes.txt'), 'restored local project\n', 'utf-8');
    const archived = await prisma.project.create({
      data: {
        name: 'Restore local project',
        repoPath: oldPath,
        archivedAt: new Date(),
        repoDeletedAt: new Date(),
      },
    });

    const result = await service.restore(archived.id, {
      repoPath: nextPath,
    });

    expect(result.project).toMatchObject({
      id: archived.id,
      repoPath: nextPath,
      archivedAt: null,
      repoDeletedAt: null,
      repoRemoteUrl: null,
      isGitRepo: false,
    });
  });

  it('abandons active workspaces when archiving a project', async () => {
    const service = new ProjectService();
    const project = await prisma.project.create({
      data: {
        name: 'Project archive workspace cleanup',
        repoPath: testDir,
      },
    });
    const task = await prisma.task.create({
      data: {
        title: 'Archive workspace task',
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

    await expect(prisma.workspace.findUnique({ where: { id: activeWorkspace.id } })).resolves.toMatchObject({
      status: 'ABANDONED',
    });
    await expect(prisma.workspace.findUnique({ where: { id: abandonedWorkspace.id } })).resolves.toMatchObject({
      status: 'ABANDONED',
    });
  });

  it('cleans workspace paths when deleting an archived repository', async () => {
    const service = new ProjectService();
    const repoPath = fs.mkdtempSync(path.join(testDir, 'archive-delete-repo-'));
    const worktreePath = path.join(testDir, 'archive-delete-worktree');
    fs.mkdirSync(worktreePath, { recursive: true });
    const project = await prisma.project.create({
      data: {
        name: 'Project delete repo workspace cleanup',
        repoPath,
      },
    });
    const task = await prisma.task.create({
      data: {
        title: 'Archive delete repo workspace task',
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

    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(fs.existsSync(repoPath)).toBe(false);
    await expect(prisma.workspace.findUnique({ where: { id: activeWorkspace.id } })).resolves.toMatchObject({
      status: 'ABANDONED',
      worktreePath: '',
      workingDir: '',
    });
  });
});
