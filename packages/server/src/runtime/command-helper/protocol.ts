/**
 * Messages between the server and the command helper process. The channel is
 * Node IPC with `serialization: 'advanced'`, so strings and `undefined`
 * values cross it unchanged. Errors do not: structured clone keeps only the
 * message, so their own properties travel explicitly.
 */
import type {
  GitDiffRequest, GitDiffResult, GitStateCounters, GitStateRequest, GitStateResult, GitStateSnapshot, GitStateTrigger,
} from '../../git/state/git-state-types.js';

/** Process title of the helper, visible in `ps`. */
export const COMMAND_HELPER_PROCESS_TITLE = 'agent-tower-command-helper';

/**
 * Rejection code for a command whose helper went away before it answered.
 * The command may have been stopped part-way and is never re-run.
 */
export const COMMAND_HELPER_EXITED = 'ERR_COMMAND_HELPER_EXITED';

/**
 * Rejection code for a command whose result did not arrive within its
 * deadline (its timeout plus the stop grace). The helper is then replaced;
 * the command is never re-run.
 */
export const COMMAND_HELPER_UNRESPONSIVE = 'ERR_COMMAND_HELPER_UNRESPONSIVE';

export interface RunCommandRequest {
  type: 'run';
  id: number;
  command: string;
  args: string[];
  /** The caller's working directory, already resolved in the server. */
  cwd: string | undefined;
  /** The caller's effective environment (`options.env ?? process.env`). */
  env: Record<string, string>;
  timeout: number;
  maxBuffer: number | undefined;
}

/**
 * Asks the helper's git state service (git/state/git-state-service.ts) for a
 * worktree's state. Its request ids share the counter of `run`.
 */
export interface GitStateRequestMessage {
  type: 'git-state';
  id: number;
  /** Carries the caller's effective environment, like `run`. */
  request: GitStateRequest;
}

/**
 * Asks the helper's git state service for one file's diff
 * (git/state/git-file-diff.ts). `cancel` with the same id stops it when no
 * other request waits for the same diff.
 */
export interface GitDiffRequestMessage {
  type: 'git-diff';
  id: number;
  /** Carries the caller's effective environment, like `run`. */
  request: GitDiffRequest;
}

/** Registers a viewed worktree and answers with its current state. */
export interface RegisterGitStateRequestMessage {
  type: 'git-state-register';
  id: number;
  request: GitStateRequest;
}

export interface UnregisterGitStateMessage {
  type: 'git-state-unregister';
  worktreePath: string;
}

export interface InvalidateGitStateMessage {
  type: 'git-state-invalidate';
  worktreePath: string;
  trigger: GitStateTrigger;
}

/** Cancels a `run`, `git-state` or `git-diff` request with this id. */
export interface CancelCommandRequest {
  type: 'cancel';
  id: number;
}

/** Stop every running command through the owner stop rules, report the results, then exit. */
export interface ShutdownHelperRequest {
  type: 'shutdown';
}

export type ServerToHelperMessage = RunCommandRequest | GitStateRequestMessage | RegisterGitStateRequestMessage | GitDiffRequestMessage
  | { type: 'git-state-retire' } | UnregisterGitStateMessage | InvalidateGitStateMessage | CancelCommandRequest | ShutdownHelperRequest;

export interface HelperReadyMessage {
  type: 'ready';
  pid: number;
  rssBytes: number;
  /**
   * Commands run under the scope supervisor, which stops their trees when the
   * helper dies; without it, killing the helper can orphan them.
   */
  supervisedScopes: boolean;
}

export interface HelperStatsMessage {
  type: 'stats';
  rssBytes: number;
  running: number;
}

/** The helper stops accepting commands; results of running ones still follow. */
export interface HelperClosingMessage {
  type: 'closing';
  reason: string;
}

export interface CommandSucceededMessage {
  type: 'result';
  id: number;
  ok: true;
  stdout: string;
  stderr: string;
}

export interface CommandFailedMessage {
  type: 'result';
  id: number;
  ok: false;
  error: SerializedCommandError;
}

export interface GitStateSucceededMessage {
  type: 'git-state-result';
  id: number;
  ok: true;
  result: GitStateResult;
}

export interface GitStateFailedMessage {
  type: 'git-state-result';
  id: number;
  ok: false;
  /** `ERR_COMMAND_HELPER_EXITED` when the helper is shutting down: the request can be asked elsewhere. */
  error: SerializedCommandError;
}

export interface GitDiffSucceededMessage {
  type: 'git-diff-result';
  id: number;
  ok: true;
  result: GitDiffResult;
}

export interface GitDiffFailedMessage {
  type: 'git-diff-result';
  id: number;
  ok: false;
  /** `ERR_COMMAND_HELPER_EXITED` when the helper is shutting down: the request can be asked elsewhere. */
  error: SerializedCommandError;
}

/** Unsolicited: a registered worktree produced different content. */
export interface GitStateChangedMessage {
  type: 'git-state-changed';
  snapshot: GitStateSnapshot;
  counters: GitStateCounters;
}

/** Includes unchanged background computations, which have no state push. */
export interface GitStateActivityMessage {
  type: 'git-state-activity';
  epoch: string;
  counters: GitStateCounters;
  registeredWorktrees: number;
  rssBytes: number;
}

export type HelperToServerMessage =
  | HelperReadyMessage
  | HelperStatsMessage
  | HelperClosingMessage
  | CommandSucceededMessage
  | CommandFailedMessage
  | GitStateSucceededMessage
  | GitStateFailedMessage
  | GitDiffSucceededMessage
  | GitDiffFailedMessage
  | GitStateChangedMessage
  | GitStateActivityMessage;

export interface SerializedCommandError {
  name: string;
  message: string;
  /** Own enumerable properties: code, signal, stdout, stderr, and errno/syscall/path/spawnargs for spawn errors. */
  properties: Record<string, unknown>;
}

const BUILTIN_ERRORS: Record<string, ErrorConstructor> = {
  Error,
  TypeError,
  RangeError,
  SyntaxError,
  ReferenceError,
  EvalError,
  URIError,
};

function isTransferable(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'bigint') return true;
  return Array.isArray(value) && value.every((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item));
}

export function serializeCommandError(error: unknown): SerializedCommandError {
  if (!(error instanceof Error)) {
    return { name: 'Error', message: String(error), properties: {} };
  }
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(error)) {
    if (isTransferable(value)) properties[key] = value;
  }
  return { name: error.name, message: error.message, properties };
}

/** Rebuilds the error with the same class, message and own properties as in the helper. */
export function deserializeCommandError(serialized: SerializedCommandError): Error {
  const ErrorClass = BUILTIN_ERRORS[serialized.name] ?? Error;
  const error = new ErrorClass(serialized.message);
  if (error.name !== serialized.name) error.name = serialized.name;
  return Object.assign(error, serialized.properties);
}
