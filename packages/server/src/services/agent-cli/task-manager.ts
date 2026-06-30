import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  AgentCliCommandSpec,
  AgentCliInstallLogResponse,
  AgentCliInstallTask,
} from '@agent-tower/shared';
import { ServiceError, ValidationError } from '../../errors.js';
import {
  AgentCliLogRingBuffer,
  AgentCliStreamingLogRedactor,
  buildCleanAgentCliEnv,
} from './security.js';
import { type AgentCliStoredPreview, removePreviewFile } from './downloader.js';

export interface AgentCliRunnerProcess {
  pid?: number
  stdout?: NodeJS.ReadableStream
  stderr?: NodeJS.ReadableStream
  kill(signal?: NodeJS.Signals | number): boolean
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  once(event: 'error', listener: (error: Error) => void): this
}

export type AgentCliRunner = (
  command: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv
    detached: boolean
    stdio: 'pipe'
    windowsHide: true
  }
) => AgentCliRunnerProcess;

export type AgentCliVerifier = (spec: AgentCliCommandSpec) => Promise<void>;

const FINAL_STATUSES = new Set<AgentCliInstallTask['status']>([
  'succeeded',
  'failed',
  'cancelled',
]);

const CANCEL_FORCE_KILL_TIMEOUT_MS = 5000;

function defaultRunner(
  command: string,
  args: string[],
  options: Parameters<AgentCliRunner>[2]
): ChildProcessWithoutNullStreams {
  return spawn(command, args, options);
}

