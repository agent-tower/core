import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Tunnel, type Tunnel as CloudflaredTunnel } from 'cloudflared';

class FakeTunnel extends EventEmitter {
  stopped = false;

  stop() {
    this.stopped = true;
    this.emit('exit');
  }
}

const fakeTunnels: FakeTunnel[] = [];
let nextUrl = 'https://first.trycloudflare.com';

vi.mock('cloudflared', () => ({
  Tunnel: {
    quick: vi.fn(() => {
      const tunnel = new FakeTunnel();
      fakeTunnels.push(tunnel);
      queueMicrotask(() => tunnel.emit('url', nextUrl));
      return tunnel as unknown as CloudflaredTunnel;
    }),
  },
}));

const { TunnelService } = await import('../tunnel.service.js');

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('TunnelService health state', () => {
  beforeEach(() => {
    fakeTunnels.length = 0;
    nextUrl = 'https://first.trycloudflare.com';
    TunnelService.__resetForTests();
  });

  afterEach(() => {
    TunnelService.__resetForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('marks the tunnel healthy when cloudflared is running and local health passes', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      expect(parsed.hostname).toBe('localhost');
      return jsonResponse({
        ok: true,
        generation: Number(parsed.searchParams.get('generation')),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await TunnelService.start(18080);
    await TunnelService.checkNow();

    const status = TunnelService.getStatus();
    expect(status.status).toBe('healthy');
    expect(status.running).toBe(true);
    expect(status.lastCheckedAt).not.toBeNull();
    expect(status.lastHealthyAt).not.toBeNull();
    expect(status.lastHealthyAt).toBe(status.lastCheckedAt);
    expect(status.lastRemoteError).toBeNull();
    expect(status.consecutiveRemoteFailures).toBe(0);
    expect(Tunnel.quick).toHaveBeenCalledWith('http://localhost:18080', { '--no-autoupdate': true });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('http://localhost:18080/api/tunnel/health'),
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('127.0.0.1:18080'),
      expect.anything(),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('trycloudflare.com'),
      expect.anything(),
    );
  });

  it('keeps the tunnel healthy without probing the public URL', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      expect(parsed.hostname).toBe('localhost');
      return jsonResponse({
        ok: true,
        generation: Number(parsed.searchParams.get('generation')),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    await TunnelService.start(18080);
    await TunnelService.checkNow();
    await TunnelService.checkNow();

    const status = TunnelService.getStatus();
    expect(status.status).toBe('healthy');
    expect(status.running).toBe(true);
    expect(status.lastRemoteError).toBeNull();
    expect(status.consecutiveRemoteFailures).toBe(0);
    expect(fakeTunnels).toHaveLength(1);
    expect(fakeTunnels[0]?.stopped).toBe(false);
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('trycloudflare.com'),
      expect.anything(),
    );
  });

  it('moves from localUnhealthy back to healthy when local health recovers', async () => {
    let localHealthy = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const parsed = new URL(url);
      if (!localHealthy) {
        throw new Error('local unavailable');
      }
      return jsonResponse({
        ok: true,
        generation: Number(parsed.searchParams.get('generation')),
      });
    }));

    await TunnelService.start(18080);
    await TunnelService.checkNow();
    expect(TunnelService.getStatus().status).toBe('localUnhealthy');

    localHealthy = true;
    await TunnelService.checkNow();

    const status = TunnelService.getStatus();
    expect(status.status).toBe('healthy');
    expect(status.consecutiveLocalFailures).toBe(0);
    expect(status.consecutiveRemoteFailures).toBe(0);
    expect(fakeTunnels).toHaveLength(1);
  });

  it('updates checked and healthy timestamps on each successful health check', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T08:00:00.000Z'));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const parsed = new URL(url);
      return jsonResponse({
        ok: true,
        generation: Number(parsed.searchParams.get('generation')),
      });
    }));

    await TunnelService.start(18080);
    await TunnelService.checkNow();

    const firstStatus = TunnelService.getStatus();
    expect(firstStatus.status).toBe('healthy');
    expect(firstStatus.lastCheckedAt).toBe('2026-06-01T08:00:00.000Z');
    expect(firstStatus.lastHealthyAt).toBe('2026-06-01T08:00:00.000Z');

    vi.setSystemTime(new Date('2026-06-01T08:00:10.000Z'));
    await TunnelService.checkNow();

    const secondStatus = TunnelService.getStatus();
    expect(secondStatus.status).toBe('healthy');
    expect(secondStatus.lastCheckedAt).toBe('2026-06-01T08:00:10.000Z');
    expect(secondStatus.lastHealthyAt).toBe('2026-06-01T08:00:10.000Z');
  });

  it('updates lastCheckedAt while preserving lastHealthyAt when local health fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T08:00:00.000Z'));
    let localHealthy = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (!localHealthy) {
        throw new Error('local unavailable');
      }

      const parsed = new URL(url);
      return jsonResponse({
        ok: true,
        generation: Number(parsed.searchParams.get('generation')),
      });
    }));

    await TunnelService.start(18080);
    await TunnelService.checkNow();
    expect(TunnelService.getStatus().lastHealthyAt).toBe('2026-06-01T08:00:00.000Z');

    localHealthy = false;
    vi.setSystemTime(new Date('2026-06-01T08:00:10.000Z'));
    await TunnelService.checkNow();

    const status = TunnelService.getStatus();
    expect(status.status).toBe('localUnhealthy');
    expect(status.lastCheckedAt).toBe('2026-06-01T08:00:10.000Z');
    expect(status.lastHealthyAt).toBe('2026-06-01T08:00:00.000Z');
    expect(status.lastLocalError).toBe('local unavailable');
  });

  it('regenerates explicitly while reusing the existing target port', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const parsed = new URL(url);
      return jsonResponse({
        ok: true,
        generation: Number(parsed.searchParams.get('generation')),
      });
    }));

    const first = await TunnelService.start(18080);
    await TunnelService.checkNow();

    nextUrl = 'https://second.trycloudflare.com';
    const second = await TunnelService.regenerate(443);
    await TunnelService.checkNow();

    const status = TunnelService.getStatus();
    expect(first.url).toBe('https://first.trycloudflare.com');
    expect(second.url).toBe('https://second.trycloudflare.com');
    expect(second.token).not.toBe(first.token);
    expect(status.generation).toBe(2);
    expect(status.targetPort).toBe(18080);
    expect(Tunnel.quick).toHaveBeenNthCalledWith(1, 'http://localhost:18080', { '--no-autoupdate': true });
    expect(Tunnel.quick).toHaveBeenNthCalledWith(2, 'http://localhost:18080', { '--no-autoupdate': true });
    expect(Tunnel.quick).not.toHaveBeenCalledWith('http://localhost:443');
    expect(fakeTunnels).toHaveLength(2);
    expect(fakeTunnels[0]?.stopped).toBe(true);
  });

  it('keeps startup failures visible as an error status', async () => {
    vi.stubGlobal('fetch', vi.fn());
    vi.mocked(Tunnel.quick).mockImplementationOnce(() => {
      const tunnel = new FakeTunnel();
      fakeTunnels.push(tunnel);
      queueMicrotask(() => tunnel.emit('error', new Error('startup failed')));
      return tunnel as unknown as CloudflaredTunnel;
    });

    await expect(TunnelService.start(18080)).rejects.toThrow('startup failed');

    const status = TunnelService.getStatus();
    expect(status.status).toBe('error');
    expect(status.running).toBe(false);
    expect(status.targetPort).toBeNull();
    expect(status.lastError).toBe('startup failed');
    expect(status.canRegenerate).toBe(true);
  });

  it('uses the requested port for regenerate after a startup failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const parsed = new URL(url);
      return jsonResponse({
        ok: true,
        generation: Number(parsed.searchParams.get('generation')),
      });
    }));
    vi.mocked(Tunnel.quick).mockImplementationOnce(() => {
      const tunnel = new FakeTunnel();
      fakeTunnels.push(tunnel);
      queueMicrotask(() => tunnel.emit('error', new Error('startup failed')));
      return tunnel as unknown as CloudflaredTunnel;
    });

    await expect(TunnelService.start(443)).rejects.toThrow('startup failed');
    expect(TunnelService.getStatus().targetPort).toBeNull();
    vi.mocked(Tunnel.quick).mockClear();

    nextUrl = 'https://second.trycloudflare.com';
    await TunnelService.regenerate(18080);
    await TunnelService.checkNow();

    const status = TunnelService.getStatus();
    expect(status.status).toBe('healthy');
    expect(status.targetPort).toBe(18080);
    expect(Tunnel.quick).toHaveBeenCalledWith('http://localhost:18080', { '--no-autoupdate': true });
    expect(Tunnel.quick).not.toHaveBeenCalledWith('http://localhost:443');
    expect(fakeTunnels).toHaveLength(2);
  });

  it('keeps cloudflared diagnostics when startup exits before a URL is emitted', async () => {
    vi.stubGlobal('fetch', vi.fn());
    vi.mocked(Tunnel.quick).mockImplementationOnce(() => {
      const tunnel = new FakeTunnel();
      fakeTunnels.push(tunnel);
      queueMicrotask(() => {
        tunnel.emit('stderr', 'cloudflared: unsupported architecture\n');
        tunnel.emit('exit', 1, null);
      });
      return tunnel as unknown as CloudflaredTunnel;
    });

    await expect(TunnelService.start(18080)).rejects.toThrow('cloudflared exited with code 1');

    const status = TunnelService.getStatus();
    expect(status.status).toBe('error');
    expect(status.running).toBe(false);
    expect(status.lastError).toBe('cloudflared exited with code 1');
    expect(status.lastExitCode).toBe(1);
    expect(status.lastExitSignal).toBeNull();
    expect(status.lastProcessOutput).toContain('cloudflared: unsupported architecture');
  });
});
