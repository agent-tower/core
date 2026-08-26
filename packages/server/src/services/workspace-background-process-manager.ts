import type { IPty } from '@shitiandmw/node-pty';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  WorkspaceBackgroundServiceLogEntry,
} from '@agent-tower/shared';
import { ServiceError } from '../errors.js';
import { buildCleanAgentCliEnv } from './agent-cli/security.js';
import { buildPtyCommand, buildPtyWrapperEnv } from '../utils/process-launch.js';
import { which } from '../utils/index.js';
import { writeErrorLog } from '../utils/error-log.js';
import {
  createUnixProcessIdentityAdapter,
  type UnixProcessGroupIdentity,
  type UnixProcessIdentity,
  type UnixProcessIdentityAdapter,
} from '../utils/unix-process-identity.js';

const MAX_LOG_ENTRIES = 2_000;
const MAX_LOG_BYTES = 1024 * 1024;
const MAX_LOG_ENTRY_BYTES = 32 * 1024;
// The PTY wrapper escalates its child process group after five seconds.
// Wait beyond that boundary before applying the manager-level fallback.
const STOP_TIMEOUT_MS = 7_500;
const FORCE_KILL_EXIT_TIMEOUT_MS = 2_000;

export interface WorkspaceBackgroundProcessSpec {
  command: string;
  args: string[];
  cwd: string;
}

export interface WorkspaceBackgroundProcessExit {
  serviceId: string;
  runtimeInstanceId: string;
  exitCode: number;
}

export interface WorkspaceBackgroundProcessStartResult {
  runtimeInstanceId: string;
  pid: number;
}

interface ManagedProcess {
  runtimeInstanceId: string;
  pty: IPty | null;
  pid: number | null;
  ownershipToken: string;
  rootIdentity: UnixProcessIdentity | null;
  cleanups: Array<{ dispose(): void }>;
  exitPromise: Promise<number>;
  resolveExit: (exitCode: number) => void;
}

interface ServiceLogBuffer {
  runtimeInstanceId: string;
  entries: WorkspaceBackgroundServiceLogEntry[];
  nextSeq: number;
  totalBytes: number;
}

export interface WorkspaceBackgroundProcessManagerOptions {
  spawn?: PtySpawn;
  resolveCommand?: (command: string, env: NodeJS.ProcessEnv) => Promise<string | null>;
  stopTimeoutMs?: number;
  platform?: NodeJS.Platform;
  unixProcessAdapter?: UnixProcessIdentityAdapter;
}

type PtySpawn = typeof import('@shitiandmw/node-pty').spawn;

export class WorkspaceBackgroundProcessManager {
  private readonly processes = new Map<string, ManagedProcess>();
  private readonly logs = new Map<string, ServiceLogBuffer>();
  private readonly spawnPty?: PtySpawn;
  private readonly resolveCommand: (command: string, env: NodeJS.ProcessEnv) => Promise<string | null>;
  private readonly stopTimeoutMs: number;
  private readonly platform: NodeJS.Platform;
  private readonly unixProcessAdapter: UnixProcessIdentityAdapter;

  constructor(options: WorkspaceBackgroundProcessManagerOptions = {}) {
    this.spawnPty = options.spawn;
    this.resolveCommand = options.resolveCommand ?? ((command, env) => which(command, { env }));
    this.stopTimeoutMs = options.stopTimeoutMs ?? STOP_TIMEOUT_MS;
    this.platform = options.platform ?? process.platform;
    this.unixProcessAdapter = options.unixProcessAdapter
      ?? createUnixProcessIdentityAdapter(this.platform);
  }

