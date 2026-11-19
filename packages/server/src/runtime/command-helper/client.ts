import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GIT_FILE_DIFF_BUDGET_MS, GIT_STATE_COMPUTATION_BUDGET_MS } from '../../git/state/git-state-limits.js';
import type { GitDiffRequest, GitDiffResult, GitStateRequest, GitStateResult, GitStateTrigger } from '../../git/state/git-state-types.js';
import type { OwnedCommandOptions } from '../../utils/owned-child-process.js';
import { DEFAULT_STOP_GRACE_MS, FORCE_EXIT_TIMEOUT_MS, OWNER_STOP_BUDGET_MS } from '../../utils/owned-process-limits.js';
import { getNodeRuntimeCommand, isStandaloneNodeRuntime } from '../../utils/process-launch.js';
import { assertApplicationProcessStartAllowed } from '../application-process-cleanup.js';
import { countCommandHelperRecycle, countCommandHelperRestart } from '../runtime-metrics.js';
import {
  COMMAND_HELPER_EXITED,
  COMMAND_HELPER_UNRESPONSIVE,
  deserializeCommandError,
  type CommandFailedMessage,
  type CommandSucceededMessage,
  type GitDiffFailedMessage,
  type GitDiffRequestMessage,
  type GitDiffSucceededMessage,
  type GitStateFailedMessage,
  type GitStateActivityMessage,
  type GitStateChangedMessage,
  type GitStateRequestMessage,
  type GitStateSucceededMessage,
  type RegisterGitStateRequestMessage,
  type HelperReadyMessage,
  type HelperToServerMessage,
  type RunCommandRequest,
  type ServerToHelperMessage,
} from './protocol.js';

/**
 * Server side of the command helper.
 *
 * On Linux, Node starts every child with fork(), which copies the page tables
 * of the calling process (all memory outside the V8 heap, which V8 marks
 * MADV_DONTFORK) and blocks its event loop; in the production server that is
 * 0.1-0.3 s per start. The application therefore forks one small helper
 * process at boot and lets it start the owned commands (`runOwnedCommand`);
 * the server only exchanges IPC messages with it.
 *
 * Nothing starts the helper implicitly: only the server entries call
 * `startCommandHelper()`. Without a running helper, commands run in the
 * calling process exactly as before. A command is never re-run after the
 * helper went away; its caller gets `ERR_COMMAND_HELPER_EXITED`.
 */

export type CommandHelperMode = 'auto' | 'on' | 'off';

export type CommandHelperState =
  | 'idle'
  /** A helper process was forked and has not reported ready yet. */
  | 'starting'
  /** Commands are sent to the helper. */
  | 'running'
  /** The helper is closing or has exited; results of running commands may still arrive. */
  | 'draining'
  /** Waiting for the backoff delay before the next start. */
  | 'restarting'
  /** Gave up after repeated failures; commands run in the server process. */
  | 'failed'
  | 'stopping'
  | 'stopped';

export const COMMAND_HELPER_ENV = 'AGENT_TOWER_COMMAND_HELPER';
export const DEFAULT_RESTART_DELAYS_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];
/** The helper is not restarted after this many consecutive failures. */
export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;
const DEFAULT_RECYCLE_RSS_MB = 384;
const DEFAULT_RECYCLE_INTERVAL_MS = 10 * 60_000;
const DEFAULT_READY_TIMEOUT_MS = 15_000;
/** A helper that served this long before exiting starts a new failure count. */
const DEFAULT_STABLE_UPTIME_MS = 60_000;
/** Results written just before an exit are still in the channel; wait for them this long. */
const EXIT_DRAIN_GRACE_MS = 1_000;
/**
 * How long after a command's own timeout (or after its abort) its result may
 * still legitimately arrive: the helper's owner needs up to
 * OWNER_STOP_BUDGET_MS to confirm that the tree is gone; the rest is margin
 * for IPC and scheduling on a busy host. Later, the helper is unresponsive.
 */
const DEFAULT_RESULT_GRACE_MS = OWNER_STOP_BUDGET_MS + 4_000;
/**
 * SIGTERM to SIGKILL for an unresponsive helper: long enough for a helper that
 * is only slow to escalate its own commands to SIGKILL (grace + force wait).
 */
const DEFAULT_TERMINATE_GRACE_MS = DEFAULT_STOP_GRACE_MS + FORCE_EXIT_TIMEOUT_MS;
/** stop() waits this long for the helper's exit: more than three full owner stop attempts. */
const DEFAULT_STOP_TIMEOUT_MS = 20_000;

export function parseCommandHelperMode(value: string | undefined): { mode: CommandHelperMode; valid: boolean } {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === 'auto') return { mode: 'auto', valid: true };
  if (normalized === 'on' || normalized === 'off') return { mode: normalized, valid: true };
  return { mode: 'auto', valid: false };
}

/** `auto` enables the helper where fork() blocks the server: Linux. */
export function isCommandHelperEnabled(mode: CommandHelperMode, platform: NodeJS.Platform = process.platform): boolean {
  return mode === 'on' || (mode === 'auto' && platform === 'linux');
}

