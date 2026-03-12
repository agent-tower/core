/**
 * BaseExecutor - 执行器基类
 * 参考 Rust 实现: crates/executors/src/executors/mod.rs
 */

import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import { EventEmitter } from 'events';
import { AgentType } from '../types/index.js';
import { ExecutionEnv } from './execution-env.js';
import { CommandBuilder, CommandParts, CmdOverrides, resolveCommandParts } from './command-builder.js';

/**
 * Agent 可用性信息
 */
export type AvailabilityInfo =
  | { type: 'LOGIN_DETECTED'; lastAuthTimestamp: number }
  | { type: 'INSTALLATION_FOUND' }
  | { type: 'NOT_FOUND'; error?: string };

/**
 * 取消令牌 - 用于优雅关闭
 */
export class CancellationToken extends EventEmitter {
  private _cancelled = false;

  get isCancelled(): boolean {
    return this._cancelled;
  }

  cancel(): void {
    if (!this._cancelled) {
      this._cancelled = true;
      this.emit('cancelled');
    }
  }

  onCancelled(callback: () => void): void {
    if (this._cancelled) {
      callback();
    } else {
      this.once('cancelled', callback);
    }
  }
}

/**
 * 退出结果
 */
export enum ExecutorExitResult {
  Success = 'SUCCESS',
  Failure = 'FAILURE',
}

/**
 * 退出信号 - Promise 形式
 */
export type ExecutorExitSignal = Promise<ExecutorExitResult>;

/**
 * 生成的子进程
 */
export interface SpawnedChild {
  /** 进程 ID */
  pid: number;
  /** PTY 实例 */
  pty: IPty;
  /** Executor -> Container: 执行器想要退出时发出信号 */
  exitSignal?: ExecutorExitSignal;
  /** Container -> Executor: 容器想要取消执行时发出信号 */
  cancel?: CancellationToken;
}

/**
 * 执行器配置
 */
export interface ExecutorSpawnConfig {
  /** 工作目录 */
  workingDir: string;
  /** 用户提示 */
  prompt: string;
  /** 执行环境 */
  env: ExecutionEnv;
}

/**
 * 斜杠命令描述
 */
export interface SlashCommandDescription {
  /** 命令名称（不含前导斜杠） */
  name: string;
  /** 命令描述 */
  description?: string;
}

/**
 * Agent 能力
 */
export enum AgentCapability {
  /** 支持会话分叉 */
  SESSION_FORK = 'SESSION_FORK',
  /** 需要设置助手 */
  SETUP_HELPER = 'SETUP_HELPER',
  /** 报告上下文/token 使用信息 */
  CONTEXT_USAGE = 'CONTEXT_USAGE',
}

/**
 * 标准编码 Agent 执行器接口
 */
export interface StandardCodingAgentExecutor {
  /** Agent 类型 */
  readonly agentType: AgentType;
  /** 显示名称 */
  readonly displayName: string;

  /**
   * 获取可用性信息
   */
  getAvailabilityInfo(): Promise<AvailabilityInfo>;

  /**
   * 获取 Agent 能力列表
   */
  getCapabilities(): AgentCapability[];

  /**
   * 获取可用的斜杠命令
   */
  getAvailableSlashCommands?(workDir: string): Promise<SlashCommandDescription[]>;

  /**
   * 启动新会话
   */
  spawn(config: ExecutorSpawnConfig): Promise<SpawnedChild>;

  /**
   * 继续现有会话
   */
  spawnFollowUp?(
    config: ExecutorSpawnConfig,
    sessionId: string,
    resetToMessageId?: string
  ): Promise<SpawnedChild>;

  /**
   * 获取默认 MCP 配置路径
   */
  getDefaultMcpConfigPath?(): string | null;
}

/**
 * 基础执行器抽象类
 */
export abstract class BaseExecutor implements StandardCodingAgentExecutor {
  abstract readonly agentType: AgentType;
  abstract readonly displayName: string;

  /** 命令覆盖配置 */
  protected cmdOverrides?: CmdOverrides;

  /**
   * 构建命令
   */
  protected abstract buildCommandBuilder(): CommandBuilder;

  /**
   * 获取可用性信息
   */
  abstract getAvailabilityInfo(): Promise<AvailabilityInfo>;

  /**
   * 获取 Agent 能力
   */
  getCapabilities(): AgentCapability[] {
    return [];
  }

