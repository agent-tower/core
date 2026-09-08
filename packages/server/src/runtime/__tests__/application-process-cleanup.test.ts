import { describe, expect, it, vi } from 'vitest';
import { cleanupApplicationProcessOwners, registerApplicationProcessCleanup } from '../application-process-cleanup.js';
import { createServerEntryShutdownCoordinator } from '../server-entry-shutdown.js';

describe('application process cleanup', () => {
  it('attempts every owner and retries route-local owners after Fastify has closed', async () => {
    vi.useFakeTimers();
    let previewAlive = true;
    const preview = vi.fn(async () => {
      if (preview.mock.calls.length < 3) throw new Error('cloudflared still alive');
      previewAlive = false;
    });
    const unregister = registerApplicationProcessCleanup(preview);
    const session = vi.fn(async () => {});
    const installer = vi.fn(async () => {});
    const cleanup = () => cleanupApplicationProcessOwners([session, installer]);
    const closeApp = vi.fn(cleanup);
    const coordinator = createServerEntryShutdownCoordinator({ closeApp, destroyRuntime: cleanup });
    try {
      const stopped = coordinator.request();
      await vi.advanceTimersByTimeAsync(0);
      expect(previewAlive).toBe(true);
      expect(coordinator.pending).toBe(true);
      expect(session).toHaveBeenCalledTimes(2);
      expect(installer).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(250);
      await stopped;
      expect(previewAlive).toBe(false);
      expect(closeApp).toHaveBeenCalledTimes(1);
      expect(preview).toHaveBeenCalledTimes(3);
    } finally {
      unregister();
      vi.useRealTimers();
    }
  });
});
