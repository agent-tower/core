import type { ChildProcess } from 'node:child_process';
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
import { runAgentCliCommand } from './command-runner.js';
import { OwnedChildProcess, spawnOwnedProcess, type ChildProcessOwner } from '../../utils/owned-child-process.js';
import { PROCESS_IDENTITY_ENV } from '../../utils/unix-process-identity.js';

export interface AgentCliRunnerProcess {
  owner?: ChildProcessOwner
  commandResult?: { code: number | null; signal: NodeJS.Signals | null }
  pid?: number
  stdout?: NodeJS.ReadableStream | null
  stderr?: NodeJS.ReadableStream | null
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

export type AgentCliVerifier = (spec: AgentCliCommandSpec, signal?: AbortSignal) => Promise<void>;

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
): AgentCliRunnerProcess {
  return spawnOwnedProcess(command, args, { env: options.env });
}

async function defaultVerifier(spec: AgentCliCommandSpec, signal?: AbortSignal): Promise<void> {
  await runAgentCliCommand(spec, { platform: process.platform === 'win32' ? 'win32' : null, signal });
}

function publicTask(task: AgentCliInstallTask): AgentCliInstallTask {
  return { ...task };
}

export class AgentCliInstallTaskManager {
  private tasks = new Map<string, AgentCliInstallTask>();
  private buffers = new Map<string, AgentCliLogRingBuffer>();
  private previewCleanup = new Map<string, string>();
  private owners = new Map<string, ChildProcessOwner>();
  private completions = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  private verifiers = new Map<string, AbortController>();
  private shuttingDown = false;

  constructor(
    private readonly runner: AgentCliRunner = defaultRunner,
    private readonly forceKillTimeoutMs = CANCEL_FORCE_KILL_TIMEOUT_MS,
    private readonly verifier: AgentCliVerifier = defaultVerifier
  ) {}

  createTask(preview: AgentCliStoredPreview): { reused: boolean; task: AgentCliInstallTask } {
    if (this.shuttingDown) throw new ServiceError('Agent CLI installer is shutting down', 'SERVICE_STOPPING', 503);
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
    let resolveCompletion!: () => void;
    const promise = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    this.completions.set(id, { promise, resolve: resolveCompletion });
    buffer.push('system', `Starting ${preview.toolId} installer`);

    const command = preview.interpreter.command;
    const args = [...preview.interpreter.args, preview.tempFilePath, ...preview.fixedArgs];
    const token = randomUUID();
    let child: AgentCliRunnerProcess;
    try {
      child = this.runner(command, args, {
        env: {
          ...buildCleanAgentCliEnv(undefined, preview.platform),
          ...(preview.env ?? {}),
          [PROCESS_IDENTITY_ENV]: token,
        },
        detached: process.platform !== 'win32',
        stdio: 'pipe',
        windowsHide: true,
      });
    } catch (error) {
      this.finishTask(id, 1, null, 'failed', 'PROCESS_ERROR', 'Installer process failed');
      throw error;
    }

    const owner = child.owner ?? new OwnedChildProcess(child as ChildProcess, token, { graceMs: this.forceKillTimeoutMs });
    this.owners.set(id, owner);
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
      void owner.stop().then(() => this.finishTask(id, 1, null, 'failed', 'PROCESS_ERROR', 'Installer process failed'));
    });
    child.once('exit', (code, signal) => {
      for (const chunk of stdoutRedactor.flush()) {
        buffer.pushRedacted('stdout', chunk);
      }
      for (const chunk of stderrRedactor.flush()) {
        buffer.pushRedacted('stderr', chunk);
      }

      const result = child.commandResult;
      void this.handleInstallerExit(id, preview.verifyCommand, result ? result.code : code, result ? result.signal : signal);
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
    this.verifiers.get(taskId)?.abort();
    void this.owners.get(taskId)?.stop();

    return publicTask(task);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const task of this.tasks.values()) {
      if (!FINAL_STATUSES.has(task.status)) this.cancel(task.id);
    }
    await Promise.all([...this.completions.values()].map(({ promise }) => promise));
  }

  private getRunningTask(): AgentCliInstallTask | null {
    for (const task of this.tasks.values()) {
      if (!FINAL_STATUSES.has(task.status)) return task;
    }
    return null;
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
    this.owners.delete(taskId);
    this.verifiers.delete(taskId);
    this.completions.get(taskId)?.resolve();
    this.completions.delete(taskId);
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
    await this.owners.get(taskId)?.stop();
    this.owners.delete(taskId);
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
    const controller = new AbortController();
    this.verifiers.set(taskId, controller);

    try {
      await this.verifier(verifyCommand, controller.signal);
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
