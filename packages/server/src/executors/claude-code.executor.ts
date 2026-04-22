/**
 * ClaudeCodeExecutor - Claude Code 执行器
 * 参考 Rust 实现: crates/executors/src/executors/claude.rs
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AgentType } from '../types/index.js';
import { execAsync, which } from '../utils/index.js';
import {
  BaseExecutor,
  AvailabilityInfo,
  AgentCapability,
  ExecutorSpawnConfig,
  SpawnedChild,
} from './base.executor.js';
import { CommandBuilder, applyOverrides, CmdOverrides } from './command-builder.js';
import { parsePromptWithImages, buildUserMessageNDJSON } from './image-utils.js';

/**
 * Claude Code 权限模式
 */
export enum PermissionMode {
  /** 默认模式 - 需要审批 */
  Default = 'default',
  /** 计划模式 - 只有 ExitPlanMode 需要审批 */
  Plan = 'plan',
  /** 绕过权限 - 自动批准所有操作 */
  BypassPermissions = 'bypassPermissions',
}

/**
 * Claude Code 配置
 */
export interface ClaudeCodeConfig {
  /** 追加到 prompt 的文本 */
  appendPrompt?: string;
  /** 是否使用 claude-code-router */
  claudeCodeRouter?: boolean;
  /** 计划模式 */
  plan?: boolean;
  /** 审批模式 */
  approvals?: boolean;
  /** 模型选择 */
  model?: string;
  /** 推理努力程度 (low | medium | high | xhigh | max) */
  effort?: string;
  /** 跳过权限检查 */
  dangerouslySkipPermissions?: boolean;
  /** 禁用 API Key */
  disableApiKey?: boolean;
  /** 命令覆盖 */
  cmd?: CmdOverrides;
  /** CLI 原生配置 JSON 字符串，直接传给 --settings */
  settings?: string;
}

/**
 * 获取基础命令
 */
function getBaseCommand(useRouter: boolean): string {
  if (useRouter) {
    return 'npx -y @musistudio/claude-code-router@1.0.66 code';
  }
  return 'claude';
}

export class ClaudeCodeExecutor extends BaseExecutor {
  readonly agentType = AgentType.CLAUDE_CODE;
  readonly displayName = 'Claude Code';

  private config: ClaudeCodeConfig;

  constructor(config: ClaudeCodeConfig = {}) {
    super();
    this.config = config;
    this.cmdOverrides = config.cmd;
  }

  /**
   * 获取可用性信息
   */
  async getAvailabilityInfo(): Promise<AvailabilityInfo> {
    const authFilePath = path.join(os.homedir(), '.claude.json');

    try {
      const stats = fs.statSync(authFilePath);
      const timestamp = Math.floor(stats.mtimeMs / 1000);
      return {
        type: 'LOGIN_DETECTED',
        lastAuthTimestamp: timestamp,
      };
    } catch {
      // 文件不存在，检查命令是否可用
      const claudePath = await which('claude');
      if (claudePath) {
        return { type: 'INSTALLATION_FOUND' };
      }
      return { type: 'NOT_FOUND', error: 'Claude Code CLI not installed' };
    }
  }

  /**
   * 获取 Agent 能力
   */
  getCapabilities(): AgentCapability[] {
    return [AgentCapability.SESSION_FORK, AgentCapability.CONTEXT_USAGE];
  }

  /**
   * 获取默认 MCP 配置路径
   */
  getDefaultMcpConfigPath(): string | null {
    return path.join(os.homedir(), '.claude.json');
  }

  /**
   * 获取权限模式
   */
  getPermissionMode(): PermissionMode {
    if (this.config.plan) {
      return PermissionMode.Plan;
    }
    if (this.config.approvals) {
      return PermissionMode.BypassPermissions;
    }
    return PermissionMode.BypassPermissions;
  }