export interface CommandHelperEntry {
  modulePath: string;
  execArgv: string[];
}

/**
 * `dist/` runs the compiled entry. The development source tree (tsx dev
 * server, vitest) runs the TypeScript entry through the tsx loader.
 */
export function resolveCommandHelperEntry(): CommandHelperEntry {
  const moduleFile = fileURLToPath(import.meta.url);
  const directory = path.dirname(moduleFile);
  if (!moduleFile.endsWith('.ts')) {
    return { modulePath: path.join(directory, 'helper-main.js'), execArgv: [] };
  }
  const tsxLoader = createRequire(import.meta.url).resolve('tsx');
  return { modulePath: path.join(directory, 'helper-main.ts'), execArgv: ['--import', pathToFileURL(tsxLoader).href] };
}

type LogLevel = 'info' | 'warn' | 'error';

export interface CommandHelperClientOptions {
  /** Defaults to `AGENT_TOWER_NODE_RUNTIME`, then `process.execPath`. */
  execPath?: string;
  entry?: CommandHelperEntry;
  restartDelaysMs?: readonly number[];
  maxConsecutiveFailures?: number;
  readyTimeoutMs?: number;
  stableUptimeMs?: number;
  /** Grace after a command's timeout or abort before the helper counts as unresponsive. */
  resultGraceMs?: number;
  /** SIGTERM to SIGKILL when an unresponsive helper is replaced. */
  terminateGraceMs?: number;
  /** How long stop() waits for the helper's exit before it escalates or reports pending cleanup. */
  stopTimeoutMs?: number;
  /** How long a git state request may wait for its answer; default: the computation budget plus the result grace. */
  gitStateDeadlineMs?: number;
  /** How long a file diff request may wait: the state's budget, the diff's budget and the result grace. */
  gitDiffDeadlineMs?: number;
  /** MiB of resident memory. Zero disables planned replacement. */
  recycleRssMb?: number;
  recycleReports?: number;
  recycleMinIntervalMs?: number;
  log?: (level: LogLevel, message: string) => void;
}

export interface CommandHelperStatus {
  state: CommandHelperState | 'off';
  pid?: number;
  rssBytes?: number;
  /** Known once the helper is ready: its commands run under the scope supervisor. */
  supervisedScopes?: boolean;
  pendingCommands: number;
}

interface HelperProcess {
  child: ChildProcess;
  rssBytes?: number;
  highRssReports: number;
  readyTimer?: ReturnType<typeof setTimeout>;
  /** After the atomic switch, only replies to this process's own requests are accepted. */
  retiring?: boolean;
  stopWait?: Promise<void>;
  /** Resolves once the process is gone (exit, or a start that never produced a process). */
  exited: Promise<void>;
  /** Once ready, start of uninterrupted helper availability across planned switches. */
  servingSince?: number;
  /** Killed because it did not report ready in time; a late ready is ignored. */
  abandoned: boolean;
  gone: boolean;
  /** The process itself has exited (the channel may still drain). */
  processExited: boolean;
  /** From the ready message: a dying helper cannot orphan its command trees. */
  supervised: boolean;
  /** Being replaced because it stopped answering. */
  terminating: boolean;
  killTimer?: ReturnType<typeof setTimeout>;
  pendingCommands: number;
}

/** A `run`, `git-state` or `git-diff` request waiting for its result. */
interface PendingCommand {
  /** What the request runs, for error messages: the command, or "git state". */
  command: string;
  helper: HelperProcess;
  sentAt: number;
  /** Result expected by this time (epoch ms); none for a timeout of 0 until it is aborted. */
  deadline?: number;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const defaultLog = (level: LogLevel, message: string) => {
  if (level === 'info') console.log(message);
  else if (level === 'warn') console.warn(message);
  else console.error(message);
};

function megabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Copies `env` the way child_process.spawn reads it: inherited keys included, `undefined` skipped. */
function snapshotEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const key in env) {
    const value = env[key];
    if (value !== undefined) snapshot[key] = `${value}`;
  }
  return snapshot;
}

function currentDirectory(): string | undefined {
  try {
    return process.cwd();
  } catch {
    // A deleted working directory: let the spawn report it as it would here.
    return undefined;
  }
}

