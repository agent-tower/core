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
