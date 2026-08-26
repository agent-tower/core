import { describe, expect, it, vi } from 'vitest';
import { createBeforeQuitHandler } from '../src/before-quit.js';

describe('desktop before-quit gate', () => {
  it('does not quit after a failed backend stop and retries until a later success', async () => {
    const preventDefault = vi.fn();
    const stopBackend = vi.fn()
      .mockRejectedValueOnce(new Error('backend still owns processes'))
      .mockResolvedValueOnce(undefined);
    const quit = vi.fn();
    const errors: unknown[] = [];
    const timers: Array<() => void> = [];
    const handler = createBeforeQuitHandler({
      stopBackend,
      quit,
      onError: (error) => errors.push(error),
      setTimer: ((callback: () => void) => {
        timers.push(callback);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
    });

    handler({ preventDefault });
    await Promise.resolve();
    await Promise.resolve();
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    expect(timers).toHaveLength(1);

    timers.shift()!();
    await Promise.resolve();
    await Promise.resolve();
    expect(stopBackend).toHaveBeenCalledTimes(2);
    expect(quit).toHaveBeenCalledTimes(1);

    // Electron emits before-quit again when app.quit() is finally allowed.
    handler({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });
});