  async start(
    serviceId: string,
    runtimeInstanceId: string,
    spec: WorkspaceBackgroundProcessSpec,
    onExit: (event: WorkspaceBackgroundProcessExit) => void | Promise<void>,
  ): Promise<WorkspaceBackgroundProcessStartResult> {
    if (this.has(serviceId)) {
      throw new ServiceError('Workspace service is already running', 'SERVICE_BUSY', 409);
    }

    const stat = await fs.stat(spec.cwd).catch(() => null);
    if (!stat?.isDirectory()) {
      throw new ServiceError('Workspace service working directory does not exist', 'CWD_NOT_FOUND', 400);
    }

    const cleanEnv = buildCleanAgentCliEnv();
    const programPath = await this.resolveCommand(spec.command, cleanEnv);
    if (!programPath) {
      throw new ServiceError(`Executable not found: ${spec.command}`, 'SERVICE_START_FAILED', 500);
    }

    const ownershipToken = randomUUID();
    const invocation = buildPtyCommand(programPath, spec.args);
    const spawnPty = this.spawnPty ?? (await import('@shitiandmw/node-pty')).spawn;
    const shell = spawnPty(invocation.command, invocation.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: spec.cwd,
      env: buildPtyWrapperEnv(
        cleanEnv as Record<string, string>,
        process.env,
        ownershipToken,
      ),
    });

    let resolveExit!: (exitCode: number) => void;
    const exitPromise = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const managed: ManagedProcess = {
      runtimeInstanceId,
      pty: shell,
      pid: shell.pid,
      ownershipToken,
      rootIdentity: null,
      cleanups: [],
      exitPromise,
      resolveExit,
    };
    this.processes.set(serviceId, managed);
    this.logs.set(serviceId, {
      runtimeInstanceId,
      entries: [],
      nextSeq: 1,
      totalBytes: 0,
    });

    managed.cleanups.push(shell.onData((data) => {
      if (this.processes.get(serviceId)?.runtimeInstanceId !== runtimeInstanceId) return;
      this.appendLog(serviceId, data);
    }));
    managed.cleanups.push(shell.onExit(({ exitCode }) => {
      const current = this.processes.get(serviceId);
      if (!current || current.runtimeInstanceId !== runtimeInstanceId) return;
      this.disposeManagedProcess(current);
      this.processes.delete(serviceId);
      current.resolveExit(exitCode);
      queueMicrotask(() => {
        void Promise.resolve(onExit({ serviceId, runtimeInstanceId, exitCode })).catch((error) => {
          writeErrorLog({
            level: 'error',
            source: 'workspace-background-process.exit',
            message: 'Failed to persist workspace service exit state',
            error,
            metadata: { serviceId, runtimeInstanceId, exitCode },
          });
        });
      });
    }));

    if (this.platform !== 'win32') {
      managed.rootIdentity = await this.captureRootIdentity(shell.pid, ownershipToken);
      if (!managed.rootIdentity && this.processes.get(serviceId) === managed && managed.pty) {
        throw new ServiceError(
          'Workspace service root process identity could not be verified',
          'SERVICE_PROCESS_IDENTITY_UNAVAILABLE',
          500,
        );
      }
    }

