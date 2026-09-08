import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error The dev entry and its helper run as native JavaScript.
import { stopBackendAndWait } from './backend-process-shutdown.mjs';

describe('dev backend shutdown', () => {
  it('uses IPC and waits beyond five seconds without force killing the backend', async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), {
        exitCode: null as number | null,
        signalCode: null,
        connected: true,
        send: vi.fn((_message, callback) => callback(null)),
        kill: vi.fn(),
      });
      const stopped = vi.fn();
      const pending = stopBackendAndWait(child).then(stopped);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(child.send).toHaveBeenCalledWith({ type: 'agent-tower:shutdown' }, expect.any(Function));
      expect(child.kill).not.toHaveBeenCalled();
      expect(stopped).not.toHaveBeenCalled();
      child.exitCode = 0;
      child.emit('exit', 0, null);
      await pending;
      expect(stopped).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});