  /**
   * 获取默认 MCP 配置路径
   */
  getDefaultMcpConfigPath(): string | null {
    return null;
  }

  /**
   * 启动进程
   */
  async spawn(config: ExecutorSpawnConfig): Promise<SpawnedChild> {
    const commandBuilder = this.buildCommandBuilder();
    const commandParts = commandBuilder.buildInitial();
    return this.spawnInternal(config, commandParts);
  }

  /**
   * 继续会话（默认不支持，子类可覆盖）
   */
  async spawnFollowUp(
    config: ExecutorSpawnConfig,
    sessionId: string,
    resetToMessageId?: string
  ): Promise<SpawnedChild> {
    throw new Error(`${this.displayName} does not support follow-up sessions`);
  }

  /**
   * 内部启动方法
   */
  protected async spawnInternal(
    config: ExecutorSpawnConfig,
    commandParts: CommandParts
  ): Promise<SpawnedChild> {
    const { programPath, args } = await resolveCommandParts(commandParts);
    const env = config.env.withProfile(this.cmdOverrides);

    const cancel = new CancellationToken();

    // 添加 prompt 到参数列表
    const fullArgs = [...args, config.prompt];

    // 构建完整的 shell 命令，确保正确处理 Node.js 脚本
    // node-pty 直接 spawn Node.js 脚本会失败 (posix_spawnp failed)
    const shellArgs = [programPath, ...fullArgs].map(arg =>
      // 转义单引号
      `'${arg.replace(/'/g, "'\\''")}'`
    ).join(' ');

    const shell = pty.spawn('/bin/bash', ['-c', shellArgs], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: config.workingDir,
      env: env.getFullEnv(),
    });

    // 监听取消信号
    cancel.onCancelled(() => {
      // 发送 SIGINT 进行优雅关闭
      shell.kill('SIGINT');
    });

    return {
      pid: shell.pid,
      pty: shell,
      cancel,
    };
  }

  /**
   * 通过 stdin 发送数据启动进程
   * 用于需要通过 stdin 传递结构化数据的场景（如图片）
   */
  protected async spawnWithStdin(
    config: ExecutorSpawnConfig,
    commandParts: CommandParts,
    stdinData: string
  ): Promise<SpawnedChild> {
    const { programPath, args } = await resolveCommandParts(commandParts);
    const env = config.env.withProfile(this.cmdOverrides);

    const cancel = new CancellationToken();

    // 不添加 prompt 到参数列表，因为会通过 stdin 发送
    const fullArgs = [...args];

    // 使用 echo 通过管道传递 stdin 数据
    // 这样可以正确地将数据传递给 Claude CLI 的 stdin
    const escapedStdinData = stdinData.replace(/'/g, "'\\''");
    const shellCommand = `echo '${escapedStdinData}' | ${programPath} ${fullArgs.map(arg => `'${arg.replace(/'/g, "'\\''")}'`).join(' ')}`;

    console.log('[BaseExecutor] Spawning with stdin via pipe');
    console.log('[BaseExecutor] Command length:', shellCommand.length);
    console.log('[BaseExecutor] Stdin data length:', stdinData.length);
    console.log('[BaseExecutor] Stdin data preview:', stdinData.substring(0, 500));

    const shell = pty.spawn('/bin/bash', ['-c', shellCommand], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: config.workingDir,
      env: env.getFullEnv(),
    });

    // 添加调试输出监听
    let outputBuffer = '';
    shell.onData((data) => {
      outputBuffer += data;
      // 只打印前1000个字符，避免日志过多
      if (outputBuffer.length < 1000) {
        console.log('[BaseExecutor] PTY output:', data.substring(0, 200));
      }
    });

    // 监听退出事件
    shell.onExit(({ exitCode, signal }) => {
      console.log('[BaseExecutor] PTY exited, code:', exitCode, 'signal:', signal);
      console.log('[BaseExecutor] Total output length:', outputBuffer.length);
      if (outputBuffer.length < 2000) {
        console.log('[BaseExecutor] Full output:', outputBuffer);
      }
    });

    // 监听取消信号
    cancel.onCancelled(() => {
      shell.kill('SIGINT');
    });

    return {
      pid: shell.pid,
      pty: shell,
      cancel,
    };
  }

  /**
   * 向 PTY 发送消息
   */
  sendMessage(ptyInstance: IPty, message: string): void {
    ptyInstance.write(message + '\n');
  }
}
