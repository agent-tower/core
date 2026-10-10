/**
 * CodexExecutor - OpenAI Codex CLI 执行器
 * 参考: https://shipyard.build/blog/codex-cli-cheat-sheet/
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile, execFileSync } from 'child_process';
import { parse as parseToml } from 'smol-toml';
import { ExecutorConfigurationError } from './start-error.js';
import { AgentType } from '../types/index.js';
import { which } from '../utils/index.js';
import { hasCodexBuiltinProviderAliasCollision } from '../utils/codex-provider-config.js';
import type { ExecutionPermissionMode } from '@agent-tower/shared';
import { cachedCodexCliSupport, refreshCodexCliSupport } from '../services/codex-cli-capabilities.service.js';
import type { CodexCliStart } from '../runtime/codex-cli-control.js';
import {
  BaseExecutor,
  AvailabilityInfo,
  AgentCapability,
  ExecutorSpawnConfig,
  SpawnedChild,
} from './base.executor.js';
import { CommandBuilder, applyOverrides, CmdOverrides, type CommandParts } from './command-builder.js';
import { extractImagePaths } from './image-utils.js';
import {
  AGENT_TOWER_MCP_IDENTITY_ENV_KEYS,
  AGENT_TOWER_MCP_SERVICE_ENV_KEYS,
} from './execution-env.js';
import {
  CODEX_OPENAI_COMPATIBLE_PROVIDER_ID,
  CODEX_OPENAI_COMPATIBLE_PROVIDER_NAME,
} from '../services/provider-effective-connection.service.js';

/**
 * 将嵌套对象展平为 dotted path 键值对（递归到标量叶子）
 * { model_providers: { azure: { name: "A", query_params: { "api-version": "v1" } } } }
 * → [
 *     ["model_providers.azure.name", "A"],
 *     ["model_providers.azure.query_params.api-version", "v1"],
 *   ]
 */
function flattenObject(obj: Record<string, unknown>, prefix = ''): [string, unknown][] {
  const entries: [string, unknown][] = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
      entries.push(...flattenObject(value as Record<string, unknown>, fullPath));
    } else {
      entries.push([fullPath, value]);
    }
  }
  return entries;
}

/**
 * 将 JS 值转为 TOML 字面量字符串（用于 -c 参数）
 * 对象转为 TOML inline table: { key = "value", key2 = 123 }
 */
function toTomlLiteral(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    return `[${value.map(v => toTomlLiteral(v)).join(', ')}]`;
  }
  if (value !== null && typeof value === 'object') {
    // TOML inline table: { key = "value", key2 = 123 }
    const pairs = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k} = ${toTomlLiteral(v)}`)
      .join(', ');
    return `{${pairs}}`;
  }
  return String(value);
}

function toTomlPathSegment(value: string): string {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value);
}

export const CODEX_HTTP_ONLY_OPENAI_PROVIDER_ID = 'agent-tower-openai-http';

const AGENT_TOWER_MCP_ENV_KEYS = [
  ...AGENT_TOWER_MCP_IDENTITY_ENV_KEYS,
  ...AGENT_TOWER_MCP_SERVICE_ENV_KEYS,
] as const;

const AGENT_TOWER_MCP_SERVER_NAMES = [
  'agent-tower',
  'agent-tower-dev',
] as const;

function getCodexConfigDir(): string {
  return process.env.CODEX_HOME
    || path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), '.codex');
}

/**
 * 读取 Codex config.toml 中实际声明的 mcp_servers 顶层 key。
 * 文件不存在、读取失败或解析失败时返回空集合（不抛错）。
 */
export function getCodexDeclaredMcpServerNames(configPath?: string): Set<string> {
  const filePath = configPath ?? path.join(getCodexConfigDir(), 'config.toml');
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseToml(content) as Record<string, unknown>;
    const mcpServers = parsed.mcp_servers;
    if (mcpServers && typeof mcpServers === 'object' && !Array.isArray(mcpServers)) {
      return new Set(Object.keys(mcpServers));
    }
  } catch {
    // config 不存在或解析失败 — 静默降级，不阻塞 Codex 启动
  }
  return new Set();
}

const CODEX_MCP_LIST_TIMEOUT_MS = 3000;

const CODEX_MCP_CACHE_RETRY_MS = 30_000;

interface CodexMcpCacheEntry {
  names: Set<string>;
  refreshedAt: number;
  refreshPromise?: Promise<void>;
}

const codexMcpCache = new Map<string, CodexMcpCacheEntry>();

function resolveCodexExecutableForCache(program = 'codex', env: NodeJS.ProcessEnv = process.env): string {
  if (path.isAbsolute(program)) return path.resolve(program);
  const pathValue = env.PATH ?? '';
  const candidates = pathValue.split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : [''];

  for (const dir of candidates) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${program}${extension}`);
      try {
        if (fs.statSync(candidate).isFile()) return path.resolve(candidate);
      } catch {
        // Continue searching. The cache must never block task startup.
      }
    }
  }
  return 'codex';
}