/** True when `promise` settles within `ms`; the timer keeps the host alive meanwhile. */
async function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); });
  try {
    return await Promise.race([promise.then(() => true), expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function applicationAllowsProcessStarts(): boolean {
  try {
    assertApplicationProcessStartAllowed();
    return true;
  } catch {
    return false;
  }
}

export class CommandHelperClient {
  private stateValue: CommandHelperState = 'idle';
  private current?: HelperProcess;
  private candidate?: HelperProcess;
  /** Includes disconnected children until the OS confirms their exit. */
  private readonly processes = new Set<HelperProcess>();
  /** Monotonic time of the latest attempt or its completion, including a failed startup. */
  private lastRecycleAt = -Infinity;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly gitStateChangeListeners = new Set<(message: GitStateChangedMessage) => void>();
  private readonly gitStateActivityListeners = new Set<(message: GitStateActivityMessage) => void>();
  private nextRequestId = 0;
  private consecutiveFailures = 0;
  private restartTimer?: ReturnType<typeof setTimeout>;
  private readonly recycleRssBytes: number;
  private readonly recycleReports: number;
  private readonly recycleMinIntervalMs: number;
  private firstStart?: { promise: Promise<boolean>; resolve: (ready: boolean) => void };
  private stopRequested = false;
  /** The bounded wait in progress, shared by concurrent stop() calls. */
  private stopWait?: Promise<void>;
  private readonly execPath: string;
  private readonly entry: CommandHelperEntry;
  private readonly restartDelaysMs: readonly number[];
  private readonly maxConsecutiveFailures: number;
  private readonly readyTimeoutMs: number;
  private readonly stableUptimeMs: number;
  private readonly resultGraceMs: number;
  private readonly terminateGraceMs: number;
  private readonly stopTimeoutMs: number;
  private readonly gitStateDeadlineMs: number;
  private readonly gitDiffDeadlineMs: number;
  private readonly log: (level: LogLevel, message: string) => void;

  constructor(options: CommandHelperClientOptions = {}) {
    this.execPath = options.execPath ?? getNodeRuntimeCommand();
    this.entry = options.entry ?? resolveCommandHelperEntry();
    this.restartDelaysMs = options.restartDelaysMs?.length ? options.restartDelaysMs : DEFAULT_RESTART_DELAYS_MS;
    this.maxConsecutiveFailures = Math.max(1, options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES);
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.stableUptimeMs = options.stableUptimeMs ?? DEFAULT_STABLE_UPTIME_MS;
    this.resultGraceMs = options.resultGraceMs ?? DEFAULT_RESULT_GRACE_MS;
    this.terminateGraceMs = options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    this.gitStateDeadlineMs = options.gitStateDeadlineMs ?? GIT_STATE_COMPUTATION_BUDGET_MS + this.resultGraceMs;
    this.gitDiffDeadlineMs = options.gitDiffDeadlineMs ?? GIT_STATE_COMPUTATION_BUDGET_MS + GIT_FILE_DIFF_BUDGET_MS + this.resultGraceMs;
    const configured = process.env.AGENT_TOWER_COMMAND_HELPER_RECYCLE_RSS_MB?.trim();
    const mb = options.recycleRssMb ?? (configured ? Number(configured) : DEFAULT_RECYCLE_RSS_MB);
    this.recycleRssBytes = (Number.isFinite(mb) && mb >= 0 ? mb : DEFAULT_RECYCLE_RSS_MB) * 1024 * 1024;
    this.recycleReports = Math.max(1, options.recycleReports ?? 3);
    this.recycleMinIntervalMs = options.recycleMinIntervalMs ?? DEFAULT_RECYCLE_INTERVAL_MS;
    this.log = options.log ?? defaultLog;
  }

  get state(): CommandHelperState {
    return this.stateValue;
  }

  private setState(next: CommandHelperState): void {
    this.stateValue = next;
    publishPlacement();
  }

  /** True while new commands are sent to the helper. */
  get accepting(): boolean {
    return this.stateValue === 'running' && this.current?.child.connected === true;
  }

  get finished(): boolean {
    return this.stateValue === 'stopped' || this.stateValue === 'failed';
  }

  status(): CommandHelperStatus {
    const helper = this.current && !this.current.gone ? this.current : undefined;
    return {
      state: this.stateValue,
      pid: helper?.child.pid,
      rssBytes: helper?.rssBytes,
      supervisedScopes: helper?.servingSince !== undefined ? helper.supervised : undefined,
      pendingCommands: this.pending.size,
    };
  }

  /** Resolves true when the helper first serves commands, false if it never does. */
  start(): Promise<boolean> {
    if (!this.firstStart) {
      let resolve!: (ready: boolean) => void;
      const promise = new Promise<boolean>((done) => { resolve = done; });
      this.firstStart = { promise, resolve };
      // A stopped client never forks a helper.
      if (this.stopRequested) resolve(false);
      else this.launch('start');
    }
    return this.firstStart.promise;
  }

  /**
   * Sends one command. The caller has checked `accepting`, the abort signal
   * and `assertApplicationProcessStartAllowed()`.
   */
  run(command: string, args: string[], options: OwnedCommandOptions): Promise<{ stdout: string; stderr: string }> {
    const helper = this.current;
    if (!helper || !this.accepting) {
      return Promise.reject(Object.assign(new Error(`${command} was not started: the command helper is not running`), { code: COMMAND_HELPER_EXITED }));
    }
    const id = ++this.nextRequestId;
    const request: RunCommandRequest = {
      type: 'run',
      id,
      command,
      args: [...args],
      cwd: options.cwd ?? currentDirectory(),
      env: snapshotEnvironment(options.env ?? process.env),
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
    };
    // The helper enforces the timeout; this deadline only catches a helper
    // that no longer answers at all.
    return this.dispatch<{ stdout: string; stderr: string }>(command, helper, request, {
      deadlineMs: options.timeout > 0 ? options.timeout + this.resultGraceMs : undefined,
      signal: options.signal,
    });
  }

  /**
   * Asks the git state service in the helper (git/state/git-state-service.ts).
   * Same rules as `run`: a distinct error when the helper goes away
   * (`ERR_COMMAND_HELPER_EXITED`), and a bounded wait after which the helper
   * counts as unresponsive and is replaced (`ERR_COMMAND_HELPER_UNRESPONSIVE`).
   * The service bounds its own computation, so the deadline is that budget
   * plus the stop grace.
   */
  requestGitState(request: GitStateRequest, options: { signal?: AbortSignal } = {}): Promise<GitStateResult> {
    return this.dispatchGitState('git-state', request, options);
  }

  registerGitState(request: GitStateRequest, options: { signal?: AbortSignal } = {}): Promise<GitStateResult> {
    return this.dispatchGitState('git-state-register', request, options);
  }

  /**
   * One file's diff from the helper's git state service. Same rules as
   * `requestGitState`; aborting the signal sends `cancel`, and the helper
   * stops the git process when no other request waits for that diff.
   */
  requestGitDiff(request: GitDiffRequest, options: { signal?: AbortSignal } = {}): Promise<GitDiffResult> {
    const helper = this.current;
    if (!helper || !this.accepting) {
      return Promise.reject(Object.assign(new Error('git diff was not computed: the command helper is not running'), { code: COMMAND_HELPER_EXITED }));
    }
    if (options.signal?.aborted) return Promise.reject(Object.assign(new Error('The git diff request was cancelled'), { code: 'ABORT_ERR' }));
    const message: GitDiffRequestMessage = {
      type: 'git-diff',
      id: ++this.nextRequestId,
      request: { ...request, env: snapshotEnvironment(request.env ?? process.env) },
    };
    return this.dispatch<GitDiffResult>('git diff', helper, message, { deadlineMs: this.gitDiffDeadlineMs, signal: options.signal });
  }

  unregisterGitState(worktreePath: string): void {
    if (this.current && this.accepting) this.send(this.current, { type: 'git-state-unregister', worktreePath });
  }

  invalidateGitState(worktreePath: string, trigger: GitStateTrigger): void {
    if (this.current && this.accepting) this.send(this.current, { type: 'git-state-invalidate', worktreePath, trigger });
  }

  onGitStateChange(listener: (message: GitStateChangedMessage) => void): () => void {
    this.gitStateChangeListeners.add(listener);
    return () => { this.gitStateChangeListeners.delete(listener); };
  }

  onGitStateActivity(listener: (message: GitStateActivityMessage) => void): () => void {
    this.gitStateActivityListeners.add(listener);
    return () => { this.gitStateActivityListeners.delete(listener); };
  }

  private dispatchGitState(type: GitStateRequestMessage['type'] | RegisterGitStateRequestMessage['type'], request: GitStateRequest, options: { signal?: AbortSignal }): Promise<GitStateResult> {
    const helper = this.current;
    if (!helper || !this.accepting) {
      return Promise.reject(Object.assign(new Error('git state was not computed: the command helper is not running'), { code: COMMAND_HELPER_EXITED }));
    }
    if (options.signal?.aborted) return Promise.reject(Object.assign(new Error('The git state request was cancelled'), { code: 'ABORT_ERR' }));
    const message: GitStateRequestMessage | RegisterGitStateRequestMessage = {
      type,
      id: ++this.nextRequestId,
      request: { ...request, env: snapshotEnvironment(request.env ?? process.env) },
    };
    return this.dispatch<GitStateResult>('git state', helper, message, { deadlineMs: this.gitStateDeadlineMs, signal: options.signal });
  }

  /** Registers a request, arms its deadline and its cancel, and sends it. */
  private dispatch<T>(
    label: string,
    helper: HelperProcess,
    message: RunCommandRequest | GitStateRequestMessage | RegisterGitStateRequestMessage | GitDiffRequestMessage,
    options: { deadlineMs?: number; signal?: AbortSignal },
  ): Promise<T> {
    const id = message.id;
    return new Promise<T>((resolve, reject) => {
      const entry: PendingCommand = { command: label, helper, sentAt: Date.now(), resolve: resolve as (value: unknown) => void, reject, signal: options.signal };
      this.pending.set(id, entry);
      helper.pendingCommands += 1;
      this.updateRefs(helper);
      if (options.deadlineMs !== undefined) this.armDeadline(id, entry, options.deadlineMs);
      if (options.signal) {
        entry.onAbort = () => {
          this.send(helper, { type: 'cancel', id });
          // A cancelled request must report within the same stop grace.
          this.armDeadline(id, entry, this.resultGraceMs);
        };
        options.signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      try {
        helper.child.send(message, (error) => {
          if (error) this.rejectUndelivered(id, error);
        });
      } catch (error) {
        // The request could not be serialized; it never left this process.
        this.forget(id);
        reject(error);
        return;
      }
      if (options.signal?.aborted) entry.onAbort?.();
    });
  }

  /**
   * Asks the helper to stop its running commands through the owner stop rules,
   * waits until it has reported their results and exited, and never restarts it.
   *
   * The wait is bounded by `stopTimeoutMs`. A helper that has not exited by
   * then is killed when its commands run under the scope supervisor (which
   * stops their trees when the helper dies); otherwise this rejects with
   * "cleanup remains pending", like an unconfirmed in-process owner, and a
   * later call waits again. Concurrent calls share one wait.
   */
  stop(): Promise<void> {
    if (!this.stopRequested) {
      this.stopRequested = true;
      if (this.restartTimer) clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
      this.firstStart?.resolve(false);
      this.setState('stopping');
    }
    this.stopWait ??= Promise.all([...this.processes].map(helper => this.stopHelper(helper)))
      .then(() => this.setState('stopped')).finally(() => { this.stopWait = undefined; });
    return this.stopWait;
  }

  private stopHelper(helper: HelperProcess): Promise<void> {
    if (helper.stopWait) return helper.stopWait;
    if (helper.readyTimer) clearTimeout(helper.readyTimer);
    helper.child.ref();
    helper.child.channel?.ref();
    if (!helper.gone) {
      if (helper.servingSince === undefined) {
        helper.abandoned = true;
        helper.child.kill('SIGKILL');
      } else {
        this.send(helper, { type: 'shutdown' });
      }
    }
    helper.stopWait = this.waitUntilExited(helper).finally(() => { helper.stopWait = undefined; });
    return helper.stopWait;
  }

  private async waitUntilExited(helper: HelperProcess): Promise<void> {
    if (!helper.processExited && !await settlesWithin(helper.exited, this.stopTimeoutMs)) {
      const pid = helper.child.pid ?? 'none';
      if (helper.servingSince !== undefined && !helper.supervised) {
        throw new Error(`Command helper pid=${pid} did not exit within ${this.stopTimeoutMs} ms of the stop request; child process tree cleanup remains pending`);
      }
      this.log('warn', `[command-helper] pid=${pid} did not exit within ${this.stopTimeoutMs} ms of the stop request; killing it (the scope supervisors stop its command trees)`);
      helper.child.kill('SIGKILL');
      await helper.exited;
    }
  }

  private launch(reason: 'start' | 'restart' | 'recycle'): void {
    if (!applicationAllowsProcessStarts()) {
      if (reason !== 'recycle') {
        this.setState('stopped');
        this.firstStart?.resolve(false);
      }
      return;
    }
    if (reason === 'restart') countCommandHelperRestart();
    if (reason !== 'recycle') this.setState('starting');
    // fork() hands its options to spawn(), which honours windowsHide: a
    // console-less host (the desktop backend) must not open a console window.
    const options: ForkOptions & { windowsHide: boolean } = {
      execPath: this.execPath,
      execArgv: this.entry.execArgv,
      env: this.helperEnvironment(),
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    };
    let child: ChildProcess;
    try {
      child = fork(this.entry.modulePath, [], options);
    } catch (error) {
      if (reason === 'recycle') this.log('warn', `[command-helper] replacement could not be started: ${describeError(error)}`);
      else {
        this.current = undefined;
        this.handleFailure(`could not be started: ${describeError(error)}`);
      }
      return;
    }
    let markExited!: () => void;
    const helper: HelperProcess = {
      child,
      highRssReports: 0,
      exited: new Promise<void>((resolve) => { markExited = resolve; }),
      abandoned: false,
      gone: false,
      processExited: false,
      supervised: false,
      terminating: false,
      pendingCommands: 0,
    };
    this.processes.add(helper);
    if (reason === 'recycle') this.candidate = helper;
    else this.current = helper;
    // Referenced until it reports ready: whoever started it is waiting for it.

    child.on('message', (message) => this.handleMessage(helper, message as HelperToServerMessage));
    child.on('error', (error) => {
      if (child.pid !== undefined) return;
      // The process never started: there will be no exit event.
      helper.processExited = true;
      this.processes.delete(helper);
      markExited();
      this.handleGone(helper, `could not be started: ${describeError(error)}`);
    });
    child.once('disconnect', () => this.handleGone(helper, 'went away (IPC channel closed)'));
    child.once('exit', (code, signal) => {
      helper.processExited = true;
      this.processes.delete(helper);
      if (helper.killTimer) clearTimeout(helper.killTimer);
      markExited();
      const reason = `exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
      if (!child.connected) {
        this.handleGone(helper, reason);
        return;
      }
      // An exited helper takes no new command; results it wrote before
      // exiting may still be in the channel.
      if (helper === this.current && this.stateValue === 'running') this.setState('draining');
      const timer = setTimeout(() => this.handleGone(helper, reason), EXIT_DRAIN_GRACE_MS);
      timer.unref();
    });

    helper.readyTimer = setTimeout(() => {
      helper.readyTimer = undefined;
      if (helper.servingSince !== undefined || helper.gone) return;
      const label = helper === this.candidate ? 'replacement ' : '';
      this.log('warn', `[command-helper] ${label}pid=${child.pid ?? 'none'} did not report ready within ${this.readyTimeoutMs} ms; stopping it`);
      // Safe: a helper that is not ready has never been given a command.
      helper.abandoned = true;
      child.kill('SIGKILL');
    }, this.readyTimeoutMs);
    helper.readyTimer.unref();
  }

  private helperEnvironment(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    // Same rule as the PTY wrapper: Electron's Node mode marker is only kept
    // when the runtime is the Electron executable itself.
    if (isStandaloneNodeRuntime(this.execPath)) delete env.ELECTRON_RUN_AS_NODE;
    return env;
  }

  private onReady(helper: HelperProcess, message: HelperReadyMessage): void {
    if (helper.readyTimer) clearTimeout(helper.readyTimer);
    if (helper.abandoned || helper.gone || helper.servingSince !== undefined || this.stopRequested) return;
    const replacement = helper === this.candidate;
    const old = replacement ? this.current : undefined;
    if (replacement) {
      if (!old || !this.accepting || !applicationAllowsProcessStarts()) {
        helper.abandoned = true;
        helper.child.kill('SIGKILL');
        return;
      }
      this.candidate = undefined;
      old.retiring = true;
    } else if (helper !== this.current || this.stateValue !== 'starting') return;

    helper.servingSince = old?.servingSince ?? Date.now();
    helper.supervised = message.supervisedScopes === true;
    helper.rssBytes = message.rssBytes;
    this.current = helper;
    if (old) {
      countCommandHelperRecycle();
      const now = performance.now();
      const elapsed = Math.round(now - this.lastRecycleAt);
      this.lastRecycleAt = now;
      this.log('info', `[command-helper] recycled old_pid=${old.child.pid} old_rss_mb=${megabytes(old.rssBytes!)} new_pid=${message.pid} new_rss_mb=${megabytes(message.rssBytes)} switch_ms=${elapsed}`);
      this.send(old, { type: 'git-state-retire' });
      publishPlacement();
      this.finishDrain(old);
    } else {
      this.setState('running');
      this.log('info', `[command-helper] ready pid=${message.pid} rss_mb=${megabytes(message.rssBytes)}`);
      this.firstStart?.resolve(true);
    }
    this.updateRefs(helper);
  }

  private onStats(helper: HelperProcess, rssBytes: number): void {
    helper.rssBytes = rssBytes;
    helper.highRssReports = rssBytes > this.recycleRssBytes ? helper.highRssReports + 1 : 0;
    // Only one warmup or drain at a time, including a child whose IPC has closed.
    if (!this.recycleRssBytes || helper.highRssReports < this.recycleReports || !this.accepting || this.processes.size !== 1) return;
    const now = performance.now();
    if (now - this.lastRecycleAt < this.recycleMinIntervalMs) return;
    this.lastRecycleAt = now;
    helper.highRssReports = 0;
    this.launch('recycle');
  }

  private finishDrain(helper: HelperProcess): void {
    if (helper.retiring && !helper.gone && helper.pendingCommands === 0 && !this.stopRequested) {
      void this.stopHelper(helper).catch(error => this.log('warn', `[command-helper] retiring pid=${helper.child.pid}: ${describeError(error)}`));
    }
  }

  private handleMessage(helper: HelperProcess, message: HelperToServerMessage): void {
    if (!message || typeof message !== 'object' || helper.gone) return;
    // Results and cancellations stay with the process that owns the request.
    if (message.type === 'result' || message.type === 'git-state-result' || message.type === 'git-diff-result') {
      if (this.pending.get(message.id)?.helper === helper) this.settle(message);
      return;
    }
    if (message.type === 'ready') { this.onReady(helper, message); return; }
    if (helper !== this.current) return;
    switch (message.type) {
      case 'stats':
        this.onStats(helper, message.rssBytes);
        return;
      case 'git-state-changed':
      case 'git-state-activity': {
        // A draining generation must not overwrite the new active placement.
        if (!this.accepting || helper.gone) return;
        if (message.type === 'git-state-changed') this.notifyGitState(this.gitStateChangeListeners, message);
        else {
          helper.rssBytes = message.rssBytes;
          this.notifyGitState(this.gitStateActivityListeners, message);
        }
        return;
      }
      case 'closing':
        if (this.stateValue === 'running' || this.stateValue === 'starting') {
          this.setState('draining');
          this.log('warn', `[command-helper] pid=${helper.child.pid} is closing (${message.reason}); new commands run in the server process`);
        }
        return;
    }
  }

  private notifyGitState<T>(listeners: Set<(message: T) => void>, message: T): void {
    for (const listener of [...listeners]) {
      try { listener(message); }
      catch (error) { this.log('error', `[command-helper] git state listener failed: ${describeError(error)}`); }
    }
  }

  private settle(message: CommandSucceededMessage | CommandFailedMessage | GitStateSucceededMessage | GitStateFailedMessage | GitDiffSucceededMessage | GitDiffFailedMessage): void {
    const entry = this.forget(message.id);
    if (!entry) return;
    if (!message.ok) entry.reject(deserializeCommandError(message.error));
    else if (message.type === 'git-state-result' || message.type === 'git-diff-result') entry.resolve(message.result);
    else entry.resolve({ stdout: message.stdout, stderr: message.stderr });
  }

  private forget(id: number): PendingCommand | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    entry.helper.pendingCommands -= 1;
    if (entry.deadlineTimer) clearTimeout(entry.deadlineTimer);
    if (entry.onAbort) entry.signal?.removeEventListener('abort', entry.onAbort);
    this.updateRefs(entry.helper);
    this.finishDrain(entry.helper);
    return entry;
  }

  /**
   * The helper keeps the host alive while someone waits for it: until it is
   * ready, while it runs commands (as their child processes would) and while
   * it stops. An idle helper does not; it exits when the host goes away.
   */
  private updateRefs(helper: HelperProcess): void {
    if (helper.gone) return;
    const waitedFor = helper.servingSince === undefined || helper.pendingCommands > 0 || !!helper.stopWait || this.stateValue === 'stopping';
    if (waitedFor) {
      helper.child.ref();
      helper.child.channel?.ref();
    } else {
      helper.child.unref();
      helper.child.channel?.unref();
    }
  }

  /** Expects the result within `delayMs`; an earlier deadline stays. */
  private armDeadline(id: number, entry: PendingCommand, delayMs: number): void {
    const deadline = Date.now() + delayMs;
    if (entry.deadline !== undefined && entry.deadline <= deadline) return;
    if (entry.deadlineTimer) clearTimeout(entry.deadlineTimer);
    entry.deadline = deadline;
    entry.deadlineTimer = setTimeout(() => this.handleUnresponsive(id), delayMs);
    entry.deadlineTimer.unref();
  }

  /** A result is overdue: reject that command and replace the helper. */
  private handleUnresponsive(id: number): void {
    const entry = this.forget(id);
    if (!entry) return;
    const waitedMs = Date.now() - entry.sentAt;
    entry.reject(Object.assign(
      new Error(`${entry.command} did not finish: the command helper did not answer within ${waitedMs} ms. The command was not re-run.`),
      { code: COMMAND_HELPER_UNRESPONSIVE },
    ));
    const helper = entry.helper;
    if (this.stopRequested) return;
    this.terminate(helper, `did not answer ${entry.command} within ${waitedMs} ms`);
  }

  /**
   * Replaces a helper that stopped answering: no new commands, SIGTERM, then
   * SIGKILL after `terminateGraceMs`. Its exit runs the crash path: the other
   * pending commands are rejected and the restart backoff begins.
   */
  private terminate(helper: HelperProcess, reason: string): void {
    if (helper.terminating || helper.processExited) return;
    helper.terminating = true;
    if (helper === this.current && (this.stateValue === 'running' || this.stateValue === 'starting')) this.setState('draining');
    const pid = helper.child.pid ?? 'none';
    const orphans = helper.supervised
      ? ''
      : ' There is no scope supervisor, so commands still running in it may be orphaned.';
    this.log('error', `[command-helper] pid=${pid} ${reason}; stopping it (SIGTERM, SIGKILL after ${this.terminateGraceMs} ms).${orphans}`);
    helper.child.kill('SIGTERM');
    helper.killTimer = setTimeout(() => {
      if (helper.processExited) return;
      this.log('error', `[command-helper] pid=${pid} did not exit after SIGTERM; killing it`);
      helper.child.kill('SIGKILL');
    }, this.terminateGraceMs);
    helper.killTimer.unref();
  }

  private rejectUndelivered(id: number, error: Error): void {
    const entry = this.forget(id);
    entry?.reject(Object.assign(
      new Error(`${entry.command} was not started: the command helper is unavailable (${error.message})`),
      { code: COMMAND_HELPER_EXITED },
    ));
  }

  private send(helper: HelperProcess, message: ServerToHelperMessage): boolean {
    if (helper.gone || !helper.child.connected) return false;
    try {
      helper.child.send(message, () => undefined);
      return true;
    } catch {
      return false;
    }
  }

  /** The helper can no longer answer: reject what it still owed, then restart or give up. */
  private handleGone(helper: HelperProcess, reason: string): void {
    if (helper.gone) return;
    helper.gone = true;
    let rejected = 0;
    for (const [id, entry] of [...this.pending]) {
      if (entry.helper !== helper) continue;
      this.forget(id);
      rejected += 1;
      entry.reject(Object.assign(
        new Error(`${entry.command} did not finish: the command helper ${reason}. The command was not re-run.`),
        { code: COMMAND_HELPER_EXITED },
      ));
    }
    if (helper.readyTimer) clearTimeout(helper.readyTimer);
    if (helper === this.candidate) {
      this.candidate = undefined;
      this.lastRecycleAt = performance.now();
      if (!this.stopRequested && !helper.abandoned) this.log('warn', `[command-helper] replacement pid=${helper.child.pid ?? 'none'} ${reason} before the switch`);
      // A disconnected candidate never received a command.
      if (!helper.processExited) helper.child.kill('SIGKILL');
      return;
    }
    if (helper !== this.current) {
      if (helper.retiring && rejected && !this.stopRequested) {
        this.log('warn', `[command-helper] draining pid=${helper.child.pid} ${reason}; rejected ${rejected} pending request(s)`);
      }
      return;
    }
    if (this.candidate) {
      this.candidate.abandoned = true;
      this.candidate.child.kill('SIGKILL');
    }
    if (this.stateValue === 'stopping' || this.stateValue === 'stopped') return;
    const uptime = helper.servingSince === undefined ? 0 : Date.now() - helper.servingSince;
    if (uptime >= this.stableUptimeMs) this.consecutiveFailures = 0;
    const detail = rejected ? `; ${rejected} running command(s) were rejected and not re-run` : '';
    this.handleFailure(`pid=${helper.child.pid ?? 'none'} ${reason}${detail}`);
  }

  private handleFailure(reason: string): void {
    if (!applicationAllowsProcessStarts()) {
      // The application is shutting down; its own cleanup no longer needs the helper.
      this.setState('stopped');
      this.log('info', `[command-helper] ${reason}; not restarted during application shutdown`);
      this.firstStart?.resolve(false);
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      this.setState('failed');
      this.log('error', `[command-helper] ${reason}. Stopped restarting after ${this.consecutiveFailures} consecutive failures; commands run in the server process`);
      this.firstStart?.resolve(false);
      return;
    }
    const delay = this.restartDelaysMs[Math.min(this.consecutiveFailures - 1, this.restartDelaysMs.length - 1)]!;
    this.setState('restarting');
    this.log('warn', `[command-helper] ${reason}; commands run in the server process until it restarts in ${delay} ms`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.stateValue !== 'restarting') return;
      this.launch('restart');
    }, delay);
    this.restartTimer.unref();
  }
}

let activeClient: CommandHelperClient | undefined;
let reportedInvalidMode = false;

/** Called with `true` when owned commands start going to the helper, `false` when they stop. */
export type CommandHelperAvailabilityListener = (running: boolean, status: CommandHelperStatus) => void;

const placementListeners = new Set<CommandHelperAvailabilityListener>();
let publishedPid: number | undefined;

function publishPlacement(): void {
  const running = activeClient?.accepting === true;
  const status = getCommandHelperStatus();
  const pid = running ? status.pid : undefined;
  if (pid === publishedPid) return;
  publishedPid = pid;
  for (const listener of [...placementListeners]) {
    try { listener(running, status); }
    catch (error) { console.error('[command-helper] placement listener failed', error); }
  }
}

export interface StartCommandHelperOptions extends CommandHelperClientOptions {
  /** Overrides `AGENT_TOWER_COMMAND_HELPER`. */
  mode?: CommandHelperMode;
  platform?: NodeJS.Platform;
}

/**
 * Starts the command helper when the switch enables it. Never throws.
 * Resolves true once commands go to the helper, false when it is disabled or
 * could not be started (commands then run in the calling process).
 */
export function startCommandHelper(options: StartCommandHelperOptions = {}): Promise<boolean> {
  if (activeClient && !activeClient.finished) return activeClient.start();
  let mode = options.mode;
  if (!mode) {
    const parsed = parseCommandHelperMode(process.env[COMMAND_HELPER_ENV]);
    if (!parsed.valid && !reportedInvalidMode) {
      reportedInvalidMode = true;
      (options.log ?? defaultLog)('warn', `[command-helper] ignoring ${COMMAND_HELPER_ENV}=${process.env[COMMAND_HELPER_ENV]}; expected auto, on or off`);
    }
    mode = parsed.mode;
  }
  if (!isCommandHelperEnabled(mode, options.platform)) return Promise.resolve(false);
  activeClient = new CommandHelperClient(options);
  const started = activeClient.start();
  publishPlacement();
  return started;
}

/** Stops the helper and its running commands; part of the application shutdown. */
export function stopCommandHelper(): Promise<void> {
  return activeClient?.stop() ?? Promise.resolve();
}

/** The helper when it currently accepts commands; null means "run in this process". */
export function getRunningCommandHelper(): CommandHelperClient | null {
  return activeClient?.accepting ? activeClient : null;
}

/** True while owned commands go to the helper; false means they run in the calling process. */
export function isCommandHelperRunning(): boolean {
  return getRunningCommandHelper() !== null;
}

/**
 * Notifies when owned commands start or stop going to the helper: it became
 * ready, closed, crashed, restarted, gave up or was stopped. Listeners run
 * synchronously after the change. Returns the unsubscribe function.
 */
export function onCommandHelperAvailabilityChange(listener: CommandHelperAvailabilityListener): () => void {
  let previous = isCommandHelperRunning();
  return onCommandHelperPlacementChange((running, status) => {
    if (previous === running) return;
    previous = running;
    listener(running, status);
  });
}

/** Also reports a ready-to-ready switch to a different helper process. */
export function onCommandHelperPlacementChange(listener: CommandHelperAvailabilityListener): () => void {
  placementListeners.add(listener);
  return () => { placementListeners.delete(listener); };
}

export function getCommandHelperStatus(): CommandHelperStatus {
  return activeClient?.status() ?? { state: 'off', pendingCommands: 0 };
}