function defaultVerifier(spec: AgentCliCommandSpec): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(spec.command, [...spec.args], {
      timeout: spec.timeoutMs,
      maxBuffer: 256 * 1024,
      env: buildCleanAgentCliEnv(),
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
    }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function publicTask(task: AgentCliInstallTask): AgentCliInstallTask {
  return { ...task };
}

export class AgentCliInstallTaskManager {
  private tasks = new Map<string, AgentCliInstallTask>();
  private buffers = new Map<string, AgentCliLogRingBuffer>();
  private processes = new Map<string, AgentCliRunnerProcess>();
  private previewCleanup = new Map<string, string>();

  constructor(
    private readonly runner: AgentCliRunner = defaultRunner,
    private readonly forceKillTimeoutMs = CANCEL_FORCE_KILL_TIMEOUT_MS,
    private readonly verifier: AgentCliVerifier = defaultVerifier
  ) {}

  createTask(preview: AgentCliStoredPreview): { reused: boolean; task: AgentCliInstallTask } {
    const running = this.getRunningTask();
    if (running) {
      void removePreviewFile(preview.tempFilePath);
      return { reused: true, task: publicTask(running) };
    }

    if (new Date(preview.expiresAt).getTime() <= Date.now()) {
      void removePreviewFile(preview.tempFilePath);
      throw new ServiceError('Agent CLI install preview expired', 'AGENT_CLI_PREVIEW_EXPIRED', 409);
    }

    const id = `agent-cli-task-${randomUUID()}`;
    const now = new Date().toISOString();
    const task: AgentCliInstallTask = {
      id,
      toolId: preview.toolId,
      previewId: preview.id,
      status: 'running',
      createdAt: now,
      startedAt: now,
      finishedAt: null,
      exitCode: null,
      signal: null,
    };

    const buffer = new AgentCliLogRingBuffer();
    this.tasks.set(id, task);
    this.buffers.set(id, buffer);
    this.previewCleanup.set(id, preview.tempFilePath);
    buffer.push('system', `Starting ${preview.toolId} installer`);

    const command = preview.interpreter.command;
    const args = [...preview.interpreter.args, preview.tempFilePath, ...preview.fixedArgs];
    const child = this.runner(command, args, {
      env: buildCleanAgentCliEnv(),
      detached: process.platform !== 'win32',
      stdio: 'pipe',
      windowsHide: true,
    });

    this.processes.set(id, child);
    const stdoutRedactor = new AgentCliStreamingLogRedactor();
    const stderrRedactor = new AgentCliStreamingLogRedactor();
    child.stdout?.on('data', (data) => {
      for (const chunk of stdoutRedactor.push(String(data))) {
        buffer.pushRedacted('stdout', chunk);
      }
    });
    child.stderr?.on('data', (data) => {
      for (const chunk of stderrRedactor.push(String(data))) {
        buffer.pushRedacted('stderr', chunk);
      }
    });
    child.once('error', (error) => {
      buffer.push('system', `Installer process failed: ${error.message}`);
      this.finishTask(id, 1, null, 'failed', 'PROCESS_ERROR', 'Installer process failed');
    });
    child.once('exit', (code, signal) => {
      for (const chunk of stdoutRedactor.flush()) {
        buffer.pushRedacted('stdout', chunk);
      }
      for (const chunk of stderrRedactor.flush()) {
        buffer.pushRedacted('stderr', chunk);
      }

      void this.handleInstallerExit(id, preview.verifyCommand, code, signal);
    });

    return { reused: false, task: publicTask(task) };
  }

  getTask(taskId: string): AgentCliInstallTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new ServiceError('Agent CLI install task not found', 'NOT_FOUND', 404);
    return publicTask(task);
  }

  getLogs(taskId: string, afterSeq = 0): AgentCliInstallLogResponse {
    if (!this.tasks.has(taskId)) {
      throw new ServiceError('Agent CLI install task not found', 'NOT_FOUND', 404);
    }
    const buffer = this.buffers.get(taskId);
    if (!buffer) {
      return { taskId, entries: [], nextSeq: afterSeq + 1, truncated: false };
    }
    const { entries, nextSeq, truncated } = buffer.list(afterSeq);
    return { taskId, entries, nextSeq, truncated };
  }

  cancel(taskId: string): AgentCliInstallTask {
    const task = this.tasks.get(taskId);
    if (!task) throw new ServiceError('Agent CLI install task not found', 'NOT_FOUND', 404);
    if (FINAL_STATUSES.has(task.status)) return publicTask(task);

    task.status = 'cancelling';
    this.buffers.get(taskId)?.push('system', 'Cancelling installer task');
    const child = this.processes.get(taskId);
    if (child) {
      this.killProcessGroup(child, 'SIGTERM');
      this.killProcessGroup(child, 'SIGHUP');
      setTimeout(() => {
        if (this.processes.has(taskId)) {
          this.killProcessGroup(child, 'SIGKILL');
        }
      }, this.forceKillTimeoutMs).unref?.();
    }

    return publicTask(task);
  }

  private getRunningTask(): AgentCliInstallTask | null {
    for (const task of this.tasks.values()) {
      if (!FINAL_STATUSES.has(task.status)) return task;
    }
    return null;
  }

  private killProcessGroup(child: AgentCliRunnerProcess, signal: NodeJS.Signals): void {
    if (!child.pid || process.platform === 'win32') {
      child.kill(signal);
      return;
    }

    try {
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  }

  private finishTask(
    taskId: string,
    code: number | null,
    signal: NodeJS.Signals | null,
    status: AgentCliInstallTask['status'],
    errorCode?: string,
    errorMessage?: string
  ): void {
    const task = this.tasks.get(taskId);
    if (!task || FINAL_STATUSES.has(task.status)) return;

    if (!FINAL_STATUSES.has(status)) {
      throw new ValidationError(`Invalid final Agent CLI task status: ${status}`);
    }

    task.status = status;
    task.finishedAt = new Date().toISOString();
    task.exitCode = code;
    task.signal = signal;
    if (errorCode) task.errorCode = errorCode;
    if (errorMessage) task.errorMessage = errorMessage;
    this.processes.delete(taskId);
    this.buffers.get(taskId)?.push('system', `Installer task ${status}`);

    const tempFilePath = this.previewCleanup.get(taskId);
    if (tempFilePath) {
      this.previewCleanup.delete(taskId);
      void removePreviewFile(tempFilePath);
    }
  }

  private async handleInstallerExit(
    taskId: string,
    verifyCommand: AgentCliCommandSpec,
    code: number | null,
    signal: NodeJS.Signals | null
  ): Promise<void> {
    this.processes.delete(taskId);
    const task = this.tasks.get(taskId);
    if (!task || FINAL_STATUSES.has(task.status)) return;

    if (task.status === 'cancelling') {
      this.finishTask(taskId, code, signal, 'cancelled');
      return;
    }

    if (code !== 0) {
      this.finishTask(taskId, code, signal, 'failed');
      return;
    }

    task.status = 'verifying';
    task.exitCode = code;
    task.signal = signal;
    this.buffers.get(taskId)?.push('system', 'Installer exited successfully; verifying CLI availability');

    try {
      await this.verifier(verifyCommand);
      if (this.tasks.get(taskId)?.status === 'cancelling') {
        this.finishTask(taskId, code, signal, 'cancelled');
        return;
      }
      this.buffers.get(taskId)?.push('system', 'Installer verification passed');
      this.finishTask(taskId, code, signal, 'succeeded');
    } catch {
      if (this.tasks.get(taskId)?.status === 'cancelling') {
        this.finishTask(taskId, code, signal, 'cancelled');
        return;
      }
      this.buffers.get(taskId)?.push('system', 'Installer verification failed');
      this.finishTask(taskId, code, signal, 'failed', 'VERIFY_FAILED', 'Installer verification failed');
    }
  }
}
