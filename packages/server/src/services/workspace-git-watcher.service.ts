import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { FSWatcher } from 'node:fs';
import type { WorkspaceGitChangeReason } from '@agent-tower/shared/socket';
import type { EventBus } from '../core/event-bus.js';
import { prisma } from '../utils/index.js';
import { WorkspaceKind, WorkspaceStatus } from '../types/index.js';

const execFileAsync = promisify(execFile);

const DEFAULT_DEBOUNCE_MS = 250;
const WATCHER_RETRY_MS = 1_000;
const IGNORED_PATH_SEGMENTS = new Set(['node_modules', '.agent-tower']);

type GitWatchReason = WorkspaceGitChangeReason;

type WatchableWorkspace = {
  id: string;
  taskId: string;
  worktreePath: string;
  workingDir: string;
  task: {
    projectId: string;
  };
};

type WatchTargetKind = 'worktree' | 'git-dir';

type WatchTarget = {
  path: string;
  recursive: boolean;
  kind: WatchTargetKind;
};

type WorkspaceRegistrationToken = {
  serviceGeneration: number;
  workspaceGeneration: number;
  startupGeneration?: number;
};

type ManagedWorkspaceWatcher = {
  workspace: WatchableWorkspace;
  targets: WatchTarget[];
  watchers: FSWatcher[];
  watchedPaths: Set<string>;
  timers: Set<ReturnType<typeof setTimeout>>;
  changeTimer: ReturnType<typeof setTimeout> | null;
  pendingReason: GitWatchReason;
  stopped: boolean;
};

type ActiveWorkspaceQuery = () => Promise<WatchableWorkspace[]>;

export interface WorkspaceGitWatcherOptions {
  debounceMs?: number;
  retryMs?: number;
  loadActiveWorkspaces?: ActiveWorkspaceQuery;
}

async function pathExists(targetPath: string): Promise<boolean> {
  return fsPromises.access(targetPath).then(() => true).catch(() => false);
}

function normalizePath(targetPath: string): string {
  return path.resolve(targetPath);
}

function isNotFoundLike(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && ((error as { code?: unknown }).code === 'ENOENT'
      || (error as { code?: unknown }).code === 'ENOTDIR');
}

/**
 * Watches ACTIVE worktree workspaces for filesystem and git metadata changes.
 *
 * The service intentionally listens to the filesystem rather than terminal
 * output, so changes from the built-in shell, external terminals, IDEs, and
 * scripts all flow through the same path.
 */
export class WorkspaceGitWatcherService {
  private watchers = new Map<string, ManagedWorkspaceWatcher>();
  private debounceMs: number;
  private retryMs: number;
  private startupGeneration = 0;
  private startupActive = false;
  private serviceGeneration = 0;
  private workspaceGenerations = new Map<string, number>();
  private readonly loadActiveWorkspaces: ActiveWorkspaceQuery;

  constructor(
    private readonly eventBus: EventBus,
    options: WorkspaceGitWatcherOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.retryMs = options.retryMs ?? WATCHER_RETRY_MS;
    this.loadActiveWorkspaces = options.loadActiveWorkspaces ?? (() => this.findActiveWorkspaces());
  }

  async start(): Promise<void> {
    const generation = ++this.startupGeneration;
    this.startupActive = true;
    const workspaces = await this.loadActiveWorkspaces();

    for (const workspace of workspaces) {
      if (!this.isStartupCurrent(generation)) return;
      await this.watchWorkspaceInternal(workspace, generation);
    }
  }

  stop(): void {
    this.startupActive = false;
    this.startupGeneration += 1;
    this.serviceGeneration += 1;
    for (const workspaceId of [...this.watchers.keys()]) {
      this.unwatchWorkspace(workspaceId);
    }
  }

