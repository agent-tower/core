import { expect, it, vi } from 'vitest';
import { Tunnel } from 'cloudflared';
import { EventBus } from '../../core/event-bus.js';
import { beginApplicationProcessShutdown } from '../../runtime/application-process-cleanup.js';
import { TerminalManager } from '../terminal-manager.js';
import { TunnelService } from '../tunnel.service.js';

vi.mock('../cloudflared-runtime.js', () => ({ ensureCloudflaredBinary: async () => {} }));

it('rejects new terminals and tunnels as soon as application shutdown starts', async () => {
  const terminals = new TerminalManager(new EventBus());
  const launch = vi.spyOn(Tunnel, 'quick').mockImplementation(() => { throw new Error('Unexpected tunnel launch'); });
  const stopping = TunnelService.stop();
  const queuedStart = TunnelService.start(18080);
  const queuedRejection = expect(queuedStart).rejects.toThrow('Application process shutdown');
  beginApplicationProcessShutdown();
  try {
    expect(() => terminals.create('shutdown-test')).toThrow('Application process shutdown');
    await expect(TunnelService.start(18080)).rejects.toThrow('Application process shutdown');
    await queuedRejection;
    await stopping;
    expect(terminals.size).toBe(0);
    expect(TunnelService.isRunning()).toBe(false);
    expect(launch).not.toHaveBeenCalled();
  } finally {
    await terminals.destroyAll();
    await TunnelService.stop();
    launch.mockRestore();
  }
});
