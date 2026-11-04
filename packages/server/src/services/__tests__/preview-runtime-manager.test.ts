import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizePreviewTarget } from '../preview.service.js';
import { PreviewRuntimeManager, rewriteTargetCookie } from '../preview-runtime-manager.js';

const managers: PreviewRuntimeManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stopAll()));
});

describe('PreviewRuntimeManager lifecycle', () => {
  it('reclaims every gateway after simultaneous first acquisition', async () => {
    const manager = new PreviewRuntimeManager({ listenHost: '127.0.0.1' });
    managers.push(manager);
    const target = normalizePreviewTarget('http://127.0.0.1:3000');
    const sessions = await Promise.all([
      manager.acquire('same-workspace', target, 'localhost'),
      manager.acquire('same-workspace', target, 'localhost'),
    ]);
    expect(sessions[0].viewBaseUrl).toBe(sessions[1].viewBaseUrl);
    expect(await manager.heartbeat('same-workspace', sessions[0].id)).not.toBeNull();
    await manager.stopAll();
    await expect(fetch(sessions[0].viewBaseUrl)).rejects.toThrow();
  });

  it('closes a gateway invalidated before listen completes and rejects shutdown opens', async () => {
    const manager = new PreviewRuntimeManager({ listenHost: '127.0.0.1' });
    managers.push(manager);
    const target = normalizePreviewTarget('http://127.0.0.1:3000');
    const opening = manager.acquire('pending-listen', target, 'localhost');
    const rejected = expect(opening).rejects.toThrow('invalidated');
    await manager.invalidate('pending-listen');
    await rejected;
    await manager.stopAll();
    await expect(manager.acquire('after-stop', target, 'localhost')).rejects.toThrow('stopped');
  });

  it('formats IPv6 browser hostnames for the gateway URL', async () => {
    const manager = new PreviewRuntimeManager({ listenHost: '127.0.0.1' });
    managers.push(manager);
    const session = await manager.acquire('ipv6', normalizePreviewTarget('http://127.0.0.1:3000'), '::1');
    expect(session.viewBaseUrl).toMatch(/^http:\/\/\[::1\]:\d+$/);
  });

  it('stops the local gateway after the last lease becomes idle', async () => {
    let now = 0;
    const manager = new PreviewRuntimeManager({
      listenHost: '127.0.0.1',
      idleTtlMs: 20,
      leaseTtlMs: 20,
      sweepIntervalMs: 5,
      now: () => now,
    });
    managers.push(manager);
    const targetServer = http.createServer((_request, response) => response.end('ok'));
    await new Promise<void>((resolve) => targetServer.listen(0, '127.0.0.1', resolve));
    const address = targetServer.address();
    if (!address || typeof address === 'string') throw new Error('Target server did not start');

    try {
      const target = normalizePreviewTarget(`http://127.0.0.1:${address.port}`);
      const session = await manager.acquire('workspace-idle', target, 'localhost');
      manager.release('workspace-idle', session.id);
      now = 100;

      await expect.poll(async () => manager.heartbeat('workspace-idle', session.id), { timeout: 500 }).toBeNull();
      await expect(fetch(session.viewBaseUrl)).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => targetServer.close(() => resolve()));
    }
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
