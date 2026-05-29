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
    vi.restoreAllMocks();
    TunnelService.__resetForTests();
  });

  it('marks the tunnel healthy only after local and remote health checks pass', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const parsed = new URL(url);
      return jsonResponse({
        ok: true,
        generation: Number(parsed.searchParams.get('generation')),
      });
    }));

    await TunnelService.start(18080);
    await TunnelService.checkNow();

    const status = TunnelService.getStatus();
    expect(status.status).toBe('healthy');
    expect(status.running).toBe(true);
    expect(status.lastHealthyAt).not.toBeNull();
    expect(status.consecutiveRemoteFailures).toBe(0);
  });

  it('enters degraded when remote health keeps failing but does not restart the tunnel', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.hostname === '127.0.0.1') {
        return jsonResponse({
          ok: true,
          generation: Number(parsed.searchParams.get('generation')),
        });
      }
      throw new Error('remote unavailable');
    }));

    await TunnelService.start(18080);
    await TunnelService.checkNow();
    await TunnelService.checkNow();

    const status = TunnelService.getStatus();
    expect(status.status).toBe('degraded');
    expect(status.running).toBe(true);
    expect(status.lastRemoteError).toBe('remote unavailable');
    expect(status.consecutiveRemoteFailures).toBeGreaterThanOrEqual(2);
    expect(fakeTunnels).toHaveLength(1);
    expect(fakeTunnels[0]?.stopped).toBe(false);
  });

  it('moves from degraded back to healthy when the original remote URL recovers', async () => {
    let remoteHealthy = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.hostname !== '127.0.0.1' && !remoteHealthy) {
        throw new Error('remote unavailable');
      }
      return jsonResponse({
        ok: true,
        generation: Number(parsed.searchParams.get('generation')),
      });
    }));

    await TunnelService.start(18080);
    await TunnelService.checkNow();
    await TunnelService.checkNow();
    expect(TunnelService.getStatus().status).toBe('degraded');

    remoteHealthy = true;
    await TunnelService.checkNow();

    const status = TunnelService.getStatus();
    expect(status.status).toBe('healthy');
    expect(status.consecutiveRemoteFailures).toBe(0);
    expect(fakeTunnels).toHaveLength(1);
  });

  it('regenerates only when explicitly requested and rotates token generation', async () => {
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
    const second = await TunnelService.regenerate(18080);
    await TunnelService.checkNow();

    const status = TunnelService.getStatus();
    expect(first.url).toBe('https://first.trycloudflare.com');
    expect(second.url).toBe('https://second.trycloudflare.com');
    expect(second.token).not.toBe(first.token);
    expect(status.generation).toBe(2);
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
    expect(status.lastError).toBe('startup failed');
    expect(status.canRegenerate).toBe(true);
  });
});
