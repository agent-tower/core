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
const DEFAULT_MIN_CHECK_INTERVAL_MS = 1_500;
const DEFAULT_MAX_FINGERPRINT_CONCURRENCY = 1;
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

type FingerprintQueueItem = {
  resolve: (acquired: boolean) => void;
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
  fingerprint: string | null;
  fingerprintInFlight: boolean;
  fingerprintPending: boolean;
  lastFingerprintStartedAt: number;
  stopped: boolean;
};

type ActiveWorkspaceQuery = () => Promise<WatchableWorkspace[]>;

export interface WorkspaceGitWatcherOptions {
  debounceMs?: number;
  minCheckIntervalMs?: number;
  maxConcurrentFingerprints?: number;
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
  private minCheckIntervalMs: number;
  private maxConcurrentFingerprints: number;
  private activeFingerprintChecks = 0;
  private fingerprintQueue: FingerprintQueueItem[] = [];
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
    this.minCheckIntervalMs = options.minCheckIntervalMs ?? DEFAULT_MIN_CHECK_INTERVAL_MS;
    this.maxConcurrentFingerprints = Math.max(
      1,
      options.maxConcurrentFingerprints ?? DEFAULT_MAX_FINGERPRINT_CONCURRENCY,
    );
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
    this.cancelQueuedFingerprints();
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
    const fingerprint = await this.runFingerprint(
      normalizedWorkspace.workingDir,
      canContinueRegistration,
    );
    if (fingerprint === null) return;
    if (!canContinueRegistration()) return;

    const managed: ManagedWorkspaceWatcher = {
      workspace: normalizedWorkspace,
      targets,
      watchers: [],
      watchedPaths: new Set(),
      timers: new Set(),
      changeTimer: null,
      pendingReason: 'unknown',
      fingerprint,
      fingerprintInFlight: false,
      fingerprintPending: false,
      lastFingerprintStartedAt: 0,
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
    managed.fingerprintPending = true;
    this.schedulePendingFingerprint(managed, this.debounceMs);
  }

  private schedulePendingFingerprint(
    managed: ManagedWorkspaceWatcher,
    requestedDelayMs: number,
  ): void {
    if (managed.stopped || managed.fingerprintInFlight) return;
    if (managed.changeTimer) {
      clearTimeout(managed.changeTimer);
    }

    const elapsedSinceLastCheck = managed.lastFingerprintStartedAt > 0
      ? Date.now() - managed.lastFingerprintStartedAt
      : Number.POSITIVE_INFINITY;
    const intervalDelay = Math.max(0, this.minCheckIntervalMs - elapsedSinceLastCheck);
    const delay = Math.max(requestedDelayMs, intervalDelay);

    const timer = setTimeout(() => {
      managed.changeTimer = null;
      this.processPendingFingerprint(managed).catch((error) => {
        console.warn(
          `[WorkspaceGitWatcher] failed to process change for ${managed.workspace.id}:`,
          error instanceof Error ? error.message : error,
        );
      });
    }, delay);
    managed.changeTimer = timer;
    timer.unref?.();
  }

  private async processPendingFingerprint(
    managed: ManagedWorkspaceWatcher,
  ): Promise<void> {
    if (managed.stopped) return;
    if (managed.fingerprintInFlight || !managed.fingerprintPending) return;

    const initialReason = managed.pendingReason;
    managed.fingerprintPending = false;
    managed.fingerprintInFlight = true;
    managed.lastFingerprintStartedAt = Date.now();

    try {
      const nextFingerprint = await this.runFingerprint(
        managed.workspace.workingDir,
        () => !managed.stopped,
      );
      if (managed.stopped || nextFingerprint === null) return;

      const reason = managed.fingerprintPending ? managed.pendingReason : initialReason;
      this.emitIfChanged(managed, nextFingerprint, reason);
    } finally {
      managed.fingerprintInFlight = false;
      if (!managed.stopped && managed.fingerprintPending) {
        this.schedulePendingFingerprint(managed, 0);
      }
    }
  }

  private emitIfChanged(
    managed: ManagedWorkspaceWatcher,
    nextFingerprint: string,
    reason: GitWatchReason,
  ): void {
    if (nextFingerprint === managed.fingerprint) return;

    managed.fingerprint = nextFingerprint;
    this.eventBus.emit('workspace:git_changed', {
      workspaceId: managed.workspace.id,
      taskId: managed.workspace.taskId,
      projectId: managed.workspace.task.projectId,
      workingDir: managed.workspace.workingDir,
      reason,
    });
  }

  private async runFingerprint(
    workingDir: string,
    shouldContinue?: () => boolean,
  ): Promise<string | null> {
    if (shouldContinue && !shouldContinue()) return null;
    const acquired = await this.acquireFingerprintSlot();
    if (!acquired) return null;
    try {
      if (shouldContinue && !shouldContinue()) return null;
      return await this.getFingerprint(workingDir);
    } finally {
      this.releaseFingerprintSlot();
    }
  }

  private acquireFingerprintSlot(): Promise<boolean> {
    if (this.activeFingerprintChecks < this.maxConcurrentFingerprints) {
      this.activeFingerprintChecks += 1;
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      this.fingerprintQueue.push({ resolve });
    });
  }

  private releaseFingerprintSlot(): void {
    const next = this.fingerprintQueue.shift();
    if (next) {
      next.resolve(true);
      return;
    }
    this.activeFingerprintChecks = Math.max(0, this.activeFingerprintChecks - 1);
  }

  private cancelQueuedFingerprints(): void {
    const queue = this.fingerprintQueue.splice(0);
    for (const item of queue) {
      item.resolve(false);
    }
  }

  private async getFingerprint(workingDir: string): Promise<string> {
    const [status, head, heads, staged, dirtyFiles] = await Promise.all([
      this.execGit(workingDir, ['status', '--porcelain=v1', '-b', '--untracked-files=all'])
        .catch((error) => `status-error:${String(error)}`),
      this.execGit(workingDir, ['rev-parse', 'HEAD']).catch((error) => `head-error:${String(error)}`),
      this.execGit(workingDir, ['show-ref', '--heads']).catch((error) => `heads-error:${String(error)}`),
      this.execGit(workingDir, ['diff', '--cached', '--raw', '--no-abbrev', 'HEAD'])
        .catch((error) => `staged-error:${String(error)}`),
      this.execGit(workingDir, ['ls-files', '--modified', '--others', '--exclude-standard', '-z'])
        .catch(() => ''),
    ]);
    const dirtyStats = await this.buildDirtyFileStats(workingDir, dirtyFiles);
    return [
      status.trim(),
      head.trim(),
      heads.trim(),
      staged.trim(),
      dirtyStats,
    ].join('\n');
  }

  private async buildDirtyFileStats(workingDir: string, filesOutput: string): Promise<string> {
    const files = filesOutput
      .split('\0')
      .map((file) => file.trim())
      .filter(Boolean)
      .sort();

    const stats: string[] = [];
    for (const file of files) {
      const absolutePath = path.resolve(workingDir, file);
      if (!this.isPathInside(workingDir, absolutePath)) continue;
      const stat = await fsPromises.stat(absolutePath).catch(() => null);
      if (!stat?.isFile()) continue;
      stats.push(`${file}\0${stat.size}\0${stat.mtimeMs}`);
    }
    return stats.join('\n');
  }

  private isPathInside(root: string, targetPath: string): boolean {
    const relative = path.relative(root, targetPath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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