  /**
   * 构建 --settings 参数，用于覆盖 ~/.claude/settings.json 中的 env 配置
   *
   * 优先使用 config.settings（用户通过 CLI 原生配置面板填写的完整 settings），
   * 同时将 cmdOverrides.env 中的 ANTHROPIC_* 合并到 settings.env 中。
   * 无 settings 时 fallback 到原有逻辑：从 env 中提取 ANTHROPIC_* 构造 settings。
   */
  private buildSettingsOverride(): string[] {
    // 从 cmdOverrides.env 提取 ANTHROPIC_* 变量
    const envOverrides = this.cmdOverrides?.env;
    const anthropicEnv: Record<string, string> = {};
    if (envOverrides) {
      for (const [key, value] of Object.entries(envOverrides)) {
        if (key.startsWith('ANTHROPIC_')) {
          anthropicEnv[key] = value;
        }
      }
    }

    if (this.config.settings) {
      // 有 settings 时：以 settings 为基础，将 ANTHROPIC_* env 合并进去
      const settings = JSON.parse(this.config.settings) as Record<string, unknown>;
      if (Object.keys(anthropicEnv).length > 0) {
        const existingEnv = (settings.env as Record<string, string>) ?? {};
        settings.env = { ...existingEnv, ...anthropicEnv };
      }
      return ['--settings', JSON.stringify(settings)];
    }

    // fallback: 无 settings 时，仅注入 ANTHROPIC_* 变量
    if (Object.keys(anthropicEnv).length === 0) {
      return [];
    }
    return ['--settings', JSON.stringify({ env: anthropicEnv })];
  }

  /**
   * 构建命令（用于普通文本 prompt）
   */
  protected buildCommandBuilder(): CommandBuilder {
    const useRouter = this.config.claudeCodeRouter ?? false;
    let builder = CommandBuilder.new(getBaseCommand(useRouter));

    // 基础参数
    builder.setParams(['-p']);

    // 权限模式设置
    const plan = this.config.plan ?? false;
    const approvals = this.config.approvals ?? false;

    if (plan || approvals) {
      builder.extendParams(['--permission-prompt-tool=stdio']);
      builder.extendParams([`--permission-mode=${PermissionMode.BypassPermissions}`]);
    }

    // 跳过权限检查
    if (this.config.dangerouslySkipPermissions) {
      builder.extendParams(['--dangerously-skip-permissions']);
    }

    // 模型选择
    if (this.config.model) {
      builder.extendParams(['--model', this.config.model]);
    }

    // 推理努力程度
    if (this.config.effort) {
      builder.extendParams(['--effort', this.config.effort]);
    }

    // 通过 --settings 覆盖 ~/.claude/settings.json 中的 ANTHROPIC_* env
    builder.extendParams(this.buildSettingsOverride());

    // 输出格式 - 使用 stream-json 进行双向通信
    builder.extendParams([
      '--verbose',
      '--output-format=stream-json',
      '--input-format=stream-json',
      '--include-partial-messages',
      '--replay-user-messages',
      '--disallowedTools=AskUserQuestion',
    ]);

    // 追加系统提示
    if (this.config.appendPrompt) {
      builder.extendParams(['--append-system-prompt', this.config.appendPrompt]);
    }

    // 应用覆盖
    return applyOverrides(builder, this.cmdOverrides);
  }

  /**
   * 构建命令（用于包含图片的 stream-json 输入）
   * 使用 -p 模式配合 --input-format=stream-json
   */
  protected buildCommandBuilderForStreamJson(): CommandBuilder {
    const useRouter = this.config.claudeCodeRouter ?? false;
    let builder = CommandBuilder.new(getBaseCommand(useRouter));

    // 使用 -p 参数（print 模式）
    builder.setParams(['-p']);

    // 权限模式设置
    const plan = this.config.plan ?? false;
    const approvals = this.config.approvals ?? false;

    if (plan || approvals) {
      builder.extendParams(['--permission-prompt-tool=stdio']);
      builder.extendParams([`--permission-mode=${PermissionMode.BypassPermissions}`]);
    }

    // 跳过权限检查
    if (this.config.dangerouslySkipPermissions) {
      builder.extendParams(['--dangerously-skip-permissions']);
    }

    // 模型选择
    if (this.config.model) {
      builder.extendParams(['--model', this.config.model]);
    }

    // 推理努力程度
    if (this.config.effort) {
      builder.extendParams(['--effort', this.config.effort]);
    }

    // 通过 --settings 覆盖 ~/.claude/settings.json 中的 ANTHROPIC_* env
    builder.extendParams(this.buildSettingsOverride());

    // 输出格式 - 使用 stream-json 进行双向通信
    builder.extendParams([
      '--verbose',
      '--output-format=stream-json',
      '--input-format=stream-json',
      '--include-partial-messages',
      '--replay-user-messages',
      '--disallowedTools=AskUserQuestion',
    ]);

    // 追加系统提示
    if (this.config.appendPrompt) {
      builder.extendParams(['--append-system-prompt', this.config.appendPrompt]);
    }

    // 应用覆盖
    return applyOverrides(builder, this.cmdOverrides);
  }

