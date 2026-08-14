import fs from 'node:fs/promises';
import path from 'node:path';
import type { Prisma } from '@prisma/client';
import type {
  StartWorkspaceBackgroundServiceInput,
  TeamMemberCapabilities,
  WorkspaceBackgroundServiceDto,
  WorkspaceBackgroundServiceInputResponse,
  WorkspaceBackgroundServiceLogsResponse,
  WorkspaceBackgroundServiceRuntimeState,
} from '@agent-tower/shared';
import { ServiceError } from '../errors.js';
import { WorkspaceStatus } from '../types/index.js';
import { prisma } from '../utils/index.js';
import { getWorkspaceWorkingDir } from './workspace-kind.js';
import {
  WorkspaceBackgroundProcessManager,
  type WorkspaceBackgroundProcessExit,
  type WorkspaceBackgroundProcessStartResult,
} from './workspace-background-process-manager.js';
import {
  defaultWorkspaceLifecycleBarrier,
  type WorkspaceLifecycleBarrier,
} from './workspace-lifecycle-barrier.js';

const MAX_SERVICES_PER_WORKSPACE = 20;
const MAX_ARGS = 100;
const MAX_ARG_LENGTH = 8_192;
const MAX_INPUT_BYTES = 8 * 1024;
const DEFAULT_LOG_LIMIT = 100;
const MAX_LOG_LIMIT = 200;
const MAX_LOG_RESPONSE_CHARS = 64 * 1024;
const ACTIVE_RUNTIME_STATES: WorkspaceBackgroundServiceRuntimeState[] = [
  'STARTING',
  'RUNNING',
  'STOPPING',
];
const COUNTED_SERVICE_WHERE = {
  OR: [
    { desiredState: { not: 'STOPPED' } },
    { runtimeState: { not: 'STOPPED' } },
    { runtimeInstanceId: { not: null } },
  ],
} satisfies Prisma.WorkspaceBackgroundServiceWhereInput;

