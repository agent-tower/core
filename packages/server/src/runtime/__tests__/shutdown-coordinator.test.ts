import { describe, expect, it, vi } from 'vitest';
import { ReferencedShutdownCoordinator } from '../shutdown-coordinator.js';

describe('ReferencedShutdownCoordinator', () => {
  it('shares concurrent shutdown requests and retries with a referenced timer', async () => {
    vi.useFakeTimers();
    try {
      let fail = true;
      const cleanup = vi.fn(async () => {
        if (fail) throw new Error('runtime_cleanup_pending');
      });
      const coordinator = new ReferencedShutdownCoordinator(cleanup);
      const first = coordinator.request();
      const second = coordinator.request();
      expect(second).toBe(first);

      await vi.advanceTimersByTimeAsync(250);
      expect(cleanup).toHaveBeenCalledTimes(2);
      fail = false;
      await vi.advanceTimersByTimeAsync(500);
      await expect(first).resolves.toBeUndefined();
      expect(coordinator.pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