function getConfigFingerprint(configPath: string): string {
  try {
    const stats = fs.statSync(configPath);
    return `${configPath}:${stats.mtimeMs}:${stats.size}`;
  } catch {
    return `${configPath}:missing`;
  }
}

function getCodexConfigPathForEnv(env: NodeJS.ProcessEnv, explicitConfigPath?: string): string {
  if (explicitConfigPath) return path.resolve(explicitConfigPath);
  const codexHome = env.CODEX_HOME
    || path.join(env.HOME || env.USERPROFILE || os.homedir(), '.codex');
  return path.join(codexHome, 'config.toml');
}

/**
 * Keep an executor-provided config path only when it is genuinely explicit.
 * Codex's default path is process-global, so it must be recomputed from the
 * provider's effective env (CODEX_HOME/HOME) for each probe.
 */
function getExplicitMcpConfigPath(configPath: string | null): string | undefined {
  if (!configPath) return undefined;
  const processDefault = path.join(getCodexConfigDir(), 'config.toml');
  return path.resolve(configPath) === path.resolve(processDefault) ? undefined : configPath;
}

function getCodexMcpCacheKey(
  executable: string,
  probeArgs: string[],
  configOverrideArgs: string[],
  fallbackConfigPath?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configPath = getCodexConfigPathForEnv(env, fallbackConfigPath);
  return JSON.stringify({
    executable,
    path: env.PATH ?? '',
    pathext: env.PATHEXT ?? '',
    codexHome: env.CODEX_HOME ?? '',
    home: env.HOME ?? '',
    userProfile: env.USERPROFILE ?? '',
    xdgConfigHome: env.XDG_CONFIG_HOME ?? '',
    config: getConfigFingerprint(configPath),
    probeArgs,
    overrides: configOverrideArgs,
  });
}

function getFallbackMcpServerNames(configOverrideArgs: string[], fallbackConfigPath?: string): Set<string> {
  const names = getCodexDeclaredMcpServerNames(fallbackConfigPath);
  // Settings injected with -c are not visible in config.toml. Preserve those
  // names during the first non-blocking launch while the CLI probe refreshes.
  for (let index = 0; index < configOverrideArgs.length - 1; index += 1) {
    if (configOverrideArgs[index] !== '-c') continue;
    const match = /^mcp_servers\.([^\.]+)\./.exec(configOverrideArgs[index + 1]);
    if (match?.[1]) names.add(match[1]);
  }
  return names;
}

function refreshCodexMcpServerCache(
  key: string,
  executable: string,
  env: NodeJS.ProcessEnv,
  probeArgs: string[],
  configOverrideArgs: string[],
  fallbackConfigPath?: string,
): void {
  const existing = codexMcpCache.get(key);
  if (existing?.refreshPromise) return;

  const entry: CodexMcpCacheEntry = existing ?? {
    names: getFallbackMcpServerNames(configOverrideArgs, fallbackConfigPath),
    refreshedAt: 0,
  };
  codexMcpCache.set(key, entry);

  // A real async child process is required here. Moving execFileSync into a
  // timer still blocks the Node event loop and delays every PTY/Socket stream.
  const refreshPromise = queryCodexMcpServerNamesAsync(executable, env, probeArgs)
    .then((result) => {
      if (result !== null) entry.names = result;
      else if (entry.names.size === 0) entry.names = getFallbackMcpServerNames(configOverrideArgs, fallbackConfigPath);
    })
    .catch(() => {
      // Fail open: retain the last known/fallback names.
    })
    .finally(() => {
      entry.refreshedAt = Date.now();
      if (entry.refreshPromise === refreshPromise) {
        delete entry.refreshPromise;
      }
    });
  entry.refreshPromise = refreshPromise;
}

