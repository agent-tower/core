import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerWebStatic, WEB_ASSET_CACHE_CONTROL } from '../web-static.js';

describe('web client static files', () => {
  let root: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'at-web-static-'));
    await fs.mkdir(path.join(root, 'assets'));
    await fs.writeFile(path.join(root, 'index.html'), '<!doctype html><title>app</title>');
    await fs.writeFile(path.join(root, 'favicon.ico'), 'icon');
    await fs.writeFile(path.join(root, 'assets', 'TaskDetail-DWrhK-lq.js'), 'export const view = 1;');
    app = Fastify();
    await registerWebStatic(app, root);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('caches hashed assets as immutable', async () => {
    const response = await app.inject({ method: 'GET', url: '/assets/TaskDetail-DWrhK-lq.js' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('export const view = 1;');
    expect(response.headers['cache-control']).toBe(WEB_ASSET_CACHE_CONTROL);
  });

  it('keeps revalidating index.html and other unhashed files', async () => {
    for (const url of ['/', '/index.html', '/favicon.ico']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers['cache-control'], url).toBe('public, max-age=0');
    }
  });

  it('answers client-side routes with a revalidated index.html and unknown API paths with 404', async () => {
    const page = await app.inject({ method: 'GET', url: '/projects/p1/tasks/t1' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<title>app</title>');
    expect(page.headers['cache-control']).toBe('public, max-age=0');

    const api = await app.inject({ method: 'GET', url: '/api/missing' });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toEqual({ error: 'Not Found' });
  });
});
