import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { stopChildProcessAndWait, waitForBackendStartup } from '../src/backend-shutdown.js';

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn((_signal: NodeJS.Signals) => true);
}

describe('backend shutdown', () => {
  it('requests graceful shutdown over IPC and waits for exit', async () => {
    const child = Object.assign(new FakeChild(), {
      connected: true,
      send: vi.fn((_message, callback) => { callback(null); return true; }),
    });
    const stopping = stopChildProcessAndWait(child as never);
    expect(child.send).toHaveBeenCalledWith({ type: 'agent-tower:shutdown' }, expect.any(Function));
    expect(child.kill).not.toHaveBeenCalled();
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await stopping;
  });

  it('does not retry a failed startup until its living child is cleaned up', async () => {
    const child = Object.assign(new FakeChild(), { pid: 12345 });
    const failedStartup = waitForBackendStartup(child as never, Promise.reject(new Error('health timeout')));
    const retried = vi.fn();
    const observed = failedStartup.catch(retried);
    await Promise.resolve();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(retried).not.toHaveBeenCalled();
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await observed;
    expect(retried).toHaveBeenCalledOnce();
  });
  it('waits past the legacy five-second window for a real exit', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      const stopping = stopChildProcessAndWait(child as never);
      await vi.advanceTimersByTimeAsync(5_001);
      let settled = false;
      void stopping.then(() => { settled = true; });
      expect(settled).toBe(false);
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      child.exitCode = 0;
      child.emit('exit', 0, null);
      await expect(stopping).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not treat kill errors as a successful backend stop', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild();
      child.kill.mockImplementationOnce(() => {
        throw new Error('permission denied');
      });
      const stopping = stopChildProcessAndWait(child as never);
      child.emit('error', new Error('permission denied'));
      let settled = false;
      void stopping.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(249);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(child.kill).toHaveBeenCalledTimes(2);
      child.exitCode = 0;
      child.emit('exit', 0, null);
      await expect(stopping).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
