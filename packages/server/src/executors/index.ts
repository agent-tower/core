import { AgentType } from '../types/index.js';
import { BaseExecutor } from './base.executor.js';
import { ClaudeCodeExecutor } from './claude-code.executor.js';
import { GeminiCliExecutor } from './gemini-cli.executor.js';

const executors = new Map<AgentType, BaseExecutor>();

executors.set(AgentType.CLAUDE_CODE, new ClaudeCodeExecutor());
executors.set(AgentType.GEMINI_CLI, new GeminiCliExecutor());

export function getExecutor(agentType: AgentType): BaseExecutor | undefined {
  return executors.get(agentType);
}

export function getAllExecutors(): BaseExecutor[] {
  return Array.from(executors.values());
}

export async function getAvailableExecutors(): Promise<BaseExecutor[]> {
  const available: BaseExecutor[] = [];

  for (const executor of executors.values()) {
    const availability = await executor.checkAvailability();
    if (availability.available) {
      available.push(executor);
    }
  }

  return available;
}

export { BaseExecutor } from './base.executor.js';
export { ClaudeCodeExecutor } from './claude-code.executor.js';
export { GeminiCliExecutor } from './gemini-cli.executor.js';
