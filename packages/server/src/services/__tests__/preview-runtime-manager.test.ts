import { EventEmitter } from 'node:events';
import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizePreviewTarget } from '../preview.service.js';
import { PreviewRuntimeManager, rewriteTargetCookie } from '../preview-runtime-manager.js';

class FakeTunnel extends EventEmitter {
  stopped = false;

  stop(): boolean {
    this.stopped = true;
    this.emit('exit', 0, null);
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
    const ensureTunnelBinary = vi.fn(async () => {});
    const manager = new PreviewRuntimeManager({
      listenHost: '127.0.0.1',
      ensureTunnelBinary,
      createTunnel: () => {
        const tunnel = new FakeTunnel();
        tunnels.push(tunnel);
        setTimeout(() => tunnel.emit('url', 'https://preview-test.trycloudflare.com'), 0);
        return tunnel;
      },
    });
    managers.push(manager);
    const target = normalizePreviewTarget('http://127.0.0.1:3000');

    const [first, second] = await Promise.all([
      manager.acquire('workspace-1', target, 'remote', 'localhost'),
      manager.acquire('workspace-1', target, 'remote', 'localhost'),
    ]);

    expect(first.viewBaseUrl).toBe('https://preview-test.trycloudflare.com');
    expect(second.viewBaseUrl).toBe(first.viewBaseUrl);
    expect(tunnels).toHaveLength(1);
    expect(ensureTunnelBinary).toHaveBeenCalledTimes(1);
  });

  it('reclaims every gateway after simultaneous first acquisition', async () => {
    const manager = new PreviewRuntimeManager({ listenHost: '127.0.0.1' });
    managers.push(manager);
    const target = normalizePreviewTarget('http://127.0.0.1:3000');
    const sessions = await Promise.all([
      manager.acquire('same-workspace', target, 'local', 'localhost'),
      manager.acquire('same-workspace', target, 'local', 'localhost'),
    ]);
    expect(sessions[0].viewBaseUrl).toBe(sessions[1].viewBaseUrl);
    expect(await manager.heartbeat('same-workspace', sessions[0].id)).not.toBeNull();
    await manager.stopAll();
    await expect(fetch(sessions[0].viewBaseUrl)).rejects.toThrow();
  });

  it('cancels binary setup on invalidation and never launches the old tunnel', async () => {
    let finishSetup!: () => void;
    const setup = new Promise<void>((resolve) => { finishSetup = resolve; });
    const ensureTunnelBinary = vi.fn(() => setup);
    const createTunnel = vi.fn(() => new FakeTunnel());
    const manager = new PreviewRuntimeManager({ listenHost: '127.0.0.1', ensureTunnelBinary, createTunnel });
    managers.push(manager);
    const opening = manager.acquire('invalidated', normalizePreviewTarget('http://127.0.0.1:3000'), 'remote', 'localhost');
    const rejected = expect(opening).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(ensureTunnelBinary).toHaveBeenCalled());
    await manager.invalidate('invalidated');
    finishSetup();
    await rejected;
    expect(createTunnel).not.toHaveBeenCalled();
  });

  it('closes a gateway invalidated before listen completes and rejects shutdown opens', async () => {
    const manager = new PreviewRuntimeManager({ listenHost: '127.0.0.1' });
    managers.push(manager);
    const target = normalizePreviewTarget('http://127.0.0.1:3000');
    const opening = manager.acquire('pending-listen', target, 'local', 'localhost');
    const rejected = expect(opening).rejects.toThrow('invalidated');
    await manager.invalidate('pending-listen');
    await rejected;
    await manager.stopAll();
    await expect(manager.acquire('after-stop', target, 'local', 'localhost')).rejects.toThrow('stopped');
  });

  it('retains a tunnel after failed invalidation and retries it on shutdown', async () => {
    const tunnel = new FakeTunnel();
    const manager = new PreviewRuntimeManager({ listenHost: '127.0.0.1', createTunnel: () => {
      queueMicrotask(() => tunnel.emit('url', 'https://retry.trycloudflare.com'));
      return tunnel;
    } });
    managers.push(manager);
    await manager.acquire('retry-workspace', normalizePreviewTarget('http://127.0.0.1:3000'), 'remote', 'localhost');
    const stop = vi.spyOn(tunnel, 'stop').mockImplementation(() => true);
    vi.useFakeTimers();
    try {
      const invalidating = manager.invalidate('retry-workspace');
      const rejected = expect(invalidating).rejects.toThrow('did not exit');
      await vi.advanceTimersByTimeAsync(3000);
      await rejected;
      stop.mockRestore();
      await manager.stopAll();
      expect(tunnel.stopped).toBe(true);
    } finally { stop.mockRestore(); vi.useRealTimers(); }
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

  it('also scopes instance-specific Agent Tower target auth cookies', () => {
    const rewritten = rewriteTargetCookie(
      'agent-tower-access-0123456789abcdef=target; Path=/; HttpOnly; SameSite=Lax',
      target,
      'agent-tower-preview-workspace',
      false,
    );

    expect(rewritten).toContain('agent-tower-preview-workspace-target-');
    expect(rewritten).not.toMatch(/^agent-tower-access-0123456789abcdef=/);
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
