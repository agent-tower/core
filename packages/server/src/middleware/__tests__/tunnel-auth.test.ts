import fastifyCookie from '@fastify/cookie';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tunnelAuthHook } from '../tunnel-auth.js';
import { TunnelService } from '../../services/tunnel.service.js';

describe('tunnelAuthHook', () => {
  beforeEach(() => {
    vi.spyOn(TunnelService, 'isRunning').mockReturnValue(true);
    vi.spyOn(TunnelService, 'validateToken').mockImplementation((token) => token === 'good-token');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('bootstraps a tunnel session from a valid document query token', async () => {
    const app = Fastify();
    await app.register(fastifyCookie);
    app.addHook('onRequest', tunnelAuthHook);
    app.get('/settings/general', async () => ({ ok: true }));

    const response = await app.inject({
      method: 'GET',
      url: '/settings/general?token=good-token&tab=advanced',
      headers: {
        'cf-ray': 'abc123',
        accept: 'text/html',
        'sec-fetch-dest': 'document',
      },
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/settings/general?tab=advanced');
    expect(String(response.headers['set-cookie'])).toContain('__Host-agent-tower-tunnel=good-token');

    await app.close();
  });

  it('allows tunnel API requests that already carry the tunnel session cookie', async () => {
    const app = Fastify();
    await app.register(fastifyCookie);
    app.addHook('onRequest', tunnelAuthHook);
    app.get('/api/ping', async () => ({ ok: true }));

    const response = await app.inject({
      method: 'GET',
      url: '/api/ping',
      headers: {
        'cf-ray': 'abc123',
        cookie: '__Host-agent-tower-tunnel=good-token',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    await app.close();
  });

  it('bootstraps a tunnel session from a non-document request without redirecting', async () => {
    const app = Fastify();
    await app.register(fastifyCookie);
    app.addHook('onRequest', tunnelAuthHook);
    app.post('/api/ping', async () => ({ ok: true }));

    const response = await app.inject({
      method: 'POST',
      url: '/api/ping?token=good-token',
      headers: {
        'cf-ray': 'abc123',
        accept: 'application/json',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(response.headers.location).toBeUndefined();
    expect(String(response.headers['set-cookie'])).toContain('__Host-agent-tower-tunnel=good-token');

    await app.close();
  });

  it('rejects tunnel requests without a valid session cookie or bootstrap token', async () => {
    const app = Fastify();
    await app.register(fastifyCookie);
    app.addHook('onRequest', tunnelAuthHook);
    app.get('/api/ping', async () => ({ ok: true }));

    const response = await app.inject({
      method: 'GET',
      url: '/api/ping',
      headers: { 'cf-ray': 'abc123' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: 'Unauthorized',
      message: 'Valid tunnel token required',
    });

    await app.close();
  });
});
