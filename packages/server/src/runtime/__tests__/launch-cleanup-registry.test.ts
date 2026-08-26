import { describe, expect, it, vi } from 'vitest';
import { LaunchCleanupRegistry } from '../acp/launch-cleanup-registry.js';

describe('ACP launch cleanup registry', () => {
  it('keeps a callback after three immediate failures and retries it later', async () => {
    vi.useFakeTimers();
    try {
      const registry = new LaunchCleanupRegistry();
      let attempts = 0;
      const ownerId = registry.register(async () => {
        attempts += 1;
        if (attempts < 4) throw new Error('temporary cleanup failure');
      }, 'generation-1');

      await expect(registry.runWithImmediateRetries(ownerId)).rejects.toThrow('temporary cleanup failure');
      expect(attempts).toBe(3);
      expect(registry.getState(ownerId)).toMatchObject({ status: 'FAILED', attemptCount: 3 });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(attempts).toBe(4);
      expect(registry.getState(ownerId)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not overwrite cleanup owners from different transport generations', async () => {
    const registry = new LaunchCleanupRegistry();
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    const firstId = registry.register(first, 'generation-1');
    const secondId = registry.register(second, 'generation-2');

    await Promise.all([
      registry.runWithImmediateRetries(firstId),
      registry.runWithImmediateRetries(secondId),
    ]);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(registry.getState(firstId)).toBeUndefined();
    expect(registry.getState(secondId)).toBeUndefined();
  });

  it('drains a scheduled owner without waiting for its backoff timer', async () => {
    vi.useFakeTimers();
    try {
      const registry = new LaunchCleanupRegistry();
      let attempts = 0;
      const ownerId = registry.register(async () => {
        attempts += 1;
        if (attempts < 4) throw new Error('temporary cleanup failure');
      }, 'drain-generation');

      await expect(registry.runWithImmediateRetries(ownerId)).rejects.toThrow('temporary cleanup failure');
      expect(attempts).toBe(3);

      await registry.drain();

      expect(attempts).toBe(4);
      expect(registry.getState(ownerId)).toBeUndefined();
      registry.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps failed owners observable with capped backoff until cleanup succeeds', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const registry = new LaunchCleanupRegistry();
      let failCleanup = true;
      const cleanup = vi.fn(async () => {
        if (failCleanup) throw new Error('persistent cleanup failure');
      });
      const ownerId = registry.register(cleanup, 'failed-generation');

      await expect(registry.runWithImmediateRetries(ownerId)).rejects.toThrow('persistent cleanup failure');
      await vi.advanceTimersByTimeAsync(1_000 + 5_000 + 30_000 + 120_000 + 300_000);

      expect(cleanup).toHaveBeenCalledTimes(8);
      expect(registry.getState(ownerId)).toMatchObject({
        status: 'FAILED',
        attemptCount: 8,
        lastError: 'persistent cleanup failure',
        nextRetryAt: expect.any(Number),
      });

      expect(registry.shutdown()).toEqual([
        expect.objectContaining({ id: ownerId, status: 'FAILED', attemptCount: 8 }),
      ]);
      expect(warn).toHaveBeenCalledWith(
        '[AcpRuntimeDriver] Auxiliary launch cleanup unresolved during shutdown',
        expect.objectContaining({ id: ownerId, attemptCount: 8 }),
      );
      expect(registry.getState(ownerId)).toBeDefined();

      failCleanup = false;
      await vi.advanceTimersByTimeAsync(300_000);
      expect(registry.getState(ownerId)).toBeUndefined();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not wait forever when an auxiliary cleanup callback never settles', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const registry = new LaunchCleanupRegistry();
      const ownerId = registry.register(() => new Promise<void>(() => undefined), 'hung-generation');

      const cleanup = registry.runWithImmediateRetries(ownerId);
      const rejected = expect(cleanup).rejects.toThrow('ACP auxiliary launch cleanup timed out');
      await vi.advanceTimersByTimeAsync(3_000);

      await rejected;
      expect(registry.getState(ownerId)).toMatchObject({ status: 'FAILED', attemptCount: 3 });
      expect(registry.shutdown()).toEqual([
        expect.objectContaining({ id: ownerId, status: 'FAILED', attemptCount: 3 }),
      ]);
      expect(registry.getState(ownerId)).toBeDefined();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('preserves pending and running owners across repeated shutdown calls', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const registry = new LaunchCleanupRegistry();
      const pendingId = registry.register(async () => undefined, 'pending-generation');
      const runningCleanup = deferred<void>();
      const runningId = registry.register(() => runningCleanup.promise, 'running-generation');
      const runningAttempt = registry.runAttemptById(runningId);

      expect(registry.getState(pendingId)).toMatchObject({ status: 'PENDING', attemptCount: 0 });
      expect(registry.getState(runningId)).toMatchObject({ status: 'RUNNING', attemptCount: 0 });
      expect(registry.shutdown()).toHaveLength(2);
      expect(registry.shutdown()).toHaveLength(2);
      expect(registry.getState(pendingId)).toMatchObject({ status: 'PENDING', nextRetryAt: expect.any(Number) });
      expect(registry.getState(runningId)).toMatchObject({ status: 'RUNNING' });
      expect(warn).toHaveBeenCalledTimes(2);

      runningCleanup.resolve();
      await runningAttempt;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(registry.getState(runningId)).toBeUndefined();
      expect(registry.getState(pendingId)).toBeUndefined();
      expect(registry.shutdown()).toEqual([]);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
