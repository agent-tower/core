/**
 * GeminiCliExecutor - Gemini CLI 执行器
 * 参考 Rust 实现: crates/executors/src/executors/gemini.rs
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
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

/**
 * Gemini CLI 配置
 */
export interface GeminiCliConfig {
  /** 追加到 prompt 的文本 */
  appendPrompt?: string;
  /** 模型选择 */
  model?: string;
  /** YOLO 模式 - 自动批准所有操作 */
  yolo?: boolean;
  /** 命令覆盖 */
  cmd?: CmdOverrides;
}

/**
 * 获取基础命令
 */
function getBaseCommand(): string {
  return 'npx -y @google/gemini-cli@0.23.0';
}

export class GeminiCliExecutor extends BaseExecutor {
  readonly agentType = AgentType.GEMINI_CLI;
  readonly displayName = 'Gemini CLI';

  private config: GeminiCliConfig;

  constructor(config: GeminiCliConfig = {}) {
    super();
    this.config = config;
    this.cmdOverrides = config.cmd;
  }

  /**
   * 获取可用性信息
   */
  async getAvailabilityInfo(): Promise<AvailabilityInfo> {
    const oauthCredsPath = path.join(os.homedir(), '.gemini', 'oauth_creds.json');

    try {
      const stats = fs.statSync(oauthCredsPath);
      const timestamp = Math.floor(stats.mtimeMs / 1000);
      return {
        type: 'LOGIN_DETECTED',
        lastAuthTimestamp: timestamp,
      };
    } catch {
      // 检查 MCP 配置或安装标识
      const mcpConfigPath = this.getDefaultMcpConfigPath();
      const installationIdPath = path.join(os.homedir(), '.gemini', 'installation_id');

      const mcpConfigFound = mcpConfigPath && fs.existsSync(mcpConfigPath);
      const installationFound = fs.existsSync(installationIdPath);

      if (mcpConfigFound || installationFound) {
        return { type: 'INSTALLATION_FOUND' };
      }

      return { type: 'NOT_FOUND', error: 'Gemini CLI not configured' };
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
    return path.join(os.homedir(), '.gemini', 'settings.json');
  }

  /**
   * 构建命令
   */
  protected buildCommandBuilder(): CommandBuilder {
    let builder = CommandBuilder.new(getBaseCommand());

    // 模型选择
    if (this.config.model) {
      builder.extendParams(['--model', this.config.model]);
    }

    // YOLO 模式
    if (this.config.yolo) {
      builder.extendParams(['--yolo']);
      builder.extendParams(['--allowed-tools', 'run_shell_command']);
    }

    // 非交互模式用短 prompt 参数触发 one-shot，长 prompt 仍从 stdin 读取。
    // ACP 会占用 stdin 作为协议通道，不能直接写入普通 prompt。
    builder.extendParams(['--output-format=stream-json', '-p', '']);

    // 应用覆盖
    return applyOverrides(builder, this.cmdOverrides);
  }

  /**
   * 启动新会话
   */
  async spawn(config: ExecutorSpawnConfig): Promise<SpawnedChild> {
    const commandBuilder = this.buildCommandBuilder();
    const commandParts = commandBuilder.buildInitial();

    // 组合 prompt
    const prompt = this.combinePrompt(config.prompt);

    return this.spawnWithStdin(config, commandParts, prompt);
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

    const additionalArgs: string[] = [];
    if (sessionId) {
      additionalArgs.push('--resume', sessionId);
    }
    // resetToMessageId 参数暂时忽略：Gemini CLI 只支持按 session 继续。

    const commandParts = commandBuilder.buildFollowUp(additionalArgs);

    // 组合 prompt
    const prompt = this.combinePrompt(config.prompt);

    return this.spawnWithStdin(config, commandParts, prompt);
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