    return { runtimeInstanceId, pid: shell.pid };
  }

  has(serviceId: string, runtimeInstanceId?: string | null): boolean {
    const managed = this.processes.get(serviceId);
    return Boolean(
      managed?.pty
      && (!runtimeInstanceId || managed.runtimeInstanceId === runtimeInstanceId),
    );
  }

  write(serviceId: string, runtimeInstanceId: string, data: string): void {
    const managed = this.processes.get(serviceId);
    if (!managed?.pty || managed.runtimeInstanceId !== runtimeInstanceId) {
      throw new ServiceError('Workspace service is not running', 'SERVICE_NOT_RUNNING', 409);
    }
    managed.pty.write(data);
  }

  async stop(serviceId: string, runtimeInstanceId?: string | null): Promise<number | null> {
    const managed = this.processes.get(serviceId);
    if (!managed?.pty) return null;
    if (runtimeInstanceId && managed.runtimeInstanceId !== runtimeInstanceId) return null;

    if (this.platform === 'win32') {
      await this.killWindowsTree(managed.pid);
    } else {
      const rootIdentity = managed.rootIdentity
        ?? await this.captureRootIdentity(managed.pid, managed.ownershipToken);
      if (!rootIdentity) {
        throw new ServiceError(
          'Workspace service root process identity is no longer available',
          'SERVICE_PROCESS_IDENTITY_UNAVAILABLE',
          500,
        );
      }
      managed.rootIdentity = rootIdentity;
      const processGroups = await this.unixProcessAdapter.captureDescendantGroups(rootIdentity);
      await this.unixProcessAdapter.signalProcess(rootIdentity, 'SIGTERM');

      const gracefulExit = await this.waitForExit(managed, this.stopTimeoutMs);
      if (gracefulExit !== null) {
        await this.ensureProcessGroupsExited(processGroups);
        return gracefulExit;
      }

      await this.killProcessGroups(processGroups, 'SIGKILL');
      await this.forceKill(managed);
      const forcedExit = await this.waitForExit(managed, FORCE_KILL_EXIT_TIMEOUT_MS);
      if (forcedExit !== null) {
        await this.ensureProcessGroupsExited(processGroups);
        return forcedExit;
      }
      throw new ServiceError(
        'Workspace service process did not exit after forced termination',
        'SERVICE_STOP_TIMEOUT',
        500,
      );
    }

    const gracefulExit = await this.waitForExit(managed, this.stopTimeoutMs);
    if (gracefulExit !== null) return gracefulExit;

    await this.forceKill(managed);
    const forcedExit = await this.waitForExit(managed, FORCE_KILL_EXIT_TIMEOUT_MS);
    if (forcedExit !== null) return forcedExit;
    throw new ServiceError(
      'Workspace service process did not exit after forced termination',
      'SERVICE_STOP_TIMEOUT',
      500,
    );
  }

  forget(serviceId: string): void {
    if (this.has(serviceId)) {
      throw new ServiceError('Cannot release logs for a running workspace service', 'SERVICE_BUSY', 409);
    }
    this.logs.delete(serviceId);
  }

  getLogs(
    serviceId: string,
    options: {
      afterSeq?: number;
      runtimeInstanceId?: string;
      limit: number;
      maxChars: number;
    },
  ): {
    runtimeInstanceId: string | null;
    entries: WorkspaceBackgroundServiceLogEntry[];
    oldestSeq: number;
    nextSeq: number;
    reset: boolean;
    truncated: boolean;
    hasMore: boolean;
  } {
    const buffer = this.logs.get(serviceId);
    const actualRuntimeInstanceId = buffer?.runtimeInstanceId ?? null;
    const entriesInBuffer = buffer?.entries ?? [];
    const bufferNextSeq = buffer?.nextSeq ?? 1;
    const oldestSeq = entriesInBuffer[0]?.seq ?? bufferNextSeq;
    const generationWasReset = options.runtimeInstanceId !== undefined
      && options.runtimeInstanceId !== actualRuntimeInstanceId;
    const cursorWasReset = !generationWasReset
      && options.afterSeq !== undefined
      && options.afterSeq >= bufferNextSeq;
    const reset = generationWasReset || cursorWasReset;
    const effectiveAfterSeq = generationWasReset
      ? oldestSeq - 1
      : cursorWasReset
        ? undefined
        : options.afterSeq;
    const available = effectiveAfterSeq === undefined
      ? entriesInBuffer.slice(-options.limit)
      : entriesInBuffer.filter((entry) => entry.seq > effectiveAfterSeq);
    const entries: WorkspaceBackgroundServiceLogEntry[] = [];
    let chars = 0;
    for (const entry of available) {
      if (entries.length >= options.limit) break;
      if (entries.length > 0 && chars + entry.data.length > options.maxChars) break;
      entries.push(entry);
      chars += entry.data.length;
    }
    const lastSeq = entries.at(-1)?.seq;
    const availableLastSeq = available.at(-1)?.seq;
    const bufferWasTruncated = oldestSeq > 1 && (
      generationWasReset
      || effectiveAfterSeq === undefined
      || effectiveAfterSeq < oldestSeq - 1
    );
    const hasMore = lastSeq !== undefined && availableLastSeq !== undefined && lastSeq < availableLastSeq;
    return {
      runtimeInstanceId: actualRuntimeInstanceId,
      entries,
      oldestSeq,
      nextSeq: (lastSeq ?? effectiveAfterSeq ?? (oldestSeq - 1)) + 1,
      reset,
      truncated: bufferWasTruncated,
      hasMore,
    };
  }

  async stopAll(): Promise<void> {
    const results = await Promise.allSettled([...this.processes.entries()].map(([serviceId, managed]) => (
      this.stop(serviceId, managed.runtimeInstanceId)
    )));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  createRuntimeInstanceId(): string {
    return randomUUID();
  }

  private appendLog(serviceId: string, rawData: string): void {
    const data = Buffer.byteLength(rawData, 'utf8') > MAX_LOG_ENTRY_BYTES
      ? Buffer.from(rawData, 'utf8').subarray(0, MAX_LOG_ENTRY_BYTES).toString('utf8')
      : rawData;
    const managed = this.processes.get(serviceId);
    if (!managed) return;
    const buffer = this.logs.get(serviceId) ?? {
      runtimeInstanceId: managed.runtimeInstanceId,
      entries: [],
      nextSeq: 1,
      totalBytes: 0,
    };
    const entry: WorkspaceBackgroundServiceLogEntry = {
      seq: buffer.nextSeq++,
      timestamp: new Date().toISOString(),
      data,
    };
    buffer.entries.push(entry);
    buffer.totalBytes += Buffer.byteLength(data, 'utf8');
    while (buffer.entries.length > MAX_LOG_ENTRIES || buffer.totalBytes > MAX_LOG_BYTES) {
      const removed = buffer.entries.shift();
      if (!removed) break;
      buffer.totalBytes -= Buffer.byteLength(removed.data, 'utf8');
    }
    this.logs.set(serviceId, buffer);
  }

  private async forceKill(managed: ManagedProcess): Promise<void> {
    if (!managed.pty || !managed.pid) return;
    if (this.platform === 'win32') {
      await this.killWindowsTree(managed.pid);
      return;
    }
    try {
      if (managed.rootIdentity) {
        await this.unixProcessAdapter.signalProcess(managed.rootIdentity, 'SIGKILL');
      }
    } catch {
      // A concurrent process exit is expected.
    }
  }

  private async killWindowsTree(pid: number | null): Promise<void> {
    if (!pid) return;
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    });
  }

  private async captureRootIdentity(
    pid: number | null,
    ownershipToken: string,
  ): Promise<UnixProcessIdentity | null> {
    if (!pid) return null;
    for (let attempt = 0; attempt < 10; attempt++) {
      const identity = await this.unixProcessAdapter.captureProcess(pid, ownershipToken);
      if (identity) return identity;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return null;
  }

  private async killProcessGroups(
    groups: UnixProcessGroupIdentity[],
    signal: NodeJS.Signals,
  ): Promise<void> {
    await Promise.all(groups.map(async (group) => {
      await this.unixProcessAdapter.signalProcessGroup(group, signal);
    }));
  }

  private async getAliveProcessGroups(
    groups: UnixProcessGroupIdentity[],
  ): Promise<UnixProcessGroupIdentity[]> {
    const alive = await Promise.all(groups.map(async (group) => (
      await this.unixProcessAdapter.isProcessGroupAlive(group) ? group : null
    )));
    return alive.filter((group): group is UnixProcessGroupIdentity => group !== null);
  }

  private async ensureProcessGroupsExited(groups: UnixProcessGroupIdentity[]): Promise<void> {
    if ((await this.getAliveProcessGroups(groups)).length === 0) return;
    await this.killProcessGroups(groups, 'SIGKILL');
    const deadline = Date.now() + FORCE_KILL_EXIT_TIMEOUT_MS;
    while ((await this.getAliveProcessGroups(groups)).length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if ((await this.getAliveProcessGroups(groups)).length > 0) {
      throw new ServiceError(
        'Workspace service descendants survived forced termination',
        'SERVICE_STOP_TIMEOUT',
        500,
      );
    }
  }

  private async waitForExit(managed: ManagedProcess, timeoutMs: number): Promise<number | null> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
      timer.unref?.();
    });
    const exitCode = await Promise.race([managed.exitPromise, timeout]);
    if (timer) clearTimeout(timer);
    return exitCode;
  }

  private disposeManagedProcess(managed: ManagedProcess): void {
    for (const cleanup of managed.cleanups) cleanup.dispose();
    managed.cleanups = [];
    managed.pty = null;
    managed.pid = null;
  }
}
