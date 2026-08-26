import { RuntimeType, type RuntimeCapabilities, AgentType } from '@agent-tower/shared';
import { describe, expect, it, vi } from 'vitest';
import { ExecutionEnv } from '../../executors/execution-env.js';
import { MsgStore } from '../../output/msg-store.js';
import type {
  DriverSession,
  RuntimeCoordinatorHost,
  RuntimeDriver,
  RuntimeDriverEventSink,
  RuntimeRunTurnInput,
  RuntimeTurnOutcome,
} from '../contracts.js';
import { RuntimeCoordinator } from '../runtime-coordinator.js';
import { StaticRuntimeRegistry } from '../runtime-registry.js';
import { acpLaunchCleanupRegistry } from '../acp/launch-cleanup-registry.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const capabilities: RuntimeCapabilities = {
  loadSession: true,
  terminalInput: false,
  terminalResize: false,
  permissions: true,
};

function setup() {
  const turns: Array<ReturnType<typeof deferred<RuntimeTurnOutcome>>> = [];
  const sinks: RuntimeDriverEventSink[] = [];
  const session: DriverSession = {
    runtimeInstanceId: 'runtime-1',
    capabilities,
    runTurn: vi.fn(async (_input: RuntimeRunTurnInput, sink: RuntimeDriverEventSink) => {
      sinks.push(sink);
      const turn = deferred<RuntimeTurnOutcome>();
      turns.push(turn);
      return { completion: turn.promise };
    }),
    cancelTurn: vi.fn(async () => undefined),
    resolvePermission: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  const driver: RuntimeDriver = {
    type: RuntimeType.ACP,
    open: vi.fn(async () => session),
  };
  const events: Parameters<RuntimeCoordinatorHost['onTurnEvent']>[0][] = [];
  const states: Parameters<RuntimeCoordinatorHost['onRuntimeState']>[0][] = [];
  const onDriverSessionDisposed = vi.fn();
  const host: RuntimeCoordinatorHost = {
    onTurnEvent: (event) => events.push(event),
    onRuntimeState: (state) => states.push(state),
    onProcessEvent: vi.fn(async () => undefined),
    onDriverSessionDisposed,
  };
  const coordinator = new RuntimeCoordinator(new StaticRuntimeRegistry([driver]), host);
  const input = {
    towerSessionId: 'tower-1',
    agentType: AgentType.CODEX,
    runtimeType: RuntimeType.ACP,
    variant: 'DEFAULT',
    workingDir: process.cwd(),
    env: ExecutionEnv.default(process.cwd()),
    msgStore: new MsgStore(),
    prompt: 'hello',
    launchClaimNumber: undefined as number | undefined,
  };
  return { coordinator, input, session, turns, sinks, events, states, onDriverSessionDisposed };
}

describe('RuntimeCoordinator', () => {
  it('allows only one active turn per Tower session', async () => {
    const { coordinator, input } = setup();
    await coordinator.startTurn(input);
    await expect(coordinator.startTurn(input)).rejects.toThrow(/active turn/);
    await coordinator.destroyAll();
  });

  it('drops stale stream events after a turn reaches its terminal state', async () => {
    const { coordinator, input, turns, sinks, events } = setup();
    const handle = await coordinator.startTurn(input);
    sinks[0].stream({ type: 'progress' });
    turns[0].resolve({ stopReason: 'end_turn' });
    await handle.completion;
    sinks[0].stream({ type: 'progress' });

    expect(events.map((event) => event.event.type)).toEqual(['progress', 'completed']);
    expect(events.map((event) => event.sequence)).toEqual([1, 2]);
    await coordinator.destroyAll();
  });

  it('emits a terminal event exactly once when completion settles repeatedly', async () => {
    const { coordinator, input, turns, events } = setup();
    const handle = await coordinator.startTurn(input);
    turns[0].resolve({});
    turns[0].resolve({});
    await handle.completion;

    expect(events.filter((event) => event.event.type === 'completed')).toHaveLength(1);
    await coordinator.destroyAll();
  });

  it('passes the current turn MsgStore to a reused driver session', async () => {
    const { coordinator, input, session, turns } = setup();
    const first = await coordinator.startTurn(input);
    turns[0].resolve({});
    await first.completion;

    const nextMsgStore = new MsgStore();
    const second = await coordinator.startTurn({
      ...input,
      msgStore: nextMsgStore,
      prompt: 'follow up',
    });

    expect(vi.mocked(session.runTurn).mock.calls[1]?.[0].msgStore).toBe(nextMsgStore);
    turns[1].resolve({});
    await second.completion;
    await coordinator.destroyAll();
  });

  it('forwards the requested resume mode to the driver turn', async () => {
    const { coordinator, input, session, turns } = setup();
    const handle = await coordinator.startTurn({
      ...input,
      resumeExternalSessionId: 'external-1',
      resumeMode: 'resume',
      historyBoundaryEntryId: 'current-user',
    });

    expect(vi.mocked(session.runTurn)).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeExternalSessionId: 'external-1',
        resumeMode: 'resume',
        historyBoundaryEntryId: 'current-user',
      }),
      expect.anything(),
    );
    turns[0].resolve({});
    await handle.completion;
    await coordinator.destroyAll();
  });

  it('cancels an abandoned turn, suppresses its terminal event, and reuses the driver session', async () => {
    const { coordinator, input, session, turns, sinks, events } = setup();
    const first = await coordinator.startTurn(input);
    vi.mocked(session.cancelTurn).mockImplementationOnce(async () => {
      turns[0].resolve({ stopReason: 'cancelled' });
    });

    await expect(coordinator.abandonTurn(input.towerSessionId, 100)).resolves.toBe(true);
    await first.completion;
    sinks[0].stream({ type: 'progress' });

    const second = await coordinator.startTurn({ ...input, prompt: 'continue' });
    expect(session.cancelTurn).toHaveBeenCalledWith(first.turnId);
    expect(events).toHaveLength(0);
    expect(session.close).not.toHaveBeenCalled();
    expect(vi.mocked(session.runTurn)).toHaveBeenCalledTimes(2);

    turns[1].resolve({ stopReason: 'end_turn' });
    await second.completion;
    await coordinator.destroyAll();
  });

  it('reports an abandon timeout so the caller can dispose the driver session', async () => {
    const { coordinator, input, session } = setup();
    await coordinator.startTurn(input);

    await expect(coordinator.abandonTurn(input.towerSessionId, 1)).resolves.toBe(false);
    expect(session.cancelTurn).toHaveBeenCalledTimes(1);
    expect(session.close).not.toHaveBeenCalled();
    await coordinator.destroyAll();
  });

  it('validates permission option ids and returns to running after resolution', async () => {
    const { coordinator, input, sinks, session } = setup();
    const handle = await coordinator.startTurn(input);
    sinks[0].stream({
      type: 'permission_requested',
      request: {
        requestId: 'permission-1',
        sessionId: input.towerSessionId,
        turnId: handle.turnId,
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
        createdAt: new Date().toISOString(),
      },
    });

    expect(coordinator.getState(input.towerSessionId).turnState).toBe('AWAITING_PERMISSION');
    await expect(coordinator.resolvePermission(input.towerSessionId, 'permission-1', 'other'))
      .rejects.toThrow(/not offered/);
    await coordinator.resolvePermission(input.towerSessionId, 'permission-1', 'allow');
    expect(session.resolvePermission).toHaveBeenCalledWith('permission-1', 'allow');
    expect(coordinator.getState(input.towerSessionId).turnState).toBe('RUNNING');
    await coordinator.destroyAll();
  });

  it('awaits driver disposal during shutdown', async () => {
    const { coordinator, input, session, onDriverSessionDisposed } = setup();
    await coordinator.startTurn(input);
    await coordinator.destroyAll();
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(onDriverSessionDisposed).toHaveBeenCalledWith(input.towerSessionId);
    expect(coordinator.getState(input.towerSessionId).turnState).toBe('IDLE');
  });

  it('keeps a failed disposal retryable instead of reopening over an owned runtime', async () => {
    const { coordinator, input, session } = setup();
    await coordinator.startTurn(input);
    vi.mocked(session.close)
      .mockRejectedValueOnce(new Error('tree still alive'))
      .mockResolvedValueOnce(undefined);

    await expect(coordinator.disposeSession(input.towerSessionId)).rejects.toThrow('tree still alive');
    expect(coordinator.getState(input.towerSessionId).turnState).toBe('DISPOSED');
    await expect(coordinator.disposeSession(input.towerSessionId)).resolves.toBeUndefined();
    expect(session.close).toHaveBeenCalledTimes(2);
  });

  it('rejects failed disposal and allows a later destroy attempt to finish cleanup', async () => {
    const { coordinator, input, session } = setup();
    await coordinator.startTurn(input);
    vi.mocked(session.close)
      .mockRejectedValueOnce(new Error('shutdown tree still alive'))
      .mockResolvedValueOnce(undefined);

    await expect(coordinator.destroyAll()).rejects.toMatchObject({ code: 'runtime_cleanup_pending' });
    expect(coordinator.getState(input.towerSessionId).turnState).toBe('DISPOSED');
    await expect(coordinator.destroyAll()).resolves.toBeUndefined();
    expect(session.close).toHaveBeenCalledTimes(2);
  });

  it('keeps unresolved launch cleanup observable and retryable across repeated destroy calls', async () => {
    const { coordinator, input } = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let failCleanup = true;
    const ownerId = acpLaunchCleanupRegistry.register(async () => {
      if (failCleanup) throw new Error('owned tree still alive');
    }, 'post-spawn-without-process-row');

    try {
      await expect(coordinator.destroyAll()).rejects.toMatchObject({
        code: 'runtime_cleanup_pending',
        message: expect.stringContaining('1 unresolved ACP launch cleanup owner'),
      });
      expect(acpLaunchCleanupRegistry.getState(ownerId)).toMatchObject({
        status: 'FAILED',
        attemptCount: 1,
        lastError: 'owned tree still alive',
        nextRetryAt: expect.any(Number),
      });
      await expect(coordinator.startTurn(input)).rejects.toMatchObject({ code: 'runtime_disposed' });

      await expect(coordinator.destroyAll()).rejects.toMatchObject({ code: 'runtime_cleanup_pending' });
      expect(acpLaunchCleanupRegistry.getState(ownerId)).toMatchObject({
        status: 'FAILED',
        attemptCount: 2,
      });

      failCleanup = false;
      await expect(coordinator.destroyAll()).resolves.toBeUndefined();
      expect(acpLaunchCleanupRegistry.getState(ownerId)).toBeUndefined();
      await expect(coordinator.destroyAll()).resolves.toBeUndefined();
    } finally {
      failCleanup = false;
      await acpLaunchCleanupRegistry.drain();
      acpLaunchCleanupRegistry.shutdown();
      warn.mockRestore();
    }
  });

  it('persists the cleanup admission boundary before closing the driver session', async () => {
    const { coordinator, input, session } = setup();
    await coordinator.startTurn(input);
    const callOrder: string[] = [];
    const host = (coordinator as unknown as { host: RuntimeCoordinatorHost }).host;
    host.onDriverSessionDisposeStarted = vi.fn(async () => {
      callOrder.push('pending');
    });
    vi.mocked(session.close).mockImplementation(async () => {
      callOrder.push('close');
    });

    await coordinator.disposeSession(input.towerSessionId);

    expect(callOrder).toEqual(['pending', 'close']);
  });

  it('passes the process launch claim to disposal ownership callbacks', async () => {
    const { coordinator, input, session } = setup();
    const onDisposeStarted = vi.fn(async () => undefined);
    const host = (coordinator as unknown as { host: RuntimeCoordinatorHost }).host;
    host.onDriverSessionDisposeStarted = onDisposeStarted;
    input.launchClaimNumber = 7;

    await coordinator.startTurn(input);
    await coordinator.disposeSession(input.towerSessionId);

    expect(onDisposeStarted).toHaveBeenCalledWith(input.towerSessionId, session.runtimeInstanceId, 7);
  });

  it('rejects a new turn once disposal has claimed the Tower session', async () => {
    const { coordinator, input, session } = setup();
    await coordinator.startTurn(input);
    const close = deferred<void>();
    vi.mocked(session.close).mockReturnValueOnce(close.promise);

    const disposal = coordinator.disposeSession(input.towerSessionId);
    await expect(coordinator.startTurn(input)).rejects.toMatchObject({ code: 'runtime_disposed' });

    close.resolve();
    await disposal;
    expect(session.runTurn).toHaveBeenCalledTimes(1);
  });
});
