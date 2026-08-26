/**
 * BaseExecutor - 执行器基类
 * 参考 Rust 实现: crates/executors/src/executors/mod.rs
 */

import * as pty from '@shitiandmw/node-pty';
import type { IPty } from '@shitiandmw/node-pty';
import { EventEmitter } from 'events';
import { appendFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AgentType } from '../types/index.js';
import { ExecutionEnv } from './execution-env.js';
import { CommandBuilder, CommandParts, CmdOverrides, resolveCommandParts } from './command-builder.js';
import { stripAnsiSequences } from '../output/utils/ansi.js';
import {
  buildPtyCommand,
  buildPtyCommandWithStdin,
  buildPtyWrapperEnv,
  getPtyLogFilePath,
} from '../utils/process-launch.js';
import { writeErrorLog } from '../utils/error-log.js';
import {
  captureSpawnedProcessIdentity,
  type SpawnedProcessIdentity,
} from '../utils/spawned-process-identity.js';
import {
  attachSpawnCleanupOwner,
  markPreChildProcessFailure,
  type SpawnCleanupOwner,
} from './start-error.js';
import { createTreeCleanupChannel, type TreeCleanupChannel } from '../utils/tree-cleanup-channel.js';

const PTY_LOG_FILE = getPtyLogFilePath();
const OUTPUT_BUFFER_LIMIT = 8000;

const REDACT_VALUE_AFTER_ARGS = new Set([
  '-p',
  '--prompt',
  '--append-system-prompt',
  '--settings',
]);

function ptyLog(pid: number, msg: string): void {
  const line = `[${new Date().toISOString()}][pid=${pid}] ${msg}\n`;
  process.stdout.write(line);
  try { appendFileSync(PTY_LOG_FILE, line); } catch { /* ignore */ }
}

function logPtyOutput(pid: number, data: string): void {
  const cleaned = stripAnsiSequences(data).replace(/\s+/g, ' ').trim();
  if (cleaned) {
    ptyLog(pid, `PTY> ${cleaned.slice(0, 300)}`);
  }
}

