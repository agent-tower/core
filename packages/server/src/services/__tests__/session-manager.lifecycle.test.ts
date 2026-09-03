import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { AgentType, SessionStatus, TaskStatus } from '../../types/index.js';
import { EventBus } from '../../core/event-bus.js';
import type { EarlyPtyEvent } from '../../executors/base.executor.js';
import { RuntimeType, type RuntimeCapabilities } from '@agent-tower/shared';
import type {
  DriverSession,
  RuntimeDriver,
  RuntimeRunTurnInput,
  StartRuntimeTurnInput,
  RuntimeTurnOutcome,
} from '../../runtime/contracts.js';
import { StaticRuntimeRegistry } from '../../runtime/runtime-registry.js';
import {
  AGENT_API_CREDENTIAL_ENV,
  clearAgentApiCredentials,
  validateAgentApiCredential,
} from '../../utils/agent-api-credential.js';

/**
 * Session 状态与真实进程状态一致性的集成测试（真实 SQLite + 真实 parser/MsgStore/Pipeline，
 * 仅 mock executor.spawn 返回的 PTY）。
 *
 * 覆盖用户报告的"卡住"关键面：
 * - PTY 退出后 session 必须离开 RUNNING（COMPLETED/FAILED），快照落库
 * - spawn→attach 窗口内就退出的进程（early exit 竞态）不得把 session 留在 RUNNING
 */

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-session-lifecycle-'));
const dbPath = path.join(testDir, 'test.db');
process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;

const {
  spawnMock,
  getProviderByIdMock,
  getExecutorByProviderMock,
  createMockExecutor,
} = vi.hoisted(() => {
  const spawnMock = vi.fn();
  const createMockExecutor = () => ({
    agentType: 'CODEX',
    displayName: 'Mock Codex',
    getAvailabilityInfo: vi.fn(),
    getCapabilities: vi.fn(() => []),
    spawn: spawnMock,
    // No spawnFollowUp: sendMessage exercises the new-spawn path.
  });
  return {
    spawnMock,
    getProviderByIdMock: vi.fn(),
    getExecutorByProviderMock: vi.fn(),
    createMockExecutor,
  };
});

vi.mock('../../executors/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../executors/index.js')>();
  getExecutorByProviderMock.mockImplementation(createMockExecutor);
  return {
    ...actual,
    getExecutor: vi.fn(createMockExecutor),
    getExecutorByProvider: getExecutorByProviderMock,
    getProviderById: getProviderByIdMock,
  };
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, '../../..');
const schemaPath = path.join(serverRoot, 'prisma/schema.prisma');

let prisma: PrismaClient;
let SessionManager: typeof import('../session-manager.js').SessionManager;
let sessionMsgStoreManager: typeof import('../../output/index.js').sessionMsgStoreManager;
let WorkspaceBackgroundService: typeof import('../workspace-background-service.service.js').WorkspaceBackgroundService;
let WorkspaceBackgroundProcessManager: typeof import('../workspace-background-process-manager.js').WorkspaceBackgroundProcessManager;
let markPreChildProcessFailure: typeof import('../../executors/start-error.js').markPreChildProcessFailure;

/** 可手动触发事件的 fake PTY，语义对齐 node-pty（不重放事件） */
class ControlledPty {
  pid = 4242;
  killed = false;
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = [];
  private exited = false;

  onData = (cb: (data: string) => void) => {
    this.dataListeners.push(cb);
    return { dispose: () => { this.dataListeners = this.dataListeners.filter((l) => l !== cb); } };
  };

  onExit = (cb: (e: { exitCode: number; signal?: number }) => void) => {
    this.exitListeners.push(cb);
    return { dispose: () => { this.exitListeners = this.exitListeners.filter((l) => l !== cb); } };
  };

  emitData(data: string) {
    for (const l of [...this.dataListeners]) l(data);
  }

  emitExit(exitCode: number) {
    if (this.exited) return;
    this.exited = true;
    for (const l of [...this.exitListeners]) l({ exitCode });
  }

  write() {}
  resize() {}
  kill() {
    this.killed = true;
    this.emitExit(0);
  }
}

