/**
 * One cached, versioned state per worktree in either the server or command
 * helper. Registrations own git-directory watches and safety checks; plain
 * REST callers retain the bounded freshness window and idle eviction.
 *
 * File diffs (`diff()`) are computed here too, next to the state that
 * versions them: cached by (worktree, path, kind, token, limit), shared by
 * simultaneous requests, and stopped when nobody waits for them any more.
 */
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fingerprintRepository, resolveRevisionName } from './git-repository-files.js';
import { computeFileDiff, FileDiffCache, type FileDiffTarget } from './git-file-diff.js';
import { isRacyAt, racyToken, sameStat, statWorkingFile, uncommittedToken, unlistedToken } from './git-file-versions.js';
import {
  computeGitState, gitStateAbortError, LruCache,
  type ComparisonValue, type GitCommandRunner, type GitStateFiles, type RepositoryFingerprint,
} from './git-state-compute.js';
import {
  GIT_FILE_DIFF_BUDGET_MS, GIT_FILE_DIFF_FORCED_LIMIT_BYTES, GIT_FILE_DIFF_FORCED_TIMEOUT_MS,
  GIT_FILE_DIFF_LIMIT_BYTES, GIT_FILE_DIFF_TIMEOUT_MS,
  GIT_STATE_COMPUTATION_BUDGET_MS, GIT_STATE_FRESHNESS_MS,
  GIT_STATE_SAFETY_INTERVAL_MS, GIT_STATE_DEBOUNCE_MS, GIT_STATE_MIN_COMPUTATION_INTERVAL_MS,
} from './git-state-limits.js';
import { GitStateWatches, type GitStateWatchFactory } from './git-state-watches.js';
import type {
  GitDiffRequest, GitDiffResult, GitDiffSource, GitFileDiff,
  GitStateCounters, GitStateRequest, GitStateResult, GitStateSnapshot, GitStateSource, GitStateTrigger,
} from './git-state-types.js';

export interface GitStateServiceOptions {
  run: GitCommandRunner;
  freshnessMs?: number;
  maxEntries?: number;
  entryIdleMs?: number;
  sweepIntervalMs?: number;
  computationBudgetMs?: number;
  safetyIntervalMs?: number;
  debounceMs?: number;
  minComputationIntervalMs?: number;
  now?: () => number;
  onCounters?: (delta: Partial<GitStateCounters>) => void;
  onChange?: (snapshot: GitStateSnapshot) => void;
  onRegisteredCount?: (count: number) => void;
  /** Injection for unavailable-watch and safety-check tests. */
  watch?: GitStateWatchFactory;
  log?: (message: string) => void;
  /** Bytes of diff text kept for all worktrees (default GIT_DIFF_CACHE_LIMIT_BYTES). */
  diffCacheLimitBytes?: number;
  /** A larger diff text is not kept (default GIT_DIFF_CACHE_ENTRY_LIMIT_BYTES). */
  diffCacheEntryLimitBytes?: number;
}

/** What a diff request resolves to in the current state. */
type DiffTarget =
  | { kind: 'uncommitted'; root: string; diffTarget: Extract<FileDiffTarget, { kind: 'uncommitted' }> }
  | { kind: 'committed'; root: string; token: string; diffTarget: Extract<FileDiffTarget, { kind: 'committed' }> };

/** One file diff in progress, shared by every request for the same key. */
interface DiffRun {
  key: string;
  controller: AbortController;
  promise: Promise<GitFileDiff>;
  waiters: number;
}

interface Computation {
  baseBranch: string;
  controller: AbortController;
  promise: Promise<GitStateSnapshot>;
  waiters: number;
}

interface Pending {
  promise: Promise<GitStateSnapshot>;
  resolve: (snapshot: GitStateSnapshot) => void;
  reject: (error: unknown) => void;
  waiters: number;
  computation?: Computation;
}

