/**
 * CursorAgentExecutor - Cursor Agent CLI 执行器
 * 参考 vibe-kanban Rust 实现: crates/executors/src/executors/cursor.rs
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
 * Cursor Agent 配置
 */
export interface CursorAgentConfig {
  /** 追加到 prompt 的文本 */
  appendPrompt?: string;
  /** 强制允许命令（除非明确拒绝） */
  force?: boolean;
  /** 模型选择: auto, sonnet-4.5, sonnet-4.5-thinking, gpt-5, opus-4.1, grok, composer-1 */
  model?: string;
  /** 命令覆盖 */
  cmd?: CmdOverrides;
}

/**
 * 获取基础命令
 */
function getBaseCommand(): string {
  return 'cursor-agent';
}

export class CursorAgentExecutor extends BaseExecutor {
  readonly agentType = AgentType.CURSOR_AGENT;
  readonly displayName = 'Cursor Agent';

  private config: CursorAgentConfig;

  constructor(config: CursorAgentConfig = {}) {
    super();
    this.config = config;
    this.cmdOverrides = config.cmd;
  }

  /**
   * 获取可用性信息
   */
  async getAvailabilityInfo(): Promise<AvailabilityInfo> {
    // 检查 cursor-agent 命令是否可用
    const cursorAgentPath = await which(getBaseCommand());
    if (!cursorAgentPath) {
      return { type: 'NOT_FOUND', error: 'Cursor Agent CLI not installed. Run: curl https://cursor.com/install -fsS | bash' };
    }

    // 检查 MCP 配置文件是否存在（作为安装标识）
    const mcpConfigPath = this.getDefaultMcpConfigPath();
    if (mcpConfigPath && fs.existsSync(mcpConfigPath)) {
      return { type: 'INSTALLATION_FOUND' };
    }

    // 命令存在但没有配置文件，也视为已安装
    return { type: 'INSTALLATION_FOUND' };
  }

  /**
   * 获取 Agent 能力
   */
  getCapabilities(): AgentCapability[] {
    return [AgentCapability.SETUP_HELPER];
  }

  /**
   * 获取默认 MCP 配置路径
   */
  getDefaultMcpConfigPath(): string | null {
    return path.join(os.homedir(), '.cursor', 'mcp.json');
  }

  /**
   * 构建命令
   */
  protected buildCommandBuilder(): CommandBuilder {
    let builder = CommandBuilder.new(getBaseCommand());

    // 基础参数: -p 表示从 stdin 读取 prompt, --output-format=stream-json 输出 JSON 流
    builder.setParams(['-p', '--output-format=stream-json']);

    // 强制模式
    if (this.config.force) {
      builder.extendParams(['--force']);
    }

    // 模型选择
    if (this.config.model) {
      builder.extendParams(['--model', this.config.model]);
    }

    // 应用覆盖
    return applyOverrides(builder, this.cmdOverrides);
  }

  /**
   * 启动新会话
   * Cursor Agent 通过 stdin 接收 prompt，不同于 Claude Code 通过参数传递
   */
  async spawn(config: ExecutorSpawnConfig): Promise<SpawnedChild> {
    const commandBuilder = this.buildCommandBuilder();
    const commandParts = commandBuilder.buildInitial();

    // 组合 prompt
    const prompt = this.combinePrompt(config.prompt);
    const newConfig = { ...config, prompt };

    return this.spawnInternal(newConfig, commandParts);
  }

  /**
   * 继续现有会话
   * Cursor Agent 使用 --resume 参数恢复会话
   */
  async spawnFollowUp(
    config: ExecutorSpawnConfig,
    sessionId: string,
    _resetToMessageId?: string
  ): Promise<SpawnedChild> {
    const commandBuilder = this.buildCommandBuilder();

    const additionalArgs = ['--resume', sessionId];
    const commandParts = commandBuilder.buildFollowUp(additionalArgs);

    // 组合 prompt
    const prompt = this.combinePrompt(config.prompt);
    const newConfig = { ...config, prompt };

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
