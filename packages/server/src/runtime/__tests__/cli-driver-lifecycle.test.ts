import { AgentType, RuntimeType } from '@agent-tower/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as executors from '../../executors/index.js';
import { ExecutionEnv } from '../../executors/execution-env.js';
import { MsgStore } from '../../output/msg-store.js';
import type { RuntimeDriverEventSink } from '../contracts.js';
import { CliRuntimeDriver } from '../cli-driver.js';

describe('CliRuntimeDriver cleanup lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(firstClose).rejects.toMatchObject({ code: 'process_exit_timeout' });

    const secondClose = session.close();
    let settled = false;
    void secondClose.finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(settled).toBe(false);
    expect(vi.mocked(sink.process).mock.calls.some(([event]) => event.type === 'tree_cleanup_completed')).toBe(false);

    for (const listener of exitListeners) listener({ exitCode: 0, signal: null });
    await expect(secondClose).resolves.toBeUndefined();
    expect(vi.mocked(sink.process).mock.calls.some(([event]) => event.type === 'tree_cleanup_completed')).toBe(true);
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
