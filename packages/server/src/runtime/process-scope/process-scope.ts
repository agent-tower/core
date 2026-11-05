import os from 'node:os';
import type { CommandInvocation } from '../../utils/process-launch.js';
import { resolveScopeHelper, type ScopeHelper } from './scope-helper.js';

/**
 * A process scope is one command plus everything it starts, supervised by the
 * `agent-tower-scope` helper (a child subreaper). The supervisor keeps the
 * members attached to the scope regardless of setsid, environment changes, or
 * parent exits, forwards stop requests, escalates after the grace period, and
 * exits only when the scope is empty. Its exit is therefore the only
 * "scope empty" signal the server needs; no process-table sampling is involved.
 */

export type ScopeStopSignal = 'SIGHUP' | 'SIGTERM' | 'SIGINT';

/** Makes the supervisor escalate to SIGKILL immediately. Never SIGKILL the supervisor itself. */
export const SCOPE_FORCE_SIGNAL: NodeJS.Signals = 'SIGUSR1';

export interface ScopePolicy {
  /** Shown in `ps` for diagnostics; never used for ownership. */
  id: string;
  /** Delay between the graceful signal and SIGKILL, enforced by the supervisor. */
  graceMs: number;
  /** Signal forwarded to the remaining members once the command itself exits. */
  rootExitSignal: ScopeStopSignal | 'none';
  /** Stop the scope when the launching process dies, even by SIGKILL (PR_SET_PDEATHSIG). */
  stopOnParentDeath: boolean;
  /** Child fd that receives `root-exit <code> <signal>` and `empty` status lines. */
  statusFd?: number;
}

export type ScopeStatus =
  | { type: 'root-exit'; code: number | null; signal: NodeJS.Signals | null }
  | { type: 'empty' };

export interface ProcessScopeRuntime {
  readonly helper: ScopeHelper;
  /** Wraps a command so that it starts inside a supervised scope. */
  buildInvocation(policy: ScopePolicy, command: string, args: readonly string[]): CommandInvocation;
  /** Forwards a stop request to the supervisor. Returns false when it has already exited. */
  requestStop(pid: number, signal?: ScopeStopSignal): boolean;
  /** Asks the supervisor to escalate to SIGKILL now. Returns false when it has already exited. */
  forceStop(pid: number): boolean;
}

export function createProcessScopeRuntime(helper: ScopeHelper): ProcessScopeRuntime {
  return {
    helper,
    buildInvocation(policy, command, args) {
      const helperArgs = [
        '--id', policy.id,
        '--grace', String(Math.max(0, Math.round(policy.graceMs))),
        '--root-exit-signal', policy.rootExitSignal,
      ];
      if (policy.stopOnParentDeath) helperArgs.push('--pdeathsig');
      if (policy.statusFd !== undefined) helperArgs.push('--status-fd', String(policy.statusFd));
      return { command: helper.path, args: [...helperArgs, '--', command, ...args] };
    },
    requestStop(pid, signal = 'SIGTERM') {
      return signalSupervisor(pid, signal);
    },
    forceStop(pid) {
      return signalSupervisor(pid, SCOPE_FORCE_SIGNAL);
    },
  };
}

function signalSupervisor(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

let defaultRuntime: { helperPath: string; runtime: ProcessScopeRuntime } | undefined;

/** The host's supervisor-backed runtime, or null when scopes must use the compatibility backend. */
export function getDefaultProcessScopeRuntime(platform: NodeJS.Platform = process.platform): ProcessScopeRuntime | null {
  const helper = resolveScopeHelper(platform);
  if (!helper) return null;
  if (defaultRuntime?.helperPath !== helper.path) {
    defaultRuntime = { helperPath: helper.path, runtime: createProcessScopeRuntime(helper) };
  }
  return defaultRuntime.runtime;
}

const signalNames = new Map<number, NodeJS.Signals>(
  Object.entries(os.constants.signals).map(([name, value]) => [value, name as NodeJS.Signals]),
);

export function parseScopeStatusLine(line: string): ScopeStatus | null {
  const parts = line.trim().split(/\s+/);
  if (parts[0] === 'empty' && parts.length === 1) return { type: 'empty' };
  if (parts[0] === 'root-exit' && parts.length === 3) {
    const code = Number(parts[1]);
    const signalNumber = Number(parts[2]);
    if (!Number.isInteger(code) || !Number.isInteger(signalNumber)) return null;
    return {
      type: 'root-exit',
      code: code >= 0 ? code : null,
      signal: signalNumber > 0 ? signalNames.get(signalNumber) ?? null : null,
    };
  }
  return null;
}
