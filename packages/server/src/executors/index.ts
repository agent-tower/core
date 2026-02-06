/**
 * Executors 模块导出
 */

import { AgentType } from '../types/index.js';
import { BaseExecutor, AvailabilityInfo } from './base.executor.js';
import { ClaudeCodeExecutor } from './claude-code.executor.js';
import { GeminiCliExecutor } from './gemini-cli.executor.js';
import { CursorAgentExecutor } from './cursor-agent.executor.js';

// 执行器注册表
const executors = new Map<AgentType, BaseExecutor>();

// 注册默认执行器
executors.set(AgentType.CLAUDE_CODE, new ClaudeCodeExecutor());
executors.set(AgentType.GEMINI_CLI, new GeminiCliExecutor());
executors.set(AgentType.CURSOR_AGENT, new CursorAgentExecutor());

/**
 * 获取指定类型的执行器
 */
export function getExecutor(agentType: AgentType): BaseExecutor | undefined {
  return executors.get(agentType);
}

/**
 * 获取所有执行器
 */
export function getAllExecutors(): BaseExecutor[] {
  return Array.from(executors.values());
}

/**
 * 获取可用的执行器列表
 */
export async function getAvailableExecutors(): Promise<BaseExecutor[]> {
  const available: BaseExecutor[] = [];

  for (const executor of executors.values()) {
    const availability = await executor.getAvailabilityInfo();
    if (availability.type !== 'NOT_FOUND') {
      available.push(executor);
    }
  }

  return available;
}

/**
 * 获取所有执行器的可用性信息
 */
export async function getAllExecutorsAvailability(): Promise<
  Array<{
    agentType: AgentType;
    displayName: string;
    availability: AvailabilityInfo;
  }>
> {
  const results = [];

  for (const executor of executors.values()) {
    const availability = await executor.getAvailabilityInfo();
    results.push({
      agentType: executor.agentType,
      displayName: executor.displayName,
      availability,
    });
  }

  return results;
}

// 导出类
export { BaseExecutor, CancellationToken } from './base.executor.js';
export { ClaudeCodeExecutor, PermissionMode } from './claude-code.executor.js';
export { GeminiCliExecutor } from './gemini-cli.executor.js';
export { CursorAgentExecutor } from './cursor-agent.executor.js';
export { CommandBuilder } from './command-builder.js';
export { ExecutionEnv } from './execution-env.js';

// 导出类型
export type { AvailabilityInfo, SpawnedChild, ExecutorSpawnConfig, AgentCapability } from './base.executor.js';
export type { ClaudeCodeConfig } from './claude-code.executor.js';
export type { GeminiCliConfig } from './gemini-cli.executor.js';
export type { CursorAgentConfig } from './cursor-agent.executor.js';
export type { CmdOverrides, CommandParts } from './command-builder.js';
export type { RepoContext } from './execution-env.js';
