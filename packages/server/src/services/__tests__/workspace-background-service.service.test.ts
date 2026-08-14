import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-background-service-'));
const dbPath = path.join(testDir, 'test.db');
process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '../../..');
const schemaPath = path.join(serverRoot, 'prisma/schema.prisma');

class FakeProcessManager {
  private next = 1;
  private active = new Map<string, { runtimeInstanceId: string; onExit: (event: any) => unknown }>();
  startCalls = vi.fn();
  stopCalls = vi.fn();
  forget = vi.fn();
  afterStart?: (serviceId: string) => Promise<void>;
  beforeStop?: (serviceId: string) => Promise<void>;
  write = vi.fn();
  callbacks = new Map<string, (event: any) => unknown>();

  createRuntimeInstanceId() {
    return `runtime-${this.next++}`;
  }

  async start(serviceId: string, runtimeInstanceId: string, spec: unknown, onExit: (event: any) => unknown) {
    this.startCalls(serviceId, runtimeInstanceId, spec);
    this.active.set(serviceId, { runtimeInstanceId, onExit });
    this.callbacks.set(runtimeInstanceId, onExit);
    await this.afterStart?.(serviceId);
    return { runtimeInstanceId, pid: 1000 + this.next };
  }

  has(serviceId: string, runtimeInstanceId?: string | null) {
    const active = this.active.get(serviceId);
    return Boolean(active && (!runtimeInstanceId || active.runtimeInstanceId === runtimeInstanceId));
  }

  async stop(serviceId: string, runtimeInstanceId?: string | null) {
    this.stopCalls(serviceId, runtimeInstanceId);
    await this.beforeStop?.(serviceId);
    const active = this.active.get(serviceId);
    if (!active || (runtimeInstanceId && active.runtimeInstanceId !== runtimeInstanceId)) return null;
    this.active.delete(serviceId);
    await active.onExit({ serviceId, runtimeInstanceId: active.runtimeInstanceId, exitCode: 0 });
    return 0;
  }

  getLogs() {
    return {
      runtimeInstanceId: null,
      entries: [],
      oldestSeq: 1,
      nextSeq: 1,
      reset: false,
      truncated: false,
      hasMore: false,
    };
  }

  async stopAll() {}

  async exit(serviceId: string, exitCode: number) {
    const active = this.active.get(serviceId);
    if (!active) return;
    this.active.delete(serviceId);
    await active.onExit({ serviceId, runtimeInstanceId: active.runtimeInstanceId, exitCode });
  }

  async emitLateExit(serviceId: string, runtimeInstanceId: string, exitCode: number) {
    await this.callbacks.get(runtimeInstanceId)?.({ serviceId, runtimeInstanceId, exitCode });
  }
}

let prisma: PrismaClient;
let WorkspaceBackgroundService: typeof import('../workspace-background-service.service.js').WorkspaceBackgroundService;
let WorkspaceLifecycleBarrier: typeof import('../workspace-lifecycle-barrier.js').WorkspaceLifecycleBarrier;

async function createWorkspace(label: string) {
  const workingDir = fs.mkdtempSync(path.join(testDir, `${label}-`));
  const project = await prisma.project.create({ data: { name: `${label}-project`, repoPath: workingDir } });
  const task = await prisma.task.create({ data: { title: `${label}-task`, projectId: project.id } });
  const workspace = await prisma.workspace.create({
    data: {
      taskId: task.id,
      workspaceKind: 'MAIN_DIRECTORY',
      branchName: '',
      worktreePath: '',
      workingDir,
      status: 'ACTIVE',
    },
  });
  return { project, task, workspace, workingDir };
}

