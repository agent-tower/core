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

const { spawnMock, getProviderByIdMock, getExecutorByProviderMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  getProviderByIdMock: vi.fn(),
  getExecutorByProviderMock: vi.fn(),
}));

vi.mock('../../executors/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../executors/index.js')>();
  return {
    ...actual,
    getExecutor: vi.fn(() => ({
      agentType: 'CODEX',
      displayName: 'Mock Codex',
      getAvailabilityInfo: vi.fn(),
      getCapabilities: vi.fn(() => []),
      spawn: spawnMock,
      // 无 spawnFollowUp —— sendMessage 走全新 spawn 路径
    })),
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

/** 可手动触发事件的 fake PTY，语义对齐 node-pty（不重放事件） */
class ControlledPty {
  pid = 4242;
  killed = false;
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = [];

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
    for (const l of [...this.exitListeners]) l({ exitCode });
  }

  write() {}
  resize() {}
  kill() { this.killed = true; }
}

function spawnResultFor(pty: ControlledPty, earlyEvents: EarlyPtyEvent[] = []) {
  let taken = false;
  return {
    pid: pty.pid,
    pty,
    takeEarlyEvents: () => {
      if (taken) return [];
      taken = true;
      return earlyEvents;
    },
  };
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
    prisma = utilsModule.prisma;
    SessionManager = sessionManagerModule.SessionManager;
    sessionMsgStoreManager = outputModule.sessionMsgStoreManager;
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    getProviderByIdMock.mockReturnValue(null);
    getExecutorByProviderMock.mockReset();
    await prisma.executionProcess.deleteMany();
    await prisma.session.deleteMany();
    await prisma.workspace.deleteMany();
    await prisma.task.deleteMany();
    await prisma.project.deleteMany();
  });

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
    expect(manager.hasActivePipeline(session.id)).toBe(true);

    await vi.waitFor(() => {
      expect(pty.killed).toBe(true);
      expect(manager.hasActivePipeline(session.id)).toBe(false);
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

    const followUp = manager.sendMessage(session.id, 'follow-up');
    await vi.waitFor(() => {
      expect(waitForAutoCommitSpy).toHaveBeenCalledWith(session.id);
      expect(autoCommitSpy).toHaveBeenCalledTimes(1);
      expect(spawnMock).toHaveBeenCalledTimes(1);
    });

    releaseAutoCommit();
    await followUp;
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(autoCommitSpy.mock.calls[0]?.[0]).toBe(session.id);
    expect(autoCommitSpy.mock.calls[0]?.[1]).toBe(1);
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
    manager.destroyAll();
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
    expect(autoCommitSpy).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    releaseAutoCommit();
    await vi.waitFor(async () => {
      expect(reconcileSpy).toHaveBeenCalledWith(session.id);
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
    expect(autoCommitSpy).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    releaseAutoCommit();
    await vi.waitFor(async () => {
      expect(reconcileSpy).toHaveBeenCalledWith(session.id);
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
    manager.destroyAll();
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
});
