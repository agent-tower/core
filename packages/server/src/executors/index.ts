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
import {
  getProviderById,
  getDefaultProvider,
  getAllProviders,
  getProviderRuntimeType,
  type Provider,
} from './providers.js';
import { resolveEffectiveProviderConnection } from '../services/provider-effective-connection.service.js';
import { isUserVisibleAgentType, RuntimeType } from '@agent-tower/shared';

// ─── Executor Factory ────────────────────────────────────────────

function normalizeConfig(agentType: AgentType, config: VariantConfig = {}): VariantConfig {
  if (agentType !== AgentType.CODEX) {
    return config;
  }

  const normalized = { ...config };

  // 兼容旧数据：fullAuto 曾表示 workspace-write + on-request
  if (normalized.fullAuto === true) {
    if (typeof normalized.sandbox !== 'string' || !normalized.sandbox) {
      normalized.sandbox = 'workspace-write';
    }
    if (typeof normalized.approvalPolicy !== 'string' || !normalized.approvalPolicy) {
      normalized.approvalPolicy = 'on-request';
    }
  }

  delete normalized.fullAuto;
  return normalized;
}

/**
 * 根据 agent 类型和 variant 配置创建 executor 实例
 */
function createExecutor(agentType: AgentType, config: VariantConfig = {}): BaseExecutor {
  const normalizedConfig = normalizeConfig(agentType, config);

  switch (agentType) {
    case AgentType.CLAUDE_CODE:
      return new ClaudeCodeExecutor(normalizedConfig as ClaudeCodeConfig);
    case AgentType.GEMINI_CLI:
      return new GeminiCliExecutor(normalizedConfig as GeminiCliConfig);
    case AgentType.CURSOR_AGENT:
      return new CursorAgentExecutor(normalizedConfig as CursorAgentConfig);
    case AgentType.CODEX:
      return new CodexExecutor(normalizedConfig as CodexConfig);
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
  const env = { ...provider.env };
  const unsetEnv: string[] = [];
  let connection: CodexConfig['connection'];

  if (agentType === AgentType.CODEX) {
    const effective = resolveEffectiveProviderConnection(provider);
    if (effective.diagnostics.length > 0) {
      throw new Error(effective.diagnostics.map(diagnostic => diagnostic.message).join('; '));
    }
    if (
      effective.providerKind !== 'built-in'
      && effective.providerKind !== 'custom'
      && effective.providerKind !== 'native'
    ) {
      throw new Error('Codex Provider connection could not be resolved');
    }
    if (effective.providerKind === 'built-in') {
      delete env.OPENAI_BASE_URL;
      delete env.OPENAI_API_KEY;
      unsetEnv.push('OPENAI_BASE_URL', 'OPENAI_API_KEY', 'CODEX_API_KEY');
      if (effective.secret) env.CODEX_API_KEY = effective.secret;
    } else if (effective.providerKind === 'custom') {
      delete env.OPENAI_BASE_URL;
      delete env.OPENAI_API_KEY;
      delete env.CODEX_API_KEY;
      unsetEnv.push('OPENAI_BASE_URL', 'OPENAI_API_KEY', 'CODEX_API_KEY');
      if (effective.envKey) {
        unsetEnv.push(effective.envKey);
        if (effective.secret !== undefined) env[effective.envKey] = effective.secret;
      }
    }
    if (effective.providerKind !== 'native') {
      connection = {
        providerKind: effective.providerKind,
        modelProviderId: effective.modelProviderId ?? 'openai',
        baseUrl: effective.baseUrl,
        envKey: effective.envKey,
      };
    }
  }
  const config: VariantConfig = {
    ...provider.config,
    // 将 provider.env 注入到 cmd.env，这样会在 spawnInternal 时通过 withProfile 合并到环境变量
    cmd: {
      env,
      unsetEnv,
    },
    // CLI Driver 投影 Agent 原生配置（如 Claude Code 的 settings.json 覆盖）
    settings: provider.settings,
    ...(connection ? { connection } : {}),
  };
  return createExecutor(agentType, config);
}

export async function smokeTestProviderConfiguration(provider: Provider): Promise<{
  availability: AvailabilityInfo;
}> {
  if (getProviderRuntimeType(provider) === RuntimeType.ACP) {
    return { availability: await getAcpProviderAvailability(provider) };
  }
  const executor = createExecutorFromProvider(provider);
  const availability = await executor.getAvailabilityInfo();
  const commandCapableExecutor = executor as unknown as {
    buildCommandBuilder(): { buildInitial(): { program: string; args: string[] } };
  };
  commandCapableExecutor.buildCommandBuilder().buildInitial();
  return { availability };
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
  const results: Array<{
    agentType: AgentType;
    displayName: string;
    availability: AvailabilityInfo;
  }> = [];

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
  const providers = getAllProviders().filter(provider => isUserVisibleAgentType(provider.agentType));
  const results: Array<{ provider: Provider; availability: AvailabilityInfo }> = [];

  // Runtime dependency checks differ even for the same AgentType.
  const availabilityCache = new Map<string, AvailabilityInfo>();

  for (const provider of providers) {
    const agentType = provider.agentType as AgentType;
    const runtimeType = getProviderRuntimeType(provider);
    const cacheKey = `${agentType}:${runtimeType}`;
    // ACP definitions may resolve Provider-specific absolute executable paths.
    let availability = runtimeType === RuntimeType.CLI
      ? availabilityCache.get(cacheKey)
      : undefined;

    if (!availability) {
      try {
        if (runtimeType === RuntimeType.ACP) {
          availability = await getAcpProviderAvailability(provider);
        } else {
          const executor = createExecutorFromProvider(provider);
          availability = await executor.getAvailabilityInfo();
        }
        if (runtimeType === RuntimeType.CLI) availabilityCache.set(cacheKey, availability);
      } catch {
        results.push({
          provider,
          availability: { type: 'NOT_FOUND', error: 'Provider configuration is invalid' },
        });
        continue;
      }
    }

    results.push({ provider, availability });
  }

  return results;
}

async function getAcpProviderAvailability(provider: Provider): Promise<AvailabilityInfo> {
  const { getAcpAgentDefinition } = await import('../runtime/acp/agents/registry.js');
  return getAcpAgentDefinition(provider.agentType as AgentType).checkAvailability(provider);
}

// 导出类
export { BaseExecutor, CancellationToken } from './base.executor.js';
export { ClaudeCodeExecutor, PermissionMode } from './claude-code.executor.js';
export { GeminiCliExecutor } from './gemini-cli.executor.js';
export { CursorAgentExecutor } from './cursor-agent.executor.js';
export { CodexExecutor } from './codex.executor.js';
export { CommandBuilder } from './command-builder.js';
export {
  AgentCommandUnavailableError,
  ExecutorConfigurationError,
  ExecutorNotFoundError,
  isPreChildProcessFailure,
  markPreChildProcessFailure,
  normalizeExecutorStartError,
  attachSpawnCleanupOwner,
  getSpawnCleanupOwner,
} from './start-error.js';
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
  getUserProviders,
  createProviderBackup,
  previewProviderImport,
  importProvidersFromBackup,
  createProvider,
  updateProvider,
  deleteProvider,
  canDeleteProvider,
  loadProviders,
  reloadProviders,
  getDefaultProviders,
  getProviderRuntimeType,
} from './providers.js';

// 导出类型
export type { AvailabilityInfo, SpawnedChild, ExecutorSpawnConfig, AgentCapability } from './base.executor.js';
export type { ClaudeCodeConfig } from './claude-code.executor.js';
export type { GeminiCliConfig } from './gemini-cli.executor.js';
export type { CursorAgentConfig } from './cursor-agent.executor.js';
export type { CodexConfig } from './codex.executor.js';
export type { CmdOverrides, CommandParts } from './command-builder.js';
export type { RepoContext } from './execution-env.js';
export type { SpawnCleanupOwner } from './start-error.js';
export type { ExecutorProfiles, VariantConfig, AgentVariants } from './profiles.js';
export type { Provider, ProvidersData } from './providers.js';
