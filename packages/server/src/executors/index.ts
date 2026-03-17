/**
 * Executors 模块导出
 *
 * 改造: 不再使用全局单例 Map，而是从 profiles 读取配置动态构造 executor 实例
 */

import { AgentType } from '../types/index.js';
import { BaseExecutor, AvailabilityInfo } from './base.executor.js';
import { ClaudeCodeExecutor, type ClaudeCodeConfig } from './claude-code.executor.js';
import { GeminiCliExecutor, type GeminiCliConfig } from './gemini-cli.executor.js';
import { CursorAgentExecutor, type CursorAgentConfig } from './cursor-agent.executor.js';
import { CodexExecutor, type CodexConfig } from './codex.executor.js';
import { getVariantConfig, type VariantConfig } from './profiles.js';
import { getProviderById, getDefaultProvider, getAllProviders, type Provider } from './providers.js';

// ─── Executor Factory ────────────────────────────────────────────

/**
 * 根据 agent 类型和 variant 配置创建 executor 实例
 */
function createExecutor(agentType: AgentType, config: VariantConfig = {}): BaseExecutor {
  switch (agentType) {
    case AgentType.CLAUDE_CODE:
      return new ClaudeCodeExecutor(config as ClaudeCodeConfig);
    case AgentType.GEMINI_CLI:
      return new GeminiCliExecutor(config as GeminiCliConfig);
    case AgentType.CURSOR_AGENT:
      return new CursorAgentExecutor(config as CursorAgentConfig);
    case AgentType.CODEX:
      return new CodexExecutor(config as CodexConfig);
    default:
      throw new Error(`Unknown agent type: ${agentType}`);
  }
}

/**
 * 获取指定类型的执行器（支持 variant）
 *
 * @param agentType - agent 类型
 * @param variant - 配置变体名称，默认 'DEFAULT'
 */
export function getExecutor(agentType: AgentType, variant: string = 'DEFAULT'): BaseExecutor | undefined {
  const config = getVariantConfig(agentType, variant);
  if (!config) {
    // variant 不存在时 fallback 到 DEFAULT
    const defaultConfig = getVariantConfig(agentType, 'DEFAULT');
    if (!defaultConfig) return undefined;
    return createExecutor(agentType, defaultConfig);
  }
  return createExecutor(agentType, config);
}

/**
 * 根据 provider ID 创建 executor
 * provider 的 env 会通过 CmdOverrides.env 注入，config 作为 executor 配置
 */
export function getExecutorByProvider(providerId: string): BaseExecutor | undefined {
  const provider = getProviderById(providerId);
  if (!provider) return undefined;
  return createExecutorFromProvider(provider);
}

/**
 * 根据 agentType 找默认 provider 创建 executor
 */
export function getExecutorByAgentType(agentType: AgentType): BaseExecutor | undefined {
  const provider = getDefaultProvider(agentType);
  if (!provider) return undefined;
  return createExecutorFromProvider(provider);
}

/**
 * 从 Provider 创建 executor 实例
 */
function createExecutorFromProvider(provider: Provider): BaseExecutor {
  const agentType = provider.agentType as AgentType;
  const config: VariantConfig = {
    ...provider.config,
    // 将 provider.env 注入到 cmd.env，这样会在 spawnInternal 时通过 withProfile 合并到环境变量
    cmd: {
      env: provider.env,
    },
  };
  return createExecutor(agentType, config);
}

/**
 * 获取所有已注册的 agent 类型
 */
export function getAllAgentTypes(): AgentType[] {
  return Object.values(AgentType);
}

/**
 * 获取所有执行器（每种 agent 的 DEFAULT variant）
 */
export function getAllExecutors(): BaseExecutor[] {
  return getAllAgentTypes()
    .map(type => getExecutor(type))
    .filter((e): e is BaseExecutor => e !== undefined);
}

/**
 * 获取可用的执行器列表
 */
export async function getAvailableExecutors(): Promise<BaseExecutor[]> {
  const available: BaseExecutor[] = [];

  for (const executor of getAllExecutors()) {
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

  for (const executor of getAllExecutors()) {
    const availability = await executor.getAvailabilityInfo();
    results.push({
      agentType: executor.agentType,
      displayName: executor.displayName,
      availability,
    });
  }

  return results;
}

/**
 * 获取所有 providers 的可用性信息（用于前端选择 provider）
 */
export async function getAllProvidersAvailability(): Promise<
  Array<{
    provider: Provider;
    availability: AvailabilityInfo;
  }>
> {
  const providers = getAllProviders();
  const results = [];

  // 缓存每种 agentType 的可用性结果，避免重复检查
  const availabilityCache = new Map<string, AvailabilityInfo>();

  for (const provider of providers) {
    const agentType = provider.agentType as AgentType;
    let availability = availabilityCache.get(agentType);

    if (!availability) {
      const executor = createExecutorFromProvider(provider);
      availability = await executor.getAvailabilityInfo();
      availabilityCache.set(agentType, availability);
    }

    results.push({ provider, availability });
  }

  return results;
}

// 导出类
export { BaseExecutor, CancellationToken } from './base.executor.js';
export { ClaudeCodeExecutor, PermissionMode } from './claude-code.executor.js';
export { GeminiCliExecutor } from './gemini-cli.executor.js';
export { CursorAgentExecutor } from './cursor-agent.executor.js';
export { CodexExecutor } from './codex.executor.js';
export { CommandBuilder } from './command-builder.js';
export { ExecutionEnv } from './execution-env.js';

// 导出 profiles (deprecated — 保留向后兼容)
export {
  getProfiles,
  loadProfiles,
  reloadProfiles,
  getVariantConfig,
  getVariantNames,
  setVariantConfig,
  deleteVariantConfig,
  getDefaultProfiles,
} from './profiles.js';

// 导出 providers
export {
  getAllProviders,
  getProviderById,
  getProvidersByAgentType,
  getDefaultProvider,
  createProvider,
  updateProvider,
  deleteProvider,
  loadProviders,
  reloadProviders,
  getDefaultProviders,
} from './providers.js';

// 导出类型
export type { AvailabilityInfo, SpawnedChild, ExecutorSpawnConfig, AgentCapability } from './base.executor.js';
export type { ClaudeCodeConfig } from './claude-code.executor.js';
export type { GeminiCliConfig } from './gemini-cli.executor.js';
export type { CursorAgentConfig } from './cursor-agent.executor.js';
export type { CodexConfig } from './codex.executor.js';
export type { CmdOverrides, CommandParts } from './command-builder.js';
export type { RepoContext } from './execution-env.js';
export type { ExecutorProfiles, VariantConfig, AgentVariants } from './profiles.js';
export type { Provider, ProvidersData } from './providers.js';
