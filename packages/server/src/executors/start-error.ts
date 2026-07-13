import { ServiceError } from '../errors.js';
import { CommandBuildError } from './command-builder.js';

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
    return new AgentCommandUnavailableError(error);
  }
  return error;
}