interface WorkspaceBackgroundServiceRecord {
  id: string;
  workspaceId: string;
  name: string;
  command: string;
  argsJson: string;
  relativeCwd: string;
  desiredState: string;
  runtimeState: string;
  runtimeInstanceId: string | null;
  pid: number | null;
  exitCode: number | null;
  lastError: string | null;
  startedAt: Date | null;
  stoppedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function parseArgs(argsJson: string): string[] | null {
  try {
    const value = JSON.parse(argsJson) as unknown;
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null;
    return value;
  } catch {
    return null;
  }
}

function asRuntimeState(value: string): WorkspaceBackgroundServiceRuntimeState {
  return ['STOPPED', 'STARTING', 'RUNNING', 'STOPPING', 'EXITED', 'FAILED'].includes(value)
    ? value as WorkspaceBackgroundServiceRuntimeState
    : 'FAILED';
}

function toDto(record: WorkspaceBackgroundServiceRecord): WorkspaceBackgroundServiceDto {
  const args = parseArgs(record.argsJson);
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    name: record.name,
    command: record.command,
    args: args ?? [],
    relativeCwd: record.relativeCwd,
    desiredState: record.desiredState === 'RUNNING' ? 'RUNNING' : 'STOPPED',
    runtimeState: args ? asRuntimeState(record.runtimeState) : 'FAILED',
    runtimeInstanceId: record.runtimeInstanceId,
    pid: record.pid,
    exitCode: record.exitCode,
    lastError: args ? record.lastError : 'Stored service arguments are invalid',
    startedAt: record.startedAt?.toISOString() ?? null,
    stoppedAt: record.stoppedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function specsMatch(
  record: Pick<WorkspaceBackgroundServiceRecord, 'command' | 'argsJson' | 'relativeCwd'>,
  input: Required<StartWorkspaceBackgroundServiceInput>,
): boolean {
  const args = parseArgs(record.argsJson);
  return record.command === input.command
    && record.relativeCwd === input.relativeCwd
    && args !== null
    && args.length === input.args.length
    && args.every((arg, index) => arg === input.args[index]);
}

function isFullyStopped(
  record: Pick<WorkspaceBackgroundServiceRecord, 'desiredState' | 'runtimeState' | 'runtimeInstanceId'>,
): boolean {
  return record.desiredState === 'STOPPED'
    && record.runtimeState === 'STOPPED'
    && record.runtimeInstanceId === null;
}

function parseCapabilities(value: string): Partial<TeamMemberCapabilities> {
  try {
    return JSON.parse(value) as Partial<TeamMemberCapabilities>;
  } catch {
    return {};
  }
}

export class WorkspaceBackgroundService {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly processManager = new WorkspaceBackgroundProcessManager(),
    private readonly lifecycleBarrier: WorkspaceLifecycleBarrier = defaultWorkspaceLifecycleBarrier,
  ) {}

  async authorizeCaller(
    workspaceId: string,
    caller: {
      kind: 'browser' | 'agent' | 'internal';
      sessionId?: string | null;
      invocationId?: string | null;
    },
    access: 'read' | 'control' = 'control',
  ): Promise<void> {
    if (caller.kind === 'browser') {
      if (access === 'read') {
        await this.requireWorkspace(workspaceId, false);
        return;
      }
      throw new ServiceError(
        'Browser control of workspace services is not available',
        'WORKSPACE_SERVICE_BROWSER_UNAVAILABLE',
        403,
      );
    }
    if (!caller.sessionId) {
      throw new ServiceError(
        'Internal workspace service calls require a session identity',
        'INTERNAL_CALLER_IDENTITY_REQUIRED',
        403,
      );
    }
    const session = await prisma.session.findUnique({
      where: { id: caller.sessionId },
      select: { workspaceId: true },
    });
    if (!session) {
      throw new ServiceError('Agent session was not found', 'INTERNAL_SESSION_NOT_FOUND', 403);
    }
    if (session.workspaceId !== workspaceId) {
      throw new ServiceError(
        'Agent session is not bound to this workspace',
        'SESSION_WORKSPACE_MISMATCH',
        403,
      );
    }

    if (!caller.invocationId) {
      const sessionInvocation = await prisma.agentInvocation.findFirst({
        where: { sessionId: caller.sessionId },
        select: { id: true },
      });
      if (!sessionInvocation) return;
      throw new ServiceError(
        'TeamRun workspace service calls require an invocation identity',
        'INVOCATION_IDENTITY_REQUIRED',
        403,
      );
    }
    const invocation = await prisma.agentInvocation.findUnique({
      where: { id: caller.invocationId },
    });
    if (!invocation || invocation.sessionId !== caller.sessionId) {
      throw new ServiceError(
        'Agent invocation is not bound to this session',
        'INVOCATION_SESSION_MISMATCH',
        403,
      );
    }
    if (invocation.workspaceId !== workspaceId) {
      throw new ServiceError(
        'Agent invocation is not bound to this workspace',
        'INVOCATION_WORKSPACE_MISMATCH',
        403,
      );
    }
    const member = await prisma.teamMember.findUnique({ where: { id: invocation.memberId } });
    if (!member || member.teamRunId !== invocation.teamRunId || member.membershipStatus === 'REMOVED') {
      throw new ServiceError('TeamRun member is not active', 'FORBIDDEN', 403);
    }
    if (parseCapabilities(member.capabilities).runCommands !== true) {
      throw new ServiceError(
        'TeamRun member lacks runCommands capability',
        'TEAM_RUN_MEMBER_CAPABILITY_REQUIRED',
        403,
      );
    }
  }

  async list(workspaceId: string): Promise<WorkspaceBackgroundServiceDto[]> {
    await this.requireWorkspace(workspaceId, false);
    const records = await prisma.workspaceBackgroundService.findMany({
      where: { workspaceId, ...COUNTED_SERVICE_WHERE },
      orderBy: { createdAt: 'asc' },
    });
    return records.map((record) => toDto(record));
  }

  async start(
    workspaceId: string,
    name: string,
    rawInput: StartWorkspaceBackgroundServiceInput,
  ): Promise<WorkspaceBackgroundServiceDto> {
    const input = this.validateStartInput(name, rawInput);
    return this.lifecycleBarrier.withWorkspace(workspaceId, () => (
      this.withLock(`${workspaceId}:${name}`, async () => {
        const workspace = await this.requireWorkspace(workspaceId, true);
        const cwd = await this.resolveCwd(getWorkspaceWorkingDir(workspace), input.relativeCwd);
        let record = await prisma.workspaceBackgroundService.findUnique({
          where: { workspaceId_name: { workspaceId, name } },
        });

        if (record && !specsMatch(record, input)) {
          throw new ServiceError(
            `Workspace service "${name}" already exists with a different command`,
            'SERVICE_SPEC_CONFLICT',
            409,
          );
        }
        if (
          record
          && (record.runtimeState === 'STARTING' || record.runtimeState === 'RUNNING')
          && this.processManager.has(record.id, record.runtimeInstanceId)
        ) {
          return toDto(record);
        }
        if (record && this.processManager.has(record.id)) {
          throw new ServiceError('Workspace service is busy', 'SERVICE_BUSY', 409);
        }
        if (!record || isFullyStopped(record)) {
          await this.requireAvailableServiceSlot(workspaceId);
        }
        if (!record) {
          record = await prisma.workspaceBackgroundService.create({
            data: {
              workspaceId,
              name,
              command: input.command,
              argsJson: JSON.stringify(input.args),
              relativeCwd: input.relativeCwd,
            },
          });
        }

        return this.startRecord(record, cwd);
      })
    ));
  }

  async stop(workspaceId: string, name: string): Promise<WorkspaceBackgroundServiceDto> {
    return this.lifecycleBarrier.withWorkspace(workspaceId, () => (
      this.withLock(`${workspaceId}:${name}`, async () => {
        await this.requireWorkspace(workspaceId, false);
        const record = await this.requireRecord(workspaceId, name);
        return toDto(await this.stopRecord(record, false));
      })
    ));
  }

  async restart(workspaceId: string, name: string): Promise<WorkspaceBackgroundServiceDto> {
    return this.lifecycleBarrier.withWorkspace(workspaceId, () => (
      this.withLock(`${workspaceId}:${name}`, async () => {
        const workspace = await this.requireWorkspace(workspaceId, true);
        let record = await this.requireRecord(workspaceId, name);
        record = await this.stopRecord(record, false);
        await this.requireAvailableServiceSlot(workspaceId);
        const args = parseArgs(record.argsJson);
        if (!args) {
          throw new ServiceError('Stored service arguments are invalid', 'SERVICE_SPEC_CONFLICT', 409);
        }
        const cwd = await this.resolveCwd(getWorkspaceWorkingDir(workspace), record.relativeCwd);
        return this.startRecord(record, cwd);
      })
    ));
  }

  async getLogs(
    workspaceId: string,
    name: string,
    options: { afterSeq?: number; runtimeInstanceId?: string; limit?: number } = {},
  ): Promise<WorkspaceBackgroundServiceLogsResponse> {
    await this.requireWorkspace(workspaceId, false);
    const record = await this.requireRecord(workspaceId, name);
    const limit = Math.min(MAX_LOG_LIMIT, Math.max(1, options.limit ?? DEFAULT_LOG_LIMIT));
    const logs = this.processManager.getLogs(record.id, {
      afterSeq: options.afterSeq,
      runtimeInstanceId: options.runtimeInstanceId,
      limit,
      maxChars: MAX_LOG_RESPONSE_CHARS,
    });
    return {
      serviceName: record.name,
      runtimeState: asRuntimeState(record.runtimeState),
      ...logs,
    };
  }

  async sendInput(
    workspaceId: string,
    name: string,
    data: string,
  ): Promise<WorkspaceBackgroundServiceInputResponse> {
    const byteLength = Buffer.byteLength(data, 'utf8');
    if (byteLength === 0 || byteLength > MAX_INPUT_BYTES) {
      throw new ServiceError(
        `Workspace service input must be between 1 and ${MAX_INPUT_BYTES} bytes`,
        'VALIDATION_ERROR',
        400,
      );
    }
    await this.requireWorkspace(workspaceId, false);
    const record = await this.requireRecord(workspaceId, name);
    if (
      !record.runtimeInstanceId
      || !['STARTING', 'RUNNING'].includes(record.runtimeState)
      || !this.processManager.has(record.id, record.runtimeInstanceId)
    ) {
      throw new ServiceError('Workspace service is not running', 'SERVICE_NOT_RUNNING', 409);
    }
    this.processManager.write(record.id, record.runtimeInstanceId, data);
    return { serviceName: name, accepted: true, byteLength };
  }

  async stopAllForWorkspace(
    workspaceId: string,
    options: { preserveDesired?: boolean } = {},
  ): Promise<void> {
    await this.lifecycleBarrier.withWorkspace(workspaceId, async () => {
      const records = await prisma.workspaceBackgroundService.findMany({ where: { workspaceId } });
      const errors: unknown[] = [];
      for (const record of records) {
        try {
          await this.withLock(`${workspaceId}:${record.name}`, async () => {
            const current = await prisma.workspaceBackgroundService.findUnique({ where: { id: record.id } });
            if (current) await this.stopRecord(current, options.preserveDesired === true);
          });
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) throw errors[0];
    }, { allowReentry: true });
  }

  async releaseLogsForWorkspace(workspaceId: string): Promise<void> {
    const records = await prisma.workspaceBackgroundService.findMany({
      where: { workspaceId },
      select: { id: true },
    });
    for (const record of records) this.processManager.forget(record.id);
  }

  async reconcile(): Promise<void> {
    await prisma.workspaceBackgroundService.updateMany({
      where: { runtimeState: { in: ACTIVE_RUNTIME_STATES } },
      data: {
        runtimeState: 'STOPPED',
        runtimeInstanceId: null,
        pid: null,
        stoppedAt: new Date(),
      },
    });
    const desired = await prisma.workspaceBackgroundService.findMany({
      where: { desiredState: 'RUNNING' },
      include: { workspace: { include: { task: { include: { project: true } } } } },
    });
    for (const record of desired) {
      const workspace = record.workspace;
      const args = parseArgs(record.argsJson);
      if (!args) {
        await prisma.workspaceBackgroundService.update({
          where: { id: record.id },
          data: {
            runtimeState: 'FAILED',
            runtimeInstanceId: null,
            pid: null,
            lastError: 'Stored service arguments are invalid',
          },
        });
        continue;
      }
      if (
        workspace.status !== WorkspaceStatus.ACTIVE
        || workspace.task.deletedAt
        || workspace.task.project.archivedAt
      ) {
        await prisma.workspaceBackgroundService.update({
          where: { id: record.id },
          data: { desiredState: 'STOPPED', runtimeState: 'STOPPED' },
        });
        continue;
      }
      try {
        await this.start(workspace.id, record.name, {
          command: record.command,
          args,
          relativeCwd: record.relativeCwd,
        });
      } catch (error) {
        // A cwd or validation failure can happen before startRecord() creates a
        // runtime generation, so reconcile owns the fallback FAILED state.
        if (this.processManager.has(record.id)) continue;
        const message = error instanceof ServiceError
          ? error.message
          : 'Failed to restore workspace service';
        await prisma.workspaceBackgroundService.updateMany({
          where: { id: record.id, desiredState: 'RUNNING' },
          data: {
            runtimeState: 'FAILED',
            runtimeInstanceId: null,
            pid: null,
            lastError: message,
            stoppedAt: new Date(),
          },
        });
      }
    }
  }

  async shutdown(): Promise<void> {
    const records = await prisma.workspaceBackgroundService.findMany({
      where: { runtimeState: { in: ACTIVE_RUNTIME_STATES } },
    });
    const errors: unknown[] = [];
    for (const record of records) {
      try {
        await this.withLock(`${record.workspaceId}:${record.name}`, async () => {
          const current = await prisma.workspaceBackgroundService.findUnique({ where: { id: record.id } });
          if (current) await this.stopRecord(current, true);
        });
      } catch (error) {
        errors.push(error);
      }
    }
    await this.processManager.stopAll();
    if (errors.length > 0) throw errors[0];
  }

  private async startRecord(
    record: WorkspaceBackgroundServiceRecord,
    cwd: string,
  ): Promise<WorkspaceBackgroundServiceDto> {
    const args = parseArgs(record.argsJson);
    if (!args) {
      const failed = await prisma.workspaceBackgroundService.update({
        where: { id: record.id },
        data: { desiredState: 'RUNNING', runtimeState: 'FAILED', lastError: 'Stored service arguments are invalid' },
      });
      return toDto(failed);
    }
    const runtimeInstanceId = this.processManager.createRuntimeInstanceId();
    await prisma.workspaceBackgroundService.update({
      where: { id: record.id },
      data: {
        desiredState: 'RUNNING',
        runtimeState: 'STARTING',
        runtimeInstanceId,
        pid: null,
        exitCode: null,
        lastError: null,
        stoppedAt: null,
      },
    });
    let started: WorkspaceBackgroundProcessStartResult | null = null;
    try {
      started = await this.processManager.start(
        record.id,
        runtimeInstanceId,
        { command: record.command, args, cwd },
        (event) => this.handleProcessExit(event),
      );
      const promoted = await prisma.workspaceBackgroundService.updateMany({
        where: { id: record.id, runtimeInstanceId, runtimeState: 'STARTING' },
        data: { runtimeState: 'RUNNING', pid: started.pid, startedAt: new Date() },
      });
      if (promoted.count !== 1) {
        throw new ServiceError(
          'Workspace service start state was superseded',
          'SERVICE_START_FAILED',
          500,
        );
      }
      return toDto(await prisma.workspaceBackgroundService.findUniqueOrThrow({ where: { id: record.id } }));
    } catch (error) {
      let cleanupError: unknown = null;
      if (started || this.processManager.has(record.id, runtimeInstanceId)) {
        try {
          await this.processManager.stop(record.id, runtimeInstanceId);
        } catch (stopError) {
          cleanupError = stopError;
        }
      }
      const message = error instanceof ServiceError
        ? error.message
        : 'Failed to start workspace service';
      const runtimeStillActive = this.processManager.has(record.id, runtimeInstanceId);
      await prisma.workspaceBackgroundService.updateMany({
        where: { id: record.id },
        data: {
          runtimeState: 'FAILED',
          runtimeInstanceId: runtimeStillActive ? runtimeInstanceId : null,
          pid: runtimeStillActive ? started?.pid ?? null : null,
          lastError: cleanupError
            ? `${message}; spawned process cleanup failed`
            : message,
          stoppedAt: new Date(),
        },
      });
      if (cleanupError) {
        throw new ServiceError(
          'Workspace service failed to start and its process could not be stopped',
          'SERVICE_START_CLEANUP_FAILED',
          500,
        );
      }
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(message, 'SERVICE_START_FAILED', 500);
    }
  }

  private async stopRecord(
    record: WorkspaceBackgroundServiceRecord,
    preserveDesired: boolean,
  ): Promise<WorkspaceBackgroundServiceRecord> {
    const desiredState = preserveDesired ? record.desiredState : 'STOPPED';
    if (record.runtimeInstanceId && this.processManager.has(record.id, record.runtimeInstanceId)) {
      await prisma.workspaceBackgroundService.updateMany({
        where: { id: record.id, runtimeInstanceId: record.runtimeInstanceId },
        data: { desiredState, runtimeState: 'STOPPING' },
      });
      await this.processManager.stop(record.id, record.runtimeInstanceId);
    }
    await prisma.workspaceBackgroundService.update({
      where: { id: record.id },
      data: {
        desiredState,
        runtimeState: 'STOPPED',
        runtimeInstanceId: null,
        pid: null,
        stoppedAt: new Date(),
      },
    });
    return prisma.workspaceBackgroundService.findUniqueOrThrow({ where: { id: record.id } });
  }

  private async handleProcessExit(event: WorkspaceBackgroundProcessExit): Promise<void> {
    const record = await prisma.workspaceBackgroundService.findUnique({ where: { id: event.serviceId } });
    if (!record || record.runtimeInstanceId !== event.runtimeInstanceId) return;
    const stopped = record.desiredState === 'STOPPED' || record.runtimeState === 'STOPPING';
    await prisma.workspaceBackgroundService.updateMany({
      where: { id: record.id, runtimeInstanceId: event.runtimeInstanceId },
      data: {
        runtimeState: stopped ? 'STOPPED' : event.exitCode === 0 ? 'EXITED' : 'FAILED',
        runtimeInstanceId: null,
        pid: null,
        exitCode: event.exitCode,
        lastError: stopped || event.exitCode === 0 ? null : `Process exited with code ${event.exitCode}`,
        stoppedAt: new Date(),
      },
    });
  }

  private validateStartInput(
    name: string,
    rawInput: StartWorkspaceBackgroundServiceInput,
  ): Required<StartWorkspaceBackgroundServiceInput> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
      throw new ServiceError('Invalid workspace service name', 'VALIDATION_ERROR', 400);
    }
    const command = rawInput.command.trim();
    const args = rawInput.args ?? [];
    const relativeCwd = rawInput.relativeCwd?.trim() || '.';
    if (!command || command.length > 512 || command.includes('\0')) {
      throw new ServiceError('Invalid workspace service command', 'VALIDATION_ERROR', 400);
    }
    if (args.length > MAX_ARGS || args.some((arg) => arg.length > MAX_ARG_LENGTH || arg.includes('\0'))) {
      throw new ServiceError('Invalid workspace service arguments', 'VALIDATION_ERROR', 400);
    }
    if (path.isAbsolute(relativeCwd) || relativeCwd.includes('\0')) {
      throw new ServiceError('relativeCwd must be relative to the workspace', 'CWD_OUTSIDE_WORKSPACE', 400);
    }
    return { command, args, relativeCwd };
  }

