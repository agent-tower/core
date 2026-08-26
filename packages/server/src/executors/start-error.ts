import { ServiceError } from '../errors.js';
import { CommandBuildError } from './command-builder.js';

const PRE_CHILD_FAILURE = Symbol('agent-tower.pre-child-process-failure');
const SPAWN_CLEANUP_OWNER = Symbol('agent-tower.spawn-cleanup-owner');

type PreChildFailure = Error & { [PRE_CHILD_FAILURE]?: true };

/**
 * Cleanup handoff for a PTY that was created before launch identity could be
 * persisted. The owner must remain reachable until the wrapper emits exit.
 */
export interface SpawnCleanupOwner {
  readonly processExit: Promise<void>;
  requestStop(): void;
  cleanup(): Promise<void>;
  dispose(): void;
  /** Close the launch-scoped completion channel after tree cleanup is confirmed. */
  disposeTreeCleanupChannel?: () => void;
}

type SpawnCleanupError = Error & { [SPAWN_CLEANUP_OWNER]?: SpawnCleanupOwner };

/** Mark only failures that are proven to have happened before child creation. */
export function markPreChildProcessFailure(error: unknown): unknown {
  const marked = error instanceof Error ? error as PreChildFailure : new Error(String(error)) as PreChildFailure;
  try {
    Object.defineProperty(marked, PRE_CHILD_FAILURE, { value: true, configurable: false });
  } catch {
    // A frozen third-party error cannot carry evidence, so keep it conservative.
  }
  return marked;
}

export function isPreChildProcessFailure(error: unknown): boolean {
  return error instanceof Error
    && !(error as SpawnCleanupError)[SPAWN_CLEANUP_OWNER]
    && (error as PreChildFailure)[PRE_CHILD_FAILURE] === true;
}

export function attachSpawnCleanupOwner(error: unknown, owner: SpawnCleanupOwner): unknown {
  const target = error instanceof Error ? error as SpawnCleanupError : new Error(String(error)) as SpawnCleanupError;
  try {
    Object.defineProperty(target, SPAWN_CLEANUP_OWNER, { value: owner, configurable: false });
  } catch {
    // A frozen error cannot carry the handoff; callers remain conservative and
    // quarantine the launch claim instead of assuming no child was created.
  }
  return target;
}

export function getSpawnCleanupOwner(error: unknown): SpawnCleanupOwner | undefined {
  return error instanceof Error ? (error as SpawnCleanupError)[SPAWN_CLEANUP_OWNER] : undefined;
}

export class ExecutorNotFoundError extends ServiceError {
  constructor(agentType: string, providerId?: string | null) {
    super(
      `Executor not found for agent type: ${agentType}${providerId ? ` (provider: ${providerId})` : ''}`,
      'EXECUTOR_NOT_FOUND',
      400,
    );
  }
}

export class ExecutorConfigurationError extends ServiceError {
  constructor(agentType: string, cause: unknown, providerId?: string | null) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Invalid executor configuration for agent type ${agentType}${providerId ? ` (provider: ${providerId})` : ''}: ${detail}`,
      'EXECUTOR_CONFIGURATION_INVALID',
      400,
    );
  }
}

export class AgentCommandUnavailableError extends ServiceError {
  constructor(cause: CommandBuildError) {
    super(cause.message, 'AGENT_COMMAND_UNAVAILABLE', 400);
  }
}

export function normalizeExecutorStartError(error: unknown): unknown {
  if (error instanceof CommandBuildError) {
    return markPreChildProcessFailure(new AgentCommandUnavailableError(error));
  }
  if (error instanceof ExecutorConfigurationError) {
    return markPreChildProcessFailure(error);
  }
  return error;
}
