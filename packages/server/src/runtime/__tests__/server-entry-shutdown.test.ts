import { describe, expect, it, vi } from 'vitest';
import { createServerEntryShutdownCoordinator } from '../server-entry-shutdown.js';

describe('server entry shutdown wiring', () => {
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
