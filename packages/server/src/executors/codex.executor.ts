/**
 * CodexExecutor - OpenAI Codex CLI 执行器
 * 参考: https://shipyard.build/blog/codex-cli-cheat-sheet/
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parse as parseToml } from 'smol-toml';
import { AgentType } from '../types/index.js';
import { which } from '../utils/index.js';
import {
  BaseExecutor,
  AvailabilityInfo,
  AgentCapability,
  ExecutorSpawnConfig,
  SpawnedChild,
} from './base.executor.js';
import { CommandBuilder, applyOverrides, CmdOverrides } from './command-builder.js';
import { extractImagePaths } from './image-utils.js';

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
  if (typeof value === 'string') return `"${value}"`;
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

/**
 * Codex CLI 配置
 */
export interface CodexConfig {
  /** 追加到 prompt 的文本 */
  appendPrompt?: string;
  /** 模型选择 (gpt-5.3-codex, gpt-5.3-codex-spark, gpt-5.1-codex-max) */
  model?: string;
  /** 沙箱模式 (read-only, workspace-write, danger-full-access) */
  sandbox?: string;
  /** 审批策略 (untrusted, on-request, never, reject) */
  approvalPolicy?: string;
  /** 全自动模式 - 相当于 on-request + workspace-write */
  fullAuto?: boolean;
  /** 启用实时网络搜索 */
  liveSearch?: boolean;
  /** 配置 profile 名称，对应 ~/.codex/config.toml 中的 [profiles.xxx] */
  profile?: string;
  /** CLI 原生配置 (TOML 格式字符串)，通过 -c 参数注入 */
  settings?: string;
  /** 命令覆盖 */
  cmd?: CmdOverrides;
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

  constructor(config: CodexConfig = {}) {
    super();
    this.config = config;
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

    // 检查配置文件是否存在
    const configPath = path.join(os.homedir(), '.codex', 'config.toml');
    const authPath = path.join(os.homedir(), '.codex', 'auth.json');

    try {
      // 检查认证文件
      if (fs.existsSync(authPath)) {
        const stats = fs.statSync(authPath);
        const timestamp = Math.floor(stats.mtimeMs / 1000);
        return {
          type: 'LOGIN_DETECTED',
          lastAuthTimestamp: timestamp,
        };
      }

      // 检查配置文件
      if (fs.existsSync(configPath)) {
        return { type: 'INSTALLATION_FOUND' };
      }

      return { type: 'NOT_FOUND', error: 'Codex CLI not authenticated' };
    } catch {
      return { type: 'NOT_FOUND', error: 'Codex CLI not configured' };
    }
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
    return path.join(os.homedir(), '.codex', 'config.toml');
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
      const parsed = parseToml(this.config.settings);
      for (const [key, value] of flattenObject(parsed as Record<string, unknown>)) {
        args.push('-c', `${key}=${toTomlLiteral(value)}`);
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

    // 沙箱模式
    if (this.config.sandbox) {
      builder.extendParams(['--sandbox', this.config.sandbox]);
    }

    // 审批策略
    if (this.config.approvalPolicy) {
      builder.extendParams(['--ask-for-approval', this.config.approvalPolicy]);
    }

    // 全自动模式
    if (this.config.fullAuto) {
      builder.extendParams(['--full-auto']);
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
    const commandBuilder = this.buildCommandBuilder();

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

    const commandParts = commandBuilder.buildInitial();
    const newConfig = { ...config, prompt: textPrompt };

    return this.spawnInternal(newConfig, commandParts);
  }

  /**
   * 继续现有会话
   */
  async spawnFollowUp(
    config: ExecutorSpawnConfig,
    sessionId: string,
    resetToMessageId?: string
  ): Promise<SpawnedChild> {
    const commandBuilder = this.buildCommandBuilder();

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

    const commandParts = commandBuilder.buildFollowUp(additionalArgs);
    const newConfig = { ...config, prompt: textPrompt };

    return this.spawnInternal(newConfig, commandParts);
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
}