  async refreshWorkspace(workspaceId: string): Promise<void> {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: { task: { select: { projectId: true, deletedAt: true } } },
    });

    if (!workspace
      || workspace.task.deletedAt
      || workspace.status !== WorkspaceStatus.ACTIVE
      || workspace.workspaceKind !== WorkspaceKind.WORKTREE
      || !workspace.worktreePath) {
      this.unwatchWorkspace(workspaceId);
      return;
    }

    await this.watchWorkspace({
      id: workspace.id,
      taskId: workspace.taskId,
      worktreePath: workspace.worktreePath,
      workingDir: workspace.workingDir,
      task: { projectId: workspace.task.projectId },
    });
  }

  async watchWorkspace(workspace: WatchableWorkspace): Promise<void> {
    await this.watchWorkspaceInternal(workspace);
  }

  private async watchWorkspaceInternal(
    workspace: WatchableWorkspace,
    startupGeneration?: number,
  ): Promise<void> {
    const registration = this.beginWorkspaceRegistration(workspace.id, startupGeneration);
    const canContinueRegistration = () => this.isRegistrationCurrent(workspace.id, registration);

    if (!canContinueRegistration()) return;
    const workingDir = workspace.workingDir || workspace.worktreePath;
    if (!workingDir || !await pathExists(workingDir)) {
      this.unwatchWorkspace(workspace.id);
      return;
    }
    if (!canContinueRegistration()) return;

    const normalizedWorkspace: WatchableWorkspace = {
      ...workspace,
      worktreePath: normalizePath(workspace.worktreePath),
      workingDir: normalizePath(workingDir),
    };

    const existing = this.watchers.get(workspace.id);
    if (existing && this.sameWorkspace(existing.workspace, normalizedWorkspace)) {
      return;
    }
    if (existing) {
      this.closeManagedWorkspace(workspace.id, existing);
    }

    const targets = await this.buildWatchTargets(normalizedWorkspace.workingDir);
    if (!canContinueRegistration()) return;

    const managed: ManagedWorkspaceWatcher = {
      workspace: normalizedWorkspace,
      targets,
      watchers: [],
      watchedPaths: new Set(),
      timers: new Set(),
      changeTimer: null,
      pendingReason: 'unknown',
      stopped: false,
    };

    this.watchers.set(normalizedWorkspace.id, managed);
    for (const target of managed.targets) {
      this.openWatcher(managed, target);
    }
  }

  unwatchWorkspace(workspaceId: string): void {
    this.invalidateWorkspaceRegistration(workspaceId);
    const managed = this.watchers.get(workspaceId);
    if (!managed) return;

    this.closeManagedWorkspace(workspaceId, managed);
  }

  private closeManagedWorkspace(workspaceId: string, managed: ManagedWorkspaceWatcher): void {
    managed.stopped = true;
    for (const watcher of managed.watchers) {
      watcher.close();
    }
    for (const timer of managed.timers) {
      clearTimeout(timer);
    }
    if (managed.changeTimer) {
      clearTimeout(managed.changeTimer);
    }
    this.watchers.delete(workspaceId);
  }

  getWatchedWorkspaceIds(): string[] {
    return [...this.watchers.keys()];
  }

  private isStartupCurrent(generation: number): boolean {
    return this.startupActive && this.startupGeneration === generation;
  }

  private canContinueStartup(generation?: number): boolean {
    return generation === undefined || this.isStartupCurrent(generation);
  }

  private beginWorkspaceRegistration(
    workspaceId: string,
    startupGeneration?: number,
  ): WorkspaceRegistrationToken {
    const workspaceGeneration = this.nextWorkspaceGeneration(workspaceId);
    const token: WorkspaceRegistrationToken = {
      serviceGeneration: this.serviceGeneration,
      workspaceGeneration,
    };
    if (startupGeneration !== undefined) {
      token.startupGeneration = startupGeneration;
    }
    return token;
  }

  private invalidateWorkspaceRegistration(workspaceId: string): void {
    this.nextWorkspaceGeneration(workspaceId);
  }

  private nextWorkspaceGeneration(workspaceId: string): number {
    const nextGeneration = (this.workspaceGenerations.get(workspaceId) ?? 0) + 1;
    this.workspaceGenerations.set(workspaceId, nextGeneration);
    return nextGeneration;
  }

  private isRegistrationCurrent(
    workspaceId: string,
    token: WorkspaceRegistrationToken,
  ): boolean {
    return this.serviceGeneration === token.serviceGeneration
      && this.workspaceGenerations.get(workspaceId) === token.workspaceGeneration
      && this.canContinueStartup(token.startupGeneration);
  }

  private async findActiveWorkspaces(): Promise<WatchableWorkspace[]> {
    return prisma.workspace.findMany({
      where: {
        status: WorkspaceStatus.ACTIVE,
        workspaceKind: WorkspaceKind.WORKTREE,
        worktreePath: { not: '' },
        task: { deletedAt: null },
      },
      include: { task: { select: { projectId: true } } },
    });
  }

  private sameWorkspace(left: WatchableWorkspace, right: WatchableWorkspace): boolean {
    return left.worktreePath === right.worktreePath
      && left.workingDir === right.workingDir
      && left.taskId === right.taskId
      && left.task.projectId === right.task.projectId;
  }

  private async buildWatchTargets(workingDir: string): Promise<WatchTarget[]> {
    const targets: WatchTarget[] = [{ path: workingDir, recursive: true, kind: 'worktree' }];
    const gitDirs = await this.resolveGitDirs(workingDir);

    for (const gitDir of gitDirs) {
      if (await pathExists(gitDir)) {
        targets.push({ path: normalizePath(gitDir), recursive: false, kind: 'git-dir' });
      }

      const recursivePaths = ['refs', 'logs', 'rebase-merge', 'rebase-apply'];
      for (const child of recursivePaths) {
        const candidate = path.join(gitDir, child);
        if (await pathExists(candidate)) {
          targets.push({ path: normalizePath(candidate), recursive: true, kind: 'git-dir' });
        }
      }
    }

    return this.dedupeTargets(targets);
  }

  private dedupeTargets(targets: WatchTarget[]): WatchTarget[] {
    const seen = new Set<string>();
    const result: WatchTarget[] = [];
    for (const target of targets) {
      const key = `${target.kind}:${target.path}:${target.recursive}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(target);
    }
    return result;
  }

  private async resolveGitDirs(workingDir: string): Promise<string[]> {
    const result = new Set<string>();
    try {
      const [gitDirOutput, commonDirOutput] = await Promise.all([
        this.execGit(workingDir, ['rev-parse', '--git-dir']),
        this.execGit(workingDir, ['rev-parse', '--git-common-dir']),
      ]);
      for (const raw of [gitDirOutput, commonDirOutput]) {
        const resolved = this.resolveGitPath(workingDir, raw.trim());
        if (resolved) result.add(resolved);
      }
    } catch {
      const dotGit = path.join(workingDir, '.git');
      if (await pathExists(dotGit)) {
        const stat = await fsPromises.stat(dotGit).catch(() => null);
        if (stat?.isDirectory()) {
          result.add(dotGit);
        }
      }
    }
    return [...result];
  }

  private resolveGitPath(workingDir: string, gitPath: string): string | null {
    if (!gitPath) return null;
    return normalizePath(path.isAbsolute(gitPath) ? gitPath : path.join(workingDir, gitPath));
  }

  private openWatcher(managed: ManagedWorkspaceWatcher, target: WatchTarget): void {
    if (managed.stopped) return;
    if (managed.watchedPaths.has(target.path)) return;

    try {
      const watcher = fs.watch(
        target.path,
        { recursive: target.recursive },
        (_eventType, filename) => {
          if (filename && this.shouldIgnorePath(filename.toString())) return;
          this.scheduleChange(managed, target.kind === 'git-dir' ? 'git-dir' : 'worktree');
        },
      );
      watcher.on('error', (error) => {
        if (managed.stopped) return;
        if (isNotFoundLike(error)) {
          this.scheduleRetry(managed, target);
          return;
        }
        console.warn(
          `[WorkspaceGitWatcher] watcher error for ${managed.workspace.id} at ${target.path}:`,
          error instanceof Error ? error.message : error,
        );
      });
      managed.watchers.push(watcher);
      managed.watchedPaths.add(target.path);
    } catch (error) {
      if (target.recursive && this.isRecursiveWatchUnsupported(error)) {
        this.openDirectoryTreeWatchers(managed, target.path, target.kind).catch((err) => {
          console.warn(
            `[WorkspaceGitWatcher] failed to open directory tree watchers for ${target.path}:`,
            err instanceof Error ? err.message : err,
          );
        });
        return;
      }
      if (isNotFoundLike(error)) {
        this.scheduleRetry(managed, target);
        return;
      }
      console.warn(
        `[WorkspaceGitWatcher] failed to watch ${target.path} for ${managed.workspace.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  private isRecursiveWatchUnsupported(error: unknown): boolean {
    return typeof error === 'object'
      && error !== null
      && 'code' in error
      && ((error as { code?: unknown }).code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM'
        || (error as { code?: unknown }).code === 'ERR_INVALID_ARG_VALUE');
  }

  private async openDirectoryTreeWatchers(
    managed: ManagedWorkspaceWatcher,
    rootPath: string,
    kind: WatchTargetKind,
  ): Promise<void> {
    if (managed.stopped || !await pathExists(rootPath)) return;
    const entries = await fsPromises.readdir(rootPath, { withFileTypes: true }).catch(() => []);
    if (managed.stopped) return;

    this.openNonRecursiveWatcher(managed, rootPath, kind);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (this.shouldIgnorePath(path.join(rootPath, entry.name))) continue;
      await this.openDirectoryTreeWatchers(managed, path.join(rootPath, entry.name), kind);
    }
  }

  private openNonRecursiveWatcher(
    managed: ManagedWorkspaceWatcher,
    targetPath: string,
    kind: WatchTargetKind,
  ): void {
    if (managed.stopped) return;
    const normalizedTarget = normalizePath(targetPath);
    if (managed.watchedPaths.has(normalizedTarget)) return;

    try {
      const watcher = fs.watch(normalizedTarget, (eventType, filename) => {
        const childPath = filename ? path.join(normalizedTarget, filename.toString()) : normalizedTarget;
        if (this.shouldIgnorePath(childPath)) return;
        this.scheduleChange(managed, kind === 'git-dir' ? 'git-dir' : 'worktree');
        if (eventType === 'rename') {
          fsPromises.stat(childPath)
            .then((stat) => {
              if (stat.isDirectory()) {
                return this.openDirectoryTreeWatchers(managed, childPath, kind);
              }
            })
            .catch(() => undefined);
        }
      });
      watcher.on('error', (error) => {
        if (managed.stopped) return;
        if (isNotFoundLike(error)) return;
        console.warn(
          `[WorkspaceGitWatcher] watcher error for ${managed.workspace.id} at ${normalizedTarget}:`,
          error instanceof Error ? error.message : error,
        );
      });
      managed.watchers.push(watcher);
      managed.watchedPaths.add(normalizedTarget);
    } catch (error) {
      if (isNotFoundLike(error)) return;
      console.warn(
        `[WorkspaceGitWatcher] failed to watch ${normalizedTarget} for ${managed.workspace.id}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  private scheduleRetry(managed: ManagedWorkspaceWatcher, target: WatchTarget): void {
    if (managed.stopped) return;
    const timer = setTimeout(() => {
      managed.timers.delete(timer);
      this.openWatcher(managed, target);
    }, this.retryMs);
    managed.timers.add(timer);
    timer.unref?.();
  }

  private shouldIgnorePath(filename: string): boolean {
    return filename
      .replace(/\\/g, '/')
      .split('/')
      .some((segment) => IGNORED_PATH_SEGMENTS.has(segment));
  }

  private scheduleChange(managed: ManagedWorkspaceWatcher, reason: GitWatchReason): void {
    if (managed.stopped) return;
    managed.pendingReason = reason;
    this.scheduleMaybeChanged(managed);
  }

  private scheduleMaybeChanged(managed: ManagedWorkspaceWatcher): void {
    if (managed.stopped) return;
    if (managed.changeTimer) {
      clearTimeout(managed.changeTimer);
    }

    const timer = setTimeout(() => {
      managed.changeTimer = null;
      this.emitMaybeChanged(managed, managed.pendingReason);
    }, this.debounceMs);
    managed.changeTimer = timer;
    timer.unref?.();
  }

  private emitMaybeChanged(
    managed: ManagedWorkspaceWatcher,
    reason: GitWatchReason,
  ): void {
    if (managed.stopped) return;

    this.eventBus.emit('workspace:git_changed', {
      workspaceId: managed.workspace.id,
      taskId: managed.workspace.taskId,
      projectId: managed.workspace.task.projectId,
      workingDir: managed.workspace.workingDir,
      reason,
    });
  }

  private async execGit(workingDir: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd: workingDir,
      timeout: 10_000,
      maxBuffer: 10 * 1024 * 1024,
      encoding: 'utf-8',
    });
    return stdout;
  }
}
