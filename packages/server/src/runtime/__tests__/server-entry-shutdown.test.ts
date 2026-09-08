import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServerEntryShutdownCoordinator, finishFailedServerEntry, installServerEntryShutdownRequests } from '../server-entry-shutdown.js';

describe('server entry shutdown wiring', () => {
  it('exits a failed IPC host only after its remaining owners have been cleaned', async () => {
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
    const shutdown = createServerEntryShutdownCoordinator({
      closeApp: async () => undefined,
      destroyRuntime: async () => cleanup,
    });
    const exit = vi.fn();
    const finished = finishFailedServerEntry(shutdown, exit);
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();
    finishCleanup();
    await finished;
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('starts runtime cleanup while HTTP close is still waiting for an active operation', async () => {
    let finishClose!: () => void;
    const closeApp = vi.fn(() => new Promise<void>((resolve) => { finishClose = resolve; }));
    const destroyRuntime = vi.fn(async () => { finishClose(); });
    const coordinator = createServerEntryShutdownCoordinator({ closeApp, destroyRuntime });
    const stopped = coordinator.request();
    await vi.waitFor(() => expect(destroyRuntime).toHaveBeenCalledOnce());
    await stopped;
    expect(closeApp).toHaveBeenCalledOnce();
  });

  it('retains a parent IPC shutdown received before startup finishes', () => {
    const host = new EventEmitter();
    const requests = installServerEntryShutdownRequests(host as unknown as NodeJS.Process);
    const handler = vi.fn();
    try {
      host.emit('message', { type: 'unrelated' });
      expect(requests.requested).toBe(false);
      host.emit('message', { type: 'agent-tower:shutdown' });
      expect(requests.requested).toBe(true);
      expect(handler).not.toHaveBeenCalled();
      requests.setHandler(handler);
      expect(handler).toHaveBeenCalledWith('parent IPC');
      host.emit('disconnect');
      expect(handler).toHaveBeenLastCalledWith('parent disconnect');
    } finally {
      requests.dispose();
    }
    expect(host.listenerCount('message')).toBe(0);
    expect(host.listenerCount('SIGTERM')).toBe(0);
  });

  it('closes Fastify once and retries runtime cleanup until owners confirm', async () => {
    vi.useFakeTimers();
    try {
      let runtimeAttempts = 0;
      const closeApp = vi.fn(async () => {
        throw new Error('fastify hook already closed');
      });
      const destroyRuntime = vi.fn(async () => {
        runtimeAttempts += 1;
        if (runtimeAttempts === 1) throw new Error('runtime owner still alive');
      });
      const appCloseErrors: unknown[] = [];
      const retryErrors: unknown[] = [];
      const coordinator = createServerEntryShutdownCoordinator({
        closeApp,
        destroyRuntime,
        onAppCloseError: (error) => appCloseErrors.push(error),
      }, (error) => retryErrors.push(error));

      const first = coordinator.request();
      expect(coordinator.request()).toBe(first);
      await vi.advanceTimersByTimeAsync(250);
      await expect(first).resolves.toBeUndefined();
      expect(closeApp).toHaveBeenCalledTimes(1);
      expect(destroyRuntime).toHaveBeenCalledTimes(2);
      expect(appCloseErrors).toHaveLength(1);
      expect(retryErrors).toHaveLength(1);
      expect(coordinator.pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
