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
let ProjectService: typeof import('../project.service.js').ProjectService;
let TaskCleanupService: typeof import('../task-cleanup.service.js').TaskCleanupService;
let WorkspaceService: typeof import('../workspace.service.js').WorkspaceService;
let SessionManagerClass: typeof import('../session-manager.js').SessionManager;
let EventBus: typeof import('../../core/event-bus.js').EventBus;
let prisma: PrismaClient;

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xDC00 || next > 0xDFFF) {
        return true;
      }
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      return true;
    }
  }
  return false;
}

describe('TaskService', () => {
  beforeAll(async () => {
    fs.closeSync(fs.openSync(dbPath, 'a'));
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
    const projectServiceModule = await import('../project.service.js');
    const cleanupModule = await import('../task-cleanup.service.js');
    const workspaceModule = await import('../workspace.service.js');
    const sessionManagerModule = await import('../session-manager.js');
    const eventBusModule = await import('../../core/event-bus.js');
    const utilsModule = await import('../../utils/index.js');
    TaskService = serviceModule.TaskService;
    ProjectService = projectServiceModule.ProjectService;
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

  it('saves explicit and default local bases before a later project default change', async () => {
    const repoPath = fs.mkdtempSync(path.join(testDir, 'base-branch-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
    git('init', '-b', 'main');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial');
    git('branch', 'develop');
    const project = await prisma.project.create({ data: { name: 'Bases', repoPath, mainBranch: 'main' } });
    const service = new TaskService(new EventBus(), {} as SessionManager);
    const overridden = await service.create(project.id, { title: 'Override', baseBranch: ' develop ' });
    const inherited = await service.create(project.id, { title: 'Default' });
    const local = await service.create(project.id, { title: 'Main directory', baseBranch: null });

    expect(overridden.baseBranch).toBe('develop');
    expect(inherited.baseBranch).toBe('main');
    expect(local.baseBranch).toBeNull();
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).mainBranch).toBe('main');
    await prisma.project.update({ where: { id: project.id }, data: { mainBranch: 'develop' } });
    expect((await service.findById(inherited.id)).baseBranch).toBe('main');
    expect((await service.findById(overridden.id)).baseBranch).toBe('develop');
    expect((await service.create(project.id, { title: 'New default' })).baseBranch).toBe('develop');
  });

  it('rejects missing, remote, tag and revision bases without creating a task', async () => {
    const repoPath = fs.mkdtempSync(path.join(testDir, 'invalid-base-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
    git('init', '-b', 'main');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial');
    git('tag', 'v1');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const project = await prisma.project.create({ data: { name: 'Invalid bases', repoPath } });
    const service = new TaskService(new EventBus(), {} as SessionManager);
    for (const baseBranch of ['', 'missing', 'origin/main', 'v1', 'main~1', '../escape']) {
      await expect(service.create(project.id, { title: 'Invalid base', baseBranch })).rejects.toMatchObject({ code: 'INVALID_BASE_BRANCH' });
    }
    expect(await prisma.task.count({ where: { projectId: project.id } })).toBe(0);
  });

  it('allows local and uncommitted projects without a base branch', async () => {
    const repoPath = fs.mkdtempSync(path.join(testDir, 'no-base-'));
    const service = new TaskService(new EventBus(), {} as SessionManager);
    const project = await prisma.project.create({ data: { name: 'Local', repoPath } });
    expect((await service.create(project.id, { title: 'No Git' })).baseBranch).toBeNull();
    await expect(service.create(project.id, { title: 'Invalid', baseBranch: 'main' })).rejects.toMatchObject({ code: 'INVALID_BASE_BRANCH' });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath, stdio: 'pipe' });
    expect((await service.create(project.id, { title: 'Unborn Git' })).baseBranch).toBeNull();
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

  it('splits multiline task content into a title and the unconsumed body', async () => {
    const service = new TaskService(new EventBus(), {} as SessionManager);
    const project = await prisma.project.create({
      data: {
        name: 'Task long input project',
        repoPath: testDir,
      },
    });
    const body = [
      'error='.repeat(200),
      'stack='.repeat(200),
    ].join('\n');
    const longInput = [
      'Analyze production checkout failure logs',
      body,
    ].join('\n');

    const task = await service.create(project.id, { title: longInput });

    expect(task.title).toBe('Analyze production checkout failure logs');
    expect(task.title.length).toBeLessThanOrEqual(200);
    expect(task.description).toBe(body);
    expect(`${task.title}\n${task.description}`).toBe(longInput);
  });

  it('preserves the unconsumed suffix of oversized single-line task content', async () => {
    const service = new TaskService(new EventBus(), {} as SessionManager);
    const project = await prisma.project.create({
      data: {
        name: 'Task oversized single-line project',
        repoPath: testDir,
      },
    });
    const longInput = 'x'.repeat(300);

    const task = await service.create(project.id, { title: longInput });

    expect(task.title).toBe(`${'x'.repeat(197)}...`);
    expect(task.description).toBe('x'.repeat(103));
    expect(`${task.title.slice(0, -3)}${task.description}`).toBe(longInput);
  });

  it('splits oversized emoji create input at complete Unicode code point boundaries', async () => {
    const service = new TaskService(new EventBus(), {} as SessionManager);
    const project = await prisma.project.create({
      data: {
        name: 'Task emoji create project',
        repoPath: testDir,
      },
    });
    const longInput = '😀'.repeat(150);

    const task = await service.create(project.id, { title: longInput });

    expect(task.title).toBe(`${'😀'.repeat(98)}...`);
    expect(task.description).toBe('😀'.repeat(52));
    expect(hasLoneSurrogate(task.title)).toBe(false);
    expect(hasLoneSurrogate(task.description ?? '')).toBe(false);
    expect(`${task.title.slice(0, -3)}${task.description}`).toBe(longInput);
  });

  it.each([
    {
      name: 'CRLF separator',
      input: `CRLF title\r\n${'detail '.repeat(50)}`,
      expectedTitle: 'CRLF title',
      expectedBody: 'detail '.repeat(50),
    },
    {
      name: 'leading body blank line',
      input: `Blank line title\n\n${'detail '.repeat(50)}`,
      expectedTitle: 'Blank line title',
      expectedBody: `\n${'detail '.repeat(50)}`,
    },
    {
      name: 'leading blank lines before the title',
      input: `\r\n\r\nPrefaced title\r\n${'detail '.repeat(50)}`,
      expectedTitle: 'Prefaced title',
      expectedBody: 'detail '.repeat(50),
    },
    {
      name: 'indented Markdown code block',
      input: `Code block title\r\n    ${'code '.repeat(60)}`,
      expectedTitle: 'Code block title',
      expectedBody: `    ${'code '.repeat(60)}`,
    },
    {
      name: 'first sentence extraction',
      input: `Stop after this sentence. Continue with ${'details '.repeat(50)}`,
      expectedTitle: 'Stop after this sentence.',
      expectedBody: `Continue with ${'details '.repeat(50)}`,
    },
  ])('preserves the exact autosplit body for $name', async ({ input, expectedTitle, expectedBody }) => {
    const service = new TaskService(new EventBus(), {} as SessionManager);
    const project = await prisma.project.create({
      data: {
        name: `Task whitespace project ${expectedTitle}`,
        repoPath: testDir,
      },
    });

    const task = await service.create(project.id, { title: input });

    expect(task.title).toBe(expectedTitle);
    expect(task.description).toBe(expectedBody);
  });

  it('preserves existing description content when splitting long task input', async () => {
    const service = new TaskService(new EventBus(), {} as SessionManager);
    const project = await prisma.project.create({
      data: {
        name: 'Task long input with attachments project',
        repoPath: testDir,
      },
    });
    const body = 'line '.repeat(300);
    const longInput = `Investigate logs\n${body}`;
    const attachmentDescription = 'Attachments:\n[log.txt](/attachments/log.txt)';

    const task = await service.create(project.id, {
      title: longInput,
      description: attachmentDescription,
    });

    expect(task.title).toBe('Investigate logs');
    expect(task.description).toBe(`${body}\n\n${attachmentDescription}`);
    expect(task.description).not.toContain('Investigate logs');
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

  it('preserves independently supplied short titles and descriptions on create', async () => {
    const service = new TaskService(new EventBus(), {} as SessionManager);
    const project = await prisma.project.create({
      data: {
        name: 'Task independent fields project',
        repoPath: testDir,
      },
    });

    const task = await service.create(project.id, {
      title: 'External task title',
      description: 'Independent task description',
    });
    expect(task).toMatchObject({
      title: 'External task title',
      description: 'Independent task description',
    });
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

  it('uses persisted project Git capability in task lists', async () => {
    const service = new TaskService(new EventBus(), {} as SessionManager);
    const projectPath = fs.mkdtempSync(path.join(testDir, 'manual-git-task-project-'));
    const project = await prisma.project.create({
      data: {
        name: 'Manual git task project',
        repoPath: projectPath,
        isGitRepo: false,
        worktreeReady: false,
        gitCapabilityReason: 'NO_GIT',
        gitCapabilityCheckedAt: new Date(),
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

    const stale = await service.findByProjectId(project.id);
    expect(stale.data[0]?.project).toMatchObject({
      isGitRepo: false,
      worktreeReady: false,
      reason: 'NO_GIT',
    });

    await new ProjectService().refreshGitCapability(project.id);
    const refreshed = await service.findByProjectId(project.id);
    expect(refreshed.data[0]?.project).toMatchObject({
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

  it('stops background services, marks a task deleted, and defers remaining cleanup', async () => {
    const stopSessionMock = vi.fn();
    const cleanupTriggerMock = vi.fn();
    const stopBackgroundServicesMock = vi.fn(async () => {});
    const eventBus = new EventBus();
    const deletedEvents: Array<{ taskId: string; projectId: string }> = [];
    eventBus.on('task:deleted', (payload) => deletedEvents.push(payload));
    const service = new TaskService(
      eventBus,
      { stop: stopSessionMock, isRuntimeCleanupConfirmed: vi.fn(async () => true) } as unknown as SessionManager,
      { trigger: cleanupTriggerMock },
      { stopAllForWorkspace: stopBackgroundServicesMock },
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
    const completedSession = await prisma.session.create({
      data: {
        workspaceId: memberWorkspace.id,
        agentType: 'CODEX',
        runtimeType: 'ACP',
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

    expect(stopBackgroundServicesMock).toHaveBeenCalledTimes(2);
    expect(stopBackgroundServicesMock).toHaveBeenCalledWith(mainWorkspace.id);
    expect(stopBackgroundServicesMock).toHaveBeenCalledWith(memberWorkspace.id);
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
          sessions: [{ id: completedSession.id }],
        },
      ],
    });
  });

  it('commits deletion markers and recovery snapshot atomically, then rejects new resources', async () => {
    const service = new TaskService(new EventBus(), {} as SessionManager, { trigger: vi.fn() });
    const project = await prisma.project.create({ data: { name: 'Atomic deletion', repoPath: testDir } });
    const parent = await prisma.task.create({ data: { title: 'Parent', projectId: project.id } });
    const child = await prisma.task.create({ data: { title: 'Child', projectId: project.id, parentTaskId: parent.id } });
    let failSnapshot = true;
    prisma.$use(async (params, next) => {
      if (failSnapshot && params.model === 'TaskCleanupJob' && params.action === 'create') {
        failSnapshot = false;
        throw new Error('snapshot persistence failed');
      }
      return next(params);
    });
    await expect(service.delete(parent.id)).rejects.toThrow('snapshot persistence failed');
    expect(await prisma.task.count({ where: { deletedAt: null } })).toBe(2);
    expect(await prisma.taskCleanupJob.count()).toBe(0);
    await service.delete(parent.id);
    expect(await prisma.task.count({ where: { deletedAt: null } })).toBe(0);
    const workspaceService = new WorkspaceService();
    await expect(workspaceService.create(parent.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(workspaceService.create(child.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.create(project.id, { title: 'Late child', parentTaskId: parent.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('inherits the parent root branch, permits an override, and rejects invalid parents', async () => {
    const repoPath = path.join(testDir, 'subtask-branches');
    fs.mkdirSync(repoPath, { recursive: true });
    const git = (args: string[]) => execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
    git(['init', '-b', 'main']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial']);
    git(['branch', 'at/parent']);
    git(['branch', 'develop']);
    const project = await prisma.project.create({ data: { name: 'Branches', repoPath, mainBranch: 'main' } });
    const parent = await prisma.task.create({ data: { title: 'Parent', projectId: project.id, baseBranch: 'main' } });
    await prisma.workspace.create({ data: { taskId: parent.id, branchName: 'at/parent', worktreePath: '/unused', baseBranch: 'main' } });
    const service = new TaskService(new EventBus(), {} as SessionManager);
    const child = await service.create(project.id, { title: 'Child', parentTaskId: parent.id });
    expect(child).toMatchObject({ parentTaskId: parent.id, baseBranch: 'at/parent' });
    const override = await service.create(project.id, { title: 'Override', parentTaskId: parent.id, baseBranch: 'develop' });
    expect(override.baseBranch).toBe('develop');
    const local = await service.create(project.id, { title: 'Local', parentTaskId: parent.id, baseBranch: null });
    expect(local.baseBranch).toBeNull();
    const grandchild = await service.create(project.id, { title: 'Nested', parentTaskId: child.id });
    expect(grandchild).toMatchObject({ parentTaskId: child.id, ancestorIds: [parent.id, child.id], baseBranch: 'at/parent' });
    git(['branch', 'at/child']);
    await prisma.workspace.create({ data: { taskId: child.id, branchName: 'at/child', worktreePath: '/unused-child', baseBranch: 'at/parent' } });
    const fromChildBranch = await service.create(project.id, { title: 'Child branch', parentTaskId: child.id });
    expect(fromChildBranch.baseBranch).toBe('at/child');
    await expect(service.create(project.id, { title: 'Fourth level', parentTaskId: grandchild.id })).rejects.toThrow('at most three levels');
    expect((await service.findById(grandchild.id)).ancestorIds).toEqual([parent.id, child.id]);
    const other = await prisma.project.create({ data: { name: 'Other', repoPath: testDir } });
    await expect(service.create(other.id, { title: 'Cross project', parentTaskId: parent.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await service.updateStatus(child.id, 'DONE' as any);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: parent.id } })).status).toBe('TODO');
  });

  it('keeps parent context when a running child is on a different page or status filter', async () => {
    const project = await prisma.project.create({ data: { name: 'Board tree', repoPath: testDir } });
    const parent = await prisma.task.create({ data: { title: 'Done parent', projectId: project.id, status: 'DONE' } });
    const child = await prisma.task.create({ data: { title: 'Running child', projectId: project.id, status: 'IN_PROGRESS', parentTaskId: parent.id } });
    const service = new TaskService(new EventBus(), {} as SessionManager);
    const page = await service.findBoard({ limit: 1 });
    expect(page.data.map(task => task.id)).toEqual([child.id]);
    expect(page.parents).toEqual([expect.objectContaining({ id: parent.id, subtaskCount: 1, runningSubtaskCount: 1 })]);
    expect(page.total).toBe(2);
    const filtered = await service.findBoard({ status: 'IN_PROGRESS' as any });
    expect(filtered.parents?.[0].id).toBe(parent.id);
    expect((await service.findSubtasks(parent.id)).data.map(task => task.id)).toEqual([child.id]);
  });

  it('returns the full ancestor path when only a grandchild matches the board page', async () => {
    const project = await prisma.project.create({ data: { name: 'Three levels', repoPath: testDir } });
    const parent = await prisma.task.create({ data: { title: 'Root', projectId: project.id, status: 'DONE' } });
    const child = await prisma.task.create({ data: { title: 'Child', projectId: project.id, parentTaskId: parent.id, status: 'DONE' } });
    const grandchild = await prisma.task.create({ data: { title: 'Grandchild', projectId: project.id, parentTaskId: child.id, status: 'IN_PROGRESS' } });
    const service = new TaskService(new EventBus(), {} as SessionManager);
    const board = await service.findBoard({ status: 'IN_PROGRESS' as any, limit: 1 });
    expect(board).toMatchObject({ total: 1, data: [{ id: grandchild.id, ancestorIds: [parent.id, child.id] }] });
    expect(board.parents?.map(task => task.id).sort()).toEqual([parent.id, child.id].sort());
    const children = await service.findSubtasks(parent.id);
    expect(children).toMatchObject({ total: 1, data: [{ id: child.id, subtaskCount: 1, ancestorIds: [parent.id] }] });
    expect((await service.findSubtasks(child.id)).data[0]?.ancestorIds).toEqual([parent.id, child.id]);
  });

  it('rechecks the full deletion scope when a grandchild is created during deletion preparation', async () => {
    const project = await prisma.project.create({ data: { name: 'Delete race', repoPath: testDir } });
    const parent = await prisma.task.create({ data: { title: 'Root', projectId: project.id } });
    const child = await prisma.task.create({ data: { title: 'Child', projectId: project.id, parentTaskId: parent.id } });
    await prisma.workspace.create({ data: { taskId: parent.id, branchName: 'at/root', worktreePath: '/unused' } });
    let ready!: () => void;
    let resume!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const blocked = new Promise<void>(resolve => { resume = resolve; });
    const service = new TaskService(new EventBus(), {} as SessionManager, { trigger: vi.fn() }, {
      stopAllForWorkspace: vi.fn(async () => { ready(); await blocked; }),
    });
    const deletion = service.delete(parent.id, 1);
    const rejected = expect(deletion).rejects.toMatchObject({ code: 'TASK_DELETE_SCOPE_CHANGED' });
    await started;
    const grandchild = await service.create(project.id, { title: 'Concurrent grandchild', parentTaskId: child.id, baseBranch: null });
    resume();
    await rejected;
    expect(await prisma.task.count({ where: { deletedAt: null } })).toBe(3);
    expect(await prisma.taskCleanupJob.count()).toBe(0);
    await service.delete(parent.id, 2);
    await expect(service.create(project.id, { title: 'Too late', parentTaskId: child.id, baseBranch: null })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await prisma.task.findUnique({ where: { id: grandchild.id } })).toMatchObject({ deletedAt: expect.any(Date) });
  });

  it('deletes the complete family and cleans child branches before the parent, preserving unrelated tasks', async () => {
    const project = await prisma.project.create({ data: { name: 'Cascade', repoPath: testDir } });
    const parent = await prisma.task.create({ data: { title: 'Parent', projectId: project.id } });
    const child = await prisma.task.create({ data: { title: 'Child', projectId: project.id, parentTaskId: parent.id } });
    const grandchild = await prisma.task.create({ data: { title: 'Grandchild', projectId: project.id, parentTaskId: child.id } });
    const other = await prisma.task.create({ data: { title: 'Other', projectId: project.id } });
    const rootWorkspace = await prisma.workspace.create({ data: { taskId: parent.id, branchName: 'at/parent', worktreePath: '/unused/parent', baseBranch: 'main' } });
    const childWorkspace = await prisma.workspace.create({ data: { taskId: child.id, branchName: 'at/child', worktreePath: '/unused/child', baseBranch: 'at/parent' } });
    const grandchildWorkspace = await prisma.workspace.create({ data: { taskId: grandchild.id, branchName: 'at/grandchild', worktreePath: '/unused/grandchild', baseBranch: 'at/child' } });
    const stop = vi.fn();
    const sessionManager = { stop, isRuntimeCleanupConfirmed: vi.fn(async () => true) } as unknown as SessionManager;
    const eventBus = new EventBus();
    const deleted: string[] = [];
    eventBus.on('task:deleted', event => deleted.push(event.taskId));
    const service = new TaskService(eventBus, sessionManager, { trigger: vi.fn() });
    await expect(service.delete(parent.id, 0)).rejects.toMatchObject({ code: 'TASK_DELETE_SCOPE_CHANGED' });
    expect(await prisma.task.count({ where: { deletedAt: null } })).toBe(4);
    expect(await service.getDeletionScope(parent.id)).toEqual({ descendantCount: 2 });
    await service.delete(parent.id, 2);
    expect(deleted).toEqual([grandchild.id, child.id, parent.id]);
    const job = await prisma.taskCleanupJob.findFirstOrThrow({ where: { taskId: parent.id } });
    expect(JSON.parse(job.payload).taskIds).toEqual([grandchild.id, child.id, parent.id]);
    const worker = new TaskCleanupService(sessionManager);
    deleteBranchIfSafeMock.mockResolvedValueOnce({ status: 'failed', branchName: 'at/grandchild', reason: 'temporary lock' });
    await worker.processDueJobs();
    expect((await service.getCleanupStatus(parent.id)).status).toBe('FAILED');
    expect(await prisma.task.count({ where: { id: { in: [parent.id, child.id, grandchild.id] } } })).toBe(3);
    await service.retryCleanup(parent.id);
    expect((await service.getCleanupStatus(parent.id)).status).toBe('PENDING');
    deleteBranchIfSafeMock.mockClear();
    await worker.processDueJobs();
    expect(removeWorktreeMock.mock.calls.slice(-3).map(call => call[0])).toEqual([grandchildWorkspace.worktreePath, childWorkspace.worktreePath, rootWorkspace.worktreePath]);
    expect(deleteBranchIfSafeMock.mock.calls.map(call => call[0])).toEqual(['at/grandchild', 'at/child', 'at/parent']);
    expect(await prisma.task.count()).toBe(1);
    expect(await prisma.task.findUnique({ where: { id: other.id } })).not.toBeNull();
    expect((await service.getCleanupStatus(parent.id)).status).toBe('COMPLETED');
  });

  it('deleting one child preserves its parent and sibling', async () => {
    const project = await prisma.project.create({ data: { name: 'Child deletion', repoPath: testDir } });
    const parent = await prisma.task.create({ data: { title: 'Parent', projectId: project.id } });
    const child = await prisma.task.create({ data: { title: 'Child', projectId: project.id, parentTaskId: parent.id } });
    const sibling = await prisma.task.create({ data: { title: 'Sibling', projectId: project.id, parentTaskId: parent.id } });
    const service = new TaskService(new EventBus(), {} as SessionManager, { trigger: vi.fn() });
    const grandchild = await prisma.task.create({ data: { title: 'Grandchild', projectId: project.id, parentTaskId: child.id } });
    const otherGrandchild = await prisma.task.create({ data: { title: 'Other grandchild', projectId: project.id, parentTaskId: child.id } });
    await service.delete(grandchild.id, 0);
    expect((await service.findById(child.id)).subtaskCount).toBe(1);
    expect((await service.findById(otherGrandchild.id)).parentTaskId).toBe(child.id);
    await service.delete(child.id, 1);
    await expect(service.findById(otherGrandchild.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await service.findById(parent.id)).subtaskCount).toBe(1);
    expect((await service.findById(sibling.id)).parentTaskId).toBe(parent.id);
  });

  it('filters deleted tasks from lists and stats', async () => {
    const service = new TaskService(new EventBus(), { stop: vi.fn(), isRuntimeCleanupConfirmed: vi.fn(async () => true) } as unknown as SessionManager);
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

  it('stops active sessions and abandons active workspaces on retry', async () => {
    const stopSessionMock = vi.fn();
    const service = new TaskService(
      new EventBus(),
      { stop: stopSessionMock, isRuntimeCleanupConfirmed: vi.fn(async () => true) } as unknown as SessionManager,
    );
    const project = await prisma.project.create({
      data: {
        name: 'Task retry workspace project',
        repoPath: testDir,
      },
    });
    const task = await prisma.task.create({
      data: {
        title: 'Retry abandons workspace',
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
    await expect(prisma.workspace.findUnique({ where: { id: workspace.id } })).resolves.toMatchObject({
      status: 'ABANDONED',
    });
    await expect(prisma.workspace.findUnique({ where: { id: inactiveWorkspace.id } })).resolves.toMatchObject({
      status: 'ABANDONED',
    });
  });

  it.each(['stop-fails', 'cleanup-unconfirmed'] as const)(
    'retains resources omitted from a legacy cleanup snapshot for retry when %s', async (failure) => {
      const project = await prisma.project.create({ data: { name: 'pending owner', repoPath: testDir } });
      const task = await prisma.task.create({ data: { title: 'pending owner', projectId: project.id, deletedAt: new Date() } });
      const workspace = await prisma.workspace.create({ data: {
        taskId: task.id, branchName: 'pending-owner', worktreePath: path.join(testDir, '.worktrees', 'pending-owner'),
        sessions: { create: {
          agentType: 'CODEX', runtimeType: 'ACP', prompt: 'audit', status: 'COMPLETED',
          processes: { create: { pid: 999999, cleanupState: 'FAILED' } },
        } },
      }, include: { sessions: true } });
      const session = workspace.sessions[0]!;
      const stop = vi.fn(async () => {
        if (failure === 'stop-fails') throw new Error('owner still alive');
        return session;
      });
      const isRuntimeCleanupConfirmed = vi.fn(async () => false);
      const worker = new TaskCleanupService({ stop, isRuntimeCleanupConfirmed } as unknown as SessionManager);
      const job = await prisma.taskCleanupJob.create({ data: {
        taskId: task.id, projectId: project.id,
        payload: JSON.stringify({
          taskId: task.id, projectId: project.id,
          project: { repoPath: project.repoPath, mainBranch: project.mainBranch },
          workspaces: [{ ...workspace, sessions: [] }],
        }),
      } });
      await worker.processDueJobs();
      expect(stop).toHaveBeenCalledWith(session.id, { skipTeamRunReconcile: true });
      expect(removeWorktreeMock).not.toHaveBeenCalled();
      expect(await prisma.executionProcess.count({ where: { sessionId: session.id } })).toBe(1);
      expect(await prisma.task.findUnique({ where: { id: task.id } })).not.toBeNull();
      expect(await prisma.taskCleanupJob.findUnique({ where: { id: job.id } })).toMatchObject({ status: 'FAILED' });
      stop.mockImplementation(async () => session);
      isRuntimeCleanupConfirmed.mockResolvedValue(true);
      await prisma.taskCleanupJob.update({ where: { id: job.id }, data: { nextRetryAt: null } });
      await worker.processDueJobs();
      expect(await prisma.task.findUnique({ where: { id: task.id } })).toBeNull();
      expect(await prisma.taskCleanupJob.findUnique({ where: { id: job.id } })).toMatchObject({ status: 'COMPLETED' });
    },
  );

  it('processes a cleanup job and hard-deletes task records after resources are cleaned', async () => {
    const stopSessionMock = vi.fn();
    const stopBackgroundServicesMock = vi.fn(async () => {});
    const releaseBackgroundLogsMock = vi.fn(async () => {});
    const cleanupService = new TaskCleanupService(
      { stop: stopSessionMock, isRuntimeCleanupConfirmed: vi.fn(async () => true) } as unknown as SessionManager,
      {
        stopAllForWorkspace: stopBackgroundServicesMock,
        releaseLogsForWorkspace: releaseBackgroundLogsMock,
      },
    );
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

    expect(stopBackgroundServicesMock).toHaveBeenCalledWith(workspace.id);
    expect(releaseBackgroundLogsMock).toHaveBeenCalledWith(workspace.id);
    expect(stopBackgroundServicesMock.mock.invocationCallOrder[0])
      .toBeLessThan(removeWorktreeMock.mock.invocationCallOrder[0]);
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
    const cleanupService = new TaskCleanupService({ stop: stopSessionMock, isRuntimeCleanupConfirmed: vi.fn(async () => true) } as unknown as SessionManager);
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
    const cleanupService = new TaskCleanupService({ stop: vi.fn(), isRuntimeCleanupConfirmed: vi.fn(async () => true) } as unknown as SessionManager);
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
