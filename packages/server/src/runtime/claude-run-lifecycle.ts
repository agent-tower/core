/**
 * Run lifecycle supervision for Claude Code print-mode processes.
 *
 * Claude Code 2.1.x treats a top-level `result` as the end of a *turn*, not of
 * the run: after `result` the process may stay alive to wait for background
 * work it started (background Bash commands, background subagents, Monitor),
 * then take further turns on its own, each ending with another `result`. The
 * run ends when the process exits. Agent Tower therefore never reclaims a
 * Claude process because of a `result`; it reclaims it on process exit, on an
 * explicit stop, on a superseding follow-up, or through the two safety nets
 * implemented here:
 *
 * - idle exit grace: after a result, when the CLI reports no pending
 *   background work and no new turn starts, the process is expected to exit
 *   within seconds. A process that lingers past the grace is treated as hung.
 * - wait ceiling: the longest time a run may stay alive after its first result
 *   while waiting for background work. The same value is exported to the CLI as
 *   `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` so both sides agree.
 */
import type { RuntimeBackgroundTask } from '@agent-tower/shared';

export const CLAUDE_BACKGROUND_WAIT_CEILING_ENV = 'AGENT_TOWER_CLAUDE_BACKGROUND_WAIT_MS';
export const CLAUDE_CLI_BACKGROUND_WAIT_CEILING_ENV = 'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS';
export const DEFAULT_CLAUDE_BACKGROUND_WAIT_CEILING_MS = 2 * 60 * 60_000;
export const DEFAULT_CLAUDE_IDLE_EXIT_GRACE_MS = 30_000;
export const CLAUDE_IDLE_EXIT_GRACE_ENV = 'AGENT_TOWER_CLAUDE_IDLE_EXIT_GRACE_MS';

/** How long a Claude process may linger after a result with nothing pending before it is treated as hung. */
export function resolveClaudeIdleExitGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[CLAUDE_IDLE_EXIT_GRACE_ENV]?.trim();
  if (raw === undefined || raw === '') return DEFAULT_CLAUDE_IDLE_EXIT_GRACE_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_CLAUDE_IDLE_EXIT_GRACE_MS;
  return Math.floor(value);
}

/** Resolve the configured wait ceiling; `0` means unlimited. */
export function resolveClaudeBackgroundWaitCeilingMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[CLAUDE_BACKGROUND_WAIT_CEILING_ENV]?.trim();
  if (raw === undefined || raw === '') return DEFAULT_CLAUDE_BACKGROUND_WAIT_CEILING_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_CLAUDE_BACKGROUND_WAIT_CEILING_MS;
  return Math.floor(value);
}

export type ClaudeRunStopReason = 'idle_exit_timeout' | 'background_wait_ceiling';

export interface ClaudeRunLifecycleOptions {
  /** Stop the process tree; called at most once. */
  stop(reason: ClaudeRunStopReason, detail: string): void;
  /** Publish the pending background work for the session runtime state. */
  publishTasks?(tasks: RuntimeBackgroundTask[]): void;
  idleExitGraceMs?: number;
  waitCeilingMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

/**
 * Tracks one Claude process after it was spawned. Feed it the parser's turn
 * and background-task events; it decides when the process is hung.
 */
export class ClaudeRunLifecycle {
  private phase: 'turn' | 'idle' = 'turn';
  private tasks: RuntimeBackgroundTask[] = [];
  private resultCount = 0;
  private firstResultAt?: number;
  private graceTimer?: ReturnType<typeof setTimeout>;
  private ceilingTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private exited = false;
  private readonly idleExitGraceMs: number;
  private readonly waitCeilingMs: number;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<ClaudeRunLifecycleOptions['setTimer']>;
  private readonly clearTimer: NonNullable<ClaudeRunLifecycleOptions['clearTimer']>;

  constructor(private readonly options: ClaudeRunLifecycleOptions) {
    this.idleExitGraceMs = options.idleExitGraceMs ?? resolveClaudeIdleExitGraceMs();
    this.waitCeilingMs = options.waitCeilingMs ?? resolveClaudeBackgroundWaitCeilingMs();
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  get pendingTasks(): RuntimeBackgroundTask[] {
    return this.tasks;
  }

  get isIdle(): boolean {
    return this.phase === 'idle';
  }

  get hasObservedResult(): boolean {
    return this.resultCount > 0;
  }

  /** A new model turn started (system/init or first assistant output after a result). */
  onTurnStarted(): void {
    if (this.exited) return;
    this.phase = 'turn';
    this.clearGrace();
  }

  /** A top-level result ended a turn; the process now either exits or waits. */
  onTurnResult(): void {
    if (this.exited) return;
    this.resultCount += 1;
    this.phase = 'idle';
    if (this.firstResultAt === undefined) {
      this.firstResultAt = this.now();
      this.armCeiling();
    }
    this.reconcileGrace();
  }

  onTasksChanged(tasks: RuntimeBackgroundTask[]): void {
    if (this.exited) return;
    this.tasks = tasks;
    this.options.publishTasks?.(tasks);
    this.reconcileGrace();
  }

  onExit(): void {
    this.exited = true;
    this.dispose();
    if (this.tasks.length > 0) {
      this.tasks = [];
      this.options.publishTasks?.([]);
    }
  }

  dispose(): void {
    this.clearGrace();
    if (this.ceilingTimer) {
      this.clearTimer(this.ceilingTimer);
      this.ceilingTimer = undefined;
    }
  }

  private reconcileGrace(): void {
    if (this.phase !== 'idle') {
      this.clearGrace();
      return;
    }
    if (this.tasks.length > 0) {
      this.clearGrace();
      return;
    }
    if (this.graceTimer) return;
    this.graceTimer = this.setTimer(() => {
      this.graceTimer = undefined;
      if (this.exited || this.phase !== 'idle' || this.tasks.length > 0) return;
      this.requestStop(
        'idle_exit_timeout',
        `Claude process did not exit within ${Math.round(this.idleExitGraceMs / 1000)}s after its final result with no pending background work`,
      );
    }, this.idleExitGraceMs);
    this.graceTimer.unref?.();
  }

  private armCeiling(): void {
    if (this.waitCeilingMs <= 0 || this.ceilingTimer) return;
    this.ceilingTimer = this.setTimer(() => {
      this.ceilingTimer = undefined;
      if (this.exited) return;
      this.requestStop(
        'background_wait_ceiling',
        `Claude process was still waiting for background work ${Math.round(this.waitCeilingMs / 60_000)} minutes after its first result`,
      );
    }, this.waitCeilingMs);
    this.ceilingTimer.unref?.();
  }

  private clearGrace(): void {
    if (!this.graceTimer) return;
    this.clearTimer(this.graceTimer);
    this.graceTimer = undefined;
  }

  private requestStop(reason: ClaudeRunStopReason, detail: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.dispose();
    this.options.stop(reason, detail);
  }
}