function spawnResultFor(pty: ControlledPty, earlyEvents: EarlyPtyEvent[] = []) {
  let taken = false;
  return {
    pid: pty.pid,
    processGroupId: String(pty.pid),
    birthMarker: `test-birth:${pty.pid}`,
    ownershipToken: `test-owner:${pty.pid}`,
    pty,
    takeEarlyEvents: () => {
      if (taken) return [];
      taken = true;
      return earlyEvents;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function createSessionFixture(options: { providerId?: string } = {}) {
  const project = await prisma.project.create({
    data: { name: 'lifecycle project', repoPath: testDir },
  });
  const task = await prisma.task.create({
    data: { title: 'lifecycle task', projectId: project.id },
  });
  const workspace = await prisma.workspace.create({
    data: {
      taskId: task.id,
      branchName: 'lifecycle',
      worktreePath: testDir,
      status: 'ACTIVE',
    },
  });
  const session = await prisma.session.create({
    data: {
      workspaceId: workspace.id,
      agentType: AgentType.CODEX,
      variant: 'DEFAULT',
      providerId: options.providerId ?? null,
      prompt: 'do something',
      status: SessionStatus.PENDING,
    },
  });
  return { project, task, workspace, session };
}

function waitForEvent(eventBus: EventBus, event: 'session:completed', timeoutMs = 5000): Promise<{ sessionId: string; status: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    eventBus.on(event, (payload) => {
      clearTimeout(timer);
      resolve(payload as { sessionId: string; status: string });
    });
  });
}

async function createRetryableAcpStopFixture(closeFailureMessages: string[]) {
  const provider = {
    id: 'cleanup-retry-acp-provider',
    name: 'Cleanup Retry ACP Provider',
    agentType: AgentType.CODEX,
    runtimeType: RuntimeType.ACP,
    env: {},
    config: {},
    isDefault: false,
  };
  getProviderByIdMock.mockReturnValue(provider);
  const { workspace, session } = await createSessionFixture({ providerId: provider.id });
  await prisma.session.update({
    where: { id: session.id },
    data: { runtimeType: RuntimeType.ACP },
  });

  const service = new WorkspaceBackgroundService();
  const turns: Array<ReturnType<typeof deferred<RuntimeTurnOutcome>>> = [];
  const observedCredentials: string[] = [];
  const driverSessions: DriverSession[] = [];
  const remainingCloseFailures = [...closeFailureMessages];
  const capabilities: RuntimeCapabilities = {
    loadSession: true,
    terminalInput: false,
    terminalResize: false,
    permissions: true,
  };
  const driver: RuntimeDriver = {
    type: RuntimeType.ACP,
    open: vi.fn(async (input, openingSink) => {
      const generation = driverSessions.length + 1;
      const generationTurns: Array<ReturnType<typeof deferred<RuntimeTurnOutcome>>> = [];
      const driverSession: DriverSession = {
        runtimeInstanceId: `cleanup-retry-runtime-${generation}`,
        capabilities,
        externalSessionId: 'cleanup-retry-external',
        runTurn: vi.fn(async (_turn: RuntimeRunTurnInput, sink) => {
          const credential = input.env.get(AGENT_API_CREDENTIAL_ENV) ?? '';
          observedCredentials.push(credential);
          const identity = validateAgentApiCredential(credential);
          if (!identity) throw new Error('ACP workspace-service credential is invalid');
          await service.authorizeCaller(workspace.id, { kind: 'agent', ...identity });
          sink.stream({
            type: 'external_session_id',
            externalSessionId: 'cleanup-retry-external',
          });
          const completion = deferred<RuntimeTurnOutcome>();
          turns.push(completion);
          generationTurns.push(completion);
          return { completion: completion.promise };
        }),
        cancelTurn: vi.fn(async () => {
          generationTurns.at(-1)?.resolve({ stopReason: 'cancelled' });
        }),
        close: vi.fn(async () => {
          generationTurns.at(-1)?.resolve({ stopReason: 'cancelled' });
          if (generation === 1) {
            const failure = remainingCloseFailures.shift();
            if (failure) throw new Error(failure);
          }
        }),
      };
      await openingSink.process({
        type: 'started',
        runtimeInstanceId: driverSession.runtimeInstanceId,
        launchClaimNumber: input.launchClaimNumber!,
        pid: 4400 + generation,
        processGroupId: String(4400 + generation),
        birthMarker: `test-birth:${4400 + generation}`,
        ownershipToken: `test-owner:${4400 + generation}`,
      });
      driverSessions.push(driverSession);
      return driverSession;
    }),
  };
  const eventBus = new EventBus();
  const manager = new SessionManager(
    eventBus,
    undefined,
    new StaticRuntimeRegistry([driver]),
  );
  const completed = waitForEvent(eventBus, 'session:completed');

  await manager.start(session.id);
  turns[0]!.resolve({ stopReason: 'end_turn' });
  await completed;
  await vi.waitFor(() => expect(sessionMsgStoreManager.has(session.id)).toBe(false));
  await manager.sendMessage(session.id, 'use workspace service again');

  return {
    driver,
    driverSessions,
    manager,
    observedCredentials,
    session,
    turns,
  };
}

async function getPersistedCleanupInput(sessionId: string, runtimeInstanceId: string) {
  const process = await prisma.executionProcess.findFirstOrThrow({
    where: { sessionId, runtimeInstanceId },
  });
  if (
    process.launchClaimNumber == null
    || process.pid == null
    || process.processGroupId == null
    || process.birthMarker == null
    || process.ownershipToken == null
  ) {
    throw new Error('Test runtime process identity is incomplete');
  }
  return {
    sessionId,
    runtimeInstanceId,
    launchClaimNumber: process.launchClaimNumber,
    pid: process.pid,
    processGroupId: process.processGroupId,
    birthMarker: process.birthMarker,
    ownershipToken: process.ownershipToken,
  };
}

describe('SessionManager session status vs real process state', () => {
  beforeAll(async () => {
    execFileSync(
      'pnpm',
      ['exec', 'prisma', 'db', 'push', '--skip-generate', `--schema=${schemaPath}`],
      {
        cwd: serverRoot,
        env: { ...process.env, AGENT_TOWER_DATABASE_URL: `file:${dbPath}` },
        stdio: 'pipe',
      }
    );

    const utilsModule = await import('../../utils/index.js');
    const sessionManagerModule = await import('../session-manager.js');
    const outputModule = await import('../../output/index.js');
    const backgroundServiceModule = await import('../workspace-background-service.service.js');
    const backgroundManagerModule = await import('../workspace-background-process-manager.js');
    const startErrorModule = await import('../../executors/start-error.js');
    prisma = utilsModule.prisma;
    SessionManager = sessionManagerModule.SessionManager;
    sessionMsgStoreManager = outputModule.sessionMsgStoreManager;
    WorkspaceBackgroundService = backgroundServiceModule.WorkspaceBackgroundService;
    WorkspaceBackgroundProcessManager = backgroundManagerModule.WorkspaceBackgroundProcessManager;
    markPreChildProcessFailure = startErrorModule.markPreChildProcessFailure;
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    getProviderByIdMock.mockReturnValue(null);
    getExecutorByProviderMock.mockReset();
    getExecutorByProviderMock.mockImplementation(createMockExecutor);
    clearAgentApiCredentials();
    await prisma.executionProcess.deleteMany();
    await prisma.conversation.deleteMany();
    await prisma.session.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.task.deleteMany();
    await prisma.project.deleteMany();
  });

  it('requires a Provider runtime supported by the selected Agent before persisting a session', async () => {
    const { workspace } = await createSessionFixture();
    const manager = new SessionManager(new EventBus());

    await expect(manager.create(
      workspace.id,
      AgentType.QWEN_CODE,
      'run qwen without an ACP provider',
    )).rejects.toThrow("Agent 'QWEN_CODE' does not support the 'CLI' runtime");

    getProviderByIdMock.mockReturnValue({
      id: 'qwen-acp-provider',
      name: 'Qwen Code ACP',
      agentType: AgentType.QWEN_CODE,
      runtimeType: 'ACP',
      env: {},
      config: {},
      isDefault: false,
    });
    const created = await manager.create(
      workspace.id,
      AgentType.QWEN_CODE,
      'run qwen through ACP',
      'DEFAULT',
      'qwen-acp-provider',
    );

    expect(created).toMatchObject({
      agentType: AgentType.QWEN_CODE,
      runtimeType: 'ACP',
      providerId: 'qwen-acp-provider',
    });
  });

  it('resolves the latest Provider transport snapshot for every new or retried spawn', async () => {
    const first = await createSessionFixture({ providerId: 'provider-snapshot' });
    const second = await createSessionFixture({ providerId: 'provider-snapshot' });
    const provider = {
      id: 'provider-snapshot',
      name: 'Provider Snapshot',
      agentType: AgentType.CODEX,
      env: {},
      config: { disableResponsesWebsocket: false },
      isDefault: false,
    };
    const executorSnapshots: boolean[] = [];
    getProviderByIdMock.mockImplementation(() => provider);
    getExecutorByProviderMock.mockImplementation(() => {
      const snapshot = provider.config.disableResponsesWebsocket;
      executorSnapshots.push(snapshot);
      return createMockExecutor();
    });
    spawnMock
      .mockResolvedValueOnce(spawnResultFor(new ControlledPty()))
      .mockResolvedValueOnce(spawnResultFor(new ControlledPty()));

    const manager = new SessionManager(new EventBus());
    await manager.start(first.session.id);
    provider.config.disableResponsesWebsocket = true;
    await manager.start(second.session.id);

    expect(getExecutorByProviderMock).toHaveBeenNthCalledWith(1, 'provider-snapshot');
    expect(getExecutorByProviderMock).toHaveBeenNthCalledWith(2, 'provider-snapshot');
    expect(executorSnapshots).toEqual([false, true]);
    await manager.destroyAll();
  });

  it('uses one latest Provider snapshot for follow-up resume and its new-session fallback', async () => {
    const provider = {
      id: 'provider-follow-up-snapshot',
      name: 'Provider Follow-up Snapshot',
      agentType: AgentType.CODEX,
      env: {},
      config: { disableResponsesWebsocket: true },
      isDefault: false,
    };
    const observed: Array<{ path: 'resume' | 'fallback'; disabled: boolean }> = [];
    getProviderByIdMock.mockImplementation(() => provider);
    getExecutorByProviderMock.mockImplementation(() => {
      const disabled = provider.config.disableResponsesWebsocket;
      return {
        agentType: AgentType.CODEX,
        displayName: 'Mock Codex',
        getAvailabilityInfo: vi.fn(),
        getCapabilities: vi.fn(() => []),
        spawnFollowUp: vi.fn(async () => {
          observed.push({ path: 'resume', disabled });
          provider.config.disableResponsesWebsocket = false;
          throw markPreChildProcessFailure(new Error('synthetic resume failure'));
        }),
        spawn: vi.fn(async () => {
          observed.push({ path: 'fallback', disabled });
          return spawnResultFor(new ControlledPty());
        }),
      };
    });
    const { session } = await createSessionFixture({ providerId: provider.id });
    await prisma.session.update({
      where: { id: session.id },
      data: { logSnapshot: JSON.stringify({ sessionId: 'codex-thread-1', entries: [] }) },
    });

    const manager = new SessionManager(new EventBus());
    await manager.sendMessage(session.id, 'continue with the current provider');

    expect(getExecutorByProviderMock).toHaveBeenCalledTimes(1);
    expect(observed).toEqual([
      { path: 'resume', disabled: true },
      { path: 'fallback', disabled: true },
    ]);
    await expect(prisma.session.findUnique({ where: { id: session.id } })).resolves.toMatchObject({
      runtimeLaunchState: 'PROCESS_RECORDED',
      runtimeLaunchClaimCount: 1,
      runtimeLaunchResolvedCount: 1,
      runtimeLaunchProcessCount: 1,
    });
    await manager.destroyAll();
  });

  it('keeps terminal conversation follow-ups compatible without a TeamRun invocation identity', async () => {
    const conversation = await prisma.conversation.create({
      data: {
        title: 'Lifecycle conversation',
        directoryName: `lifecycle-conversation-${Date.now()}`,
        workingDir: testDir,
        session: {
          create: {
            context: 'CONVERSATION',
            agentType: AgentType.CODEX,
            variant: 'DEFAULT',
            prompt: 'initial question',
            status: SessionStatus.COMPLETED,
          },
        },
      },
      include: { session: true },
    });
    spawnMock.mockResolvedValueOnce(spawnResultFor(new ControlledPty()));
    const manager = new SessionManager(new EventBus());

    await expect(manager.sendMessage(conversation.session!.id, 'follow-up question'))
      .resolves.toMatchObject({ id: conversation.session!.id });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    await expect(prisma.session.findUnique({ where: { id: conversation.session!.id } }))
      .resolves.toMatchObject({ status: SessionStatus.RUNNING });
    await manager.destroyAll();
  });

  it('serializes ACP stop and resend, then reconnects with the persisted external session id', async () => {
    const provider = {
      id: 'reused-acp-provider',
      name: 'Reused ACP Provider',
      agentType: AgentType.CODEX,
      runtimeType: 'ACP',
      env: {},
      config: {},
      isDefault: false,
    };
    getProviderByIdMock.mockReturnValue(provider);
    const { session } = await createSessionFixture({ providerId: provider.id });
    await prisma.session.update({
      where: { id: session.id },
      data: {
        runtimeType: 'ACP',
        status: SessionStatus.COMPLETED,
        runtimeLaunchState: 'PROCESS_RECORDED',
        runtimeLaunchClaimCount: 1,
        runtimeLaunchResolvedCount: 1,
        runtimeLaunchProcessCount: 1,
        externalSessionId: 'external-acp-session',
        logSnapshot: JSON.stringify({
          sessionId: 'external-acp-session',
          entries: [],
          seq: 3,
        }),
      },
    });
    await prisma.executionProcess.create({
      data: {
        sessionId: session.id,
        launchClaimNumber: 1,
        runtimeInstanceId: 'reused-acp-runtime',
        pid: 4301,
        processGroupId: '4301',
        birthMarker: 'test-birth:4301',
        ownershipToken: 'test-owner:4301',
        cleanupState: 'ACTIVE',
      },
    });

    const completion = new Promise<never>(() => undefined);
    const hasActiveTurn = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    const stopCleanup = deferred<void>();
    const withStartAdmission = async <T>(towerSessionId: string, operation: (admission: {
      towerSessionId: string;
      signal: AbortSignal;
      throwIfCancelled(): void;
    }) => Promise<T>) => operation({
      towerSessionId,
      signal: new AbortController().signal,
      throwIfCancelled: () => undefined,
    });
    const runtimeCoordinator = {
      hasActiveTurn,
      withStartAdmission: vi.fn(withStartAdmission),
      retryDisposedSessionCleanup: vi.fn(async () => undefined),
      startTurn: vi.fn(async (_input: StartRuntimeTurnInput) => ({ turnId: 'turn-2', completion })),
      abandonTurn: vi.fn(async () => true),
      cancelTurn: vi.fn(async () => undefined),
      cancelAndDisposeSession: vi.fn(async () => {
        await stopCleanup.promise;
        await prisma.executionProcess.updateMany({
          where: { sessionId: session.id },
          data: { cleanupState: 'CONFIRMED' },
        });
      }),
      disposeSession: vi.fn(async () => {
        await prisma.executionProcess.updateMany({
          where: { sessionId: session.id },
          data: { cleanupState: 'CONFIRMED' },
        });
      }),
      hasRuntimeProcessOwner: vi.fn(() => false),
      destroyAll: vi.fn(async () => undefined),
    };
    const manager = new SessionManager(new EventBus());
    (manager as any).runtimeCoordinator = runtimeCoordinator;

    await manager.sendMessage(session.id, 'continue on the reused ACP connection');

    expect(runtimeCoordinator.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      towerSessionId: session.id,
      runtimeType: 'ACP',
      resumeExternalSessionId: 'external-acp-session',
      resumeMode: 'resume',
      historyBoundaryEntryId: expect.any(String),
      prompt: expect.stringContaining('::agent-download{file="output/report.pdf"}'),
    }));
    const startInput = runtimeCoordinator.startTurn.mock.calls[0]?.[0];
    expect(startInput?.msgStore.getSnapshot().entries.at(-1)?.id)
      .toBe(startInput?.historyBoundaryEntryId);
    expect((await prisma.session.findUnique({ where: { id: session.id } }))?.status)
      .toBe(SessionStatus.RUNNING);
    await expect(prisma.session.findUnique({ where: { id: session.id } })).resolves.toMatchObject({
      runtimeLaunchState: 'REUSED',
      runtimeLaunchClaimCount: 2,
      runtimeLaunchResolvedCount: 2,
      runtimeLaunchProcessCount: 1,
    });
    expect(await prisma.executionProcess.count({ where: { sessionId: session.id } })).toBe(1);

    // Even if a stale terminal value is observed, an active Runtime turn wins.
    await prisma.session.update({
      where: { id: session.id },
      data: { status: SessionStatus.COMPLETED },
    });
    const stopping = manager.stop(session.id);
    await vi.waitFor(() => {
      expect(runtimeCoordinator.cancelAndDisposeSession).toHaveBeenCalledWith(session.id);
    });
    const resending = manager.sendMessage(session.id, 'resend after explicit stop');
    await Promise.resolve();

    expect(runtimeCoordinator.startTurn).toHaveBeenCalledTimes(1);
    stopCleanup.resolve();
    await stopping;
    await resending;

    expect(runtimeCoordinator.abandonTurn).not.toHaveBeenCalled();
    expect(runtimeCoordinator.cancelTurn).not.toHaveBeenCalled();
    expect(runtimeCoordinator.disposeSession).not.toHaveBeenCalled();
    expect(runtimeCoordinator.startTurn).toHaveBeenCalledTimes(2);
    expect(runtimeCoordinator.startTurn.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      towerSessionId: session.id,
      externalSessionId: 'external-acp-session',
      resumeExternalSessionId: 'external-acp-session',
      resumeMode: 'resume',
      prompt: expect.stringContaining('resend after explicit stop'),
    }));
    expect((await prisma.session.findUnique({ where: { id: session.id } }))?.status)
      .toBe(SessionStatus.RUNNING);
    await manager.destroyAll();
  });

  it('loads ACP history for an incomplete session even when a snapshot exists', async () => {
    const provider = {
      id: 'interrupted-acp-provider',
      name: 'Interrupted ACP Provider',
      agentType: AgentType.CODEX,
      runtimeType: RuntimeType.ACP,
      env: {},
      config: {},
      isDefault: false,
    };
    getProviderByIdMock.mockReturnValue(provider);
    const { session } = await createSessionFixture({ providerId: provider.id });
    await prisma.session.update({
      where: { id: session.id },
      data: {
        runtimeType: RuntimeType.ACP,
        status: SessionStatus.RUNNING,
        externalSessionId: 'interrupted-acp-session',
        logSnapshot: JSON.stringify({
          sessionId: 'interrupted-acp-session',
          entries: [],
          seq: 2,
        }),
      },
    });

    const completion = new Promise<never>(() => undefined);
    const withStartAdmission = async <T>(towerSessionId: string, operation: (admission: {
      towerSessionId: string;
      signal: AbortSignal;
      throwIfCancelled(): void;
    }) => Promise<T>) => operation({
      towerSessionId,
      signal: new AbortController().signal,
      throwIfCancelled: () => undefined,
    });
    const runtimeCoordinator = {
      hasActiveTurn: vi.fn(() => false),
      withStartAdmission: vi.fn(withStartAdmission),
      retryDisposedSessionCleanup: vi.fn(async () => undefined),
      startTurn: vi.fn(async (_input: StartRuntimeTurnInput) => ({ turnId: 'turn-2', completion })),
      abandonTurn: vi.fn(async () => true),
      cancelTurn: vi.fn(async () => undefined),
      disposeSession: vi.fn(async () => undefined),
      destroyAll: vi.fn(async () => undefined),
    };
    const manager = new SessionManager(new EventBus());
    (manager as any).runtimeCoordinator = runtimeCoordinator;

    await manager.sendMessage(session.id, 'continue after interruption');

    expect(runtimeCoordinator.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      towerSessionId: session.id,
      runtimeType: RuntimeType.ACP,
      resumeExternalSessionId: 'interrupted-acp-session',
      resumeMode: 'load',
      historyBoundaryEntryId: expect.any(String),
    }));
    const startInput = runtimeCoordinator.startTurn.mock.calls[0]?.[0];
    expect(startInput?.msgStore.getSnapshot().entries.at(-1)?.id)
      .toBe(startInput?.historyBoundaryEntryId);
    await manager.destroyAll();
  });

  it('retries a retained DISPOSED owner before an immediate ACP resend starts a new generation', async () => {
    const {
      driver,
      driverSessions,
      manager,
      observedCredentials,
      session,
    } = await createRetryableAcpStopFixture(['owned tree still alive']);
    const firstDriverSession = driverSessions[0]!;

    expect(observedCredentials).toHaveLength(2);
    expect(observedCredentials[1]).toBe(observedCredentials[0]);
    await expect(manager.stop(session.id)).rejects.toThrow('owned tree still alive');
    expect(firstDriverSession.close).toHaveBeenCalledOnce();
    expect(validateAgentApiCredential(observedCredentials[1]!)).toBeNull();

    await expect(manager.sendMessage(session.id, 'resend immediately after failed stop'))
      .resolves.toMatchObject({ id: session.id });

    expect(firstDriverSession.close).toHaveBeenCalledTimes(2);
    expect(driver.open).toHaveBeenCalledTimes(2);
    expect(vi.mocked(driver.open).mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      externalSessionId: 'cleanup-retry-external',
    }));
    expect(observedCredentials).toHaveLength(3);
    expect(observedCredentials[2]).not.toBe(observedCredentials[1]);
    expect(validateAgentApiCredential(observedCredentials[2]!)).toMatchObject({ sessionId: session.id });
    expect(manager.hasRuntimeProcessOwner('cleanup-retry-runtime-1', session.id, 1)).toBe(false);
    await expect(prisma.executionProcess.findFirstOrThrow({
      where: { sessionId: session.id, runtimeInstanceId: 'cleanup-retry-runtime-1' },
    })).resolves.toMatchObject({
      launchClaimNumber: 1,
      cleanupState: 'CONFIRMED',
      cleanupError: null,
      cleanupAttemptCount: 1,
    });
    await expect(prisma.session.findUnique({ where: { id: session.id } })).resolves.toMatchObject({
      status: SessionStatus.RUNNING,
      runtimeLaunchState: 'PROCESS_RECORDED',
      runtimeLaunchClaimCount: 3,
      runtimeLaunchResolvedCount: 3,
      runtimeLaunchProcessCount: 2,
      runtimeLaunchDiagnostic: null,
    });
    expect(await prisma.executionProcess.count({
      where: { sessionId: session.id, cleanupState: 'QUARANTINED' },
    })).toBe(0);
    await manager.destroyAll();
  });

  it('rejects an immediate ACP resend without advancing launch state when retained cleanup fails again', async () => {
    const {
      driver,
      driverSessions,
      manager,
      observedCredentials,
      session,
    } = await createRetryableAcpStopFixture([
      'owned tree still alive',
      'owned tree still alive on resend',
    ]);
    const firstDriverSession = driverSessions[0]!;

    await expect(manager.stop(session.id)).rejects.toThrow('owned tree still alive');
    const launchStateBeforeResend = await prisma.session.findUniqueOrThrow({
      where: { id: session.id },
      select: {
        status: true,
        runtimeLaunchState: true,
        runtimeLaunchClaimCount: true,
        runtimeLaunchResolvedCount: true,
        runtimeLaunchProcessCount: true,
        runtimeLaunchDiagnostic: true,
      },
    });
    expect((manager as any).terminalSessions.get(session.id)).toBe(SessionStatus.CANCELLED);

    await expect(manager.sendMessage(session.id, 'resend while cleanup still fails'))
      .rejects.toThrow('owned tree still alive on resend');

    expect(firstDriverSession.close).toHaveBeenCalledTimes(2);
    expect(driver.open).toHaveBeenCalledOnce();
    expect(observedCredentials).toHaveLength(2);
    expect(validateAgentApiCredential(observedCredentials[1]!)).toBeNull();
    expect((manager as any).terminalSessions.get(session.id)).toBe(SessionStatus.CANCELLED);
    await expect(prisma.session.findUniqueOrThrow({
      where: { id: session.id },
      select: {
        status: true,
        runtimeLaunchState: true,
        runtimeLaunchClaimCount: true,
        runtimeLaunchResolvedCount: true,
        runtimeLaunchProcessCount: true,
        runtimeLaunchDiagnostic: true,
      },
    })).resolves.toEqual(launchStateBeforeResend);
    expect(manager.hasRuntimeProcessOwner('cleanup-retry-runtime-1', session.id, 1)).toBe(true);
    await expect(prisma.executionProcess.findFirstOrThrow({
      where: { sessionId: session.id, runtimeInstanceId: 'cleanup-retry-runtime-1' },
    })).resolves.toMatchObject({
      launchClaimNumber: 1,
      pid: 4401,
      processGroupId: '4401',
      birthMarker: 'test-birth:4401',
      ownershipToken: 'test-owner:4401',
      cleanupState: 'FAILED',
      cleanupError: 'owned tree still alive on resend',
      cleanupAttemptCount: 2,
    });
    expect(await prisma.executionProcess.count({
      where: { sessionId: session.id, cleanupState: 'QUARANTINED' },
    })).toBe(0);

    await expect(manager.stop(session.id)).resolves.toMatchObject({ id: session.id });
    expect(firstDriverSession.close).toHaveBeenCalledTimes(3);
    await expect(manager.sendMessage(session.id, 'send after cleanup recovery'))
      .resolves.toMatchObject({ id: session.id });
    expect(driver.open).toHaveBeenCalledTimes(2);
    expect(observedCredentials).toHaveLength(3);
    expect(validateAgentApiCredential(observedCredentials[2]!)).toMatchObject({ sessionId: session.id });
    await expect(prisma.session.findUnique({ where: { id: session.id } })).resolves.toMatchObject({
      status: SessionStatus.RUNNING,
      runtimeLaunchState: 'PROCESS_RECORDED',
      runtimeLaunchClaimCount: 3,
      runtimeLaunchResolvedCount: 3,
      runtimeLaunchProcessCount: 2,
      runtimeLaunchDiagnostic: null,
    });
    expect(await prisma.executionProcess.count({
      where: { sessionId: session.id, cleanupState: 'QUARANTINED' },
    })).toBe(0);
    await manager.destroyAll();
  });

  it('holds background cleanup retry and resend behind the same disposal evidence boundary', async () => {
    const {
      driver,
      driverSessions,
      manager,
      observedCredentials,
      session,
    } = await createRetryableAcpStopFixture([]);
    const firstDriverSession = driverSessions[0]!;
    const evidenceStarted = deferred<void>();
    const evidenceRelease = deferred<void>();
    const originalMarkCleanup = (manager as any).markRuntimeProcessCleanupState.bind(manager);
    const markCleanupSpy = vi.spyOn(manager as any, 'markRuntimeProcessCleanupState')
      .mockImplementation(async (...args: unknown[]) => {
        if (args[1] === 'cleanup-retry-runtime-1' && args[2] === 'CONFIRMED') {
          evidenceStarted.resolve();
          await evidenceRelease.promise;
        }
        return originalMarkCleanup(...args);
      });
    const coordinator = (manager as any).runtimeCoordinator;
    const retryDisposedSpy = vi.spyOn(coordinator, 'retryDisposedSessionCleanup');

    const disposal = manager.disposeRuntimeSession(session.id, 'cleanup-retry-runtime-1');
    await evidenceStarted.promise;
    const cleanupInput = await getPersistedCleanupInput(session.id, 'cleanup-retry-runtime-1');
    const launchStateBeforeAdmission = await prisma.session.findUniqueOrThrow({
      where: { id: session.id },
      select: {
        status: true,
        runtimeLaunchState: true,
        runtimeLaunchClaimCount: true,
        runtimeLaunchResolvedCount: true,
        runtimeLaunchProcessCount: true,
        runtimeLaunchDiagnostic: true,
      },
    });

    const backgroundCleanup = manager.retryRuntimeProcessCleanup(cleanupInput);
    const resend = manager.sendMessage(session.id, 'resend during cleanup evidence persistence');
    await vi.waitFor(() => expect(retryDisposedSpy).toHaveBeenCalledTimes(2));

    expect(firstDriverSession.close).toHaveBeenCalledOnce();
    expect(driver.open).toHaveBeenCalledOnce();
    expect(observedCredentials).toHaveLength(2);
    await expect(prisma.session.findUniqueOrThrow({
      where: { id: session.id },
      select: {
        status: true,
        runtimeLaunchState: true,
        runtimeLaunchClaimCount: true,
        runtimeLaunchResolvedCount: true,
        runtimeLaunchProcessCount: true,
        runtimeLaunchDiagnostic: true,
      },
    })).resolves.toEqual(launchStateBeforeAdmission);
    expect(await prisma.executionProcess.count({ where: { sessionId: session.id } })).toBe(1);
    expect(await prisma.executionProcess.count({
      where: { sessionId: session.id, cleanupState: 'QUARANTINED' },
    })).toBe(0);

    evidenceRelease.resolve();
    await Promise.all([disposal, backgroundCleanup, resend]);

    expect(firstDriverSession.close).toHaveBeenCalledOnce();
    expect(driver.open).toHaveBeenCalledTimes(2);
    expect(observedCredentials).toHaveLength(3);
    await expect(prisma.executionProcess.findFirstOrThrow({
      where: { sessionId: session.id, runtimeInstanceId: 'cleanup-retry-runtime-1' },
    })).resolves.toMatchObject({ cleanupState: 'CONFIRMED' });
    expect(await prisma.executionProcess.count({
      where: { sessionId: session.id, cleanupState: 'QUARANTINED' },
    })).toBe(0);

    retryDisposedSpy.mockRestore();
    markCleanupSpy.mockRestore();
    await manager.destroyAll();
  });

  it('rejects concurrent cleanup and resend without a phantom claim when disposal evidence remains unconfirmed', async () => {
    const {
      driver,
      driverSessions,
      manager,
      observedCredentials,
      session,
    } = await createRetryableAcpStopFixture([]);
    const firstDriverSession = driverSessions[0]!;
    const evidenceStarted = deferred<void>();
    const evidenceRelease = deferred<void>();
    let skipEvidencePersistence = true;
    const originalMarkCleanup = (manager as any).markRuntimeProcessCleanupState.bind(manager);
    const markCleanupSpy = vi.spyOn(manager as any, 'markRuntimeProcessCleanupState')
      .mockImplementation(async (...args: unknown[]) => {
        if (
          args[1] === 'cleanup-retry-runtime-1'
          && args[2] === 'CONFIRMED'
          && skipEvidencePersistence
        ) {
          evidenceStarted.resolve();
          await evidenceRelease.promise;
          skipEvidencePersistence = false;
          return undefined;
        }
        return originalMarkCleanup(...args);
      });
    const coordinator = (manager as any).runtimeCoordinator;
    const retryDisposedSpy = vi.spyOn(coordinator, 'retryDisposedSessionCleanup');

    const disposal = manager.disposeRuntimeSession(session.id, 'cleanup-retry-runtime-1');
    await evidenceStarted.promise;
    const cleanupInput = await getPersistedCleanupInput(session.id, 'cleanup-retry-runtime-1');
    const launchStateBeforeAdmission = await prisma.session.findUniqueOrThrow({
      where: { id: session.id },
      select: {
        status: true,
        runtimeLaunchState: true,
        runtimeLaunchClaimCount: true,
        runtimeLaunchResolvedCount: true,
        runtimeLaunchProcessCount: true,
        runtimeLaunchDiagnostic: true,
      },
    });
    const backgroundCleanup = manager.retryRuntimeProcessCleanup(cleanupInput);
    const resend = manager.sendMessage(session.id, 'resend while evidence persistence fails');
    await vi.waitFor(() => expect(retryDisposedSpy).toHaveBeenCalledTimes(2));
    const disposalResult = expect(disposal).rejects.toThrow('is not durably confirmed');
    const backgroundResult = expect(backgroundCleanup).rejects.toMatchObject({
      code: 'runtime_cleanup_pending',
      retryable: true,
    });
    const resendResult = expect(resend).rejects.toMatchObject({
      code: 'runtime_cleanup_pending',
      retryable: true,
    });

    evidenceRelease.resolve();
    await Promise.all([disposalResult, backgroundResult, resendResult]);

    expect(firstDriverSession.close).toHaveBeenCalledOnce();
    expect(driver.open).toHaveBeenCalledOnce();
    expect(observedCredentials).toHaveLength(2);
    await expect(prisma.session.findUniqueOrThrow({
      where: { id: session.id },
      select: {
        status: true,
        runtimeLaunchState: true,
        runtimeLaunchClaimCount: true,
        runtimeLaunchResolvedCount: true,
        runtimeLaunchProcessCount: true,
        runtimeLaunchDiagnostic: true,
      },
    })).resolves.toEqual(launchStateBeforeAdmission);
    expect(manager.hasRuntimeProcessOwner('cleanup-retry-runtime-1', session.id, 1)).toBe(true);
    await expect(prisma.executionProcess.findFirstOrThrow({
      where: { sessionId: session.id, runtimeInstanceId: 'cleanup-retry-runtime-1' },
    })).resolves.toMatchObject({ cleanupState: 'FAILED' });
    expect(await prisma.executionProcess.count({
      where: { sessionId: session.id, cleanupState: 'QUARANTINED' },
    })).toBe(0);

    await expect(manager.retryRuntimeProcessCleanup(cleanupInput)).resolves.toBeUndefined();
    expect(firstDriverSession.close).toHaveBeenCalledOnce();
    expect(manager.hasRuntimeProcessOwner('cleanup-retry-runtime-1', session.id, 1)).toBe(false);
    await expect(manager.sendMessage(session.id, 'resend after evidence recovery'))
      .resolves.toMatchObject({ id: session.id });
    expect(driver.open).toHaveBeenCalledTimes(2);
    expect(observedCredentials).toHaveLength(3);
    expect(await prisma.executionProcess.count({
      where: { sessionId: session.id, cleanupState: 'QUARANTINED' },
    })).toBe(0);

    retryDisposedSpy.mockRestore();
    markCleanupSpy.mockRestore();
    await manager.destroyAll();
  });

  it('cancels an admission-first resend before background cleanup can close its DriverSession', async () => {
    const {
      driver,
      driverSessions,
      manager,
      observedCredentials,
      session,
      turns,
    } = await createRetryableAcpStopFixture([]);
    const driverSession = driverSessions[0]!;
    turns.at(-1)!.resolve({ stopReason: 'end_turn' });
    await vi.waitFor(async () => {
      const current = await prisma.session.findUniqueOrThrow({ where: { id: session.id } });
      expect(current.status).toBe(SessionStatus.COMPLETED);
    });

    const runTurnEntered = deferred<void>();
    const runTurnRelease = deferred<void>();
    vi.mocked(driverSession.runTurn).mockImplementationOnce(async (turn) => {
      runTurnEntered.resolve();
      await runTurnRelease.promise;
      turn.admissionSignal?.throwIfAborted();
      return { completion: new Promise<RuntimeTurnOutcome>(() => undefined) };
    });
    const cleanupInput = await getPersistedCleanupInput(session.id, 'cleanup-retry-runtime-1');

    const resend = manager.sendMessage(session.id, 'resend interrupted during driver handoff');
    await runTurnEntered.promise;
    const backgroundCleanup = manager.retryRuntimeProcessCleanup(cleanupInput);
    await Promise.resolve();

    expect(driverSession.close).not.toHaveBeenCalled();
    runTurnRelease.resolve();
    await expect(resend).rejects.toMatchObject({ code: 'runtime_admission_cancelled', retryable: true });
    await expect(backgroundCleanup).resolves.toBeUndefined();

    expect(driver.open).toHaveBeenCalledOnce();
    expect(driverSession.close).toHaveBeenCalledOnce();
    expect(new Set(observedCredentials).size).toBe(1);
    expect(validateAgentApiCredential(observedCredentials[0]!)).toBeNull();
    await expect(prisma.session.findUniqueOrThrow({ where: { id: session.id } })).resolves.toMatchObject({
      runtimeLaunchState: 'SAFE_PRE_CHILD_FAILURE',
      runtimeLaunchClaimCount: 3,
      runtimeLaunchResolvedCount: 3,
      runtimeLaunchProcessCount: 1,
    });
    await expect(prisma.executionProcess.findFirstOrThrow({
      where: { sessionId: session.id, runtimeInstanceId: 'cleanup-retry-runtime-1' },
    })).resolves.toMatchObject({ cleanupState: 'CONFIRMED' });
    expect(await prisma.executionProcess.count({
      where: { sessionId: session.id, cleanupState: 'QUARANTINED' },
    })).toBe(0);
    await manager.destroyAll();
  });

  it.each(['start', 'startFollowUp'] as const)(
    'revokes a public %s before runtime admission when stop wins during preparation',
    async (method) => {
      const { workspace, session } = await createSessionFixture();
      const resumeSource = await prisma.session.create({
        data: {
          workspaceId: workspace.id,
          agentType: AgentType.CODEX,
          prompt: 'previous turn',
          status: SessionStatus.COMPLETED,
          externalSessionId: 'previous-external-session',
        },
      });
      const manager = new SessionManager(new EventBus());
      const coordinator = (manager as any).runtimeCoordinator;
      const withStartAdmission = vi.spyOn(coordinator, 'withStartAdmission');
      const sessionRead = deferred<void>();
      const originalFindSession = (manager as any).findSessionExecutionRecord.bind(manager);
      vi.spyOn(manager as any, 'findSessionExecutionRecord').mockImplementation(async (sessionId: unknown) => {
        const record = await originalFindSession(String(sessionId));
        sessionRead.resolve();
        return record;
      });
      const preparationGate = deferred<void>();
      (manager as any).pendingAutoCommits.set(session.id, preparationGate.promise);

      const starting = method === 'start'
        ? manager.start(session.id)
        : manager.startFollowUp(session.id, resumeSource.id);
      const startingResult = expect(starting).rejects.toMatchObject({ code: 'SESSION_NOT_ADMITTED' });
      await sessionRead.promise;
      expect(withStartAdmission).not.toHaveBeenCalled();

      await expect(manager.stop(session.id)).resolves.toMatchObject({ id: session.id });
      await startingResult;
      expect(withStartAdmission).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
      await expect(prisma.session.findUniqueOrThrow({ where: { id: session.id } })).resolves.toMatchObject({
        status: SessionStatus.CANCELLED,
        runtimeLaunchState: 'NOT_STARTED',
        runtimeLaunchClaimCount: 0,
      });

      preparationGate.resolve();
      expect(withStartAdmission).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();

      const recoveryPty = new ControlledPty();
      spawnMock.mockResolvedValueOnce(spawnResultFor(recoveryPty));
      await expect(manager.sendMessage(session.id, 'recover after the completed stop'))
        .resolves.toMatchObject({ id: session.id });
      expect(spawnMock).toHaveBeenCalledOnce();
      await manager.stop(session.id);
      await manager.destroyAll();
    },
  );

  it.each(['start', 'startFollowUp'] as const)(
    'does not start public %s preparation while stop intent is already in flight',
    async (method) => {
      const { workspace, session } = await createSessionFixture();
      const resumeSource = await prisma.session.create({
        data: {
          workspaceId: workspace.id,
          agentType: AgentType.CODEX,
          prompt: 'previous turn',
          status: SessionStatus.COMPLETED,
        },
      });
      const manager = new SessionManager(new EventBus());
      const findSession = vi.spyOn(manager as any, 'findSessionExecutionRecord');
      const waitForAutoCommit = vi.spyOn(manager as any, 'waitForPendingAutoCommit');
      const stopBlocker = (manager as any).reserveSessionAction(session.id);
      const stopping = manager.stop(session.id);

      try {
        const starting = method === 'start'
          ? manager.start(session.id)
          : manager.startFollowUp(session.id, resumeSource.id);

        await expect(starting).rejects.toMatchObject({ code: 'SESSION_NOT_ADMITTED' });
        expect(findSession).not.toHaveBeenCalled();
        expect(waitForAutoCommit).not.toHaveBeenCalled();
        expect(spawnMock).not.toHaveBeenCalled();
      } finally {
        stopBlocker.release();
        await stopping;
        await manager.destroyAll();
      }
    },
  );

  it.each(['start', 'startFollowUp'] as const)(
    'observes a late public %s preparation rejection after stop',
    async (method) => {
      const { workspace, session } = await createSessionFixture();
      const resumeSource = await prisma.session.create({
        data: {
          workspaceId: workspace.id,
          agentType: AgentType.CODEX,
          prompt: 'previous turn',
          status: SessionStatus.COMPLETED,
        },
      });
      const manager = new SessionManager(new EventBus());
      const queryStarted = deferred<void>();
      const query = deferred<never>();
      vi.spyOn(manager as any, 'findSessionExecutionRecord').mockImplementation(() => {
        queryStarted.resolve();
        return query.promise;
      });
      const unhandledRejections: unknown[] = [];
      const recordUnhandledRejection = (reason: unknown) => {
        unhandledRejections.push(reason);
      };
      process.on('unhandledRejection', recordUnhandledRejection);

      try {
        const starting = method === 'start'
          ? manager.start(session.id)
          : manager.startFollowUp(session.id, resumeSource.id);
        const startingResult = expect(starting).rejects.toMatchObject({ code: 'SESSION_NOT_ADMITTED' });
        await queryStarted.promise;

        await expect(manager.stop(session.id)).resolves.toMatchObject({ id: session.id });
        await startingResult;
        query.reject(new Error('late session lookup failure'));
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(unhandledRejections).toEqual([]);
        expect(spawnMock).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', recordUnhandledRejection);
        await manager.destroyAll();
      }
    },
  );

  afterAll(async () => {
    await prisma.$disconnect();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('moves the session to COMPLETED with a persisted snapshot when the PTY exits normally', async () => {
    const { session } = await createSessionFixture();
    const pty = new ControlledPty();
    spawnMock.mockResolvedValueOnce(spawnResultFor(pty));

    const eventBus = new EventBus();
    const manager = new SessionManager(eventBus);
    const completed = waitForEvent(eventBus, 'session:completed');

    await manager.start(session.id);
    expect(manager.hasActivePipeline(session.id)).toBe(true);
    expect((await prisma.session.findUnique({ where: { id: session.id } }))?.status).toBe(SessionStatus.RUNNING);

    pty.emitData(JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }) + '\n');
    pty.emitData(JSON.stringify({
      type: 'item.completed',
      item: { id: 'm1', type: 'agent_message', text: 'all done' },
    }) + '\n');
    pty.emitExit(0);

    const payload = await completed;
    expect(payload.status).toBe(SessionStatus.COMPLETED);
    expect(manager.hasActivePipeline(session.id)).toBe(false);

    const persisted = await prisma.session.findUnique({ where: { id: session.id } });
    expect(persisted?.status).toBe(SessionStatus.COMPLETED);
    const snapshot = JSON.parse(persisted?.logSnapshot ?? '{}');
    expect(snapshot.sessionId).toBe('thread-1');
    expect(snapshot.entries.map((e: { content: string }) => e.content)).toContain('all done');
    // MsgStore 最终释放（handleSessionExit 的收尾步骤在 session:completed 事件之后）
    await vi.waitFor(() => {
      expect(sessionMsgStoreManager.has(session.id)).toBe(false);
    });
  });

  it('keeps a CLI DriverSession credential valid across completed follow-up and revokes it on stop', async () => {
    const { workspace, session } = await createSessionFixture();
    const firstPty = new ControlledPty();
    const secondPty = new ControlledPty();
    spawnMock
      .mockResolvedValueOnce(spawnResultFor(firstPty))
      .mockResolvedValueOnce(spawnResultFor(secondPty));
    const service = new WorkspaceBackgroundService();
    const eventBus = new EventBus();
    const manager = new SessionManager(eventBus);
    const completed = waitForEvent(eventBus, 'session:completed');

    await manager.start(session.id);
    const firstCredential = spawnMock.mock.calls[0]?.[0].env.get(AGENT_API_CREDENTIAL_ENV) as string;
    const firstIdentity = validateAgentApiCredential(firstCredential);
    expect(firstIdentity).toMatchObject({ sessionId: session.id, invocationId: null });
    await service.authorizeCaller(workspace.id, { kind: 'agent', ...firstIdentity! });

    firstPty.emitData(JSON.stringify({ type: 'turn.completed' }) + '\n');
    await completed;
    await vi.waitFor(() => expect(sessionMsgStoreManager.has(session.id)).toBe(false));
    expect(validateAgentApiCredential(firstCredential)).toEqual(firstIdentity);

    await manager.sendMessage(session.id, 'use workspace service again');
    const secondCredential = spawnMock.mock.calls[1]?.[0].env.get(AGENT_API_CREDENTIAL_ENV) as string;
    const secondIdentity = validateAgentApiCredential(secondCredential);
    expect(secondCredential).toBe(firstCredential);
    await service.authorizeCaller(workspace.id, { kind: 'agent', ...secondIdentity! });

    await manager.stop(session.id);
    expect(validateAgentApiCredential(secondCredential)).toBeNull();
    await manager.destroyAll();
  });

  it('coalesces burst patches into a low-frequency checkpoint and still force-flushes the final snapshot', async () => {
    const { session } = await createSessionFixture();
    const pty = new ControlledPty();
    spawnMock.mockResolvedValueOnce(spawnResultFor(pty));

    const eventBus = new EventBus();
    const manager = new SessionManager(eventBus);
    const completed = waitForEvent(eventBus, 'session:completed');
    await manager.start(session.id);

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    pty.emitData(JSON.stringify({ type: 'thread.started', thread_id: 'thread-checkpoint' }) + '\n');
    pty.emitData(JSON.stringify({
      type: 'item.completed',
      item: { id: 'm1', type: 'agent_message', text: 'checkpoint one' },
    }) + '\n');
    pty.emitData(JSON.stringify({
      type: 'item.completed',
      item: { id: 'm2', type: 'agent_message', text: 'checkpoint two' },
    }) + '\n');

    const checkpointTimers = setTimeoutSpy.mock.calls.filter(([, delay]) => delay === 15_000);
    expect(checkpointTimers).toHaveLength(1);
    expect((await prisma.session.findUnique({ where: { id: session.id } }))?.logSnapshot).toBeNull();

    const flushSnapshot = (
      manager as unknown as { flushSnapshotPersist(sessionId: string): Promise<void> }
    ).flushSnapshotPersist.bind(manager);
    await flushSnapshot(session.id);
    setTimeoutSpy.mockRestore();

    const checkpointed = await prisma.session.findUnique({ where: { id: session.id } });
    const checkpointedSnapshot = JSON.parse(checkpointed?.logSnapshot ?? '{}');
    expect(checkpointedSnapshot.entries.map((entry: { content: string }) => entry.content)).toEqual(
      expect.arrayContaining(['checkpoint one', 'checkpoint two']),
    );

    await new Promise((resolve) => setTimeout(resolve, 5));
    await flushSnapshot(session.id);
    const unchanged = await prisma.session.findUnique({ where: { id: session.id } });
    expect(unchanged?.updatedAt.getTime()).toBe(checkpointed?.updatedAt.getTime());

    pty.emitData(JSON.stringify({
      type: 'item.completed',
      item: { id: 'm3', type: 'agent_message', text: 'final only' },
    }) + '\n');
    pty.emitExit(0);
    await completed;

    const persisted = await prisma.session.findUnique({ where: { id: session.id } });
    expect(persisted?.status).toBe(SessionStatus.COMPLETED);
    const finalSnapshot = JSON.parse(persisted?.logSnapshot ?? '{}');
    expect(finalSnapshot.entries.map((entry: { content: string }) => entry.content)).toContain('final only');
  });

  it('completes on turn.completed before a slow PTY exit and cleans it in the background', async () => {
    const { session } = await createSessionFixture();
    const pty = new ControlledPty();
    spawnMock.mockResolvedValueOnce(spawnResultFor(pty));

    const eventBus = new EventBus();
    const manager = new SessionManager(eventBus);
    const completed = waitForEvent(eventBus, 'session:completed');

    await manager.start(session.id);
    pty.emitData(JSON.stringify({
      type: 'item.completed',
      item: { id: 'm1', type: 'agent_message', text: 'fast logical completion' },
    }) + '\n');
    pty.emitData(JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 2, output_tokens: 3 },
    }) + '\n');

    const payload = await completed;
    expect(payload.status).toBe(SessionStatus.COMPLETED);
    expect((await prisma.session.findUnique({ where: { id: session.id } }))?.status)
      .toBe(SessionStatus.COMPLETED);
    expect(manager.hasActiveTurn(session.id)).toBe(false);

    await vi.waitFor(() => {
      expect(pty.killed).toBe(true);
      expect(manager.hasActiveTurn(session.id)).toBe(false);
    }, { timeout: 2000 });

    const persisted = await prisma.session.findUnique({ where: { id: session.id } });
    const snapshot = JSON.parse(persisted?.logSnapshot ?? '{}');
    expect(snapshot.entries.map((entry: { content: string }) => entry.content))
      .toContain('fast logical completion');
  });

  it('waits for the completed generation auto-commit before starting an immediate follow-up', async () => {
    const { session } = await createSessionFixture();
    const firstPty = new ControlledPty();
    const secondPty = new ControlledPty();
    spawnMock.mockResolvedValueOnce(spawnResultFor(firstPty)).mockResolvedValueOnce(spawnResultFor(secondPty));

    const eventBus = new EventBus();
    const manager = new SessionManager(eventBus);
    const completed = waitForEvent(eventBus, 'session:completed');
    let releaseAutoCommit!: () => void;
    const autoCommit = new Promise<void>((resolve) => { releaseAutoCommit = resolve; });
    const autoCommitSpy = vi.spyOn(manager as any, 'autoCommitChanges').mockReturnValue(autoCommit);
    const waitForAutoCommitSpy = vi.spyOn(manager as any, 'waitForPendingAutoCommit');

    await manager.start(session.id);
    waitForAutoCommitSpy.mockClear();
    firstPty.emitData(JSON.stringify({
      type: 'item.completed',
      item: { id: 'm1', type: 'agent_message', text: 'first turn' },
    }) + '\n');
    firstPty.emitData(JSON.stringify({ type: 'turn.completed' }) + '\n');
    await completed;
    await vi.waitFor(() => expect(autoCommitSpy).toHaveBeenCalledTimes(1));

    const followUp = manager.sendMessage(session.id, 'follow-up');
    await vi.waitFor(() => expect(waitForAutoCommitSpy).toHaveBeenCalledWith(session.id));
    expect(spawnMock).toHaveBeenCalledTimes(1);

    releaseAutoCommit();
    await followUp;
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(autoCommitSpy.mock.calls[0]?.[0]).toBe(session.id);
    expect(autoCommitSpy.mock.calls[0]?.[1]).toBe(1);
  });

  it('writes a delayed follow-up into the new MsgStore after the completed store was released', async () => {
    const { session } = await createSessionFixture();
    const firstPty = new ControlledPty();
    const secondPty = new ControlledPty();
    spawnMock
      .mockResolvedValueOnce(spawnResultFor(firstPty))
      .mockResolvedValueOnce(spawnResultFor(secondPty));

    const eventBus = new EventBus();
    const manager = new SessionManager(eventBus);
    const firstCompleted = waitForEvent(eventBus, 'session:completed');
    await manager.start(session.id);
    firstPty.emitData(JSON.stringify({ type: 'thread.started', thread_id: 'thread-delayed' }) + '\n');
    firstPty.emitData(JSON.stringify({
      type: 'item.completed',
      item: { id: 'm1', type: 'agent_message', text: 'first response' },
    }) + '\n');
    firstPty.emitExit(0);
    await firstCompleted;
    await vi.waitFor(() => expect(sessionMsgStoreManager.has(session.id)).toBe(false));

    await manager.sendMessage(session.id, 'delayed follow-up');
    const secondCompleted = waitForEvent(eventBus, 'session:completed');
    secondPty.emitData(JSON.stringify({
      type: 'item.completed',
      item: { id: 'm2', type: 'agent_message', text: 'second response' },
    }) + '\n');
    secondPty.emitExit(0);
    await secondCompleted;

    const persisted = await prisma.session.findUnique({ where: { id: session.id } });
    const snapshot = JSON.parse(persisted?.logSnapshot ?? '{}');
    expect(snapshot.entries.map((entry: { content: string }) => entry.content)).toEqual(
      expect.arrayContaining(['first response', 'delayed follow-up', 'second response']),
    );
  });

  it('accepts a follow-up that explicitly reuses the session provider', async () => {
    const provider = {
      id: 'same-provider',
      name: 'Same provider',
      agentType: AgentType.CODEX,
      env: {},
      config: {},
      isDefault: false,
    };
    const executor = {
      agentType: AgentType.CODEX,
      displayName: 'Mock Codex',
      getAvailabilityInfo: vi.fn(),
      getCapabilities: vi.fn(() => []),
      spawn: spawnMock,
    };
    getProviderByIdMock.mockReturnValue(provider);
    getExecutorByProviderMock.mockReturnValue(executor);

    const { session } = await createSessionFixture({ providerId: provider.id });
    const pty = new ControlledPty();
    spawnMock.mockResolvedValueOnce(spawnResultFor(pty));

    const manager = new SessionManager(new EventBus());
    await manager.sendMessage(session.id, 'reuse provider', provider.id);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    await expect(prisma.session.findUnique({ where: { id: session.id } })).resolves.toMatchObject({
      providerId: provider.id,
      status: SessionStatus.RUNNING,
    });
    await manager.destroyAll();
  });

  it('keeps completed-turn post-processing alive when a follow-up provider was deleted', async () => {
    const { task, workspace, session } = await createSessionFixture();
    const pty = new ControlledPty();
    spawnMock.mockResolvedValueOnce(spawnResultFor(pty));

    const eventBus = new EventBus();
    const manager = new SessionManager(eventBus);
    const completed = waitForEvent(eventBus, 'session:completed');
    let releaseAutoCommit!: () => void;
    const autoCommit = new Promise<void>((resolve) => { releaseAutoCommit = resolve; });
    const autoCommitSpy = vi.spyOn(manager as any, 'autoCommitChanges').mockReturnValue(autoCommit);
    const reconcileSpy = vi
      .spyOn((manager as any).teamReconciler, 'handleSessionExit')
      .mockResolvedValue(false);
    const commitMessageSpy = vi
      .spyOn(manager as any, 'triggerCommitMessageGeneration')
      .mockImplementation(() => {});

    await manager.start(session.id);
    pty.emitData(JSON.stringify({ type: 'turn.completed' }) + '\n');
    await completed;

    await expect(manager.sendMessage(session.id, 'follow-up', 'deleted-provider'))
      .rejects.toThrow('Provider not found: deleted-provider');
    await vi.waitFor(() => expect(autoCommitSpy).toHaveBeenCalledTimes(1));
    expect(spawnMock).toHaveBeenCalledTimes(1);

    releaseAutoCommit();
    await vi.waitFor(async () => {
      expect(reconcileSpy).toHaveBeenCalledWith(session.id, expect.any(String));
      expect((await prisma.task.findUnique({ where: { id: task.id } }))?.status)
        .toBe(TaskStatus.IN_REVIEW);
      expect(commitMessageSpy).toHaveBeenCalledWith(workspace.id);
    });
  });

  it('keeps completed-turn post-processing alive when the session provider was deleted and omitted', async () => {
    const { task, workspace, session } = await createSessionFixture({ providerId: 'deleted-provider' });
    const pty = new ControlledPty();
    const executor = {
      agentType: AgentType.CODEX,
      displayName: 'Mock Codex',
      getAvailabilityInfo: vi.fn(),
      getCapabilities: vi.fn(() => []),
      spawn: spawnMock,
    };
    getExecutorByProviderMock.mockReturnValue(executor);
    spawnMock.mockResolvedValueOnce(spawnResultFor(pty));

    const eventBus = new EventBus();
    const manager = new SessionManager(eventBus);
    const completed = waitForEvent(eventBus, 'session:completed');
    let releaseAutoCommit!: () => void;
    const autoCommit = new Promise<void>((resolve) => { releaseAutoCommit = resolve; });
    const autoCommitSpy = vi.spyOn(manager as any, 'autoCommitChanges').mockReturnValue(autoCommit);
    const reconcileSpy = vi
      .spyOn((manager as any).teamReconciler, 'handleSessionExit')
      .mockResolvedValue(false);
    const commitMessageSpy = vi
      .spyOn(manager as any, 'triggerCommitMessageGeneration')
      .mockImplementation(() => {});

    await manager.start(session.id);
    pty.emitData(JSON.stringify({ type: 'turn.completed' }) + '\n');
    await completed;

    await expect(manager.sendMessage(session.id, 'follow-up')).rejects
      .toThrow('Provider not found: deleted-provider');
    await vi.waitFor(() => expect(autoCommitSpy).toHaveBeenCalledTimes(1));
    expect(spawnMock).toHaveBeenCalledTimes(1);

    releaseAutoCommit();
    await vi.waitFor(async () => {
      expect(reconcileSpy).toHaveBeenCalledWith(session.id, expect.any(String));
      expect((await prisma.task.findUnique({ where: { id: task.id } }))?.status)
        .toBe(TaskStatus.IN_REVIEW);
      expect(commitMessageSpy).toHaveBeenCalledWith(workspace.id);
    });
  });

  it('holds reconciliation while valid follow-up provider validation is delayed', async () => {
    const provider = {
      id: 'delayed-provider',
      name: 'Delayed provider',
      agentType: AgentType.CODEX,
      env: {},
      config: {},
      isDefault: false,
    };
    const executor = {
      agentType: AgentType.CODEX,
      displayName: 'Mock Codex',
      getAvailabilityInfo: vi.fn(),
      getCapabilities: vi.fn(() => []),
      spawn: spawnMock,
    };
    getProviderByIdMock.mockReturnValue(provider);
    getExecutorByProviderMock.mockReturnValue(executor);

    const { session } = await createSessionFixture({ providerId: provider.id });
    const firstPty = new ControlledPty();
    const secondPty = new ControlledPty();
    spawnMock.mockResolvedValueOnce(spawnResultFor(firstPty)).mockResolvedValueOnce(spawnResultFor(secondPty));

    const eventBus = new EventBus();
    const manager = new SessionManager(eventBus);
    const completed = waitForEvent(eventBus, 'session:completed');
    const autoCommitSpy = vi.spyOn(manager as any, 'autoCommitChanges').mockResolvedValue(undefined);
    const reconcileSpy = vi
      .spyOn((manager as any).teamReconciler, 'handleSessionExit')
      .mockResolvedValue(false);

    await manager.start(session.id);
    firstPty.emitData(JSON.stringify({ type: 'turn.completed' }) + '\n');
    await completed;

    const originalFind = (manager as any).findSessionExecutionRecord.bind(manager);
    let releaseValidation!: () => void;
    let markValidationStarted!: () => void;
    const validationStarted = new Promise<void>((resolve) => { markValidationStarted = resolve; });
    const validationGate = new Promise<void>((resolve) => { releaseValidation = resolve; });
    vi.spyOn(manager as any, 'findSessionExecutionRecord').mockImplementation(async (...args: unknown[]) => {
      const sessionId = args[0] as string;
      if (sessionId === session.id) {
        markValidationStarted();
        await validationGate;
      }
      return originalFind(sessionId);
    });

    const followUp = manager.sendMessage(session.id, 'delayed follow-up', provider.id);
    await validationStarted;
    await vi.waitFor(() => expect(autoCommitSpy).toHaveBeenCalledTimes(1));
    expect(reconcileSpy).not.toHaveBeenCalled();

    releaseValidation();
    await followUp;
    expect(reconcileSpy).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    await manager.destroyAll();
  });

  it('keeps turn.failed terminal when the wrapper exits with code 0', async () => {
    const { task, session } = await createSessionFixture();
    const pty = new ControlledPty();
    spawnMock.mockResolvedValueOnce(spawnResultFor(pty));

    const eventBus = new EventBus();
    const manager = new SessionManager(eventBus);
    const completed = waitForEvent(eventBus, 'session:completed');

    await manager.start(session.id);
    pty.emitData(JSON.stringify({
      type: 'turn.failed',
      error: { message: 'rate limited' },
    }) + '\n');

    const payload = await completed;
    expect(payload.status).toBe(SessionStatus.FAILED);
    pty.emitExit(0);

    await vi.waitFor(async () => {
      expect((await prisma.session.findUnique({ where: { id: session.id } }))?.status)
        .toBe(SessionStatus.FAILED);
    });
    // The session's task remains in progress; a failed turn must not trigger
    // the success-only Task -> IN_REVIEW transition.
    expect((await prisma.task.findUnique({ where: { id: task.id } }))?.status).not.toBe('IN_REVIEW');
    expect(manager.hasActivePipeline(session.id)).toBe(false);
  });

  it('stops the residual PTY without regressing a logically completed session', async () => {
    const { session } = await createSessionFixture();
    const pty = new ControlledPty();
    spawnMock.mockResolvedValueOnce(spawnResultFor(pty));

    const eventBus = new EventBus();
    const manager = new SessionManager(eventBus);
    const completed = waitForEvent(eventBus, 'session:completed');

    await manager.start(session.id);
    pty.emitData(JSON.stringify({
      type: 'item.completed',
      item: { id: 'm1', type: 'agent_message', text: 'done before stop' },
    }) + '\n');
    pty.emitData(JSON.stringify({ type: 'turn.completed' }) + '\n');
    await completed;

    await manager.stop(session.id);

    expect(pty.killed).toBe(true);
    expect(manager.hasActivePipeline(session.id)).toBe(false);
    expect((await prisma.session.findUnique({ where: { id: session.id } }))?.status)
      .toBe(SessionStatus.COMPLETED);
  });

  it('marks the session FAILED when the PTY exits non-zero with only stderr noise', async () => {
    const { session } = await createSessionFixture();
    const pty = new ControlledPty();
    spawnMock.mockResolvedValueOnce(spawnResultFor(pty));

    const eventBus = new EventBus();
    const manager = new SessionManager(eventBus);
    const completed = waitForEvent(eventBus, 'session:completed');

    await manager.start(session.id);
    pty.emitData('ERROR: unauthorized\n');
    pty.emitExit(1);

    const payload = await completed;
    expect(payload.status).toBe(SessionStatus.FAILED);

    const persisted = await prisma.session.findUnique({ where: { id: session.id } });
    expect(persisted?.status).toBe(SessionStatus.FAILED);
    const snapshot = JSON.parse(persisted?.logSnapshot ?? '{}');
    const errorEntries = snapshot.entries.filter((e: { entryType: string }) => e.entryType === 'error_message');
    expect(errorEntries).toHaveLength(1);
    expect(errorEntries[0].content).toContain('unauthorized');
  });

  it('does not leave the session RUNNING when the process exits before the pipeline attaches (early-exit race)', async () => {
    const { session } = await createSessionFixture();
    const pty = new ControlledPty();
    // 进程在 spawn 返回后立刻输出错误并退出 —— 事件发生于 attachPipeline 之前，
    // 由 executor 缓存、pipeline 构造时重放
    spawnMock.mockResolvedValueOnce(
      spawnResultFor(pty, [
        { type: 'data', data: 'codex: fatal startup error\n' },
        { type: 'exit', exitCode: 2 },
      ])
    );

    const eventBus = new EventBus();
    const manager = new SessionManager(eventBus);
    const completed = waitForEvent(eventBus, 'session:completed');

    await manager.start(session.id);
    const payload = await completed;

    expect(payload.status).toBe(SessionStatus.FAILED);
    expect(manager.hasActivePipeline(session.id)).toBe(false);
    const persisted = await prisma.session.findUnique({ where: { id: session.id } });
    expect(persisted?.status).toBe(SessionStatus.FAILED);
    const snapshot = JSON.parse(persisted?.logSnapshot ?? '{}');
    const errorEntries = snapshot.entries.filter((e: { entryType: string }) => e.entryType === 'error_message');
    expect(errorEntries.length).toBeGreaterThan(0);
    expect(errorEntries[0].content).toContain('fatal startup error');
  });

  it('stop() cancels the session, persists the snapshot and releases the MsgStore', async () => {
    const { session } = await createSessionFixture();
    const pty = new ControlledPty();
    spawnMock.mockResolvedValueOnce(spawnResultFor(pty));

    const eventBus = new EventBus();
    const manager = new SessionManager(eventBus);

    await manager.start(session.id);
    pty.emitData(JSON.stringify({
      type: 'item.completed',
      item: { id: 'm1', type: 'agent_message', text: 'partial work' },
    }) + '\n');

    await manager.stop(session.id);

    const persisted = await prisma.session.findUnique({ where: { id: session.id } });
    expect(persisted?.status).toBe(SessionStatus.CANCELLED);
    expect(manager.hasActivePipeline(session.id)).toBe(false);
    expect(pty.killed).toBe(true);
    const snapshot = JSON.parse(persisted?.logSnapshot ?? '{}');
    expect(snapshot.entries.map((e: { content: string }) => e.content)).toContain('partial work');
    expect(sessionMsgStoreManager.has(session.id)).toBe(false);
  });

  it('keeps a real workspace service alive through SessionManager and CLI disposal', async () => {
    const { workspace, session } = await createSessionFixture();
    const backgroundManager = new WorkspaceBackgroundProcessManager({
      resolveCommand: async () => process.execPath,
    });
    const backgroundService = new WorkspaceBackgroundService(backgroundManager);
    const pty = new ControlledPty();
    spawnMock.mockResolvedValueOnce(spawnResultFor(pty));
    const eventBus = new EventBus();
    const manager = new SessionManager(eventBus);
    let started: Awaited<ReturnType<InstanceType<typeof WorkspaceBackgroundService>['start']>> | null = null;

    try {
      started = await backgroundService.start(workspace.id, 'web', {
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
      });
      const completed = waitForEvent(eventBus, 'session:completed');
      await manager.start(session.id);
      pty.emitExit(0);
      await completed;

      expect(backgroundManager.has(started.id, started.runtimeInstanceId)).toBe(true);
      await manager.stop(session.id);

      expect(backgroundManager.has(started.id, started.runtimeInstanceId)).toBe(true);
      await expect(backgroundService.list(workspace.id)).resolves.toEqual([
        expect.objectContaining({ runtimeState: 'RUNNING' }),
      ]);
    } finally {
      await manager.destroyAll();
      if (started) await backgroundService.stop(workspace.id, 'web').catch(() => undefined);
      await backgroundManager.stopAll().catch(() => undefined);
    }
  }, 15_000);

  it('does not confirm ACP tree cleanup on root exit or let a late old cleanup overwrite a new runtime', async () => {
    const { session } = await createSessionFixture();
    const manager = new SessionManager(new EventBus());
    const handleProcessEvent = (manager as unknown as {
      handleRuntimeProcessEvent(event: Record<string, unknown>): Promise<void>;
    }).handleRuntimeProcessEvent.bind(manager);

    await prisma.session.update({
      where: { id: session.id },
      data: {
        status: SessionStatus.RUNNING,
        runtimeLaunchState: 'CLAIMED',
        runtimeLaunchClaimCount: 1,
      },
    });

    await handleProcessEvent({
      type: 'started',
      towerSessionId: session.id,
      runtimeInstanceId: 'runtime-old',
      launchClaimNumber: 1,
      pid: 4101,
      processGroupId: '4101',
      birthMarker: 'darwin:old:token-old',
      ownershipToken: 'token-old',
    });
    await handleProcessEvent({
      type: 'exited',
      towerSessionId: session.id,
      runtimeInstanceId: 'runtime-old',
      exitCode: 0,
      launchClaimNumber: 1,
    });
    await expect(prisma.executionProcess.findFirst({
      where: { sessionId: session.id, runtimeInstanceId: 'runtime-old' },
    })).resolves.toMatchObject({ exitCode: 0, cleanupState: 'PENDING' });

    await prisma.session.update({
      where: { id: session.id },
      data: {
        runtimeLaunchState: 'CLAIMED',
        runtimeLaunchClaimCount: 2,
      },
    });

    await handleProcessEvent({
      type: 'started',
      towerSessionId: session.id,
      runtimeInstanceId: 'runtime-new',
      launchClaimNumber: 2,
      pid: 4102,
      processGroupId: '4102',
      birthMarker: 'darwin:new:token-new',
      ownershipToken: 'token-new',
    });
    await handleProcessEvent({
      type: 'exited',
      towerSessionId: session.id,
      runtimeInstanceId: 'runtime-shared',
      launchClaimNumber: 1,
      exitCode: 0,
      signal: null,
    });
    await expect(prisma.executionProcess.findFirstOrThrow({
      where: { sessionId: session.id, launchClaimNumber: 1 },
    })).resolves.toMatchObject({ cleanupState: 'PENDING' });
    await expect(prisma.executionProcess.findFirstOrThrow({
      where: { sessionId: session.id, launchClaimNumber: 2 },
    })).resolves.toMatchObject({ cleanupState: 'ACTIVE' });

    await handleProcessEvent({
      type: 'tree_cleanup_completed',
      towerSessionId: session.id,
      runtimeInstanceId: 'runtime-old',
      launchClaimNumber: 1,
    });
    await handleProcessEvent({
      type: 'exited',
      towerSessionId: session.id,
      runtimeInstanceId: 'runtime-old',
      exitCode: 0,
      launchClaimNumber: 1,
    });

    await expect(prisma.executionProcess.findFirst({
      where: { sessionId: session.id, runtimeInstanceId: 'runtime-old' },
    })).resolves.toMatchObject({ cleanupState: 'CONFIRMED' });
    await expect(prisma.executionProcess.findFirst({
      where: { sessionId: session.id, runtimeInstanceId: 'runtime-new' },
    })).resolves.toMatchObject({ cleanupState: 'ACTIVE' });
    await manager.destroyAll();
  });

  it('requires the launch claim when cleanup events share a runtime instance id', async () => {
    const { session } = await createSessionFixture();
    const manager = new SessionManager(new EventBus());
    const handleProcessEvent = (manager as unknown as {
      handleRuntimeProcessEvent(event: Record<string, unknown>): Promise<void>;
    }).handleRuntimeProcessEvent.bind(manager);

    await prisma.session.update({
      where: { id: session.id },
      data: {
        status: SessionStatus.RUNNING,
        runtimeLaunchState: 'CLAIMED',
        runtimeLaunchClaimCount: 1,
      },
    });
    await handleProcessEvent({
      type: 'started',
      towerSessionId: session.id,
      runtimeInstanceId: 'runtime-shared',
      launchClaimNumber: 1,
      pid: 4111,
      processGroupId: '4111',
      birthMarker: 'darwin:shared:one',
      ownershipToken: 'token-shared-one',
    });

    await prisma.session.update({
      where: { id: session.id },
      data: {
        runtimeLaunchState: 'CLAIMED',
        runtimeLaunchClaimCount: 2,
      },
    });
    await handleProcessEvent({
      type: 'started',
      towerSessionId: session.id,
      runtimeInstanceId: 'runtime-shared',
      launchClaimNumber: 2,
      pid: 4112,
      processGroupId: '4112',
      birthMarker: 'darwin:shared:two',
      ownershipToken: 'token-shared-two',
    });

    // A late event without the generation claim cannot be assigned to either
    // owner, even when runtimeInstanceId is shared across reconnects.
    await handleProcessEvent({
      type: 'tree_cleanup_completed',
      towerSessionId: session.id,
      runtimeInstanceId: 'runtime-shared',
    });
    await expect(prisma.executionProcess.findMany({
      where: { sessionId: session.id, runtimeInstanceId: 'runtime-shared' },
      orderBy: { launchClaimNumber: 'asc' },
    })).resolves.toMatchObject([
      { launchClaimNumber: 1, cleanupState: 'ACTIVE' },
      { launchClaimNumber: 2, cleanupState: 'ACTIVE' },
    ]);

    await handleProcessEvent({
      type: 'tree_cleanup_completed',
      towerSessionId: session.id,
      runtimeInstanceId: 'runtime-shared',
      launchClaimNumber: 1,
    });
    await expect(prisma.executionProcess.findFirstOrThrow({
      where: { sessionId: session.id, launchClaimNumber: 1 },
    })).resolves.toMatchObject({ cleanupState: 'CONFIRMED' });
    await expect(prisma.executionProcess.findFirstOrThrow({
      where: { sessionId: session.id, launchClaimNumber: 2 },
    })).resolves.toMatchObject({ cleanupState: 'ACTIVE' });

    await handleProcessEvent({
      type: 'tree_cleanup_completed',
      towerSessionId: session.id,
      runtimeInstanceId: 'runtime-shared',
      launchClaimNumber: 2,
    });
    await expect(prisma.executionProcess.findMany({
      where: { sessionId: session.id, runtimeInstanceId: 'runtime-shared' },
      orderBy: { launchClaimNumber: 'asc' },
    })).resolves.toMatchObject([
      { launchClaimNumber: 1, cleanupState: 'CONFIRMED' },
      { launchClaimNumber: 2, cleanupState: 'CONFIRMED' },
    ]);
    await manager.destroyAll();
  });

  it('replays early process events after deferred started persistence', async () => {
    const { session } = await createSessionFixture();
    const manager = new SessionManager(new EventBus());
    const handleProcessEvent = (manager as unknown as {
      handleRuntimeProcessEvent(event: Record<string, unknown>): Promise<void>;
    }).handleRuntimeProcessEvent.bind(manager);

    // Simulate the raw wrapper exit arriving before the started transaction.
    await handleProcessEvent({
      type: 'exited',
      towerSessionId: session.id,
      runtimeInstanceId: 'runtime-deferred',
      exitCode: 0,
      launchClaimNumber: 1,
    });
    await handleProcessEvent({
      type: 'tree_cleanup_completed',
      towerSessionId: session.id,
      runtimeInstanceId: 'runtime-deferred',
      launchClaimNumber: 1,
    });
    await expect(prisma.session.findUnique({ where: { id: session.id } }))
      .resolves.toMatchObject({
        runtimeLaunchState: 'QUARANTINED',
        runtimeLaunchDiagnostic: expect.stringContaining('before started persistence'),
      });

    await prisma.session.update({
      where: { id: session.id },
      data: {
        status: SessionStatus.RUNNING,
        runtimeLaunchState: 'CLAIMED',
        runtimeLaunchClaimCount: 1,
      },
    });
    await handleProcessEvent({
      type: 'started',
      towerSessionId: session.id,
      runtimeInstanceId: 'runtime-deferred',
      launchClaimNumber: 1,
      pid: 4301,
      processGroupId: '4301',
      birthMarker: 'linux:deferred',
      ownershipToken: 'owner-deferred',
    });

    await expect(prisma.executionProcess.findFirstOrThrow({
      where: { sessionId: session.id, runtimeInstanceId: 'runtime-deferred' },
    })).resolves.toMatchObject({ exitCode: 0, cleanupState: 'CONFIRMED' });
    expect(manager.hasRuntimeProcessOwner('runtime-deferred')).toBe(false);
    await manager.destroyAll();
  });

  it('does not let late runtime events downgrade incomplete ownership quarantine', async () => {
    const { session } = await createSessionFixture();
    const manager = new SessionManager(new EventBus());
    const handleProcessEvent = (manager as unknown as {
      handleRuntimeProcessEvent(event: Record<string, unknown>): Promise<void>;
    }).handleRuntimeProcessEvent.bind(manager);
    await prisma.session.update({
      where: { id: session.id },
      data: {
        status: SessionStatus.RUNNING,
        runtimeLaunchState: 'CLAIMED',
        runtimeLaunchClaimCount: 1,
      },
    });

    await handleProcessEvent({
      type: 'started',
      towerSessionId: session.id,
      runtimeInstanceId: 'runtime-incomplete',
      launchClaimNumber: 1,
      pid: 4151,
      processGroupId: '4151',
      birthMarker: '',
      ownershipToken: 'token-incomplete',
    });
    await handleProcessEvent({
      type: 'exited',
      towerSessionId: session.id,
      runtimeInstanceId: 'runtime-incomplete',
      exitCode: 0,
      launchClaimNumber: 1,
    });
    await handleProcessEvent({
      type: 'tree_cleanup_completed',
      towerSessionId: session.id,
      runtimeInstanceId: 'runtime-incomplete',
      launchClaimNumber: 1,
    });

    await expect(prisma.executionProcess.findFirstOrThrow({
      where: { sessionId: session.id, runtimeInstanceId: 'runtime-incomplete' },
    })).resolves.toMatchObject({
      cleanupState: 'QUARANTINED',
      cleanupError: expect.stringContaining('complete process ownership identity'),
    });
    await manager.destroyAll();
  });

  it('bounds pending process events per generation and expires them', async () => {
    vi.useFakeTimers();
    try {
      const { session } = await createSessionFixture();
      const manager = new SessionManager(new EventBus());
      const handleProcessEvent = (manager as unknown as {
        handleRuntimeProcessEvent(event: Record<string, unknown>): Promise<void>;
        pendingRuntimeProcessEvents: Map<string, unknown[]>;
      });
      for (let index = 0; index < 9; index += 1) {
        await handleProcessEvent.handleRuntimeProcessEvent({
          type: 'exited',
          towerSessionId: session.id,
          runtimeInstanceId: 'runtime-overflow',
          launchClaimNumber: 1,
          exitCode: 1,
        });
      }
      expect(handleProcessEvent.pendingRuntimeProcessEvents.size).toBe(0);

      await handleProcessEvent.handleRuntimeProcessEvent({
        type: 'exited',
        towerSessionId: session.id,
        runtimeInstanceId: 'runtime-expiry',
        launchClaimNumber: 2,
        exitCode: 1,
      });
      expect(handleProcessEvent.pendingRuntimeProcessEvents.size).toBe(1);
      await vi.advanceTimersByTimeAsync(60_001);
      expect(handleProcessEvent.pendingRuntimeProcessEvents.size).toBe(0);
      await manager.destroyAll();
    } finally {
      vi.useRealTimers();
    }
  });

  it('persists bounded cleanup retry attempts for recovery scans', async () => {
    const { session } = await createSessionFixture();
    const manager = new SessionManager(new EventBus());
    const processRecord = await prisma.executionProcess.create({
      data: {
        sessionId: session.id,
        launchClaimNumber: 1,
        runtimeInstanceId: 'runtime-retry',
        pid: 4201,
        processGroupId: '4201',
        birthMarker: 'linux:200:owner-retry',
        ownershipToken: 'owner-retry',
        cleanupState: 'PENDING',
      },
    });
    const markCleanup = (manager as unknown as {
      markRuntimeProcessCleanupState(
        sessionId: string,
        runtimeInstanceId: string,
        state: 'CONFIRMED' | 'FAILED',
        error?: string,
        launchClaimNumber?: number | null,
      ): Promise<void>;
    }).markRuntimeProcessCleanupState.bind(manager);

    await markCleanup(session.id, 'runtime-retry', 'FAILED', 'first failure', 1);
    const first = await prisma.executionProcess.findUniqueOrThrow({ where: { id: processRecord.id } });
    await markCleanup(session.id, 'runtime-retry', 'FAILED', 'second failure', 1);
    const second = await prisma.executionProcess.findUniqueOrThrow({ where: { id: processRecord.id } });

    expect(first).toMatchObject({ cleanupState: 'FAILED', cleanupAttemptCount: 1, cleanupError: 'first failure' });
    expect(second).toMatchObject({ cleanupState: 'FAILED', cleanupAttemptCount: 2, cleanupError: 'second failure' });
    expect(first.nextCleanupRetryAt).not.toBeNull();
    expect(second.nextCleanupRetryAt!.getTime()).toBeGreaterThan(first.nextCleanupRetryAt!.getTime());
    await manager.destroyAll();
  });
});