interface Registration {
  request: GitStateRequest;
  dirty: boolean;
  dirtyAt: number;
  lastStartedAt: number;
  trigger?: GitStateTrigger;
  pending?: Pending;
  timer?: ReturnType<typeof setTimeout>;
  safetyTimer: ReturnType<typeof setInterval>;
  watches: GitStateWatches;
  watchPending: boolean;
  checkingWatch: boolean;
}

interface Entry {
  key: string;
  lastRequestedAt: number;
  version: number;
  contentHash?: string;
  state?: { snapshot: GitStateSnapshot; fingerprint: RepositoryFingerprint | null };
  /** Of the last computation, kept when `state` is cleared: its settled line counts can still be reused. */
  lastFiles?: GitStateFiles;
  computation?: Computation;
  registration?: Registration;
}

const DEFAULT_MAX_ENTRIES = 64;
const DEFAULT_ENTRY_IDLE_MS = 10 * 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;
const COMPARISON_CACHE_SIZE = 512;
const RETIRED_VERSIONS_SIZE = 4_096;
const TRIGGER_COUNTER: Record<GitStateTrigger, keyof GitStateCounters> = {
  watch: 'computationsWatch', agent: 'computationsAgent', terminal: 'computationsTerminal',
  service: 'computationsService', operation: 'computationsOperation', refresh: 'computationsRefresh', safety: 'computationsSafety',
};

function hashContent(value: unknown): string {
  return createHash('sha1').update(JSON.stringify(value)).digest('hex');
}

/** fingerprintRepository orders HEAD, index, packed-refs, then the branch refs. */
function metadataFingerprint(value: string): string {
  return value.split('|').filter((_part, index) => index !== 1).join('|');
}

