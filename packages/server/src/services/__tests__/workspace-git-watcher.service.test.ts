import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../core/event-bus.js';
import { WorkspaceGitWatcherService } from '../workspace-git-watcher.service.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Agent Tower Test',
      GIT_AUTHOR_EMAIL: 'agent-tower@example.test',
      GIT_COMMITTER_NAME: 'Agent Tower Test',
      GIT_COMMITTER_EMAIL: 'agent-tower@example.test',
    },
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCount<T>(items: T[], count: number, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (items.length >= count) return;
    await wait(25);
  }
  throw new Error(`Timed out waiting for ${count} events; received ${items.length}`);
}

describe('WorkspaceGitWatcherService', () => {
  let testDir = '';
  let repoPath = '';
  let worktreePath = '';
  let service: WorkspaceGitWatcherService;
  let eventBus: EventBus;
  let events: Array<{ workspaceId: string; reason: string; workingDir: string }> = [];

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-git-watcher-'));
    repoPath = path.join(testDir, 'repo');
    worktreePath = path.join(testDir, 'workspace');
    fs.mkdirSync(repoPath, { recursive: true });

    git(repoPath, ['init', '-b', 'main']);
    fs.writeFileSync(path.join(repoPath, 'README.md'), 'initial\n');
    git(repoPath, ['add', 'README.md']);
    git(repoPath, ['commit', '-m', 'initial']);
    git(repoPath, ['worktree', 'add', '-b', 'feature/watcher', worktreePath, 'main']);

    eventBus = new EventBus();
    events = [];
    eventBus.on('workspace:git_changed', (payload) => {
      events.push(payload);
    });
    service = new WorkspaceGitWatcherService(eventBus, { debounceMs: 50, retryMs: 50 });
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('debounces worktree changes and ignores unchanged fingerprints', async () => {
    await service.watchWorkspace({
      id: 'workspace-1',
      taskId: 'task-1',
      worktreePath,
      workingDir: worktreePath,
      task: { projectId: 'project-1' },
    });

    fs.writeFileSync(path.join(worktreePath, 'file.txt'), 'one\n');
    fs.writeFileSync(path.join(worktreePath, 'file.txt'), 'two\n');

    await waitForCount(events, 1);
    await wait(150);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      workspaceId: 'workspace-1',
      workingDir: worktreePath,
      reason: 'worktree',
    });
  });

  it('emits for git-dir changes such as staging, and stops cleanly', async () => {
    const gitEvents: Array<{ workspaceId: string; reason: string; workingDir: string }> = [];
    eventBus.on('workspace:git_changed', (payload) => {
      if (payload.reason === 'git-dir') gitEvents.push(payload);
    });

    await service.watchWorkspace({
      id: 'workspace-1',
      taskId: 'task-1',
      worktreePath,
      workingDir: worktreePath,
      task: { projectId: 'project-1' },
    });

    fs.writeFileSync(path.join(worktreePath, 'staged.txt'), 'staged\n');
    await waitForCount(events, 1);
    git(worktreePath, ['add', 'staged.txt']);
    await waitForCount(gitEvents, 1);

    service.unwatchWorkspace('workspace-1');
    const eventCountAfterStop = events.length;
    fs.writeFileSync(path.join(worktreePath, 'after-stop.txt'), 'ignored\n');
    await wait(150);

    expect(gitEvents[0]).toMatchObject({ workspaceId: 'workspace-1', reason: 'git-dir' });
    expect(events).toHaveLength(eventCountAfterStop);
    expect(service.getWatchedWorkspaceIds()).toEqual([]);
  });

  it('ignores large internal directories by path segment', () => {
    const shouldIgnorePath = (
      service as unknown as { shouldIgnorePath(filename: string): boolean }
    ).shouldIgnorePath.bind(service);

    expect(shouldIgnorePath('node_modules')).toBe(true);
    expect(shouldIgnorePath('node_modules/pkg/index.js')).toBe(true);
    expect(shouldIgnorePath(path.join(worktreePath, 'node_modules'))).toBe(true);
    expect(shouldIgnorePath(path.join(worktreePath, 'node_modules/pkg/index.js'))).toBe(true);
    expect(shouldIgnorePath('.agent-tower')).toBe(true);
    expect(shouldIgnorePath('.agent-tower/cache/state.json')).toBe(true);
    expect(shouldIgnorePath(path.join(worktreePath, '.agent-tower'))).toBe(true);
    expect(shouldIgnorePath(path.join(worktreePath, '.agent-tower/cache/state.json'))).toBe(true);
    expect(shouldIgnorePath('src/node_modules-like/file.ts')).toBe(false);
    expect(shouldIgnorePath('src/agent-tower/file.ts')).toBe(false);
  });

  it('does not register ignored directory watchers and re-registers a rapidly recreated directory', async () => {
    fs.writeFileSync(path.join(worktreePath, '.gitignore'), 'ignored/\n');
    fs.mkdirSync(path.join(worktreePath, 'ignored'));
    fs.mkdirSync(path.join(worktreePath, 'live'));
    await service.watchWorkspace({
      id: 'workspace-1', taskId: 'task-1', worktreePath, workingDir: worktreePath,
      task: { projectId: 'project-1' },
    });
    await wait(150);
    const getPaths = () => {
      const managed = (service as unknown as { watchers: Map<string, { watchedPaths: Set<string> }> })
        .watchers.get('workspace-1');
      return managed?.watchedPaths ?? new Set<string>();
    };
    expect(getPaths().has(path.join(worktreePath, 'ignored'))).toBe(false);
    expect(getPaths().has(path.join(worktreePath, 'live'))).toBe(true);

    fs.rmSync(path.join(worktreePath, 'live'), { recursive: true });
    fs.mkdirSync(path.join(worktreePath, 'live'));
    await wait(500);
    expect(getPaths().has(path.join(worktreePath, 'live'))).toBe(true);
    const before = events.length;
    fs.writeFileSync(path.join(worktreePath, 'live', 'again.txt'), 'again\n');
    await waitForCount(events, before + 1);
  });

  it('reconciles root and nested gitignore creation, modification, and deletion', async () => {
    const nested = path.join(worktreePath, 'nested');
    const first = path.join(nested, 'first');
    const second = path.join(nested, 'second');
    fs.mkdirSync(first, { recursive: true });
    fs.mkdirSync(second, { recursive: true });
    await service.watchWorkspace({ id: 'workspace-1', taskId: 'task-1', worktreePath, workingDir: worktreePath, task: { projectId: 'project-1' } });
    const paths = () => (service as unknown as { watchers: Map<string, { watchedPaths: Set<string> }> }).watchers.get('workspace-1')!.watchedPaths;
    await wait(200);
    expect(paths().has(first)).toBe(true);

    fs.writeFileSync(path.join(nested, '.gitignore'), 'first/\n');
    await wait(500);
    expect(paths().has(first)).toBe(false);
    fs.writeFileSync(path.join(nested, '.gitignore'), 'second/\n');
    await wait(500);
    expect(paths().has(first)).toBe(true);
    expect(paths().has(second)).toBe(false);
    fs.rmSync(path.join(nested, '.gitignore'));
    await wait(500);
    expect(paths().has(second)).toBe(true);

    fs.writeFileSync(path.join(worktreePath, '.gitignore'), 'nested/\n');
    await wait(500);
    expect(paths().has(nested)).toBe(false);
    fs.rmSync(path.join(worktreePath, '.gitignore'));
    await wait(500);
    expect(paths().has(nested)).toBe(true);
  });

  it('applies negation rules to NUL-delimited paths containing spaces', async () => {
    const ignored = path.join(worktreePath, 'space dir');
    const kept = path.join(worktreePath, 'keep special #x');
    fs.mkdirSync(ignored);
    fs.mkdirSync(kept);
    fs.writeFileSync(path.join(worktreePath, '.gitignore'), '*\n!keep special #x/\n');
    await service.watchWorkspace({ id: 'workspace-1', taskId: 'task-1', worktreePath, workingDir: worktreePath, task: { projectId: 'project-1' } });
    await wait(150);
    const paths = (service as unknown as { watchers: Map<string, { watchedPaths: Set<string> }> }).watchers.get('workspace-1')!.watchedPaths;
    expect(paths.has(ignored)).toBe(false);
    expect(paths.has(kept)).toBe(true);
  });

  it('does not rebuild after stop with a queued ignore reconcile', async () => {
    await service.watchWorkspace({ id: 'workspace-1', taskId: 'task-1', worktreePath, workingDir: worktreePath, task: { projectId: 'project-1' } });
    fs.writeFileSync(path.join(worktreePath, '.gitignore'), 'later/\n');
    service.stop();
    await wait(150);
    expect(service.getWatchedWorkspaceIds()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('accepts check-ignore exit 0/1 and fail-opens without caching exit 128', async () => {
    fs.writeFileSync(path.join(worktreePath, '.gitignore'), 'ignored/\n');
    const ignored = path.join(worktreePath, 'ignored');
    const visible = path.join(worktreePath, 'visible');
    fs.mkdirSync(ignored);
    fs.mkdirSync(visible);
    const makeManaged = (workingDir: string) => ({
      stopped: false,
      ignoreCache: new Map<string, boolean>(),
      workspace: { workingDir },
    });
    const batch = (service as unknown as {
      batchIgnoredByGit: (managed: ReturnType<typeof makeManaged>, paths: string[]) => Promise<Set<string>>;
    }).batchIgnoredByGit.bind(service);
    const valid = makeManaged(worktreePath);
    expect(await batch(valid, [ignored, visible])).toEqual(new Set([ignored]));
    expect(valid.ignoreCache.get(ignored)).toBe(true);
    expect(valid.ignoreCache.get(visible)).toBe(false);

    const nonRepo = path.join(testDir, 'not-a-repo');
    fs.mkdirSync(nonRepo);
    const invalid = makeManaged(nonRepo);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await batch(invalid, [path.join(nonRepo, 'anything')])).toEqual(new Set());
    expect(warn).toHaveBeenCalled();
    expect(invalid.ignoreCache.size).toBe(0);
  });

  it('does not cache a single-path exit 128 and caches the successful retry', async () => {
    const nonRepo = path.join(testDir, 'single-retry');
    const target = path.join(nonRepo, 'ignored');
    fs.mkdirSync(target, { recursive: true });
    const managed = {
      stopped: false,
      ignoreCache: new Map<string, boolean>(),
      workspace: { workingDir: nonRepo },
    };
    const check = (service as unknown as {
      isIgnoredByGit: (value: typeof managed, targetPath: string) => Promise<boolean>;
    }).isIgnoredByGit.bind(service);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await check(managed, target)).toBe(false);
    expect(warn).toHaveBeenCalled();
    expect(managed.ignoreCache.size).toBe(0);

    git(nonRepo, ['init', '-b', 'main']);
    fs.writeFileSync(path.join(nonRepo, '.gitignore'), 'ignored/\n');
    expect(await check(managed, target)).toBe(true);
    expect(managed.ignoreCache.get(target)).toBe(true);
  });

  it('does not open startup watchers after stop invalidates an in-flight start', async () => {
    let releaseFindMany!: () => void;
    const findManyReleased = new Promise<void>((resolve) => {
      releaseFindMany = resolve;
    });
    const loadActiveWorkspaces = vi.fn(async () => {
      await findManyReleased;
      return [{
        id: 'workspace-start-race',
        taskId: 'task-1',
        worktreePath,
        workingDir: worktreePath,
        task: { projectId: 'project-1' },
      }];
    });
    service = new WorkspaceGitWatcherService(eventBus, {
      debounceMs: 50,
      retryMs: 50,
      loadActiveWorkspaces,
    });
    const watchWorkspaceSpy = vi.spyOn(
      service as unknown as {
        watchWorkspaceInternal: (workspace: unknown, startupGeneration?: number) => Promise<void>;
      },
      'watchWorkspaceInternal',
    );

    const startPromise = service.start();
    service.stop();
    releaseFindMany();
    await startPromise;

    expect(loadActiveWorkspaces).toHaveBeenCalledTimes(1);
    expect(watchWorkspaceSpy).not.toHaveBeenCalled();
    expect(service.getWatchedWorkspaceIds()).toEqual([]);
  });
});

