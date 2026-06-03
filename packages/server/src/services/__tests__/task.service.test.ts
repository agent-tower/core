import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { SessionManager } from '../session-manager.js';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-task-service-'));
const dbPath = path.join(testDir, 'test.db');
process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;

const {
  removeWorktreeMock,
  deleteBranchIfSafeMock,
} = vi.hoisted(() => ({
  removeWorktreeMock: vi.fn(),
  deleteBranchIfSafeMock: vi.fn(),
}));

vi.mock('../../git/worktree.manager.js', () => ({
  WorktreeManager: vi.fn().mockImplementation(function () {
    return {
      remove: removeWorktreeMock,
      deleteBranchIfSafe: deleteBranchIfSafeMock,
    };
  }),
}));

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
    vi.clearAllMocks();
    removeWorktreeMock.mockImplementation(async (worktreePath: string) => ({
      status: 'removed',
      path: worktreePath,
      managed: true,
    }));
    deleteBranchIfSafeMock.mockImplementation(async (branchName: string) => ({
      status: 'deleted',
      branchName,
    }));

    await prisma.agentInvocation.deleteMany();
    await prisma.workRequest.deleteMany();
    await prisma.roomMessage.deleteMany();
    await prisma.teamMember.deleteMany();
    await prisma.teamRun.deleteMany();
    await prisma.session.deleteMany();
    await prisma.workspace.deleteMany();
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

  it('deletes all associated worktrees and local branches before deleting task records', async () => {
    const stopSessionMock = vi.fn();
    const service = new TaskService(new EventBus(), { stop: stopSessionMock } as unknown as SessionManager);
    const project = await prisma.project.create({
      data: {
        name: 'Task delete project',
        repoPath: testDir,
        mainBranch: 'main',
      },
    });
    const task = await prisma.task.create({
      data: {
        title: 'Delete task resources',
        projectId: project.id,
      },
    });
    const mainWorkspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'at/task-main',
        baseBranch: 'main',
        worktreePath: path.join(testDir, '.worktrees', 'at', 'task-main'),
        status: 'ACTIVE',
      },
    });
    const memberWorkspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'at/team/12345678/member-87654321/abcdef12',
        baseBranch: mainWorkspace.branchName,
        worktreePath: path.join(testDir, '.worktrees', 'at', 'team', '12345678', 'member-87654321', 'abcdef12'),
        status: 'ACTIVE',
      },
    });
    const runningSession = await prisma.session.create({
      data: {
        workspaceId: mainWorkspace.id,
        agentType: 'CODEX',
        prompt: 'run',
        status: 'RUNNING',
      },
    });
    await prisma.session.create({
      data: {
        workspaceId: memberWorkspace.id,
        agentType: 'CODEX',
        prompt: 'done',
        status: 'COMPLETED',
      },
    });
    deleteBranchIfSafeMock.mockImplementation(async (branchName: string) => {
      await expect(prisma.task.findUnique({ where: { id: task.id } })).resolves.toMatchObject({
        id: task.id,
      });
      return {
        status: 'deleted',
        branchName,
      };
    });

    await expect(service.delete(task.id)).resolves.toBe(true);

    expect(stopSessionMock).toHaveBeenCalledTimes(1);
    expect(stopSessionMock).toHaveBeenCalledWith(runningSession.id);
    expect(removeWorktreeMock).toHaveBeenCalledTimes(2);
    expect(removeWorktreeMock).toHaveBeenCalledWith(mainWorkspace.worktreePath);
    expect(removeWorktreeMock).toHaveBeenCalledWith(memberWorkspace.worktreePath);
    expect(deleteBranchIfSafeMock).toHaveBeenCalledTimes(2);
    expect(deleteBranchIfSafeMock).toHaveBeenCalledWith(mainWorkspace.branchName, {
      protectedBranches: [project.mainBranch, mainWorkspace.baseBranch],
    });
    expect(deleteBranchIfSafeMock).toHaveBeenCalledWith(memberWorkspace.branchName, {
      protectedBranches: [project.mainBranch, memberWorkspace.baseBranch],
    });
    expect(removeWorktreeMock.mock.invocationCallOrder[0]).toBeLessThan(
      deleteBranchIfSafeMock.mock.invocationCallOrder[0],
    );
    await expect(prisma.task.findUnique({ where: { id: task.id } })).resolves.toBeNull();
    await expect(prisma.workspace.count({ where: { taskId: task.id } })).resolves.toBe(0);
    await expect(prisma.session.count({ where: { workspaceId: { in: [mainWorkspace.id, memberWorkspace.id] } } })).resolves.toBe(0);
  });

  it('continues deleting the task when branch deletion is skipped or fails', async () => {
    const service = new TaskService(new EventBus(), { stop: vi.fn() } as unknown as SessionManager);
    const project = await prisma.project.create({
      data: {
        name: 'Task delete warning project',
        repoPath: testDir,
      },
    });
    const task = await prisma.task.create({
      data: {
        title: 'Delete task with branch warning',
        projectId: project.id,
      },
    });
    const workspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'at/failing-branch',
        baseBranch: 'main',
        worktreePath: path.join(testDir, '.worktrees', 'at', 'failing-branch'),
        status: 'ACTIVE',
      },
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    deleteBranchIfSafeMock.mockResolvedValueOnce({
      status: 'failed',
      branchName: workspace.branchName,
      reason: 'git branch failed',
    });

    try {
      await expect(service.delete(task.id)).resolves.toBe(true);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Failed to delete branch ${workspace.branchName}`),
        'git branch failed',
      );
      await expect(prisma.task.findUnique({ where: { id: task.id } })).resolves.toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
