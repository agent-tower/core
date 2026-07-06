import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { SessionManager } from '../session-manager.js';
import type { TaskCleanupSnapshot } from '../task-cleanup.service.js';
import { AgentType, WorkspaceKind } from '../../types/index.js';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-task-service-'));
const dbPath = path.join(testDir, 'test.db');
process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;

const {
  removeWorktreeMock,
  deleteBranchIfSafeMock,
  pruneWorktreesMock,
} = vi.hoisted(() => ({
  removeWorktreeMock: vi.fn(),
  deleteBranchIfSafeMock: vi.fn(),
  pruneWorktreesMock: vi.fn(),
}));

vi.mock('../../git/worktree.manager.js', () => ({
  WorktreeManager: vi.fn().mockImplementation(function () {
    return {
      remove: removeWorktreeMock,
      deleteBranchIfSafe: deleteBranchIfSafeMock,
      prune: pruneWorktreesMock,
    };
  }),
}));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, '../../..');
const schemaPath = path.join(serverRoot, 'prisma/schema.prisma');

let TaskService: typeof import('../task.service.js').TaskService;
let TaskCleanupService: typeof import('../task-cleanup.service.js').TaskCleanupService;
let WorkspaceService: typeof import('../workspace.service.js').WorkspaceService;
let SessionManagerClass: typeof import('../session-manager.js').SessionManager;
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
    const cleanupModule = await import('../task-cleanup.service.js');
    const workspaceModule = await import('../workspace.service.js');
    const sessionManagerModule = await import('../session-manager.js');
    const eventBusModule = await import('../../core/event-bus.js');
    const utilsModule = await import('../../utils/index.js');
    TaskService = serviceModule.TaskService;
    TaskCleanupService = cleanupModule.TaskCleanupService;
    WorkspaceService = workspaceModule.WorkspaceService;
    SessionManagerClass = sessionManagerModule.SessionManager;
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
    pruneWorktreesMock.mockResolvedValue(undefined);

    await prisma.taskCleanupJob.deleteMany();
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

  it('returns project Git metadata when creating a task', async () => {
    const service = new TaskService(new EventBus(), {} as SessionManager);
    const projectPath = fs.mkdtempSync(path.join(testDir, 'local-task-create-project-'));
    const project = await prisma.project.create({
      data: {
        name: 'Local task create project',
        repoPath: projectPath,
      },
    });

    const task = await service.create(project.id, { title: 'Create local task' });

    expect(task.project?.isGitRepo).toBe(false);
  });

  it('splits long single-input task content into a short title and full description', async () => {
    const service = new TaskService(new EventBus(), {} as SessionManager);
    const project = await prisma.project.create({
      data: {
        name: 'Task long input project',
        repoPath: testDir,
      },
    });
    const longInput = [
      'Analyze production checkout failure logs',
      'error='.repeat(200),
      'stack='.repeat(200),
    ].join('\n');

    const task = await service.create(project.id, { title: longInput });

    expect(task.title).toBe('Analyze production checkout failure logs');
    expect(task.title.length).toBeLessThanOrEqual(200);
    expect(task.description).toBe(longInput);
  });

  it('preserves existing description content when splitting long task input', async () => {
    const service = new TaskService(new EventBus(), {} as SessionManager);
    const project = await prisma.project.create({
      data: {
        name: 'Task long input with attachments project',
        repoPath: testDir,
      },
    });
    const longInput = `Investigate logs\n${'line '.repeat(300)}`;
    const attachmentDescription = 'Attachments:\n[log.txt](/attachments/log.txt)';

    const task = await service.create(project.id, {
      title: longInput,
      description: attachmentDescription,
    });

    expect(task.title).toBe('Investigate logs');
    expect(task.description).toContain(longInput);
    expect(task.description).toContain(attachmentDescription);
  });

  it('keeps existing description when updating a task with long single-input content', async () => {
    const service = new TaskService(new EventBus(), {} as SessionManager);
    const project = await prisma.project.create({
      data: {
        name: 'Task long update project',
        repoPath: testDir,
      },
    });
    const task = await prisma.task.create({
      data: {
        title: 'Existing task',
        description: 'Original description',
        projectId: project.id,
      },
    });
    const longInput = `New incident analysis\n${'trace '.repeat(300)}`;

    const updated = await service.update(task.id, { title: longInput });

    expect(updated.title).toBe('New incident analysis');
    expect(updated.description).toContain(longInput);
    expect(updated.description).toContain('Original description');
  });

  it('returns preview-only task lists for historical oversized titles and descriptions', async () => {
    const service = new TaskService(new EventBus(), {} as SessionManager);
    const project = await prisma.project.create({
      data: {
        name: 'Task preview list project',
        repoPath: testDir,
      },
    });
    const hugeTitle = `Historical oversized title ${'x'.repeat(1000)}`;
    const hugeDescription = `Historical oversized description ${'y'.repeat(1000)}`;
    await prisma.task.create({
      data: {
        title: hugeTitle,
        description: hugeDescription,
        projectId: project.id,
      },
    });

    const list = await service.findByProjectId(project.id);

    expect(list.data[0]?.title.length).toBeLessThanOrEqual(200);
    expect(list.data[0]?.titlePreview).toBe(list.data[0]?.title);
    expect('description' in list.data[0]!).toBe(false);
    expect(list.data[0]?.contentPreview).toBeUndefined();
    expect(list.data[0]?.isTruncated).toBe(true);
  });

  it('includes project Git metadata in task lists', async () => {
    const service = new TaskService(new EventBus(), {} as SessionManager);
    const projectPath = fs.mkdtempSync(path.join(testDir, 'local-task-project-'));
    const project = await prisma.project.create({
      data: {
        name: 'Local task list project',
        repoPath: projectPath,
      },
    });
    await prisma.task.create({
      data: {
        title: 'Local-only task',
        projectId: project.id,
      },
    });

    const list = await service.findByProjectId(project.id);

    expect(list.data[0]?.project?.isGitRepo).toBe(false);
  });

  it('refreshes project Git capability in task lists after manual Git initialization', async () => {
    const service = new TaskService(new EventBus(), {} as SessionManager);
    const projectPath = fs.mkdtempSync(path.join(testDir, 'manual-git-task-project-'));
    const project = await prisma.project.create({
      data: {
        name: 'Manual git task project',
        repoPath: projectPath,
      },
    });
    await prisma.task.create({
      data: {
        title: 'Manual git task',
        projectId: project.id,
      },
    });

    const before = await service.findByProjectId(project.id);
    expect(before.data[0]?.project).toMatchObject({
      isGitRepo: false,
      worktreeReady: false,
      reason: 'NO_GIT',
    });

    execFileSync('git', ['init'], { cwd: projectPath, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectPath, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: projectPath, stdio: 'pipe' });
    fs.writeFileSync(path.join(projectPath, 'README.md'), 'ready\n', 'utf-8');
    execFileSync('git', ['add', 'README.md'], { cwd: projectPath, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: projectPath, stdio: 'pipe' });

    const after = await service.findByProjectId(project.id);
    expect(after.data[0]?.project).toMatchObject({
      isGitRepo: true,
      worktreeReady: true,
      reason: 'READY',
    });
  });

  it('includes project Git metadata in task detail', async () => {
    const service = new TaskService(new EventBus(), {} as SessionManager);
    const projectPath = fs.mkdtempSync(path.join(testDir, 'local-task-detail-project-'));
    const project = await prisma.project.create({
      data: {
        name: 'Local task detail project',
        repoPath: projectPath,
      },
    });
    const task = await prisma.task.create({
      data: {
        title: 'Local detail task',
        projectId: project.id,
      },
    });

    const detail = await service.findById(task.id);

    expect(detail.project?.isGitRepo).toBe(false);
  });

  it('returns summary detail without full description and full body on demand', async () => {
    const service = new TaskService(new EventBus(), {} as SessionManager);
    const project = await prisma.project.create({
      data: {
        name: 'Task body detail project',
        repoPath: testDir,
      },
    });
    const description = `Full task body\n${'diagnostic '.repeat(300)}`;
    const task = await prisma.task.create({
      data: {
        title: 'Analyze incident',
        description,
        projectId: project.id,
      },
    });

    const summary = await service.findById(task.id);
    expect('description' in summary).toBe(false);
    expect(summary.contentPreview).toBeUndefined();

    const body = await service.findBodyById(task.id);
    expect(body).toMatchObject({
      taskId: task.id,
      title: 'Analyze incident',
      body: description,
      bodySource: 'description',
      prompt: `Analyze incident\n\n${description}`,
    });
  });

  it('returns historical oversized title as on-demand body when no description exists', async () => {
    const service = new TaskService(new EventBus(), {} as SessionManager);
    const project = await prisma.project.create({
      data: {
        name: 'Task historical body project',
        repoPath: testDir,
      },
    });
    const historicalTitle = `Historical incident logs\n${'legacy '.repeat(300)}`;
    const task = await prisma.task.create({
      data: {
        title: historicalTitle,
        projectId: project.id,
      },
    });

    const summary = await service.findById(task.id);
    expect(summary.title.length).toBeLessThanOrEqual(200);
    expect('description' in summary).toBe(false);

    const body = await service.findBodyById(task.id);
    expect(body).toMatchObject({
      taskId: task.id,
      body: historicalTitle,
      bodySource: 'historical_title',
      prompt: historicalTitle,
    });
  });

  it('marks a task deleted and enqueues a cleanup job without waiting for resource cleanup', async () => {
    const stopSessionMock = vi.fn();
    const cleanupTriggerMock = vi.fn();
    const eventBus = new EventBus();
    const deletedEvents: Array<{ taskId: string; projectId: string }> = [];
    eventBus.on('task:deleted', (payload) => deletedEvents.push(payload));
    const service = new TaskService(
      eventBus,
      { stop: stopSessionMock } as unknown as SessionManager,
      { trigger: cleanupTriggerMock },
    );
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
    const teamRun = await prisma.teamRun.create({
      data: {
        taskId: task.id,
        mode: 'AUTO',
      },
    });
    const member = await prisma.teamMember.create({
      data: {
        teamRunId: teamRun.id,
        presetId: null,
        name: 'Member',
        aliases: '[]',
        providerId: 'provider-1',
        rolePrompt: 'Role',
        capabilities: '{}',
        workspacePolicy: 'shared',
        triggerPolicy: 'MENTION_ONLY',
        sessionPolicy: 'new_per_request',
        queueManagementPolicy: 'own_only',
        avatar: null,
      },
    });
    const pendingRequest = await prisma.workRequest.create({
      data: {
        teamRunId: teamRun.id,
        requesterMemberId: null,
        requesterType: 'user',
        targetMemberId: member.id,
        triggerMessageId: 'pending-message',
        instruction: 'please approve',
        status: 'PENDING_APPROVAL',
      },
    });
    const queuedRequest = await prisma.workRequest.create({
      data: {
        teamRunId: teamRun.id,
        requesterMemberId: null,
        requesterType: 'user',
        targetMemberId: member.id,
        triggerMessageId: 'queued-message',
        instruction: 'please run',
        status: 'QUEUED',
      },
    });
    const runningRequest = await prisma.workRequest.create({
      data: {
        teamRunId: teamRun.id,
        requesterMemberId: null,
        requesterType: 'user',
        targetMemberId: member.id,
        triggerMessageId: 'running-message',
        instruction: 'running',
        status: 'STARTED',
      },
    });
    const runningInvocation = await prisma.agentInvocation.create({
      data: {
        teamRunId: teamRun.id,
        workRequestId: runningRequest.id,
        memberId: member.id,
        workspaceId: mainWorkspace.id,
        sessionId: runningSession.id,
        status: 'RUNNING',
        nextRoomReplyReminderAt: new Date(),
      },
    });

    await expect(service.delete(task.id)).resolves.toBe(true);

    expect(stopSessionMock).not.toHaveBeenCalled();
    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(deleteBranchIfSafeMock).not.toHaveBeenCalled();
    expect(cleanupTriggerMock).toHaveBeenCalledTimes(1);
    expect(deletedEvents).toEqual([{ taskId: task.id, projectId: project.id }]);

    const deletedTask = await prisma.task.findUnique({ where: { id: task.id } });
    expect(deletedTask?.deletedAt).toBeInstanceOf(Date);
    await expect(prisma.workspace.count({ where: { taskId: task.id } })).resolves.toBe(2);
    await expect(prisma.session.count({ where: { workspaceId: { in: [mainWorkspace.id, memberWorkspace.id] } } })).resolves.toBe(2);
    await expect(prisma.workRequest.findMany({
      where: { id: { in: [pendingRequest.id, queuedRequest.id, runningRequest.id] } },
      orderBy: { id: 'asc' },
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: pendingRequest.id, status: 'CANCELLED' }),
      expect.objectContaining({ id: queuedRequest.id, status: 'CANCELLED' }),
      expect.objectContaining({ id: runningRequest.id, status: 'CANCELLED' }),
    ]));
    await expect(prisma.agentInvocation.findUnique({ where: { id: runningInvocation.id } })).resolves.toMatchObject({
      status: 'CANCELLED',
      nextRoomReplyReminderAt: null,
    });

    const cleanupJob = await prisma.taskCleanupJob.findFirstOrThrow({ where: { taskId: task.id } });
    expect(cleanupJob).toMatchObject({
      projectId: project.id,
      status: 'PENDING',
      attempts: 0,
    });
    const payload = JSON.parse(cleanupJob.payload) as TaskCleanupSnapshot;
    expect(payload).toMatchObject({
      taskId: task.id,
      projectId: project.id,
      project: {
        repoPath: project.repoPath,
        mainBranch: project.mainBranch,
      },
      workspaces: [
        {
          id: mainWorkspace.id,
          branchName: mainWorkspace.branchName,
          worktreePath: mainWorkspace.worktreePath,
          sessions: [{ id: runningSession.id }],
        },
        {
          id: memberWorkspace.id,
          branchName: memberWorkspace.branchName,
          worktreePath: memberWorkspace.worktreePath,
        },
      ],
    });
  });

  it('marks deleted before reading the cleanup snapshot so new resource creation is rejected', async () => {
    const service = new TaskService(
      new EventBus(),
      { stop: vi.fn() } as unknown as SessionManager,
      { trigger: vi.fn() },
    );
    const project = await prisma.project.create({
      data: {
        name: 'Task delete ordering project',
        repoPath: testDir,
        mainBranch: 'main',
      },
    });
    const task = await prisma.task.create({
      data: {
        title: 'Delete ordering task',
        projectId: project.id,
      },
    });
    const existingWorkspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'at/existing-before-delete',
        baseBranch: 'main',
        worktreePath: path.join(testDir, '.worktrees', 'at', 'existing-before-delete'),
        status: 'ACTIVE',
      },
    });
    const runningSession = await prisma.session.create({
      data: {
        workspaceId: existingWorkspace.id,
        agentType: 'CODEX',
        prompt: 'run',
        status: 'RUNNING',
      },
    });
    let releaseSnapshotRead!: () => void;
    const releaseSnapshotReadPromise = new Promise<void>((resolve) => {
      releaseSnapshotRead = resolve;
    });
    let snapshotReadStarted!: () => void;
    const snapshotReadStartedPromise = new Promise<void>((resolve) => {
      snapshotReadStarted = resolve;
    });
    let shouldDelaySnapshotRead = true;
    prisma.$use(async (params, next) => {
      const include = (params.args as { include?: { workspaces?: unknown } } | undefined)?.include;
      const isSnapshotRead = params.model === 'Task'
        && params.action === 'findUnique'
        && Boolean(include?.workspaces);
      if (shouldDelaySnapshotRead && isSnapshotRead) {
        shouldDelaySnapshotRead = false;
        snapshotReadStarted();
        await releaseSnapshotReadPromise;
      }
      return next(params);
    });

    const deletePromise = service.delete(task.id);
    await snapshotReadStartedPromise;
    await expect(prisma.task.findUnique({ where: { id: task.id } })).resolves.toMatchObject({
      deletedAt: expect.any(Date),
    });
    const workspaceService = new WorkspaceService();
    await expect(workspaceService.create(task.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
    const sessionManager = new SessionManagerClass(new EventBus());
    await expect(sessionManager.create(existingWorkspace.id, AgentType.CODEX, 'late session')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });
    releaseSnapshotRead();

    await expect(deletePromise).resolves.toBe(true);

    const cleanupJob = await prisma.taskCleanupJob.findFirstOrThrow({ where: { taskId: task.id } });
    const payload = JSON.parse(cleanupJob.payload) as TaskCleanupSnapshot;
    expect(payload.workspaces).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: existingWorkspace.id,
        branchName: existingWorkspace.branchName,
        worktreePath: existingWorkspace.worktreePath,
        sessions: [{ id: runningSession.id }],
      }),
    ]));
  });

  it('filters deleted tasks from lists and stats', async () => {
    const service = new TaskService(new EventBus(), { stop: vi.fn() } as unknown as SessionManager);
    const project = await prisma.project.create({
      data: {
        name: 'Task list project',
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
        title: 'Deleted task',
        projectId: project.id,
        status: 'DONE',
        deletedAt: new Date(),
      },
    });

    const list = await service.findByProjectId(project.id);
    expect(list.total).toBe(1);
    expect(list.data.map((task) => task.title)).toEqual(['Visible task']);

    const stats = await service.getStatsByProjectId(project.id);
    expect(stats.total).toBe(1);
    expect(stats.done).toBe(0);
    expect(stats.todo).toBe(1);
  });

  it('unwatches active workspaces when retry abandons them', async () => {
    const stopSessionMock = vi.fn();
    const unwatchWorkspaceMock = vi.fn();
    const service = new TaskService(
      new EventBus(),
      { stop: stopSessionMock } as unknown as SessionManager,
      undefined,
      { unwatchWorkspace: unwatchWorkspaceMock },
    );
    const project = await prisma.project.create({
      data: {
        name: 'Task retry watcher project',
        repoPath: testDir,
      },
    });
    const task = await prisma.task.create({
      data: {
        title: 'Retry releases watcher',
        projectId: project.id,
        status: 'IN_PROGRESS',
      },
    });
    const workspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'at/retry-watcher',
        baseBranch: 'main',
        worktreePath: path.join(testDir, '.worktrees', 'at', 'retry-watcher'),
        workingDir: path.join(testDir, '.worktrees', 'at', 'retry-watcher'),
        status: 'ACTIVE',
      },
    });
    const inactiveWorkspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'at/retry-old',
        baseBranch: 'main',
        worktreePath: path.join(testDir, '.worktrees', 'at', 'retry-old'),
        workingDir: path.join(testDir, '.worktrees', 'at', 'retry-old'),
        status: 'ABANDONED',
      },
    });
    const runningSession = await prisma.session.create({
      data: {
        workspaceId: workspace.id,
        agentType: 'CODEX',
        prompt: 'run',
        status: 'RUNNING',
      },
    });

    const updated = await service.retry(task.id);

    expect(updated.status).toBe('TODO');
    expect(updated.project?.isGitRepo).toBe(false);
    expect(stopSessionMock).toHaveBeenCalledWith(runningSession.id);
    expect(unwatchWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(unwatchWorkspaceMock).toHaveBeenCalledWith(workspace.id);
    expect(unwatchWorkspaceMock).not.toHaveBeenCalledWith(inactiveWorkspace.id);
    await expect(prisma.workspace.findUnique({ where: { id: workspace.id } })).resolves.toMatchObject({
      status: 'ABANDONED',
    });
  });

  it('processes a cleanup job and hard-deletes task records after resources are cleaned', async () => {
    const stopSessionMock = vi.fn();
    const cleanupService = new TaskCleanupService({ stop: stopSessionMock } as unknown as SessionManager);
    const project = await prisma.project.create({
      data: {
        name: 'Task cleanup project',
        repoPath: testDir,
        mainBranch: 'main',
      },
    });
    const task = await prisma.task.create({
      data: {
        title: 'Cleanup task resources',
        projectId: project.id,
        deletedAt: new Date(),
      },
    });
    const workspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'at/cleanup-branch',
        baseBranch: 'main',
        worktreePath: path.join(testDir, '.worktrees', 'at', 'cleanup-branch'),
        status: 'ACTIVE',
      },
    });
    const runningSession = await prisma.session.create({
      data: {
        workspaceId: workspace.id,
        agentType: 'CODEX',
        prompt: 'run',
        status: 'RUNNING',
      },
    });
    const payload: TaskCleanupSnapshot = {
      taskId: task.id,
      projectId: project.id,
      project: {
        repoPath: project.repoPath,
        mainBranch: project.mainBranch,
      },
      workspaces: [{
        id: workspace.id,
        worktreePath: workspace.worktreePath,
        workingDir: workspace.worktreePath,
        workspaceKind: workspace.workspaceKind,
        branchName: workspace.branchName,
        baseBranch: workspace.baseBranch,
        sessions: [{ id: runningSession.id }],
      }],
    };
    await prisma.taskCleanupJob.create({
      data: {
        taskId: task.id,
        projectId: project.id,
        payload: JSON.stringify(payload),
      },
    });

    await expect(cleanupService.processDueJobs()).resolves.toBe(1);

    expect(stopSessionMock).toHaveBeenCalledWith(runningSession.id, { skipTeamRunReconcile: true });
    expect(removeWorktreeMock).toHaveBeenCalledWith(workspace.worktreePath);
    expect(deleteBranchIfSafeMock).toHaveBeenCalledWith(workspace.branchName, {
      protectedBranches: [project.mainBranch, workspace.baseBranch],
    });
    expect(pruneWorktreesMock).toHaveBeenCalledTimes(1);
    await expect(prisma.task.findUnique({ where: { id: task.id } })).resolves.toBeNull();
    await expect(prisma.workspace.count({ where: { taskId: task.id } })).resolves.toBe(0);
    await expect(prisma.taskCleanupJob.findFirst({ where: { taskId: task.id } })).resolves.toMatchObject({
      status: 'COMPLETED',
      attempts: 1,
      lastError: null,
    });
  });

  it('processes main-directory cleanup jobs without deleting worktrees or branches', async () => {
    const stopSessionMock = vi.fn();
    const cleanupService = new TaskCleanupService({ stop: stopSessionMock } as unknown as SessionManager);
    const project = await prisma.project.create({
      data: {
        name: 'Main directory cleanup project',
        repoPath: testDir,
        mainBranch: 'main',
      },
    });
    const task = await prisma.task.create({
      data: {
        title: 'Cleanup main directory resources',
        projectId: project.id,
        deletedAt: new Date(),
      },
    });
    const workspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: '',
        baseBranch: 'main',
        worktreePath: '',
        workspaceKind: WorkspaceKind.MAIN_DIRECTORY,
        workingDir: project.repoPath,
        status: 'ACTIVE',
      },
    });
    const payload: TaskCleanupSnapshot = {
      taskId: task.id,
      projectId: project.id,
      project: {
        repoPath: project.repoPath,
        mainBranch: project.mainBranch,
      },
      workspaces: [{
        id: workspace.id,
        worktreePath: workspace.worktreePath,
        workingDir: workspace.workingDir,
        workspaceKind: workspace.workspaceKind,
        branchName: workspace.branchName,
        baseBranch: workspace.baseBranch,
        sessions: [],
      }],
    };
    await prisma.taskCleanupJob.create({
      data: {
        taskId: task.id,
        projectId: project.id,
        payload: JSON.stringify(payload),
      },
    });

    await expect(cleanupService.processDueJobs()).resolves.toBe(1);

    expect(stopSessionMock).not.toHaveBeenCalled();
    expect(removeWorktreeMock).not.toHaveBeenCalled();
    expect(deleteBranchIfSafeMock).not.toHaveBeenCalled();
    expect(pruneWorktreesMock).not.toHaveBeenCalled();
    await expect(prisma.task.findUnique({ where: { id: task.id } })).resolves.toBeNull();
    await expect(prisma.workspace.count({ where: { taskId: task.id } })).resolves.toBe(0);
  });

  it('records cleanup failures and schedules retry', async () => {
    const cleanupService = new TaskCleanupService({ stop: vi.fn() } as unknown as SessionManager);
    const project = await prisma.project.create({
      data: {
        name: 'Task cleanup failure project',
        repoPath: testDir,
      },
    });
    const task = await prisma.task.create({
      data: {
        title: 'Cleanup failure',
        projectId: project.id,
        deletedAt: new Date(),
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
    const payload: TaskCleanupSnapshot = {
      taskId: task.id,
      projectId: project.id,
      project: {
        repoPath: project.repoPath,
        mainBranch: project.mainBranch,
      },
      workspaces: [{
        id: workspace.id,
        worktreePath: workspace.worktreePath,
        workingDir: workspace.worktreePath,
        workspaceKind: workspace.workspaceKind,
        branchName: workspace.branchName,
        baseBranch: workspace.baseBranch,
        sessions: [],
      }],
    };
    const job = await prisma.taskCleanupJob.create({
      data: {
        taskId: task.id,
        projectId: project.id,
        payload: JSON.stringify(payload),
      },
    });
    deleteBranchIfSafeMock.mockResolvedValueOnce({
      status: 'failed',
      branchName: workspace.branchName,
      reason: 'git branch failed',
    });

    await expect(cleanupService.processDueJobs()).resolves.toBe(1);

    await expect(prisma.task.findUnique({ where: { id: task.id } })).resolves.toMatchObject({
      id: task.id,
    });
    await expect(prisma.taskCleanupJob.findUnique({ where: { id: job.id } })).resolves.toMatchObject({
      status: 'FAILED',
      attempts: 1,
      lastError: expect.stringContaining('git branch failed'),
      nextRetryAt: expect.any(Date),
    });
  });
});
