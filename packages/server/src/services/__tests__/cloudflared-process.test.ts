import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { stopCloudflaredTunnel, trackCloudflaredTunnel } from '../cloudflared-process.js';

it('retains a failed tunnel stop for a later retry', async () => {
  vi.useFakeTimers();
  class Tunnel extends EventEmitter {
    stop = vi.fn(() => true);
  }
  const tunnel = new Tunnel();
  try {
    trackCloudflaredTunnel(tunnel);
    const stop = stopCloudflaredTunnel(tunnel);
    const rejected = expect(stop).rejects.toThrow('did not exit');
    await vi.advanceTimersByTimeAsync(3000);
    await rejected;
    tunnel.stop.mockImplementation(() => { tunnel.emit('exit', 0, null); return true; });
    await stopCloudflaredTunnel(tunnel);
    expect(tunnel.stop).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});

it.skipIf(process.platform === 'win32')('forces a real tunnel process that ignores SIGINT and waits for its exit', async () => {
  class Tunnel extends EventEmitter {
    process = spawn(process.execPath, ['-e', "process.on('SIGINT',()=>{});console.log('ready');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'pipe'] });
    constructor() {
      super();
      this.process.on('exit', (code, signal) => this.emit('exit', code, signal));
    }
    stop() { return this.process.kill('SIGINT'); }
  }
  const tunnel = new Tunnel();
  trackCloudflaredTunnel(tunnel);
  try {
    await new Promise<void>((resolve, reject) => {
      tunnel.process.stdout!.once('data', () => resolve());
      tunnel.process.once('error', reject);
    });
    await stopCloudflaredTunnel(tunnel);
    expect(tunnel.process.signalCode).toBe('SIGKILL');
  } finally {
    if (tunnel.process.exitCode === null && tunnel.process.signalCode === null) {
      tunnel.process.kill('SIGKILL');
      await new Promise<void>(resolve => tunnel.process.once('exit', () => resolve()));
    }
  }
});