function hashForLog(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function summarizeStdinForLog(stdinData: string): string {
  return `length=${Buffer.byteLength(stdinData, 'utf8')} sha256=${hashForLog(stdinData)}`;
}

function redactArgsForLog(args: string[]): string {
  const redacted: string[] = [];
  let redactNext = false;
  for (const arg of args) {
    if (redactNext) {
      redacted.push('<redacted>');
      redactNext = false;
      continue;
    }

    const equalsIndex = arg.indexOf('=');
    const key = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    if (equalsIndex !== -1 && /(?:^|[._-])(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)(?:[._-]|$)/i.test(key)) {
      redacted.push(`${key}=<redacted>`);
      continue;
    }
    if (REDACT_VALUE_AFTER_ARGS.has(key)) {
      if (equalsIndex === -1) {
        redacted.push(arg);
        redactNext = true;
      } else {
        redacted.push(`${key}=<redacted>`);
      }
      continue;
    }

    redacted.push(arg);
  }
  return redacted.join(' ');
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
 * PTY 事件在 spawn 返回后、AgentPipeline 挂载 listener 前就可能触发
 * （node-pty 不重放事件）。executor 在此窗口内缓存事件，pipeline 挂载后重放，
 * 否则启动即失败的进程会丢失 exit 事件，session 永远停留在 RUNNING。
 */
export type EarlyPtyEvent =
  | { type: 'data'; data: string }
  | { type: 'exit'; exitCode: number; signal?: number };

function isTrustedWrapperExit(event: { exitCode?: number; signal?: number | null }): boolean {
  // A wrapper that is externally killed can report a root exit while leaving
  // detached descendants behind. Only a normal wrapper exit is allowed to
  // mark the parent-owned completion capability.
  // node-pty reports a normal exit with signal=0 on macOS/Linux, while test
  // doubles and some platforms omit the field. Treat both representations as
  // “no terminating signal”; non-zero signals remain untrusted.
  return (event.signal == null || event.signal === 0)
    && typeof event.exitCode === 'number'
    && event.exitCode >= 0;
}

const POST_SPAWN_TERM_GRACE_MS = 500;
// The PTY process is a wrapper which owns the detached agent process group.
// Never SIGKILL the wrapper from this owner: doing so skips its killTree()
// handler and can leave the agent descendants running. The wrapper escalates
// its known group to SIGKILL after its own bounded grace period.
const POST_SPAWN_WRAPPER_ESCALATION_GRACE_MS = 7_000;

/**
 * A PTY handle is the only safe owner available before process identity has
 * been persisted. Keep this owner attached until a real wrapper exit arrives;
 * a timed-out signal attempt is not evidence that the process tree is gone.
 */
function createSpawnCleanupOwner(
  shell: IPty,
  takeEarlyEvents?: () => EarlyPtyEvent[],
  verifyTreeCleanup: () => boolean = () => true,
  disposeTreeCleanupChannel?: () => void,
  markTreeCleanupCompleted: () => void = () => undefined,
): SpawnCleanupOwner {
  const hasVerifiedTreeCleanup = (): boolean => {
    try {
      return verifyTreeCleanup();
    } catch {
      return false;
    }
  };
  let exited = false;
  let resolveExit!: () => void;
  const exit = new Promise<void>((resolve) => { resolveExit = resolve; });
  let offExit: { dispose(): void } | undefined;
  try {
    offExit = shell.onExit((event) => {
      // This listener is attached by the parent launch owner. A wrapper PTY
      // exit is the trusted completion origin; the latch is still checked by
      // the caller before any process-exit event is released.
      if (isTrustedWrapperExit(event)) markTreeCleanupCompleted();
      if (!hasVerifiedTreeCleanup()) return;
      exited = true;
      resolveExit();
    });
  } catch {
    // Keep the controlled kill path even when a test/damaged PTY cannot attach.
  }

  try {
    const earlyEvents = takeEarlyEvents?.() ?? [];
    if (earlyEvents.some((event) => event.type === 'exit' && isTrustedWrapperExit(event))) {
      markTreeCleanupCompleted();
    }
    if (earlyEvents.some((event) => event.type === 'exit' && isTrustedWrapperExit(event)) && hasVerifiedTreeCleanup()) {
      exited = true;
      resolveExit();
    }
  } catch {
    // The original post-spawn error is more useful than an event handoff error.
  }

  const waitForExit = async (timeoutMs: number): Promise<void> => {
    if (exited) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      exit,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  };

  const requestStop = (): void => {
    if (exited) return;
    try { shell.kill('SIGINT'); } catch { /* retry on the next cleanup attempt */ }
  };

  return {
    processExit: exit,
    requestStop,
    cleanup: async () => {
      if (!exited) {
        requestStop();
        await waitForExit(POST_SPAWN_TERM_GRACE_MS);
      }
      if (!exited) {
        // SIGTERM is handled by the wrapper and causes it to signal the
        // already captured child process group. A wrapper exit is the only
        // evidence this owner accepts as complete tree cleanup.
        try { shell.kill('SIGTERM'); } catch { /* retry on the next cleanup attempt */ }
        await waitForExit(POST_SPAWN_WRAPPER_ESCALATION_GRACE_MS);
      }
      if (!exited) {
        throw new Error('Spawned PTY did not confirm exit during cleanup');
      }
    },
    dispose: () => {
      offExit?.dispose();
      offExit = undefined;
    },
    disposeTreeCleanupChannel,
  };
}

/**
 * 生成的子进程
 */
export interface SpawnedChild {
  /** 进程 ID */
  pid: number;
  processGroupId: string;
  birthMarker: string;
  ownershipToken: string;
  /** PTY 实例 */
  pty: IPty;
  /** Executor -> Container: 执行器想要退出时发出信号 */
  exitSignal?: ExecutorExitSignal;
  /** Container -> Executor: 容器想要取消执行时发出信号 */
  cancel?: CancellationToken;
  /**
   * 取走 spawn 与 pipeline attach 之间缓存的 PTY 事件并停止缓存。
   * 必须在实时 listener 注册完成后调用（同步同一 tick 内无事件空窗）。
   */
  takeEarlyEvents?: () => EarlyPtyEvent[];
  /** True only after the wrapper has completed the parent-owned channel handshake. */
  verifyTreeCleanup?: () => boolean;
  /** Close the launch-scoped completion channel after durable acknowledgement. */
  disposeTreeCleanupChannel?: () => void;
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
   * 缓存 spawn 返回后、AgentPipeline attach 前的 PTY 事件。
   * 返回一次性的取走函数（取走即停止缓存并解除监听）。
   */
  private collectEarlyPtyEvents(shell: IPty): () => EarlyPtyEvent[] {
    let events: EarlyPtyEvent[] = [];
    let handedOff = false;
    const offData = shell.onData((data) => {
      if (!handedOff) events.push({ type: 'data', data });
    });
    const offExit = shell.onExit(({ exitCode, signal }) => {
      if (!handedOff) events.push({ type: 'exit', exitCode, signal });
    });
    return () => {
      if (handedOff) return [];
      handedOff = true;
      offData.dispose();
      offExit.dispose();
      const taken = events;
      events = [];
      return taken;
    };
  }

  /**
   * 内部启动方法
   */
  protected async spawnInternal(
    config: ExecutorSpawnConfig,
    commandParts: CommandParts
  ): Promise<SpawnedChild> {
    let resolved: Awaited<ReturnType<typeof resolveCommandParts>>;
    try {
      resolved = await resolveCommandParts(commandParts);
    } catch (error) {
      throw markPreChildProcessFailure(error);
    }
    const { programPath, args } = resolved;
    const env = config.env.withProfile(this.cmdOverrides);

    const cancel = new CancellationToken();

    // 添加 prompt 到参数列表
    const fullArgs = [...args, config.prompt];
    const invocation = buildPtyCommand(programPath, fullArgs);

    const fullEnv = env.getFullEnv();
    const ownershipToken = randomUUID();
    let cleanupChannel: TreeCleanupChannel;
    try {
      cleanupChannel = await createTreeCleanupChannel();
    } catch (error) {
      throw markPreChildProcessFailure(error);
    }
    const verifyCleanup = () => cleanupChannel.isCompleted();
    const wrapperEnv = buildPtyWrapperEnv(fullEnv, process.env, ownershipToken, cleanupChannel.env);
    ptyLog(0, `Spawning: ${programPath} ${redactArgsForLog(fullArgs.slice(0, -1))} ... <prompt>`);
    ptyLog(0, `ENV ANTHROPIC_BASE_URL=${fullEnv.ANTHROPIC_BASE_URL || '(not set)'}`);
    ptyLog(0, `ENV ANTHROPIC_API_KEY=${fullEnv.ANTHROPIC_API_KEY ? '(set)' : '(not set)'}`);
    ptyLog(0, `ENV ANTHROPIC_AUTH_TOKEN=${fullEnv.ANTHROPIC_AUTH_TOKEN ? '(set)' : '(not set)'}`);

    // On Windows, ConPTY auto-wraps at the column limit by inserting real
    // \r\n into the data stream, which breaks JSON parsing. Use very wide
    // columns to prevent this. Unix PTYs don't inject line breaks, so the
    // default 120 is fine there and avoids changing behaviour for CLI tools
    // that respect terminal width.
    const ptyCols = process.platform === 'win32' ? 16384 : 120;
    let shell: IPty;
    try {
      shell = pty.spawn(invocation.command, invocation.args, {
        name: 'xterm-256color',
        cols: ptyCols,
        rows: 30,
        cwd: config.workingDir,
        env: wrapperEnv,
      });
    } catch (error) {
      cleanupChannel.close();
      writeErrorLog({
        level: 'error',
        source: 'executor.spawn',
        message: `Failed to spawn ${this.displayName}`,
        error,
        metadata: {
          agentType: this.agentType,
          displayName: this.displayName,
          programPath,
          workingDir: config.workingDir,
        },
      });
      throw markPreChildProcessFailure(error);
    }

    ptyLog(shell.pid, `Process spawned`);

    let takeEarlyEvents: (() => EarlyPtyEvent[]) | undefined;
    let cleanupOwner: SpawnCleanupOwner | undefined;
    let cleanupAttempted = false;
    try {
      takeEarlyEvents = this.collectEarlyPtyEvents(shell);
      let identity: SpawnedProcessIdentity | null = null;
      let identityError: unknown;
      try {
        identity = await captureSpawnedProcessIdentity(shell.pid, ownershipToken);
        if (!identity) {
          throw new Error(`Could not persist a verifiable process identity for ${this.displayName}`);
        }
      } catch (error) {
        identityError = error;
      }
      if (identityError) {
        cleanupOwner = createSpawnCleanupOwner(
          shell,
          takeEarlyEvents,
          verifyCleanup,
          cleanupChannel.close,
          cleanupChannel.markCompleted,
        );
        try {
          cleanupAttempted = true;
          await cleanupOwner.cleanup();
          cleanupOwner.dispose();
          cleanupChannel.close();
        } catch {
          // The owner remains attached to the error for Driver/session retry.
          throw attachSpawnCleanupOwner(identityError, cleanupOwner);
        }
        // Only a real PTY exit makes this a safe pre-child failure.
        throw markPreChildProcessFailure(identityError);
      }
      if (!identity) {
        throw new Error(`Could not persist a verifiable process identity for ${this.displayName}`);
      }

      // 收集并实时记录 PTY 输出（写入系统临时目录日志方便诊断）
      let outputBuffer = '';
      const offData = shell.onData((data) => {
        if (outputBuffer.length < OUTPUT_BUFFER_LIMIT) {
          outputBuffer += data;
        }
        logPtyOutput(shell.pid, data);
      });

      shell.onExit(({ exitCode, signal }) => {
        // The completion latch is parent-owned. The wrapper only exits after
        // its marker-based multi-group cleanup reaches CLEAN_EMPTY; Agent
        // output cannot mark this latch.
        if (isTrustedWrapperExit({ exitCode, signal })) cleanupChannel.markCompleted();
        offData.dispose();
        ptyLog(shell.pid, `PTY exited code=${exitCode} signal=${signal}`);
        if (exitCode !== 0) {
          const cleaned = stripAnsiSequences(outputBuffer).replace(/\s+/g, ' ').trim();
          if (cleaned) {
            ptyLog(shell.pid, `full output: ${cleaned.slice(0, 1000)}`);
          }
          writeErrorLog({
            level: 'warn',
            source: 'executor.exit',
            message: `${this.displayName} exited with non-zero code ${exitCode}`,
            metadata: {
              agentType: this.agentType,
              displayName: this.displayName,
              pid: shell.pid,
              exitCode,
              signal,
              workingDir: config.workingDir,
              output: cleaned ? cleaned.slice(0, 2000) : undefined,
            },
          });
        }
      });

      // 监听取消信号
      cancel.onCancelled(() => {
        // 发送 SIGINT 进行优雅关闭
        shell.kill('SIGINT');
      });

      cleanupOwner?.dispose();

      return {
        pid: shell.pid,
        ...identity,
        pty: shell,
        cancel,
        takeEarlyEvents,
        verifyTreeCleanup: verifyCleanup,
        disposeTreeCleanupChannel: cleanupChannel.close,
      };
    } catch (error) {
      if (cleanupOwner && !cleanupAttempted) {
        try {
          cleanupAttempted = true;
          await cleanupOwner.cleanup();
          cleanupOwner.dispose();
        } catch {
          throw attachSpawnCleanupOwner(error, cleanupOwner);
        }
      }
      if (!cleanupOwner) {
        cleanupOwner = createSpawnCleanupOwner(
          shell,
          takeEarlyEvents,
          verifyCleanup,
          cleanupChannel.close,
          cleanupChannel.markCompleted,
        );
        try {
          await cleanupOwner.cleanup();
          cleanupOwner.dispose();
          cleanupChannel.close();
        } catch {
          throw attachSpawnCleanupOwner(error, cleanupOwner);
        }
      }
      throw error;
    }
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
    let resolved: Awaited<ReturnType<typeof resolveCommandParts>>;
    try {
      resolved = await resolveCommandParts(commandParts);
    } catch (error) {
      throw markPreChildProcessFailure(error);
    }
    const { programPath, args } = resolved;
    const env = config.env.withProfile(this.cmdOverrides);

    const cancel = new CancellationToken();

    // 不添加 prompt 到参数列表，因为会通过 stdin 发送
    const fullArgs = [...args];

    // 使用临时文件传递 stdin 数据，避免命令行参数长度限制
    const tmpFile = path.join(os.tmpdir(), `agent-tower-stdin-${Date.now()}-${randomUUID()}.txt`);
    try {
      await fs.writeFile(tmpFile, stdinData, { encoding: 'utf-8', mode: 0o600 });
    } catch (error) {
      throw markPreChildProcessFailure(error);
    }
    ptyLog(0, `Spawning with stdin: ${programPath} ${redactArgsForLog(fullArgs)} <stdin ${summarizeStdinForLog(stdinData)} file=${path.basename(tmpFile)}>`);
    const invocation = buildPtyCommandWithStdin(programPath, fullArgs, tmpFile);

    const fullEnv = env.getFullEnv();
    const ownershipToken = randomUUID();
    let cleanupChannel: TreeCleanupChannel;
    try {
      cleanupChannel = await createTreeCleanupChannel();
    } catch (error) {
      await fs.unlink(tmpFile).catch(() => undefined);
      throw markPreChildProcessFailure(error);
    }
    const verifyCleanup = () => cleanupChannel.isCompleted();
    const wrapperEnv = buildPtyWrapperEnv(fullEnv, process.env, ownershipToken, cleanupChannel.env);
    ptyLog(0, `ENV ANTHROPIC_BASE_URL=${fullEnv.ANTHROPIC_BASE_URL || '(not set)'}`);
    ptyLog(0, `ENV ANTHROPIC_API_KEY=${fullEnv.ANTHROPIC_API_KEY ? '(set)' : '(not set)'}`);
    ptyLog(0, `ENV ANTHROPIC_AUTH_TOKEN=${fullEnv.ANTHROPIC_AUTH_TOKEN ? '(set)' : '(not set)'}`);

    let shell: IPty | undefined;
    let identity: SpawnedProcessIdentity | null = null;
    let takeEarlyEvents: (() => EarlyPtyEvent[]) | undefined;
    let offData: { dispose(): void } | undefined;
    let offExit: { dispose(): void } | undefined;
    let cleanupOwner: SpawnCleanupOwner | undefined;
    let cleanupAttempted = false;

    try {
      const ptyCols = process.platform === 'win32' ? 16384 : 120;
      shell = pty.spawn(invocation.command, invocation.args, {
        name: 'xterm-256color',
        cols: ptyCols,
        rows: 30,
        cwd: config.workingDir,
        env: wrapperEnv,
      });
      const spawnedShell = shell;

      ptyLog(spawnedShell.pid, `Process spawned with stdin`);

      takeEarlyEvents = this.collectEarlyPtyEvents(spawnedShell);
      let identityError: unknown;
      try {
        identity = await captureSpawnedProcessIdentity(spawnedShell.pid, ownershipToken);
        if (!identity) {
          throw new Error(`Could not persist a verifiable process identity for ${this.displayName}`);
        }
      } catch (error) {
        identityError = error;
      }
      if (identityError) {
        cleanupOwner = createSpawnCleanupOwner(
          spawnedShell,
          takeEarlyEvents,
          verifyCleanup,
          cleanupChannel.close,
          cleanupChannel.markCompleted,
        );
        try {
          cleanupAttempted = true;
          await cleanupOwner.cleanup();
          cleanupOwner.dispose();
          cleanupChannel.close();
        } catch {
          throw attachSpawnCleanupOwner(identityError, cleanupOwner);
        }
        throw markPreChildProcessFailure(identityError);
      }
      if (!identity) {
        throw new Error(`Could not persist a verifiable process identity for ${this.displayName}`);
      }

      let outputBuffer = '';
      offData = spawnedShell.onData((data) => {
        if (outputBuffer.length < OUTPUT_BUFFER_LIMIT) {
          outputBuffer += data;
        }
        logPtyOutput(spawnedShell.pid, data);
      });

      // 监听退出事件
      offExit = spawnedShell.onExit(({ exitCode, signal }) => {
        if (isTrustedWrapperExit({ exitCode, signal })) cleanupChannel.markCompleted();
        offData?.dispose();
        offExit?.dispose();
        ptyLog(spawnedShell.pid, `PTY exited code=${exitCode} signal=${signal} outputLength=${outputBuffer.length}`);
        if (exitCode !== 0) {
          writeErrorLog({
            level: 'warn',
            source: 'executor.exit',
            message: `${this.displayName} exited with non-zero code ${exitCode}`,
            metadata: {
              agentType: this.agentType,
              displayName: this.displayName,
              pid: spawnedShell.pid,
              exitCode,
              signal,
              workingDir: config.workingDir,
              outputLength: outputBuffer.length,
            },
          });
        }
      });

      // 监听取消信号
      cancel.onCancelled(() => {
        spawnedShell.kill('SIGINT');
      });

      cleanupOwner?.dispose();

      return {
        pid: spawnedShell.pid,
        ...identity,
        pty: spawnedShell,
        cancel,
        takeEarlyEvents,
        verifyTreeCleanup: verifyCleanup,
        disposeTreeCleanupChannel: cleanupChannel.close,
      };
    } catch (error) {
      writeErrorLog({
        level: 'error',
        source: 'executor.spawnWithStdin',
        message: `Failed to spawn ${this.displayName} with stdin`,
        error,
        metadata: {
          agentType: this.agentType,
          displayName: this.displayName,
          programPath,
          workingDir: config.workingDir,
          stdinLength: Buffer.byteLength(stdinData, 'utf8'),
          stdinSha256: hashForLog(stdinData),
        },
      });
      offData?.dispose();
      offExit?.dispose();
      if (shell) {
        if (cleanupOwner && !cleanupAttempted) {
          try {
            cleanupAttempted = true;
            await cleanupOwner.cleanup();
            cleanupOwner.dispose();
          } catch {
            throw attachSpawnCleanupOwner(error, cleanupOwner);
          }
        }
        if (!cleanupOwner) {
          cleanupOwner = createSpawnCleanupOwner(
            shell,
            takeEarlyEvents,
            verifyCleanup,
            cleanupChannel.close,
            cleanupChannel.markCompleted,
          );
          try {
            cleanupAttempted = true;
            await cleanupOwner.cleanup();
            cleanupOwner.dispose();
            cleanupChannel.close();
          } catch {
            throw attachSpawnCleanupOwner(error, cleanupOwner);
          }
        }
      }
      try {
        await fs.unlink(tmpFile);
      } catch {
        // wrapper may already have cleaned it or the file may not exist
      }
      if (!shell) cleanupChannel.close();
      throw shell ? error : markPreChildProcessFailure(error);
    }
  }

  /**
   * 向 PTY 发送消息
   */
  sendMessage(ptyInstance: IPty, message: string): void {
    ptyInstance.write(message + '\n');
  }
}
