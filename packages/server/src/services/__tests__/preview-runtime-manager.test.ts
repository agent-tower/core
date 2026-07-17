import { EventEmitter } from 'node:events';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizePreviewTarget } from '../preview.service.js';
import { PreviewRuntimeManager, rewriteTargetCookie } from '../preview-runtime-manager.js';

class FakeTunnel extends EventEmitter {
  stopped = false;

  stop(): boolean {
    this.stopped = true;
    return true;
  }
}

const managers: PreviewRuntimeManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()));
});

describe('PreviewRuntimeManager lifecycle', () => {
  it('starts one remote tunnel per workspace and reuses it across active leases', async () => {
    const tunnels: FakeTunnel[] = [];
    const manager = new PreviewRuntimeManager({
      listenHost: '127.0.0.1',
      createTunnel: () => {
        const tunnel = new FakeTunnel();
        tunnels.push(tunnel);
        setTimeout(() => tunnel.emit('url', 'https://preview-test.trycloudflare.com'), 0);
        return tunnel;
      },
    });
    managers.push(manager);
    const target = normalizePreviewTarget('http://127.0.0.1:3000');

    const first = await manager.acquire('workspace-1', target, 'remote', 'localhost');
    const second = await manager.acquire('workspace-1', target, 'remote', 'localhost');

    expect(first.viewBaseUrl).toBe('https://preview-test.trycloudflare.com');
    expect(second.viewBaseUrl).toBe(first.viewBaseUrl);
    expect(tunnels).toHaveLength(1);
  });

  it('stops the tunnel and local gateway after the last lease becomes idle', async () => {
    let now = 0;
    const tunnels: FakeTunnel[] = [];
    const manager = new PreviewRuntimeManager({
      listenHost: '127.0.0.1',
      idleTtlMs: 20,
      leaseTtlMs: 20,
      sweepIntervalMs: 5,
      now: () => now,
      createTunnel: () => {
        const tunnel = new FakeTunnel();
        tunnels.push(tunnel);
        setTimeout(() => tunnel.emit('url', 'https://preview-idle.trycloudflare.com'), 0);
        return tunnel;
      },
    });
    managers.push(manager);
    const targetServer = http.createServer((_request, response) => response.end('ok'));
    await new Promise<void>((resolve) => targetServer.listen(0, '127.0.0.1', resolve));
    const address = targetServer.address();
    if (!address || typeof address === 'string') throw new Error('Target server did not start');

    try {
      const target = normalizePreviewTarget(`http://127.0.0.1:${address.port}`);
      const session = await manager.acquire('workspace-idle', target, 'remote', 'localhost');
      manager.release('workspace-idle', session.id);
      now = 100;

      await expect.poll(() => tunnels[0]?.stopped, { timeout: 500 }).toBe(true);
      expect(await manager.heartbeat('workspace-idle', session.id)).toBeNull();
    } finally {
      await new Promise<void>((resolve) => targetServer.close(() => resolve()));
    }
  });

  it('reclaims an idle remote tunnel while keeping an active local gateway session', async () => {
    let now = 0;
    const tunnels: FakeTunnel[] = [];
    const manager = new PreviewRuntimeManager({
      listenHost: '127.0.0.1',
      idleTtlMs: 20,
      leaseTtlMs: 1_000,
      sweepIntervalMs: 5,
      now: () => now,
      createTunnel: () => {
        const tunnel = new FakeTunnel();
        tunnels.push(tunnel);
        setTimeout(() => tunnel.emit('url', 'https://preview-mixed.trycloudflare.com'), 0);
        return tunnel;
      },
    });
    managers.push(manager);
    const target = normalizePreviewTarget('http://127.0.0.1:3000');
    const localSession = await manager.acquire('workspace-mixed', target, 'local', 'localhost');
    const remoteSession = await manager.acquire('workspace-mixed', target, 'remote', 'localhost');

    manager.release('workspace-mixed', remoteSession.id);
    now = 100;

    await expect.poll(() => tunnels[0]?.stopped, { timeout: 500 }).toBe(true);
    expect(await manager.heartbeat('workspace-mixed', localSession.id)).not.toBeNull();
    expect(tunnels).toHaveLength(1);
  });
});

describe('preview target cookies', () => {
  const target = normalizePreviewTarget('http://127.0.0.1:3000/app');

  it('makes target cookies usable in a secure cross-site preview iframe', () => {
    expect(rewriteTargetCookie(
      'session=abc; Domain=127.0.0.1; Path=/app; HttpOnly; SameSite=Lax',
      target,
      'agent-tower-preview-workspace',
      true,
    )).toBe('session=abc; Path=/; HttpOnly; Secure; SameSite=None; Partitioned');
  });

  it('scopes Agent Tower target auth cookies away from the outer application cookie', () => {
    const rewritten = rewriteTargetCookie(
      'agent-tower-access=target; Path=/; HttpOnly; SameSite=Lax',
      target,
      'agent-tower-preview-workspace',
      false,
    );

    expect(rewritten).toContain('agent-tower-preview-workspace-target-');
    expect(rewritten).not.toMatch(/^agent-tower-access=/);
    expect(rewritten).toContain('SameSite=Lax');
  });

  it('removes cookie attributes that cannot work on a local HTTP gateway', () => {
    expect(rewriteTargetCookie(
      'session=abc; Path=/; HttpOnly; Secure; SameSite=None; Partitioned',
      target,
      'agent-tower-preview-workspace',
      false,
    )).toBe('session=abc; Path=/; HttpOnly; SameSite=Lax');
  });
});