describe('WorkspaceBackgroundService', () => {
  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', `--schema=${schemaPath}`], {
      cwd: serverRoot,
      env: { ...process.env, AGENT_TOWER_DATABASE_URL: `file:${dbPath}` },
      stdio: 'pipe',
    });
    ({ prisma } = await import('../../utils/index.js'));
    ({ WorkspaceBackgroundService } = await import('../workspace-background-service.service.js'));
    ({ WorkspaceLifecycleBarrier } = await import('../workspace-lifecycle-barrier.js'));
  });

  beforeEach(async () => {
    await prisma.agentInvocation.deleteMany();
    await prisma.teamMember.deleteMany();
    await prisma.teamRun.deleteMany();
    await prisma.workspaceBackgroundService.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.task.deleteMany();
    await prisma.project.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('makes start/stop/restart idempotent and rejects spec changes', async () => {
    const manager = new FakeProcessManager();
    const service = new WorkspaceBackgroundService(manager as any);
    const { workspace } = await createWorkspace('lifecycle');

    const first = await service.start(workspace.id, 'web', { command: 'node', args: ['server.js'] });
    const duplicate = await service.start(workspace.id, 'web', { command: 'node', args: ['server.js'] });
    expect(first.id).toBe(duplicate.id);
    expect(first.runtimeState).toBe('RUNNING');
    expect(manager.startCalls).toHaveBeenCalledTimes(1);

    await expect(service.start(workspace.id, 'web', { command: 'node', args: ['other.js'] }))
      .rejects.toMatchObject({ code: 'SERVICE_SPEC_CONFLICT' });

    await expect(service.stop(workspace.id, 'web')).resolves.toMatchObject({
      desiredState: 'STOPPED',
      runtimeState: 'STOPPED',
    });
    await expect(service.stop(workspace.id, 'web')).resolves.toMatchObject({ runtimeState: 'STOPPED' });
    await expect(service.list(workspace.id)).resolves.toEqual([]);
    await expect(service.restart(workspace.id, 'web')).resolves.toMatchObject({
      desiredState: 'RUNNING',
      runtimeState: 'RUNNING',
    });
    expect(manager.startCalls).toHaveBeenCalledTimes(2);

    await manager.emitLateExit(first.id, first.runtimeInstanceId!, 9);
    await expect(service.list(workspace.id)).resolves.toEqual([
      expect.objectContaining({ runtimeState: 'RUNNING', runtimeInstanceId: 'runtime-2' }),
    ]);
  });

  it('marks a crashed service failed without automatically restarting it', async () => {
    const manager = new FakeProcessManager();
    const service = new WorkspaceBackgroundService(manager as any);
    const { workspace } = await createWorkspace('crash');
    const started = await service.start(workspace.id, 'web', { command: 'node' });

    await manager.exit(started.id, 7);

    await expect(service.list(workspace.id)).resolves.toEqual([
      expect.objectContaining({ desiredState: 'RUNNING', runtimeState: 'FAILED', exitCode: 7 }),
    ]);
    expect(manager.startCalls).toHaveBeenCalledTimes(1);
    await expect(service.sendInput(workspace.id, 'web', 'x'))
      .rejects.toMatchObject({ code: 'SERVICE_NOT_RUNNING' });
  });

  it('hides fully stopped services and excludes them from the workspace limit', async () => {
    const manager = new FakeProcessManager();
    const service = new WorkspaceBackgroundService(manager as any);
    const { workspace } = await createWorkspace('service-limit');

    for (let index = 0; index < 20; index++) {
      await service.start(workspace.id, `service-${index}`, { command: 'node' });
    }
    await expect(service.start(workspace.id, 'overflow', { command: 'node' }))
      .rejects.toMatchObject({ code: 'WORKSPACE_SERVICE_LIMIT_REACHED' });

    await service.stop(workspace.id, 'service-0');
    const afterStop = await service.list(workspace.id);
    expect(afterStop).toHaveLength(19);
    expect(afterStop.some((record) => record.name === 'service-0')).toBe(false);

    await expect(service.start(workspace.id, 'replacement', { command: 'node' }))
      .resolves.toMatchObject({ runtimeState: 'RUNNING' });
    await expect(service.list(workspace.id)).resolves.toHaveLength(20);
    await expect(prisma.workspaceBackgroundService.count({ where: { workspaceId: workspace.id } }))
      .resolves.toBe(21);

    await expect(service.start(workspace.id, 'service-0', { command: 'node' }))
      .rejects.toMatchObject({ code: 'WORKSPACE_SERVICE_LIMIT_REACHED' });
  });

  it('compensates a spawned process when persisting RUNNING fails', async () => {
    const manager = new FakeProcessManager();
    const service = new WorkspaceBackgroundService(manager as any);
    const { workspace } = await createWorkspace('spawn-compensation');
    manager.afterStart = async (serviceId) => {
      await prisma.workspaceBackgroundService.update({
        where: { id: serviceId },
        data: { runtimeInstanceId: 'superseded-before-running-persist' },
      });
    };

    await expect(service.start(workspace.id, 'web', { command: 'node' }))
      .rejects.toMatchObject({ code: 'SERVICE_START_FAILED' });

    const record = await prisma.workspaceBackgroundService.findUniqueOrThrow({
      where: { workspaceId_name: { workspaceId: workspace.id, name: 'web' } },
    });
    expect(manager.stopCalls).toHaveBeenCalledWith(record.id, 'runtime-1');
    expect(manager.has(record.id)).toBe(false);
    expect(record).toMatchObject({
      runtimeState: 'FAILED',
      runtimeInstanceId: null,
      pid: null,
    });
  });

  it('keeps the workspace service running when an agent session finishes', async () => {
    const manager = new FakeProcessManager();
    const service = new WorkspaceBackgroundService(manager as any);
    const { workspace } = await createWorkspace('session-independent');
    const session = await prisma.session.create({
      data: {
        workspaceId: workspace.id,
        agentType: 'CODEX',
        prompt: 'Start the development server',
        status: 'RUNNING',
      },
    });
    const started = await service.start(workspace.id, 'web', { command: 'node' });

    await prisma.session.update({
      where: { id: session.id },
      data: { status: 'COMPLETED' },
    });

    expect(manager.has(started.id, started.runtimeInstanceId)).toBe(true);
    await expect(service.list(workspace.id)).resolves.toEqual([
      expect.objectContaining({ runtimeState: 'RUNNING', runtimeInstanceId: started.runtimeInstanceId }),
    ]);
  });

  it('rejects a relative cwd that resolves outside the workspace', async () => {
    const manager = new FakeProcessManager();
    const service = new WorkspaceBackgroundService(manager as any);
    const { workspace } = await createWorkspace('cwd-boundary');

    await expect(service.start(workspace.id, 'web', {
      command: 'node',
      relativeCwd: '..',
    })).rejects.toMatchObject({ code: 'CWD_OUTSIDE_WORKSPACE' });
    expect(manager.startCalls).not.toHaveBeenCalled();
  });

  it('binds internal callers to a session and TeamRun invocation with runCommands', async () => {
    const manager = new FakeProcessManager();
    const service = new WorkspaceBackgroundService(manager as any);
    const first = await createWorkspace('auth-one');
    const second = await createWorkspace('auth-two');
    const teamRun = await prisma.teamRun.create({ data: { taskId: first.task.id, mode: 'AUTO' } });
    const member = await prisma.teamMember.create({
      data: {
        teamRunId: teamRun.id,
        name: 'worker',
        aliases: '[]',
        providerId: 'provider',
        rolePrompt: 'role',
        capabilities: JSON.stringify({ runCommands: true }),
        workspacePolicy: 'shared',
        triggerPolicy: 'AUTO',
      },
    });
    const session = await prisma.session.create({
      data: {
        workspaceId: first.workspace.id,
        agentType: 'CODEX',
        prompt: 'work',
        status: 'RUNNING',
      },
    });
    const invocation = await prisma.agentInvocation.create({
      data: {
        teamRunId: teamRun.id,
        memberId: member.id,
        workRequestId: 'request-1',
        workspaceId: first.workspace.id,
        sessionId: session.id,
      },
    });

    await expect(service.authorizeCaller(first.workspace.id, {
      kind: 'internal',
      sessionId: session.id,
      invocationId: invocation.id,
    })).resolves.toBeUndefined();
    await expect(service.authorizeCaller(first.workspace.id, {
      kind: 'internal',
      sessionId: session.id,
    })).rejects.toMatchObject({ code: 'INVOCATION_IDENTITY_REQUIRED' });
    await expect(service.authorizeCaller(second.workspace.id, {
      kind: 'internal',
      sessionId: session.id,
      invocationId: invocation.id,
    })).rejects.toMatchObject({ code: 'SESSION_WORKSPACE_MISMATCH' });
    await expect(service.authorizeCaller(first.workspace.id, {
      kind: 'internal',
      sessionId: session.id,
      invocationId: 'wrong-invocation',
    })).rejects.toMatchObject({ code: 'INVOCATION_SESSION_MISMATCH' });

    await prisma.teamMember.update({
      where: { id: member.id },
      data: { capabilities: JSON.stringify({ runCommands: false }) },
    });
    await expect(service.authorizeCaller(first.workspace.id, {
      kind: 'internal',
      sessionId: session.id,
      invocationId: invocation.id,
    }))
      .rejects.toMatchObject({ code: 'TEAM_RUN_MEMBER_CAPABILITY_REQUIRED' });
  });

  it('requires Solo internal callers to present a session bound to the workspace', async () => {
    const service = new WorkspaceBackgroundService(new FakeProcessManager() as any);
    const first = await createWorkspace('solo-auth-one');
    const second = await createWorkspace('solo-auth-two');
    const session = await prisma.session.create({
      data: {
        workspaceId: first.workspace.id,
        agentType: 'CODEX',
        prompt: 'work',
        status: 'RUNNING',
      },
    });

    await expect(service.authorizeCaller(first.workspace.id, {
      kind: 'internal',
    })).rejects.toMatchObject({ code: 'INTERNAL_CALLER_IDENTITY_REQUIRED' });
    await expect(service.authorizeCaller(second.workspace.id, {
      kind: 'internal',
      sessionId: session.id,
    })).rejects.toMatchObject({ code: 'SESSION_WORKSPACE_MISMATCH' });
    await expect(service.authorizeCaller(first.workspace.id, {
      kind: 'internal',
      sessionId: session.id,
    })).resolves.toBeUndefined();
    await expect(service.authorizeCaller(first.workspace.id, { kind: 'browser' }, 'read'))
      .resolves.toBeUndefined();
    await expect(service.authorizeCaller(first.workspace.id, { kind: 'browser' }))
      .rejects.toMatchObject({ code: 'WORKSPACE_SERVICE_BROWSER_UNAVAILABLE' });
  });

  it('stops runtime on app shutdown while preserving desired state for startup recovery', async () => {
    const manager = new FakeProcessManager();
    const service = new WorkspaceBackgroundService(manager as any);
    const { workspace } = await createWorkspace('shutdown');
    await service.start(workspace.id, 'web', { command: 'node' });

    await service.shutdown();
    await expect(service.list(workspace.id)).resolves.toEqual([
      expect.objectContaining({ desiredState: 'RUNNING', runtimeState: 'STOPPED' }),
    ]);

    await service.reconcile();
    await expect(service.list(workspace.id)).resolves.toEqual([
      expect.objectContaining({ desiredState: 'RUNNING', runtimeState: 'RUNNING' }),
    ]);
    expect(manager.startCalls).toHaveBeenCalledTimes(2);
  });

  it('persists FAILED and lastError when reconcile cannot resolve the stored cwd', async () => {
    const manager = new FakeProcessManager();
    const service = new WorkspaceBackgroundService(manager as any);
    const { workspace } = await createWorkspace('reconcile-missing-cwd');
    await prisma.workspaceBackgroundService.create({
      data: {
        workspaceId: workspace.id,
        name: 'web',
        command: 'node',
        argsJson: '[]',
        relativeCwd: 'missing-directory',
        desiredState: 'RUNNING',
        runtimeState: 'STOPPED',
      },
    });

    await service.reconcile();

    await expect(service.list(workspace.id)).resolves.toEqual([
      expect.objectContaining({
        desiredState: 'RUNNING',
        runtimeState: 'FAILED',
        lastError: 'Workspace service working directory does not exist',
      }),
    ]);
    expect(manager.startCalls).not.toHaveBeenCalled();
  });

  it('releases every service log buffer when its workspace entity is deleted', async () => {
    const manager = new FakeProcessManager();
    const service = new WorkspaceBackgroundService(manager as any);
    const { workspace } = await createWorkspace('release-logs');
    const first = await service.start(workspace.id, 'web', { command: 'node' });
    const second = await service.start(workspace.id, 'api', { command: 'node' });
    await service.stopAllForWorkspace(workspace.id);

    await service.releaseLogsForWorkspace(workspace.id);

    expect(manager.forget.mock.calls.map(([id]) => id)).toEqual(expect.arrayContaining([
      first.id,
      second.id,
    ]));
  });

  it('lifecycle cleanup clears desired state so reactivation does not restore the service', async () => {
    const manager = new FakeProcessManager();
    const service = new WorkspaceBackgroundService(manager as any);
    const { workspace } = await createWorkspace('hibernate-stop');
    await service.start(workspace.id, 'web', { command: 'node' });

    await service.stopAllForWorkspace(workspace.id);
    await service.reconcile();

    await expect(service.list(workspace.id)).resolves.toEqual([]);
    expect(manager.startCalls).toHaveBeenCalledTimes(1);
  });

  it('queues a new start behind the workspace lifecycle barrier and revalidates active state', async () => {
    const manager = new FakeProcessManager();
    const barrier = new WorkspaceLifecycleBarrier();
    const service = new WorkspaceBackgroundService(manager as any, barrier);
    const { workspace } = await createWorkspace('lifecycle-start-barrier');
    let startPromise!: Promise<unknown>;

    await barrier.withWorkspace(workspace.id, async () => {
      startPromise = service.start(workspace.id, 'web', { command: 'node' });
      await Promise.resolve();
      expect(manager.startCalls).not.toHaveBeenCalled();
      await prisma.workspace.update({
        where: { id: workspace.id },
        data: { status: 'ABANDONED' },
      });
    });

    await expect(startPromise).rejects.toMatchObject({ code: 'WORKSPACE_NOT_ACTIVE' });
    expect(manager.startCalls).not.toHaveBeenCalled();
  });

  it('does not let a new service name enter after stopAll has taken its record snapshot', async () => {
    const manager = new FakeProcessManager();
    const barrier = new WorkspaceLifecycleBarrier();
    const service = new WorkspaceBackgroundService(manager as any, barrier);
    const { workspace } = await createWorkspace('stop-all-snapshot-barrier');
    await service.start(workspace.id, 'web', { command: 'node' });

    let releaseStop!: () => void;
    const stopGate = new Promise<void>((resolve) => { releaseStop = resolve; });
    let markStopReached!: () => void;
    const stopReached = new Promise<void>((resolve) => { markStopReached = resolve; });
    manager.beforeStop = async () => {
      markStopReached();
      await stopGate;
    };
    let lateStart!: Promise<unknown>;

    const lifecycle = barrier.withWorkspace(workspace.id, async () => {
      const stopping = service.stopAllForWorkspace(workspace.id);
      await stopReached;
      lateStart = service.start(workspace.id, 'api', { command: 'node' });
      await Promise.resolve();
      expect(manager.startCalls).toHaveBeenCalledTimes(1);
      releaseStop();
      await stopping;
      await prisma.workspace.update({
        where: { id: workspace.id },
        data: { status: 'ABANDONED' },
      });
    });

    await lifecycle;
    await expect(lateStart).rejects.toMatchObject({ code: 'WORKSPACE_NOT_ACTIVE' });
    await expect(prisma.workspaceBackgroundService.findUnique({
      where: { workspaceId_name: { workspaceId: workspace.id, name: 'api' } },
    })).resolves.toBeNull();
  });
});