/**
 * Return MCP names without waiting for `codex mcp list --json`.
 * The probe is process-level, keyed by executable/config inputs, and uses a
 * single-flight background refresh for concurrent sessions.
 */
export function getCachedCodexMcpServerNames(
  configOverrideArgs: string[] = [],
  fallbackConfigPath?: string,
  probeCommand?: CommandParts,
  environment?: NodeJS.ProcessEnv,
): Set<string> {
  const probeArgs = probeCommand
    ? [...probeCommand.args]
    : [...configOverrideArgs];
  const env = { ...(environment ?? process.env) };
  const configPath = getCodexConfigPathForEnv(env, fallbackConfigPath);
  const executable = resolveCodexExecutableForCache(probeCommand?.program, env);
  const key = getCodexMcpCacheKey(executable, probeArgs, configOverrideArgs, configPath, env);
  const existing = codexMcpCache.get(key);
  const now = Date.now();
  if (!existing) {
    const entry: CodexMcpCacheEntry = {
      names: getFallbackMcpServerNames(configOverrideArgs, configPath),
      refreshedAt: 0,
    };
    codexMcpCache.set(key, entry);
    refreshCodexMcpServerCache(key, executable, env, probeArgs, configOverrideArgs, configPath);
    return new Set(entry.names);
  }

  if (!existing.refreshPromise && now - existing.refreshedAt >= CODEX_MCP_CACHE_RETRY_MS) {
    refreshCodexMcpServerCache(key, executable, env, probeArgs, configOverrideArgs, configPath);
  }
  return new Set(existing.names);
}

/** Test-only reset hook; no production caller should need to clear this cache. */
export function resetCodexMcpServerCache(): void {
  codexMcpCache.clear();
}

/** Wait for current refreshes; exported only to make cache behavior deterministic in tests. */
export async function waitForCodexMcpServerCacheRefresh(): Promise<void> {
  const pending = [...codexMcpCache.values()]
    .map((entry) => entry.refreshPromise)
    .filter((promise): promise is Promise<void> => Boolean(promise));
  await Promise.all(pending);
}

function parseCodexMcpServerNames(stdout: string): Set<string> | null {
  try {
    const parsed = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return null;
    for (const item of parsed) {
      if (!item || typeof item !== 'object' || typeof item.name !== 'string') {
        return null;
      }
    }
    return new Set(parsed.map((server: { name: string }) => server.name));
  } catch {
    return null;
  }
}

function queryCodexMcpServerNamesAsync(
  executable: string,
  env: NodeJS.ProcessEnv,
  probeArgs: string[] = [],
): Promise<Set<string> | null> {
  const args = [...probeArgs, 'mcp', 'list', '--json'];
  return new Promise((resolve) => {
    execFile(executable, args, {
      timeout: CODEX_MCP_LIST_TIMEOUT_MS,
      encoding: 'utf-8',
      env,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(parseCodexMcpServerNames(stdout));
    });
  });
}

/**
 * 通过 `codex mcp list --json` 查询 Codex 运行时实际可见的 MCP server 名称。
 * 传入 provider settings 展平后的 `-c` 参数，确保 settings 注入的 MCP 也在列表中。
 * CLI 不存在、超时、exit 非 0、JSON 异常时返回 null 表示需要 fallback。
 */