describe('WorkspaceGitWatcherService fingerprint scheduling', () => {
  let service: WorkspaceGitWatcherService;
  let eventBus: EventBus;
  let testDir = '';
  let events: Array<{ workspaceId: string; reason: string; workingDir: string }> = [];

  beforeEach(() => {
    vi.useFakeTimers();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-git-watcher-scheduling-'));
    eventBus = new EventBus();
    events = [];
    eventBus.on('workspace:git_changed', (payload) => {
      events.push(payload);
    });
    service = new WorkspaceGitWatcherService(eventBus, {
      debounceMs: 10,
      retryMs: 50,
    });
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('debounces lightweight maybe-changed events without running git fingerprint commands', async () => {
    const execGitSpy = vi.spyOn(
      service as unknown as { execGit: (workingDir: string, args: string[]) => Promise<string> },
      'execGit',
    );
    const managed = {
      workspace: {
        id: 'workspace-1',
        taskId: 'task-1',
        worktreePath: '/tmp/workspace-1',
        workingDir: '/tmp/workspace-1',
        task: { projectId: 'project-1' },
      },
      targets: [],
      watchers: [],
      watchedPaths: new Set<string>(),
      timers: new Set<ReturnType<typeof setTimeout>>(),
      changeTimer: null,
      pendingReason: 'unknown',
      stopped: false,
    };
    const scheduleChange = (
      service as unknown as { scheduleChange: (managed: unknown, reason: string) => void }
    ).scheduleChange.bind(service);

    scheduleChange(managed, 'worktree');
    scheduleChange(managed, 'git-dir');
    scheduleChange(managed, 'worktree');
    await vi.advanceTimersByTimeAsync(10);

    expect(execGitSpy).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      workspaceId: 'workspace-1',
      workingDir: '/tmp/workspace-1',
      reason: 'worktree',
    });
  });

  it('does not register a watcher if stop happens during initial fingerprint', async () => {
    const worktreePath = path.join(testDir, 'workspace-stop-race');
    fs.mkdirSync(worktreePath, { recursive: true });

    let targetsStarted!: () => void;
    const targetsStartedPromise = new Promise<void>((resolve) => {
      targetsStarted = resolve;
    });
    let releaseTargets!: () => void;
    const targetsPromise = new Promise<Array<{
      path: string;
      recursive: boolean;
      kind: 'worktree';
    }>>((resolve) => {
      releaseTargets = () => resolve([{
        path: worktreePath,
        recursive: true,
        kind: 'worktree',
      }]);
    });

    const serviceInternals = service as unknown as {
      buildWatchTargets: (workingDir: string) => Promise<Array<{
        path: string;
        recursive: boolean;
        kind: 'worktree';
      }>>;
      openWatcher: (managed: unknown, target: unknown) => void;
    };
    vi.spyOn(serviceInternals, 'buildWatchTargets').mockImplementation(async () => {
      targetsStarted();
      return targetsPromise;
    });
    const openWatcherSpy = vi.spyOn(serviceInternals, 'openWatcher').mockImplementation(() => undefined);

    const watchPromise = service.watchWorkspace({
      id: 'workspace-stop-race',
      taskId: 'task-1',
      worktreePath,
      workingDir: worktreePath,
      task: { projectId: 'project-1' },
    });
    await targetsStartedPromise;

    service.stop();
    releaseTargets();
    await watchPromise;

    expect(openWatcherSpy).not.toHaveBeenCalled();
    expect(service.getWatchedWorkspaceIds()).toEqual([]);
  });

  it('does not register a queued initial watcher after unwatchWorkspace invalidates it', async () => {
    const queuedWorktreePath = path.join(testDir, 'workspace-queued');
    fs.mkdirSync(queuedWorktreePath, { recursive: true });

    let queuedTargetsBuilt!: () => void;
    const queuedTargetsBuiltPromise = new Promise<void>((resolve) => {
      queuedTargetsBuilt = resolve;
    });
    let releaseQueuedTargets!: () => void;
    const queuedTargetsPromise = new Promise<Array<{
      path: string;
      recursive: boolean;
      kind: 'worktree';
    }>>((resolve) => {
      releaseQueuedTargets = () => resolve([{
        path: queuedWorktreePath,
        recursive: true,
        kind: 'worktree',
      }]);
    });
    const openedWorkspaceIds: string[] = [];

    const serviceInternals = service as unknown as {
      buildWatchTargets: (workingDir: string) => Promise<Array<{
        path: string;
        recursive: boolean;
        kind: 'worktree';
      }>>;
      openWatcher: (managed: unknown, target: unknown) => void;
    };
    vi.spyOn(serviceInternals, 'buildWatchTargets').mockImplementation(async (workingDir) => {
      if (workingDir === queuedWorktreePath) {
        queuedTargetsBuilt();
        return queuedTargetsPromise;
      }
      return [{
        path: workingDir,
        recursive: true,
        kind: 'worktree',
      }];
    });
    vi.spyOn(serviceInternals, 'openWatcher').mockImplementation((managed) => {
      openedWorkspaceIds.push((managed as { workspace: { id: string } }).workspace.id);
    });

    const queuedWatchPromise = service.watchWorkspace({
      id: 'workspace-queued',
      taskId: 'task-2',
      worktreePath: queuedWorktreePath,
      workingDir: queuedWorktreePath,
      task: { projectId: 'project-1' },
    });
    await queuedTargetsBuiltPromise;
    await Promise.resolve();

    service.unwatchWorkspace('workspace-queued');
    releaseQueuedTargets();
    await queuedWatchPromise;

    expect(openedWorkspaceIds).toEqual([]);
    expect(service.getWatchedWorkspaceIds()).toEqual([]);
  });
});
