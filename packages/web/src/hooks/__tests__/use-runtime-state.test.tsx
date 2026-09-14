// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RuntimeType, SessionStatus } from '@agent-tower/shared';
import { ServerEvents } from '@agent-tower/shared/socket';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { handlers, socket, getMock, postMock, toastErrorMock } = vi.hoisted(() => {
  const handlers = new Map<string, (payload?: any) => void>();
  return {
    handlers,
    socket: {
      on: vi.fn((event: string, handler: (payload?: any) => void) => {
        handlers.set(event, handler);
      }),
      off: vi.fn((event: string) => {
        handlers.delete(event);
      }),
    },
    getMock: vi.fn(),
    postMock: vi.fn(),
    toastErrorMock: vi.fn(),
  };
});

vi.mock('@/lib/socket/manager', () => ({
  socketManager: { connect: () => socket },
}));

vi.mock('@/lib/api-client', () => ({
  apiClient: {
    get: getMock,
    post: postMock,
  },
}));

vi.mock('sonner', () => ({
  toast: { error: toastErrorMock },
}));

import {
  isRuntimeTurnActive,
  isSessionStatusActive,
  useRuntimeState,
  useStopSession,
} from '../use-sessions';

const idleState = {
  sessionId: 'session-1',
  runtimeType: RuntimeType.ACP,
  turnState: 'IDLE' as const,
  capabilities: { loadSession: true, terminalInput: false, terminalResize: false, permissions: true },
  pendingPermissions: [],
};

function Probe() {
  const { data } = useRuntimeState('session-1');
  return <div data-state={data?.turnState}>{data?.turnState ?? 'loading'}</div>;
}

let onStopSettled: (() => void) | undefined;

function StopProbe() {
  const stop = useStopSession();
  const { data } = useRuntimeState('session-1');
  const disabled = stop.isPending || data?.turnState === 'CANCELLING';
  return (
    <button
      type="button"
      disabled={disabled}
      data-runtime-state={data?.turnState}
      onClick={() => stop.mutate('session-1', { onSettled: () => onStopSettled?.() })}
    >
      stop
    </button>
  );
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

describe('useRuntimeState reconnect behavior', () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    handlers.clear();
    socket.on.mockClear();
    socket.off.mockClear();
    getMock.mockReset().mockResolvedValue(idleState);
    postMock.mockReset().mockResolvedValue({ success: true });
    toastErrorMock.mockReset();
    onStopSettled = undefined;
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    container.remove();
  });

  it('accepts live runtime state and refetches authoritative state on reconnect', async () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(queryClient.getQueryData(['sessions', 'runtime', 'session-1'])).toMatchObject({ turnState: 'IDLE' });

    act(() => {
      handlers.get(ServerEvents.SESSION_RUNTIME_STATE_CHANGED)?.({
        sessionId: 'session-1',
        state: { ...idleState, turnState: 'AWAITING_PERMISSION' },
      });
    });
    expect(queryClient.getQueryData(['sessions', 'runtime', 'session-1']))
      .toMatchObject({ turnState: 'AWAITING_PERMISSION' });

    await act(async () => {
      handlers.get('connect')?.();
      await Promise.resolve();
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['sessions', 'runtime', 'session-1'],
    });
    expect(getMock).toHaveBeenCalledWith('/sessions/session-1/runtime');
  });

  it('invalidates every cache that contributes to stopped session activity', async () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <StopProbe />
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      container.querySelector('button')?.click();
      await vi.waitFor(() => expect(postMock).toHaveBeenCalledWith(
        '/sessions/session-1/stop',
        undefined,
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ));
    });

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sessions', 'detail', 'session-1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sessions', 'runtime', 'session-1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['workspaces'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tasks'] });
  });

  it('refreshes authoritative state and releases the stop UI after rejection', async () => {
    const stopping = deferred<never>();
    const settled = deferred<void>();
    onStopSettled = () => settled.resolve();
    postMock.mockReturnValueOnce(stopping.promise);
    getMock.mockReset()
      .mockResolvedValueOnce(idleState)
      .mockRejectedValue(new Error('status refresh unavailable'));
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <StopProbe />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('button')?.dataset.runtimeState).toBe('IDLE');

    await act(async () => {
      container.querySelector('button')?.click();
      handlers.get(ServerEvents.SESSION_RUNTIME_STATE_CHANGED)?.({
        sessionId: 'session-1',
        state: { ...idleState, turnState: 'CANCELLING' },
      });
      await Promise.resolve();
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(container.querySelector('button')?.hasAttribute('disabled')).toBe(true);
      });
    });

    await act(async () => {
      stopping.reject(new Error('cleanup not confirmed'));
      await settled.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector('button')?.hasAttribute('disabled')).toBe(false);
    expect(container.querySelector('button')?.dataset.runtimeState).toBe('IDLE');
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Failed to stop session. Refreshing status; check it and try again.',
      { description: 'cleanup not confirmed' },
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sessions', 'detail', 'session-1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sessions', 'runtime', 'session-1'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['workspaces'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tasks'] });
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces a client-side timeout instead of leaving the stop button spinning', async () => {
    const settled = deferred<void>();
    onStopSettled = () => settled.resolve();
    postMock.mockRejectedValueOnce(
      new DOMException('The operation was aborted due to timeout', 'TimeoutError'),
    );
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <StopProbe />
        </QueryClientProvider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      container.querySelector('button')?.click();
      await settled.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The hook must translate the abort into an explicit failure so the button
    // is re-enabled and the user sees why (server-side cleanup can outlive the
    // client budget).
    expect(container.querySelector('button')?.hasAttribute('disabled')).toBe(false);
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Failed to stop session. Refreshing status; check it and try again.',
      {
        description:
          'Stop request timed out before the server answered. The session may still be stopping; refresh the status and retry.',
      },
    );
  });
});

describe('session activity state', () => {
  it.each([
    ['RUNNING', true],
    ['AWAITING_PERMISSION', true],
    ['CANCELLING', true],
    ['IDLE', false],
    ['DISPOSED', false],
  ] as const)('treats Runtime turn state %s as active=%s', (turnState, expected) => {
    expect(isRuntimeTurnActive(turnState)).toBe(expected);
  });

  it('keeps persistent PENDING/RUNNING status as an initialization and reconnect fallback', () => {
    expect(isSessionStatusActive(SessionStatus.PENDING)).toBe(true);
    expect(isSessionStatusActive(SessionStatus.RUNNING)).toBe(true);
    expect(isSessionStatusActive(SessionStatus.COMPLETED)).toBe(false);
    expect(isSessionStatusActive(SessionStatus.FAILED)).toBe(false);
    expect(isSessionStatusActive(SessionStatus.CANCELLED)).toBe(false);
  });
});
