import { AgentType, RuntimeType } from '@agent-tower/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as executors from '../../executors/index.js';
import { ExecutionEnv } from '../../executors/execution-env.js';
import { MsgStore } from '../../output/msg-store.js';
import type { RuntimeDriverEventSink } from '../contracts.js';
import { CliRuntimeDriver } from '../cli-driver.js';
import { PTY_WRAPPER_EXIT_TIMEOUT_MS, PTY_WRAPPER_FORCE_KILL_GRACE_MS } from '../../utils/process-launch.js';
import { attachSpawnCleanupOwner } from '../../executors/start-error.js';

describe('CliRuntimeDriver cleanup lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('persists late failed-spawn cleanup and retains the owner until its event is acknowledged', async () => {
    let confirmExit!: () => void;
    const owner = {
      processExit: new Promise<void>((resolve) => { confirmExit = resolve; }),
      requestStop: vi.fn(), cleanup: vi.fn(async () => undefined),
      dispose: vi.fn(), disposeTreeCleanupChannel: vi.fn(),
    };
    vi.spyOn(executors, 'getExecutor').mockReturnValue({
      spawn: vi.fn(async () => { throw attachSpawnCleanupOwner(new Error('identity unavailable'), owner); }),
    } as never);
    let canPersist = false;
    const sink: RuntimeDriverEventSink = {
      stream: vi.fn(), process: vi.fn(async () => { if (!canPersist) throw new Error('database unavailable'); }),
    };
    const session = await new CliRuntimeDriver().open({
      towerSessionId: 'failed-spawn', agentType: AgentType.CODEX, runtimeType: RuntimeType.CLI,
      variant: 'DEFAULT', workingDir: process.cwd(), env: ExecutionEnv.default(process.cwd()),
    });
    const previousRuntime = session.runtimeInstanceId;
    await expect(session.runTurn({ turnId: 'failed', prompt: 'hello', msgStore: new MsgStore(), launchClaimNumber: 2 }, sink))
      .rejects.toThrow('identity unavailable');
    expect(session.runtimeInstanceId).not.toBe(previousRuntime);
    expect(sink.process).not.toHaveBeenCalled();
    confirmExit();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sink.process).toHaveBeenCalledWith({
      type: 'launch_cleanup_completed', runtimeInstanceId: session.runtimeInstanceId, launchClaimNumber: 2,
    });
    await expect(session.close()).rejects.toMatchObject({ code: 'runtime_cleanup_pending' });
    expect(owner.dispose).not.toHaveBeenCalled();
    canPersist = true;
    await expect(session.close()).resolves.toBeUndefined();
    expect(owner.dispose).toHaveBeenCalledTimes(1);
    expect(owner.disposeTreeCleanupChannel).toHaveBeenCalledTimes(1);
  });

  it.each([
    { agentType: AgentType.CODEX, runtimeType: RuntimeType.ACP },
    { agentType: AgentType.GEMINI_CLI, runtimeType: RuntimeType.CLI },
  ])('rejects mismatching Provider snapshots on open and on a later new CLI process (%j)', async (identity) => {
    const input = {
      towerSessionId: 'mismatched-cli', agentType: AgentType.CODEX, runtimeType: RuntimeType.CLI,
      variant: 'DEFAULT', workingDir: process.cwd(), env: ExecutionEnv.default(process.cwd()),
    };
    const provider = { id: 'changed', name: 'Changed', ...identity,
      executionPermission: 'FULL_ACCESS' as const, config: {}, env: {}, isDefault: false };
    const factory = vi.spyOn(executors, 'createExecutorFromProvider');
    const driver = new CliRuntimeDriver();
    await expect(driver.open({ ...input, providerSnapshot: provider })).rejects.toMatchObject({ code: 'provider_config_invalid' });
    const session = await driver.open(input);
    const sink: RuntimeDriverEventSink = { stream: vi.fn(), process: vi.fn(async () => undefined) };
    await expect(session.runTurn({ turnId: 'new-process', prompt: 'hello', msgStore: new MsgStore(), providerSnapshot: provider }, sink))
      .rejects.toMatchObject({ code: 'provider_config_invalid' });
    expect(factory).not.toHaveBeenCalled();
    expect(sink.process).not.toHaveBeenCalled();
    await session.close();
    vi.spyOn(executors, 'getProviderById').mockReturnValue(provider);
    const legacyInput = await driver.open({ ...input, providerId: provider.id });
    await expect(legacyInput.runTurn({ turnId: 'legacy-input', prompt: 'hello', msgStore: new MsgStore() }, sink))
      .rejects.toMatchObject({ code: 'provider_config_invalid' });
    expect(factory).not.toHaveBeenCalled();
    await legacyInput.close();
  });

  it('does not confirm a second close before the real PTY tree exit', async () => {
    vi.useFakeTimers();
    const exitListeners: Array<(event: { exitCode: number; signal?: string | null }) => void> = [];
    const pty = {
      onData: () => ({ dispose: vi.fn() }),
      onExit: (listener: (event: { exitCode: number; signal?: string | null }) => void) => {
        exitListeners.push(listener);
        return { dispose: vi.fn() };
      },
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
    const executor = {
      spawn: vi.fn(async () => ({
        pid: 123,
        processGroupId: 'pgid',
        birthMarker: 'birth',
        ownershipToken: 'owner',
        pty,
        cancel: { cancel: vi.fn() },
        takeEarlyEvents: () => [],
      })),
    };
    vi.spyOn(executors, 'getExecutor').mockReturnValue(executor as never);

    const sink: RuntimeDriverEventSink = {
      stream: vi.fn(),
      process: vi.fn(async () => undefined),
    };
    const session = await new CliRuntimeDriver().open({
      towerSessionId: 'tower-cli',
      agentType: AgentType.CODEX,
      runtimeType: RuntimeType.CLI,
      variant: 'DEFAULT',
      workingDir: process.cwd(),
      env: ExecutionEnv.default(process.cwd()),
    });
    await session.runTurn({ turnId: 'turn-cli', prompt: 'hello', msgStore: new MsgStore() }, sink);

    const firstClose = session.close();
    void firstClose.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(PTY_WRAPPER_EXIT_TIMEOUT_MS);
    await expect(firstClose).rejects.toMatchObject({ code: 'process_exit_timeout' });

    const secondClose = session.close();
    let settled = false;
    void secondClose.finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(PTY_WRAPPER_EXIT_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    expect(vi.mocked(sink.process).mock.calls.some(([event]) => event.type === 'tree_cleanup_completed')).toBe(false);

    for (const listener of exitListeners) listener({ exitCode: 0, signal: null });
    await expect(secondClose).resolves.toBeUndefined();
    expect(vi.mocked(sink.process).mock.calls.some(([event]) => event.type === 'tree_cleanup_completed')).toBe(true);
  });

  it.each(['success', 'error_during_execution'])('finishes Claude %s before exit and waits for wrapper escalation on close', async (subtype) => {
    vi.useFakeTimers();
    const dataListeners = new Set<(data: string) => void>();
    const exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
    let stopping = false;
    let treeClean = false;
    const pty = {
      onData: (listener: (data: string) => void) => {
        dataListeners.add(listener);
        return { dispose: () => dataListeners.delete(listener) };
      },
      onExit: (listener: (event: { exitCode: number; signal?: number }) => void) => {
        exitListeners.add(listener);
        return { dispose: () => exitListeners.delete(listener) };
      },
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(() => {
        if (stopping) return;
        stopping = true;
        setTimeout(() => {
          treeClean = true;
          for (const listener of [...exitListeners]) listener({ exitCode: 0, signal: 0 });
        }, PTY_WRAPPER_FORCE_KILL_GRACE_MS);
      }),
    };
    vi.spyOn(executors, 'getExecutor').mockReturnValue({
      spawn: vi.fn(async () => ({
        pid: 123, processGroupId: 'pgid', birthMarker: 'birth', ownershipToken: 'owner',
        pty, cancel: { cancel: vi.fn() }, verifyTreeCleanup: () => treeClean,
      })),
    } as never);
    const sink: RuntimeDriverEventSink = {
      stream: vi.fn(), process: vi.fn(async () => undefined),
    };
    const session = await new CliRuntimeDriver().open({
      towerSessionId: 'tower-claude', agentType: AgentType.CLAUDE_CODE,
      runtimeType: RuntimeType.CLI, variant: 'DEFAULT', workingDir: process.cwd(),
      env: ExecutionEnv.default(process.cwd()),
    });
    const store = new MsgStore();
    const turn = await session.runTurn({ turnId: 'claude-turn', prompt: 'hello', msgStore: store }, sink);
    const terminalResult = {
      type: 'result', subtype, is_error: subtype !== 'success', errors: ['API failed'],
      usage: { input_tokens: 2, cache_creation_input_tokens: 9780, cache_read_input_tokens: 8493 },
    };
    for (const listener of dataListeners) listener(JSON.stringify(terminalResult) + '\n');
    if (subtype === 'success') {
      await expect(turn.completion).resolves.toEqual({});
      expect(store.getSnapshot().entries.at(-1)?.metadata?.tokenUsage?.totalTokens).toBe(18275);
    } else {
      await expect(turn.completion).rejects.toMatchObject({ code: 'turn_failed' });
    }
    expect(store.isFinished()).toBe(true);
    expect(pty.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(pty.kill).toHaveBeenCalled();

    const close = session.close();
    void close.catch(() => undefined);
    let closed = false;
    void close.then(() => { closed = true; }, () => undefined);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(closed).toBe(false);
    expect(vi.mocked(sink.process).mock.calls.map(([event]) => event.type)).toEqual(['started']);
    await vi.advanceTimersByTimeAsync(PTY_WRAPPER_FORCE_KILL_GRACE_MS);
    await expect(close).resolves.toBeUndefined();
    expect(vi.mocked(sink.process).mock.calls.map(([event]) => event.type)).toEqual([
      'started', 'exited', 'tree_cleanup_completed',
    ]);
    if (subtype !== 'success') {
      await expect(turn.completion).rejects.toMatchObject({ code: 'turn_failed' });
    }
  });

  it('keeps the raw owner reachable when started persistence fails', async () => {
    vi.useFakeTimers();
    const exitListeners: Array<(event: { exitCode: number; signal?: string | null }) => void> = [];
    const pty = {
      onData: () => ({ dispose: vi.fn() }),
      onExit: (listener: (event: { exitCode: number; signal?: string | null }) => void) => {
        exitListeners.push(listener);
        return { dispose: vi.fn() };
      },
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
    vi.spyOn(executors, 'getExecutor').mockReturnValue({
      spawn: vi.fn(async () => ({
        pid: 321,
        processGroupId: 'pgid',
        birthMarker: 'birth',
        ownershipToken: 'owner',
        pty,
        cancel: { cancel: vi.fn() },
        takeEarlyEvents: () => [{ type: 'exit', exitCode: 0 }],
      })),
    } as never);
    const sink: RuntimeDriverEventSink = {
      stream: vi.fn(),
      process: vi.fn(async (event) => {
        if (event.type === 'started') throw new Error('started persistence failed');
      }),
    };
    const session = await new CliRuntimeDriver().open({
      towerSessionId: 'tower-cli-started-failure',
      agentType: AgentType.CODEX,
      runtimeType: RuntimeType.CLI,
      variant: 'DEFAULT',
      workingDir: process.cwd(),
      env: ExecutionEnv.default(process.cwd()),
    });

    await expect(session.runTurn({ turnId: 'turn-started-failure', prompt: 'hello', msgStore: new MsgStore() }, sink))
      .rejects.toThrow('started persistence failed');
    expect(vi.mocked(sink.process).mock.calls.map(([event]) => event.type)).toEqual([
      'started',
      'exited',
      'tree_cleanup_completed',
    ]);
    expect(pty.kill).toHaveBeenCalled();
    const closing = session.close();
    await expect(closing).resolves.toBeUndefined();
  });

  it('serializes early exit evidence behind the same generation started barrier', async () => {
    let releaseStarted!: () => void;
    const startedGate = new Promise<void>((resolve) => { releaseStarted = resolve; });
    const pty = {
      onData: () => ({ dispose: vi.fn() }),
      onExit: () => ({ dispose: vi.fn() }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
    vi.spyOn(executors, 'getExecutor').mockReturnValue({
      spawn: vi.fn(async () => ({
        pid: 456,
        processGroupId: 'pgid-456',
        birthMarker: 'birth-456',
        ownershipToken: 'owner-456',
        pty,
        cancel: { cancel: vi.fn() },
        takeEarlyEvents: () => [{ type: 'exit', exitCode: 0 }],
      })),
    } as never);
    const events: string[] = [];
    const sink: RuntimeDriverEventSink = {
      stream: vi.fn(),
      process: vi.fn(async (event) => {
        events.push(event.type);
        if (event.type === 'started') await startedGate;
      }),
    };
    const session = await new CliRuntimeDriver().open({
      towerSessionId: 'tower-cli-barrier',
      agentType: AgentType.CODEX,
      runtimeType: RuntimeType.CLI,
      variant: 'DEFAULT',
      workingDir: process.cwd(),
      env: ExecutionEnv.default(process.cwd()),
    });

    const run = session.runTurn({ turnId: 'turn-barrier', prompt: 'hello', msgStore: new MsgStore() }, sink);
    await Promise.resolve();
    expect(events).toEqual(['started']);
    releaseStarted();
    await expect(run).resolves.toBeDefined();
    expect(events).toEqual(['started', 'exited', 'tree_cleanup_completed']);
    await expect(session.close()).resolves.toBeUndefined();
  });

  it('keeps cleanup pending when the wrapper exits without tree evidence', async () => {
    const exitListeners: Array<(event: { exitCode: number; signal?: string | null }) => void> = [];
    const pty = {
      onData: () => ({ dispose: vi.fn() }),
      onExit: (listener: (event: { exitCode: number; signal?: string | null }) => void) => {
        exitListeners.push(listener);
        return { dispose: vi.fn() };
      },
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
    const verifyTreeCleanup = vi.fn(() => false);
    vi.spyOn(executors, 'getExecutor').mockReturnValue({
      spawn: vi.fn(async () => ({
        pid: 987,
        processGroupId: 'pgid-987',
        birthMarker: 'birth-987',
        ownershipToken: 'owner-987',
        pty,
        cancel: { cancel: vi.fn() },
        takeEarlyEvents: () => [],
        verifyTreeCleanup,
      })),
    } as never);
    const sink: RuntimeDriverEventSink = {
      stream: vi.fn(),
      process: vi.fn(async () => undefined),
    };
    const session = await new CliRuntimeDriver().open({
      towerSessionId: 'tower-cli-missing-evidence',
      agentType: AgentType.CODEX,
      runtimeType: RuntimeType.CLI,
      variant: 'DEFAULT',
      workingDir: process.cwd(),
      env: ExecutionEnv.default(process.cwd()),
    });

    await session.runTurn({ turnId: 'turn-missing-evidence', prompt: 'hello', msgStore: new MsgStore() }, sink);
    exitListeners[0]!({ exitCode: 0, signal: null });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(vi.mocked(sink.process).mock.calls.map(([event]) => event.type)).toEqual(['started', 'exited']);
    expect(verifyTreeCleanup).toHaveBeenCalled();
    await expect(session.close()).rejects.toMatchObject({ code: 'runtime_cleanup_pending' });
    expect(vi.mocked(sink.process).mock.calls.some(([event]) => event.type === 'tree_cleanup_completed')).toBe(false);
  });

  it('blocks a follow-up turn after logical completion until tree cleanup is confirmed', async () => {
    const pty = {
      onData: () => ({ dispose: vi.fn() }),
      onExit: () => ({ dispose: vi.fn() }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    };
    vi.spyOn(executors, 'getExecutor').mockReturnValue({
      spawn: vi.fn(async () => ({
        pid: 654,
        processGroupId: 'pgid-654',
        birthMarker: 'birth-654',
        ownershipToken: 'owner-654',
        pty,
        cancel: { cancel: vi.fn() },
        takeEarlyEvents: () => [{ type: 'exit', exitCode: 0 }],
        verifyTreeCleanup: () => false,
      })),
    } as never);
    const sink: RuntimeDriverEventSink = {
      stream: vi.fn(),
      process: vi.fn(async () => undefined),
    };
    const session = await new CliRuntimeDriver().open({
      towerSessionId: 'tower-cli-follow-up-pending',
      agentType: AgentType.CODEX,
      runtimeType: RuntimeType.CLI,
      variant: 'DEFAULT',
      workingDir: process.cwd(),
      env: ExecutionEnv.default(process.cwd()),
    });

    const first = await session.runTurn({ turnId: 'turn-first', prompt: 'hello', msgStore: new MsgStore() }, sink);
    await expect(first.completion).resolves.toBeDefined();
    await expect(session.runTurn({ turnId: 'turn-follow-up', prompt: 'again', msgStore: new MsgStore() }, sink))
      .rejects.toMatchObject({ code: 'process_exit_pending' });
  });
});