  private async resolveCwd(workingDir: string, relativeCwd: string): Promise<string> {
    const base = await fs.realpath(workingDir).catch(() => null);
    const candidate = await fs.realpath(path.resolve(workingDir, relativeCwd)).catch(() => null);
    if (!base || !candidate) {
      throw new ServiceError('Workspace service working directory does not exist', 'CWD_NOT_FOUND', 400);
    }
    const relative = path.relative(base, candidate);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new ServiceError('relativeCwd resolves outside the workspace', 'CWD_OUTSIDE_WORKSPACE', 400);
    }
    const stat = await fs.stat(candidate);
    if (!stat.isDirectory()) {
      throw new ServiceError('Workspace service working directory is not a directory', 'CWD_NOT_FOUND', 400);
    }
    return candidate;
  }

  private async requireWorkspace(workspaceId: string, requireActive: boolean) {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: { task: { include: { project: true } } },
    });
    if (!workspace || workspace.task.deletedAt) {
      throw new ServiceError('Workspace not found', 'WORKSPACE_NOT_FOUND', 404);
    }
    if (
      requireActive
      && (workspace.status !== WorkspaceStatus.ACTIVE || workspace.task.project.archivedAt)
    ) {
      throw new ServiceError('Workspace is not active', 'WORKSPACE_NOT_ACTIVE', 409);
    }
    return workspace;
  }

  private async requireRecord(workspaceId: string, name: string): Promise<WorkspaceBackgroundServiceRecord> {
    const record = await prisma.workspaceBackgroundService.findUnique({
      where: { workspaceId_name: { workspaceId, name } },
    });
    if (!record) {
      throw new ServiceError('Workspace service not found', 'WORKSPACE_SERVICE_NOT_FOUND', 404);
    }
    return record;
  }

  private async requireAvailableServiceSlot(workspaceId: string): Promise<void> {
    const count = await prisma.workspaceBackgroundService.count({
      where: { workspaceId, ...COUNTED_SERVICE_WHERE },
    });
    if (count >= MAX_SERVICES_PER_WORKSPACE) {
      throw new ServiceError(
        `Workspace service limit reached (${MAX_SERVICES_PER_WORKSPACE})`,
        'WORKSPACE_SERVICE_LIMIT_REACHED',
        429,
      );
    }
  }

  private async withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.locks.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
}
