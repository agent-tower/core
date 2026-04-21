/**
 * BaseExecutor - 执行器基类
 * 参考 Rust 实现: crates/executors/src/executors/mod.rs
 */

import * as pty from '@shitiandmw/node-pty';
import type { IPty } from '@shitiandmw/node-pty';
import { EventEmitter } from 'events';
import { appendFileSync } from 'node:fs';
import { AgentType } from '../types/index.js';
import { ExecutionEnv } from './execution-env.js';
import { CommandBuilder, CommandParts, CmdOverrides, resolveCommandParts } from './command-builder.js';
import { stripAnsiSequences } from '../output/utils/ansi.js';
import {
  buildPtyCommand,
  buildPtyCommandWithStdin,
  getPtyLogFilePath,
} from '../utils/process-launch.js';

const PTY_LOG_FILE = getPtyLogFilePath();
function ptyLog(pid: number, msg: string): void {
  const line = `[${new Date().toISOString()}][pid=${pid}] ${msg}\n`;
  process.stdout.write(line);
  try { appendFileSync(PTY_LOG_FILE, line); } catch { /* ignore */ }
}

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
    const invocation = buildPtyCommand(programPath, fullArgs);

    const fullEnv = env.getFullEnv();
    ptyLog(0, `Spawning: ${programPath} ${fullArgs.slice(0, -1).join(' ')} ... <prompt>`);
    ptyLog(0, `ENV ANTHROPIC_BASE_URL=${fullEnv.ANTHROPIC_BASE_URL || '(not set)'}`);
    ptyLog(0, `ENV ANTHROPIC_API_KEY=${fullEnv.ANTHROPIC_API_KEY ? fullEnv.ANTHROPIC_API_KEY.slice(0, 12) + '...' : '(not set)'}`);
    ptyLog(0, `ENV ANTHROPIC_AUTH_TOKEN=${fullEnv.ANTHROPIC_AUTH_TOKEN ? fullEnv.ANTHROPIC_AUTH_TOKEN.slice(0, 12) + '...' : '(not set)'}`);

    // On Windows, ConPTY auto-wraps at the column limit by inserting real
    // \r\n into the data stream, which breaks JSON parsing. Use very wide
    // columns to prevent this. Unix PTYs don't inject line breaks, so the
    // default 120 is fine there and avoids changing behaviour for CLI tools
    // that respect terminal width.
    const ptyCols = process.platform === 'win32' ? 16384 : 120;
    const shell = pty.spawn(invocation.command, invocation.args, {
      name: 'xterm-256color',
      cols: ptyCols,
      rows: 30,
      cwd: config.workingDir,
      env: fullEnv,
    });

    ptyLog(shell.pid, `Process spawned`);

    // 收集并实时记录 PTY 输出（写入系统临时目录日志方便诊断）
    let outputBuffer = '';
    const offData = shell.onData((data) => {
      if (outputBuffer.length < 8000) {
        outputBuffer += data;
      }
      const cleaned = stripAnsiSequences(data).replace(/\s+/g, ' ').trim();
      if (cleaned) {
        ptyLog(shell.pid, `PTY> ${cleaned.slice(0, 300)}`);
      }
    });

    shell.onExit(({ exitCode, signal }) => {
      offData.dispose();
      ptyLog(shell.pid, `PTY exited code=${exitCode} signal=${signal}`);
      if (exitCode !== 0) {
        const cleaned = stripAnsiSequences(outputBuffer).replace(/\s+/g, ' ').trim();
        if (cleaned) {
          ptyLog(shell.pid, `full output: ${cleaned.slice(0, 1000)}`);
        }
      }
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
   *
   * 注意：这里使用临时文件方式，因为 PTY 不适合传递大量结构化数据
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

    console.log('[BaseExecutor] Spawning with stdin (via temp file)');
    console.log('[BaseExecutor] Program:', programPath);
    console.log('[BaseExecutor] Args:', fullArgs.join(' '));
    console.log('[BaseExecutor] Stdin data length:', stdinData.length);
    console.log('[BaseExecutor] Stdin data preview:', stdinData.substring(0, 500));

    // 使用临时文件传递 stdin 数据，避免命令行参数长度限制
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');

    const tmpFile = path.join(os.tmpdir(), `agent-tower-stdin-${Date.now()}.json`);
    await fs.writeFile(tmpFile, stdinData, 'utf-8');
    console.log('[BaseExecutor] Wrote stdin data to temp file:', tmpFile);
    const invocation = buildPtyCommandWithStdin(programPath, fullArgs, tmpFile);

    const shell = pty.spawn(invocation.command, invocation.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: config.workingDir,
      env: env.getFullEnv(),
    });

    console.log('[BaseExecutor] Process spawned with PID:', shell.pid);

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