function pendingResult(): Pending {
  let resolve!: Pending['resolve'];
  let reject!: Pending['reject'];
  const promise = new Promise<GitStateSnapshot>((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => undefined);
  return { promise, resolve, reject, waiters: 0 };
}

export class WorkspaceGitStateService {
  readonly epoch: string = randomUUID();
  private readonly entries = new Map<string, Entry>();
  /** Includes reads finishing for entries retired by unregister/recreate. */
  private readonly computations = new Set<Computation>();
  private readonly retiredVersions = new LruCache<string, { version: number; contentHash?: string }>(RETIRED_VERSIONS_SIZE);
  private readonly comparisons = new LruCache<string, ComparisonValue>(COMPARISON_CACHE_SIZE);
  private readonly baseRefs = new LruCache<string, string>(COMPARISON_CACHE_SIZE);
  private readonly counters: GitStateCounters = {
    requests: 0, computations: 0, cacheAnswers: 0, gitProcesses: 0,
    diffRequests: 0, diffComputations: 0, diffCacheAnswers: 0,
    computationsWatch: 0, computationsAgent: 0, computationsTerminal: 0, computationsService: 0,
    computationsOperation: 0, computationsRefresh: 0, computationsSafety: 0,
  };
  /** Per-path data of each state, for its file diffs. */
  private readonly files = new WeakMap<GitStateSnapshot, GitStateFiles>();
  private readonly diffCache: FileDiffCache;
  private readonly diffRuns = new Map<string, DiffRun>();
  /** Moves when a worktree's cached diffs are dropped, so a diff that finishes later is not kept. */
  private readonly diffGenerations = new Map<string, number>();
  private readonly now: () => number;
  private sweepTimer?: ReturnType<typeof setInterval>;
  private retired = false;

  constructor(private readonly options: GitStateServiceOptions) {
    this.now = options.now ?? Date.now;
    this.diffCache = new FileDiffCache(options.diffCacheLimitBytes, options.diffCacheEntryLimitBytes);
  }

  async get(request: GitStateRequest, options: { signal?: AbortSignal } = {}): Promise<GitStateResult> {
    if (options.signal?.aborted) throw gitStateAbortError();
    this.count({ requests: 1 });
    return this.getEntry(this.entryFor(path.resolve(request.worktreePath)), { ...request, worktreePath: path.resolve(request.worktreePath) }, options.signal);
  }

  /** Idempotent: the server registry owns subscriber counts, this instance owns one registration. */
  async register(request: GitStateRequest, options: { signal?: AbortSignal } = {}): Promise<GitStateResult> {
    if (this.retired || options.signal?.aborted) throw gitStateAbortError();
    const normalized = { ...request, worktreePath: path.resolve(request.worktreePath) };
    const entry = this.entryFor(normalized.worktreePath);
    let registration = entry.registration;
    if (!registration) {
      const safetyTimer = setInterval(() => this.invalidate(entry.key, 'safety'), this.options.safetyIntervalMs ?? GIT_STATE_SAFETY_INTERVAL_MS);
      safetyTimer.unref?.();
      registration = {
        request: normalized, dirty: false, dirtyAt: 0, lastStartedAt: 0, safetyTimer,
        watches: new GitStateWatches(() => this.watchEvent(entry), this.options.watch, this.options.log),
        watchPending: false, checkingWatch: false,
      };
      entry.registration = registration;
      this.options.onRegisteredCount?.(this.registeredCount);
      // Cached REST state may predate a working-file edit, so first subscription
      // always computes unless it joins a computation already reading this base.
      entry.state = undefined;
    } else if (registration.request.baseBranch !== normalized.baseBranch || registration.request.repositoryPath !== normalized.repositoryPath) {
      registration.request = normalized;
      this.invalidate(entry.key, 'operation');
    } else {
      registration.request = normalized;
    }
    return this.get(normalized, options);
  }

  unregister(worktreePath: string): void {
    const entry = this.entries.get(path.resolve(worktreePath));
    if (!entry?.registration) return;
    this.closeRegistration(entry);
    // A REST request sharing the computation still gets its result.
    if (entry.computation?.waiters === 0) entry.computation.controller.abort();
    // Retire this entry even if an old REST read is finishing. A recreated
    // worktree at the same path must never join that old (possibly aborted)
    // read, and its completion must not replace the new registration's state.
    this.drop(entry.key, entry);
  }

  /** Explicit signals never depend on git-file stats: working files may have changed. */
  invalidate(worktreePath: string, trigger: GitStateTrigger): void {
    const entry = this.entries.get(path.resolve(worktreePath));
    const registration = entry?.registration;
    if (!entry || !registration || this.retired) return;
    registration.dirty = true;
    registration.dirtyAt = this.now();
    registration.trigger = trigger;
    this.schedule(entry);
  }

  readCounters(): GitStateCounters { return { ...this.counters }; }
  get size(): number { return this.entries.size; }
  get registeredCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) if (entry.registration) count += 1;
    return count;
  }
  get watchCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) count += entry.registration?.watches.size ?? 0;
    return count;
  }

  sweep(now = this.now()): void {
    for (const [key, entry] of this.entries) {
      if (!entry.registration && !entry.computation && now - entry.lastRequestedAt >= (this.options.entryIdleMs ?? DEFAULT_ENTRY_IDLE_MS)) this.drop(key, entry);
    }
  }

  /** Stops watches/timers; computations with REST waiters may finish in the old placement. */
  retire(): void {
    this.retired = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    for (const entry of this.entries.values()) {
      this.closeRegistration(entry);
      if (entry.computation?.waiters === 0) entry.computation.controller.abort();
    }
    // The next placement starts with its own cache; running diffs still answer their requests.
    this.diffCache.clear();
  }

  dispose(): void {
    this.retire();
    for (const computation of this.computations) computation.controller.abort();
    for (const run of this.diffRuns.values()) run.controller.abort();
    this.diffRuns.clear();
    this.entries.clear();
  }

  get diffCacheBytes(): number { return this.diffCache.bytes; }
  get diffCacheSize(): number { return this.diffCache.size; }
  get runningDiffs(): number { return this.diffRuns.size; }

  /**
   * One file's diff. The token is computed here, never taken from the caller:
   * from the worktree's current state (refreshed as REST answers are) and a
   * fresh `lstat`. A cache hit starts no process; a miss starts one, and
   * possibly a second to read a blob's size (./git-file-diff.ts).
   */
  async diff(request: GitDiffRequest, options: { signal?: AbortSignal } = {}): Promise<GitDiffResult> {
    if (options.signal?.aborted) throw gitStateAbortError();
    this.count({ requests: 1, diffRequests: 1 });
    const worktreePath = path.resolve(request.worktreePath);
    const stateRequest: GitStateRequest = {
      worktreePath, repositoryPath: request.repositoryPath, baseBranch: request.baseBranch, ...(request.env ? { env: request.env } : {}),
    };
    const { snapshot } = await this.getEntry(this.entryFor(worktreePath), stateRequest, options.signal);
    if (!snapshot.available) return this.diffResult(null, 'state');
    const files = this.files.get(snapshot);
    const target = files ? await this.diffTarget(files, snapshot, request) : null;
    if (!target) {
      // The state does not list the file: there is nothing to show in this state.
      return this.diffResult({ kind: 'text', token: unlistedToken(snapshot, request.kind, request.path), diff: '' }, 'state');
    }
    const token = target.kind === 'uncommitted' ? uncommittedToken(target.diffTarget.basis, target.diffTarget.stat, snapshot) : target.token;
    const forced = request.force === true;
    const limit = forced ? GIT_FILE_DIFF_FORCED_LIMIT_BYTES : GIT_FILE_DIFF_LIMIT_BYTES;
    const key = [worktreePath, request.kind, request.path, token, limit].join('\0');
    const cached = this.diffCache.get(key);
    if (cached) {
      this.count({ diffCacheAnswers: 1 });
      return this.diffResult(cached, 'cache');
    }
    let run = this.diffRuns.get(key);
    const source: GitDiffSource = run ? 'shared' : 'computation';
    run ??= this.startDiff(key, worktreePath, target, { token, limit, forced, env: request.env });
    return this.diffResult(await this.waitDiff(run, options.signal), source);
  }

  /** The listed entry for the request, with a fresh `lstat` of an uncommitted file; null when the state does not list it. */
  private async diffTarget(files: GitStateFiles, snapshot: GitStateSnapshot, request: GitDiffRequest): Promise<DiffTarget | null> {
    const root = files.topLevel ?? snapshot.worktreePath;
    if (request.kind === 'committed') {
      const entry = snapshot.committed.find((candidate) => candidate.path === request.path);
      if (!entry || !files.committed) return null;
      const blobs = files.committed.blobs.get(request.path);
      return {
        kind: 'committed', root, token: entry.token,
        diffTarget: {
          kind: 'committed', file: request.path, base: files.committed.base, head: files.committed.head,
          srcOid: blobs?.srcOid ?? null, dstOid: blobs?.dstOid ?? null,
        },
      };
    }
    const basis = files.tracked.get(request.path) ?? files.untracked.get(request.path);
    if (!basis) return null;
    const stat = await statWorkingFile(path.join(root, basis.file));
    return { kind: 'uncommitted', root, diffTarget: { kind: 'uncommitted', basis, stat } };
  }

  private startDiff(
    key: string, worktreePath: string, target: DiffTarget,
    request: { token: string; limit: number; forced: boolean; env?: Record<string, string> },
  ): DiffRun {
    const controller = new AbortController();
    const generation = this.diffGenerations.get(worktreePath) ?? 0;
    const startedAt = this.now();
    this.count({ diffComputations: 1 });
    const baseEnv: NodeJS.ProcessEnv = request.env ?? process.env;
    const run: DiffRun = { key, controller, waiters: 0, promise: undefined as unknown as Promise<GitFileDiff> };
    run.promise = (async () => {
      try {
        const diff = await computeFileDiff({
          target: target.diffTarget, token: request.token, limit: request.limit, forced: request.forced,
          cwd: worktreePath, env: { ...baseEnv, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
          timeout: request.forced ? GIT_FILE_DIFF_FORCED_TIMEOUT_MS : GIT_FILE_DIFF_TIMEOUT_MS,
          run: this.options.run, signal: controller.signal,
          deadline: startedAt + GIT_FILE_DIFF_BUDGET_MS, now: this.now,
          onGitProcess: () => this.count({ gitProcesses: 1 }),
        });
        if (await this.cacheable(target, startedAt) && (this.diffGenerations.get(worktreePath) ?? 0) === generation && !this.retired) {
          this.diffCache.set(key, worktreePath, diff);
        }
        return diff;
      } finally {
        if (this.diffRuns.get(key) === run) this.diffRuns.delete(key);
      }
    })();
    run.promise.catch(() => undefined);
    this.diffRuns.set(key, run);
    return run;
  }

  /**
   * A working file that was modified within the racy window when the diff
   * started, or changed while git read it, may hold other content under the
   * same token: such an answer is not kept.
   */
  private async cacheable(target: DiffTarget, startedAt: number): Promise<boolean> {
    if (target.kind !== 'uncommitted') return true;
    const { basis, stat } = target.diffTarget;
    if (basis.deleted) return true;
    if (basis.volatile || isRacyAt(stat, startedAt)) return false;
    return sameStat(stat, await statWorkingFile(path.join(target.root, basis.file)));
  }

  private waitDiff(run: DiffRun, signal?: AbortSignal): Promise<GitFileDiff> {
    run.waiters += 1;
    return new Promise<GitFileDiff>((resolve, reject) => {
      let left = false;
      const leave = (): boolean => {
        if (left) return false;
        left = true;
        run.waiters -= 1;
        signal?.removeEventListener('abort', onAbort);
        return true;
      };
      const onAbort = () => {
        if (!leave()) return;
        // The last request left: stop git, and let the next request start afresh.
        if (run.waiters === 0) {
          if (this.diffRuns.get(run.key) === run) this.diffRuns.delete(run.key);
          run.controller.abort();
        }
        reject(gitStateAbortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      run.promise.then(
        (diff) => { if (leave()) resolve(diff); },
        (error: unknown) => { if (leave()) reject(error); },
      );
      if (signal?.aborted) onAbort();
    });
  }

  private diffResult(diff: GitFileDiff | null, source: GitDiffSource): GitDiffResult {
    return { diff, epoch: this.epoch, source, counters: this.readCounters() };
  }

  private dropDiffs(worktreePath: string): void {
    this.diffCache.dropWorktree(worktreePath);
    this.diffGenerations.set(worktreePath, (this.diffGenerations.get(worktreePath) ?? 0) + 1);
    // A handful of numbers per worktree ever seen; bounded like the retired versions.
    if (this.diffGenerations.size > 4_096) this.diffGenerations.delete(this.diffGenerations.keys().next().value!);
  }

  private async getEntry(entry: Entry, request: GitStateRequest, signal?: AbortSignal): Promise<GitStateResult> {
    if (signal?.aborted) throw gitStateAbortError();
    const registration = entry.registration;
    const registeredRequest = registration?.request.baseBranch === request.baseBranch;
    const cached = entry.state;
    if (cached?.snapshot.baseBranch === request.baseBranch) {
      const fresh = registeredRequest
        ? !registration.dirty && !entry.computation
        : this.now() - cached.snapshot.computedAt < (this.options.freshnessMs ?? GIT_STATE_FRESHNESS_MS) && await this.gitFilesUnchanged(cached.fingerprint);
      if (fresh) {
        this.count({ cacheAnswers: 1 });
        return this.result(cached.snapshot, 'cache');
      }
    }
    const running = entry.computation;
    if (running) {
      const snapshot = await this.wait(entry, running, signal);
      if (running.baseBranch === request.baseBranch) return this.result(snapshot, 'shared');
      return this.getEntry(entry, request, signal);
    }
    if (registeredRequest && registration.dirty) {
      this.schedule(entry);
      return this.result(await this.waitPending(entry, registration.pending!, signal), 'shared');
    }
    return this.result(await this.wait(entry, this.start(entry, request), signal), 'computation');
  }

  private schedule(entry: Entry): void {
    const registration = entry.registration;
    if (!registration || !registration.dirty || this.retired) return;
    registration.pending ??= pendingResult();
    if (registration.timer) clearTimeout(registration.timer);
    registration.timer = undefined;
    if (entry.computation) return;
    const due = Math.max(
      registration.dirtyAt + (registration.trigger === 'safety' ? 0 : (this.options.debounceMs ?? GIT_STATE_DEBOUNCE_MS)),
      registration.lastStartedAt + (this.options.minComputationIntervalMs ?? GIT_STATE_MIN_COMPUTATION_INTERVAL_MS),
    );
    registration.timer = setTimeout(() => {
      registration.timer = undefined;
      if (entry.registration !== registration || !registration.dirty || this.retired) return;
      this.start(entry, registration.request);
    }, Math.max(0, due - this.now()));
    registration.timer.unref?.();
  }

  private start(entry: Entry, request: GitStateRequest): Computation {
    const controller = new AbortController();
    const startedAt = this.now();
    const registration = entry.registration;
    const servesRegistration = registration?.request.baseBranch === request.baseBranch;
    const trigger = servesRegistration ? registration.trigger : undefined;
    const pending = servesRegistration ? registration.pending : undefined;
    if (servesRegistration) {
      if (registration.timer) clearTimeout(registration.timer);
      registration.timer = undefined;
      registration.pending = undefined;
      registration.dirty = false;
      registration.lastStartedAt = startedAt;
      if (registration.trigger) this.count({ [TRIGGER_COUNTER[registration.trigger]]: 1 });
      registration.trigger = undefined;
    }
    this.count({ computations: 1 });
    const computation: Computation = { baseBranch: request.baseBranch, controller, waiters: pending?.waiters ?? 0, promise: undefined as unknown as Promise<GitStateSnapshot> };
    if (pending) pending.computation = computation;
    computation.promise = (async () => {
      try {
        const outcome = await computeGitState({
          request, run: this.options.run, signal: controller.signal,
          deadline: startedAt + (this.options.computationBudgetMs ?? GIT_STATE_COMPUTATION_BUDGET_MS),
          comparisons: this.comparisons, onGitProcess: () => this.count({ gitProcesses: 1 }), now: this.now,
          startedAt, previous: entry.lastFiles,
        });
        // diff can rewrite the index even with optional locks disabled. All
        // queued watch events compare against this post-computation identity.
        let fingerprint = outcome.fingerprint;
        let metadataChanged = false;
        if (entry.registration && fingerprint) {
          const value = await fingerprintRepository(fingerprint.layout, fingerprint.refs);
          // The computation can refresh index stats itself, but never changes
          // HEAD or refs. An external commit after the status read must cause
          // one follow-up even though its watch compares against our new stats.
          metadataChanged = metadataFingerprint(value) !== metadataFingerprint(fingerprint.value);
          fingerprint = { ...fingerprint, value };
        }
        // Racy entries still carry a provisional token here: an unchanged racy
        // file does not make a new version by itself. Once the version is
        // known, their tokens take it on.
        const contentHash = hashContent(outcome.content);
        const changed = contentHash !== entry.contentHash;
        if (changed) { entry.version += 1; entry.contentHash = contentHash; }
        const uncommitted = outcome.racy.length === 0 ? outcome.content.uncommitted : outcome.content.uncommitted.slice();
        for (const { index, source } of outcome.racy) {
          uncommitted[index] = { ...uncommitted[index]!, token: racyToken(source, { epoch: this.epoch, version: entry.version }) };
        }
        const snapshot: GitStateSnapshot = { ...outcome.content, uncommitted, epoch: this.epoch, version: entry.version, computedAt: startedAt };
        this.files.set(snapshot, outcome.files);
        if (this.entries.get(entry.key) === entry) entry.lastFiles = outcome.files;
        const current = entry.registration;
        if (this.entries.get(entry.key) === entry && (!current || current.request.baseBranch === request.baseBranch)) {
          entry.state = { snapshot, fingerprint };
          current?.watches.update(fingerprint);
          if (current && metadataChanged) this.invalidate(entry.key, 'watch');
          if (current && fingerprint) await this.refreshBaseUsers(entry, fingerprint, trigger ?? 'watch');
          if (current && entry.registration === current && this.entries.get(entry.key) === entry && changed && !this.retired) {
            try { this.options.onChange?.(snapshot); } catch { /* A subscriber cannot break the computation. */ }
          }
        }
        pending?.resolve(snapshot);
        return snapshot;
      } catch (error) {
        pending?.reject(error);
        throw error;
      } finally {
        this.computations.delete(computation);
        if (entry.computation === computation) entry.computation = undefined;
        this.schedule(entry);
        if (entry.registration?.watchPending) this.watchEvent(entry);
      }
    })();
    computation.promise.catch(() => undefined);
    this.computations.add(computation);
    entry.computation = computation;
    return computation;
  }

  private watchEvent(entry: Entry): void {
    const registration = entry.registration;
    if (!registration || this.retired) return;
    registration.watchPending = true;
    if (entry.computation || registration.checkingWatch) return;
    registration.checkingWatch = true;
    registration.watchPending = false;
    const state = entry.state;
    void this.gitFilesUnchanged(state?.fingerprint ?? null).then((unchanged) => {
      if (entry.registration !== registration || this.retired) return;
      if (entry.computation || entry.state !== state) {
        registration.watchPending = true;
        return;
      }
      if (!unchanged) this.invalidate(entry.key, 'watch');
    }).finally(() => {
      registration.checkingWatch = false;
      if (entry.registration === registration && registration.watchPending && !entry.computation) this.watchEvent(entry);
    });
  }

  /** A safety read can discover a moved base even when its directory watch failed. */
  private async refreshBaseUsers(entry: Entry, fingerprint: RepositoryFingerprint, trigger: GitStateTrigger): Promise<void> {
    const registration = entry.registration;
    if (!registration) return;
    const { baseBranch } = registration.request;
    const key = `${fingerprint.layout.commonDir}\0${baseBranch}`;
    const names = [baseBranch, baseBranch.startsWith('origin/') ? baseBranch : `origin/${baseBranch}`];
    const value = JSON.stringify(await Promise.all(names.map((name) => resolveRevisionName(fingerprint.layout, name).catch(() => ({ kind: 'unknown' })))));
    if (entry.registration !== registration || this.retired) return;
    const previous = this.baseRefs.get(key);
    this.baseRefs.set(key, value);
    if (previous === undefined || previous === value) return;
    for (const other of this.entries.values()) {
      if (other === entry || other.registration?.request.baseBranch !== baseBranch) continue;
      if (other.state?.fingerprint?.layout.commonDir === fingerprint.layout.commonDir) this.invalidate(other.key, trigger);
    }
  }

  private closeRegistration(entry: Entry): void {
    const registration = entry.registration;
    if (!registration) return;
    // A REST request can already be waiting for a debounced computation. Its
    // ownership survives the last subscriber leaving, like an in-flight read.
    if (registration.pending?.waiters && !entry.computation) this.start(entry, registration.request);
    entry.registration = undefined;
    clearInterval(registration.safetyTimer);
    if (registration.timer) clearTimeout(registration.timer);
    registration.watches.close();
    registration.pending?.reject(gitStateAbortError());
    this.options.onRegisteredCount?.(this.registeredCount);
  }

  private count(delta: Partial<GitStateCounters>): void {
    for (const key of Object.keys(delta) as (keyof GitStateCounters)[]) this.counters[key] += delta[key] ?? 0;
    try { this.options.onCounters?.(delta); } catch { /* Metrics never disturb a request. */ }
  }

  private result(snapshot: GitStateSnapshot, source: GitStateSource): GitStateResult {
    return { snapshot, source, counters: this.readCounters() };
  }

  private async gitFilesUnchanged(fingerprint: RepositoryFingerprint | null): Promise<boolean> {
    if (!fingerprint) return true;
    return await fingerprintRepository(fingerprint.layout, fingerprint.refs).catch(() => null) === fingerprint.value;
  }

  private entryFor(key: string): Entry {
    if (!this.retired && !this.sweepTimer) {
      this.sweepTimer = setInterval(() => this.sweep(), this.options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
      this.sweepTimer.unref?.();
    }
    let entry = this.entries.get(key);
    if (entry) this.entries.delete(key);
    else {
      const retired = this.retiredVersions.get(key);
      entry = { key, lastRequestedAt: this.now(), version: retired?.version ?? 0, contentHash: retired?.contentHash };
    }
    entry.lastRequestedAt = this.now();
    this.entries.set(key, entry);
    if (this.entries.size > (this.options.maxEntries ?? DEFAULT_MAX_ENTRIES)) {
      for (const [otherKey, other] of this.entries) {
        if (this.entries.size <= Math.max(1, this.options.maxEntries ?? DEFAULT_MAX_ENTRIES)) break;
        if (other !== entry && !other.registration && !other.computation) this.drop(otherKey, other);
      }
    }
    return entry;
  }

  private drop(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.retiredVersions.set(key, { version: entry.version, contentHash: entry.contentHash });
    // The cached diffs follow the state: an ended registration or an idle entry takes them along.
    this.dropDiffs(key);
  }

  private waitPending(entry: Entry, pending: Pending, signal?: AbortSignal): Promise<GitStateSnapshot> {
    pending.waiters += 1;
    return new Promise((resolve, reject) => {
      let left = false;
      const leave = (): boolean => {
        if (left) return false;
        left = true;
        pending.waiters -= 1;
        if (pending.computation) pending.computation.waiters -= 1;
        signal?.removeEventListener('abort', onAbort);
        return true;
      };
      const onAbort = () => {
        if (!leave()) return;
        if (pending.computation?.waiters === 0 && !entry.registration) pending.computation.controller.abort();
        reject(gitStateAbortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      pending.promise.then(
        (snapshot) => { if (leave()) resolve(snapshot); },
        (error: unknown) => { if (leave()) reject(error); },
      );
      if (signal?.aborted) onAbort();
    });
  }

  private wait(entry: Entry, computation: Computation, signal?: AbortSignal): Promise<GitStateSnapshot> {
    computation.waiters += 1;
    return new Promise<GitStateSnapshot>((resolve, reject) => {
      let left = false;
      const leave = (): boolean => {
        if (left) return false;
        left = true;
        computation.waiters -= 1;
        signal?.removeEventListener('abort', onAbort);
        return true;
      };
      const onAbort = () => {
        if (!leave()) return;
        if (computation.waiters === 0 && !entry.registration) {
          if (entry.computation === computation) entry.computation = undefined;
          computation.controller.abort();
        }
        reject(gitStateAbortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      computation.promise.then(
        (snapshot) => { if (leave()) resolve(snapshot); },
        (error: unknown) => { if (leave()) reject(error); },
      );
      if (signal?.aborted) onAbort();
    });
  }
}