  /**
   * 启动新会话
   */
  async spawn(config: ExecutorSpawnConfig): Promise<SpawnedChild> {
    // 组合 prompt
    const prompt = this.combinePrompt(config.prompt);

    console.log('[ClaudeCodeExecutor] spawn - prompt length:', prompt.length);
    console.log('[ClaudeCodeExecutor] spawn - prompt preview:', prompt.substring(0, 200));

    // 检测是否包含图片
    const parsedPrompt = await parsePromptWithImages(prompt);

    if (parsedPrompt.hasImages) {
      console.log('[ClaudeCodeExecutor] ✅ Detected images in prompt, using stdin JSON format');
      // 使用 stdin JSON 格式发送
      const commandBuilder = this.buildCommandBuilderForStreamJson();
      const commandParts = commandBuilder.buildInitial();
      const userMessage = buildUserMessageNDJSON(parsedPrompt.contentBlocks);
      return this.spawnWithStdin(config, commandParts, userMessage);
    } else {
      console.log('[ClaudeCodeExecutor] ℹ️  No images detected, using normal text format');
      // 保持原有方式
      const commandBuilder = this.buildCommandBuilder();
      const commandParts = commandBuilder.buildInitial();
      const newConfig = { ...config, prompt };
      return this.spawnInternal(newConfig, commandParts);
    }
  }

  /**
   * 继续现有会话
   */
  async spawnFollowUp(
    config: ExecutorSpawnConfig,
    sessionId: string,
    resetToMessageId?: string
  ): Promise<SpawnedChild> {
    // 组合 prompt
    const prompt = this.combinePrompt(config.prompt);

    console.log('[ClaudeCodeExecutor] spawnFollowUp - prompt length:', prompt.length);
    console.log('[ClaudeCodeExecutor] spawnFollowUp - prompt preview:', prompt.substring(0, 200));

    // 检测是否包含图片
    const parsedPrompt = await parsePromptWithImages(prompt);

    if (parsedPrompt.hasImages) {
      console.log('[ClaudeCodeExecutor] ✅ Detected images in follow-up, using stdin JSON format');
      // 使用 stdin JSON 格式发送
      const commandBuilder = this.buildCommandBuilderForStreamJson();
      const additionalArgs = ['--resume', sessionId];
      if (resetToMessageId) {
        additionalArgs.push('--resume-session-at', resetToMessageId);
      }
      const commandParts = commandBuilder.buildFollowUp(additionalArgs);
      const userMessage = buildUserMessageNDJSON(parsedPrompt.contentBlocks);
      return this.spawnWithStdin(config, commandParts, userMessage);
    } else {
      console.log('[ClaudeCodeExecutor] ℹ️  No images detected in follow-up, using normal text format');
      // 保持原有方式
      const commandBuilder = this.buildCommandBuilder();
      const additionalArgs = ['--resume', sessionId];
      if (resetToMessageId) {
        additionalArgs.push('--resume-session-at', resetToMessageId);
      }
      const commandParts = commandBuilder.buildFollowUp(additionalArgs);
      const newConfig = { ...config, prompt };
      return this.spawnInternal(newConfig, commandParts);
    }
  }

  /**
   * 组合 prompt
   * 注意: appendPrompt 已通过 --append-system-prompt CLI 参数传入，不再拼接到用户 prompt
   */
  private combinePrompt(prompt: string): string {
    return prompt;
  }
}