export function queryCodexMcpServerNames(configOverrideArgs: string[] = []): Set<string> | null {
  try {
    const args = [...configOverrideArgs, 'mcp', 'list', '--json'];
    const stdout = execFileSync('codex', args, {
      timeout: CODEX_MCP_LIST_TIMEOUT_MS,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseCodexMcpServerNames(stdout);
  } catch {
    return null;
  }
}

/**
 * 检测 Codex 已声明的 MCP server 名称。
 * 主路径：`codex mcp list --json`（能反映 config + `-c` 注入的完整 MCP 视图）。
 * Fallback：直接读取 config.toml（CLI 不可用时）。
 */
export function detectDeclaredMcpServers(
  configOverrideArgs: string[] = [],
  fallbackConfigPath?: string,
): Set<string> {
  const cliResult = queryCodexMcpServerNames(configOverrideArgs);
  if (cliResult !== null) return cliResult;
  return getCodexDeclaredMcpServerNames(fallbackConfigPath);
}

export function buildAgentTowerMcpEnvConfigOverrides(
  env: ExecutorSpawnConfig['env'],
  declaredMcpServers: Set<string>,
): string[] {
  const args: string[] = [];

  for (const serverName of AGENT_TOWER_MCP_SERVER_NAMES) {
    if (!declaredMcpServers.has(serverName)) continue;
    for (const key of AGENT_TOWER_MCP_ENV_KEYS) {
      const value = env.get(key);
      if (value) {
        args.push('-c', `mcp_servers.${serverName}.env.${key}=${toTomlLiteral(value)}`);
      }
    }
  }

  return args;
}

/**
 * Codex CLI 配置
 */
export interface CodexConfig {
  executionPermission?: ExecutionPermissionMode;
  /** 追加到 prompt 的文本 */
  appendPrompt?: string;
  /** 模型选择 (gpt-5.3-codex, gpt-5.3-codex-spark, gpt-5.1-codex-max) */
  model?: string;
  /** 跳过所有确认提示并在无沙箱环境下执行命令（危险，仅用于外部已隔离的环境） */
  dangerouslyBypassApprovalsAndSandbox?: boolean;
  /** 使用 Codex Fast service tier；false 显式关闭，undefined 跟随 Codex 配置。 */
  fastMode?: boolean;
  /** 强制适用的 Codex Responses API Provider 使用 HTTP transport。 */
  disableResponsesWebsocket?: boolean;
  /** 启用实时网络搜索 */
  liveSearch?: boolean;
  /** 配置 profile 名称，对应 ~/.codex/config.toml 中的 [profiles.xxx] */
  profile?: string;
  /** CLI 原生配置 (TOML 格式字符串)，通过 -c 参数注入 */
  settings?: string;
  /** 命令覆盖 */
  cmd?: CmdOverrides;
  /** Agent Tower 已解析的当前 model provider 连接；不包含 secret。 */
  connection?: {
    providerKind: 'built-in' | 'custom';
    modelProviderId: string;
    baseUrl?: string;
    envKey?: string;
  };
}

export type CodexPermissionMode = 'full-bypass' | 'noninteractive-workspace';

/**
 * Resolve the permission mode once when an executor is created. Invalid or
 * missing values stay on the safe path; provider validation rejects them at
 * the persistence boundary, while this guard protects direct executor use.
 */
export function getCodexPermissionMode(config: Pick<CodexConfig, 'dangerouslyBypassApprovalsAndSandbox'>): CodexPermissionMode {
  return config.dangerouslyBypassApprovalsAndSandbox === true
    ? 'full-bypass'
    : 'noninteractive-workspace';
}

/**
 * 获取基础命令
 */
function getBaseCommand(): string {
  return 'codex';
}

export class CodexExecutor extends BaseExecutor {
  readonly agentType = AgentType.CODEX;
  readonly displayName = 'Codex';

  private config: CodexConfig;
  private readonly permissionMode: CodexPermissionMode;

  constructor(config: CodexConfig = {}) {
    super();
    this.config = config;
    this.permissionMode = getCodexPermissionMode(config);
    this.cmdOverrides = config.cmd;
  }

  /**
   * 获取可用性信息
   */
  async getAvailabilityInfo(): Promise<AvailabilityInfo> {
    // 检查 codex 命令是否存在
    const codexPath = await which('codex');
    if (!codexPath) {
      return { type: 'NOT_FOUND', error: 'Codex CLI not installed' };
    }

    const codexDir = getCodexConfigDir();
    const configPath = path.join(codexDir, 'config.toml');
    const authPath = path.join(codexDir, 'auth.json');

    // 检查认证文件
    if (fs.existsSync(authPath)) {
      try {
        const stats = fs.statSync(authPath);
        const timestamp = Math.floor(stats.mtimeMs / 1000);
        return {
          type: 'LOGIN_DETECTED',
          lastAuthTimestamp: timestamp,
        };
      } catch {
        return { type: 'INSTALLATION_FOUND' };
      }
    }

    // 仅当 provider 显式依赖 profile 时，才要求本地 config.toml 存在。
    // 其他场景下，Codex 也可能通过 provider 的 settings/env 在运行时注入配置。
    if (this.config.profile && !fs.existsSync(configPath)) {
      return {
        type: 'NOT_FOUND',
        error: 'Codex profile requires ~/.codex/config.toml',
      };
    }

    return { type: 'INSTALLATION_FOUND' };
  }

  /**
   * 获取 Agent 能力
   */
  getCapabilities(): AgentCapability[] {
    return [AgentCapability.SESSION_FORK];
  }

  /**
   * 获取默认 MCP 配置路径
   */
  getDefaultMcpConfigPath(): string | null {
    return path.join(getCodexConfigDir(), 'config.toml');
  }

  /**
   * 构建 TOML 配置覆盖参数（--profile 和 -c）
   */
  private buildConfigOverrides(): string[] {
    const args: string[] = [];

    // --profile
    if (this.config.profile) {
      args.push('--profile', this.config.profile);
    }

    // settings (TOML) → -c 参数
    if (this.config.settings) {
      try {
        const parsed = parseToml(this.config.settings);
        for (const [key, value] of flattenObject(parsed as Record<string, unknown>)) {
          args.push('-c', `${key}=${toTomlLiteral(value)}`);
        }
      } catch (error) {
        throw new ExecutorConfigurationError(this.agentType, error);
      }
    }

    // Provider-level selection wins over user/profile TOML. Codex gates the
    // service tier behind this stable feature flag.
    if (this.config.fastMode === true) {
      args.push(
        '-c', 'features.fast_mode=true',
        '-c', `service_tier=${toTomlLiteral('fast')}`,
      );
    } else if (this.config.fastMode === false) {
      args.push('-c', 'features.fast_mode=false');
    }

    // Apply the effective permission mode after raw settings so the safe
    // defaults cannot be overridden accidentally by an Advanced snippet.
    if (this.config.executionPermission === 'ASK' || this.config.executionPermission === 'AUTO_SANDBOX') {
      args.push('-c', 'approval_policy=on-request', '-c', 'sandbox_mode=workspace-write', '-c',
        `approvals_reviewer=${this.config.executionPermission === 'AUTO_SANDBOX' ? 'auto_review' : 'user'}`);
      if (this.config.executionPermission === 'AUTO_SANDBOX') {
        args.push('-c', 'sandbox_workspace_write.writable_roots=[]', '-c', 'sandbox_workspace_write.network_access=false');
      }
    } else if (this.permissionMode === 'noninteractive-workspace') {
      args.push(
        '-c', 'approval_policy=never',
        '-c', 'sandbox_mode=workspace-write',
      );
    }

    if (this.config.connection) {
      const connection = this.config.connection;
      args.push('-c', `model_provider=${toTomlLiteral(connection.modelProviderId)}`);
      if (connection.baseUrl) {
        if (connection.providerKind === 'built-in') {
          args.push('-c', `openai_base_url=${toTomlLiteral(connection.baseUrl)}`);
        } else {
          const providerKey = toTomlPathSegment(connection.modelProviderId);
          if (connection.modelProviderId === CODEX_OPENAI_COMPATIBLE_PROVIDER_ID) {
            args.push(
              '-c', `model_providers.${providerKey}.name=${toTomlLiteral(CODEX_OPENAI_COMPATIBLE_PROVIDER_NAME)}`,
              '-c', `model_providers.${providerKey}.wire_api=${toTomlLiteral('responses')}`,
            );
          }
          args.push('-c', `model_providers.${providerKey}.base_url=${toTomlLiteral(connection.baseUrl)}`);
          if (connection.envKey) {
            args.push('-c', `model_providers.${providerKey}.env_key=${toTomlLiteral(connection.envKey)}`);
          }
        }
      }
    }

    if (this.config.disableResponsesWebsocket === true && this.config.connection) {
      const connection = this.config.connection;
      if (connection.providerKind === 'custom') {
        const providerKey = toTomlPathSegment(connection.modelProviderId);
        args.push('-c', `model_providers.${providerKey}.supports_websockets=false`);
      } else {
        if (hasCodexBuiltinProviderAliasCollision(this.config.settings, CODEX_HTTP_ONLY_OPENAI_PROVIDER_ID)) {
          throw new ExecutorConfigurationError(
            this.agentType,
            new Error(
              "disableResponsesWebsocket conflicts with reserved Codex model provider alias 'agent-tower-openai-http'",
            ),
          );
        }
        const aliasKey = toTomlPathSegment(CODEX_HTTP_ONLY_OPENAI_PROVIDER_ID);
        args.push(
          '-c', `model_providers.${aliasKey}.name=${toTomlLiteral('OpenAI')}`,
          '-c', `model_providers.${aliasKey}.base_url=${toTomlLiteral(connection.baseUrl)}`,
          '-c', `model_providers.${aliasKey}.wire_api=${toTomlLiteral('responses')}`,
          '-c', `model_providers.${aliasKey}.requires_openai_auth=true`,
          '-c', `model_providers.${aliasKey}.supports_websockets=false`,
          '-c', `model_provider=${toTomlLiteral(CODEX_HTTP_ONLY_OPENAI_PROVIDER_ID)}`,
        );
      }
    }

    return args;
  }

  /**
   * 构建命令
   */
  protected buildCommandBuilder(): CommandBuilder {
    let builder = CommandBuilder.new(getBaseCommand());

    // 配置覆盖（--profile、-c 参数）— 放在最前面
    const configArgs = this.buildConfigOverrides();
    if (configArgs.length > 0) {
      builder.extendParams(configArgs);
    }

    // 模型选择
    if (this.config.model) {
      builder.extendParams(['--model', this.config.model]);
    }

    // Only an explicit boolean true opts into full bypass. Safe-mode defaults
    // are emitted by buildConfigOverrides after raw settings.
    if (this.permissionMode === 'full-bypass') {
      builder.extendParams(['--dangerously-bypass-approvals-and-sandbox']);
    }

    // 实时搜索
    if (this.config.liveSearch) {
      builder.extendParams(['--search', 'live']);
    }

    // 应用覆盖
    return applyOverrides(builder, this.cmdOverrides);
  }

  /**
   * 启动新会话
   */
  async spawn(config: ExecutorSpawnConfig): Promise<SpawnedChild> {
    if (this.config.executionPermission === 'ASK' || this.config.executionPermission === 'AUTO_SANDBOX') return this.spawnAppServer(config);
    const commandBuilder = this.buildCommandBuilder();
    const configOverrideArgs = this.buildConfigOverrides();
    const probeCommand = commandBuilder.buildInitial();
    const probeEnv = config.env.withProfile(this.cmdOverrides).getFullEnv();
    const explicitConfigPath = getExplicitMcpConfigPath(this.getDefaultMcpConfigPath());
    const declaredMcpServers = getCachedCodexMcpServerNames(
      configOverrideArgs,
      explicitConfigPath,
      probeCommand,
      probeEnv,
    );

    commandBuilder.extendParams(buildAgentTowerMcpEnvConfigOverrides(config.env, declaredMcpServers));

    // Codex 使用 exec 子命令进行非交互式执行
    commandBuilder.extendParams(['exec', '--json', '--skip-git-repo-check']);

    // 组合 prompt
    const prompt = this.combinePrompt(config.prompt);

    // 检测并提取图片路径（-i <FILE>... 是 variadic 参数，会贪婪消费后续参数，
    // 必须用 -- 分隔，防止 prompt 被当成文件路径）
    const { textPrompt, imagePaths } = await extractImagePaths(prompt);
    for (const imgPath of imagePaths) {
      commandBuilder.extendParams(['-i', imgPath]);
    }
    if (imagePaths.length > 0) {
      commandBuilder.extendParams(['--']);
    }
    commandBuilder.extendParams(['-']);

    const commandParts = commandBuilder.buildInitial();

    return this.spawnWithStdin(config, commandParts, textPrompt);
  }

  /**
   * 继续现有会话
   */
  async spawnFollowUp(
    config: ExecutorSpawnConfig,
    sessionId: string,
    resetToMessageId?: string
  ): Promise<SpawnedChild> {
    if (this.config.executionPermission === 'ASK' || this.config.executionPermission === 'AUTO_SANDBOX') return this.spawnAppServer(config, sessionId);
    const commandBuilder = this.buildCommandBuilder();
    const configOverrideArgs = this.buildConfigOverrides();
    const probeCommand = commandBuilder.buildInitial();
    const probeEnv = config.env.withProfile(this.cmdOverrides).getFullEnv();
    const explicitConfigPath = getExplicitMcpConfigPath(this.getDefaultMcpConfigPath());
    const declaredMcpServers = getCachedCodexMcpServerNames(
      configOverrideArgs,
      explicitConfigPath,
      probeCommand,
      probeEnv,
    );

    commandBuilder.extendParams(buildAgentTowerMcpEnvConfigOverrides(config.env, declaredMcpServers));

    // Codex 使用 exec resume 命令继续会话（支持 JSON 输出）
    const additionalArgs = ['exec', 'resume', '--json', '--skip-git-repo-check'];

    if (sessionId) {
      additionalArgs.push(sessionId);
    }

    // 注意：Codex 的 exec resume 不支持 --from 参数
    // resetToMessageId 参数暂时忽略

    // 组合 prompt
    const prompt = this.combinePrompt(config.prompt);

    // 检测并提取图片路径（-i <FILE>... 是 variadic 参数，会贪婪消费后续参数，
    // 必须用 -- 分隔，防止 prompt 被当成文件路径）
    const { textPrompt, imagePaths } = await extractImagePaths(prompt);
    for (const imgPath of imagePaths) {
      additionalArgs.push('-i', imgPath);
    }
    if (imagePaths.length > 0) {
      additionalArgs.push('--');
    }
    additionalArgs.push('-');

    const commandParts = commandBuilder.buildFollowUp(additionalArgs);

    return this.spawnWithStdin(config, commandParts, textPrompt);
  }

  /**
   * 组合 prompt
   */
  private combinePrompt(prompt: string): string {
    if (this.config.appendPrompt) {
      return `${prompt}${this.config.appendPrompt}`;
    }
    return prompt;
  }

  private async spawnAppServer(config: ExecutorSpawnConfig, resumeThreadId?: string): Promise<SpawnedChild> {
    await refreshCodexCliSupport();
    const support = cachedCodexCliSupport({ config: this.config as unknown as Record<string, unknown>, env: this.cmdOverrides?.env ?? {} });
    if (!support.supported || !support.executable || this.config.dangerouslyBypassApprovalsAndSandbox === true) {
      throw new ExecutorConfigurationError(this.agentType, new Error(support.message ?? 'Codex interactive mode has conflicting permission configuration'));
    }
    // app-server takes config overrides, not exec's task/model/search flags.
    const args = this.buildConfigOverrides();
    if (this.config.model) args.push('-c', `model=${toTomlLiteral(this.config.model)}`);
    if (this.config.liveSearch) args.push('-c', 'web_search=live');
    const explicitPath = getExplicitMcpConfigPath(this.getDefaultMcpConfigPath());
    const names = getCachedCodexMcpServerNames(args, explicitPath, { program: support.executable, args }, config.env.withProfile(this.cmdOverrides).getFullEnv());
    args.push(...buildAgentTowerMcpEnvConfigOverrides(config.env, names), 'app-server', '--listen', 'stdio://');
    const { textPrompt, imagePaths } = await extractImagePaths(this.combinePrompt(config.prompt));
    const input: CodexCliStart = { cwd: config.workingDir, ...(resumeThreadId ? { resumeThreadId } : {}), input: [
      { type: 'text', text: textPrompt, text_elements: [] }, ...imagePaths.map(image => ({ type: 'localImage' as const, path: image })),
    ] };
    const child = await this.spawnWithDuplex(config, { program: support.executable, args });
    child.initialInput = JSON.stringify(input);
    return child;
  }
}
