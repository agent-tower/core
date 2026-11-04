import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { previewFallbackHook } from '../preview-fallback.js';
import { PREVIEW_CONTEXT_COOKIE_NAME } from '../../services/preview-cookies.js';

const app = Fastify();

beforeAll(async () => {
  app.addHook('onRequest', previewFallbackHook);
  app.get('/api/tasks', async () => ({ ok: true }));
  app.get('/assets/app.js', async () => 'agent tower asset');
  app.get('/view/:workspaceId/*', async (request) => ({ proxied: request.url }));
  app.setNotFoundHandler(async (request, reply) => reply.code(200).send({ spa: request.url }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('previewFallbackHook', () => {
  it('redirects requests referred by a preview document back into the workspace proxy', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/node_modules/.vite/deps/react.js?v=1',
      headers: { host: 'tower.local', referer: 'http://tower.local/view/workspace-1/' },
    });
    expect(response.statusCode).toBe(307);
    expect(response.headers.location).toBe('/view/workspace-1/node_modules/.vite/deps/react.js?v=1');
  });

  it('keeps tokenized prefixes and covers Agent Tower paths such as /api when referred by a preview', async () => {
    const token = 'pv1.d29ya3NwYWNlLTE.123.nonce.signature';
    const response = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { host: 'tower.local', referer: `http://tower.local/view/workspace-1/__agent_tower_preview/${token}/page` },
    });
    expect(response.statusCode).toBe(307);
    expect(response.headers.location).toBe(`/view/workspace-1/__agent_tower_preview/${token}/api/tasks`);
  });

  it('routes embedded navigations from a virtualized preview using the context cookie', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/login?next=%2F',
      headers: {
        host: 'tower.local',
        'sec-fetch-dest': 'iframe',
        cookie: `${PREVIEW_CONTEXT_COOKIE_NAME}=workspace-2`,
      },
    });
    expect(response.statusCode).toBe(307);
    expect(response.headers.location).toBe('/view/workspace-2/login?next=%2F');
  });

  it('leaves Agent Tower requests alone', async () => {
    const api = await app.inject({
      method: 'GET',
      url: '/api/tasks',
      headers: { host: 'tower.local', referer: 'http://tower.local/projects/1' },
    });
    expect(api.statusCode).toBe(200);
    expect(api.json()).toEqual({ ok: true });

    const visualization = await app.inject({
      method: 'GET',
      url: '/api/sessions/1/visualizations/chart.html',
      headers: {
        host: 'tower.local',
        'sec-fetch-dest': 'iframe',
        referer: 'http://tower.local/projects/1',
        cookie: `${PREVIEW_CONTEXT_COOKIE_NAME}=workspace-2`,
      },
    });
    expect(visualization.statusCode).not.toBe(307);

    const topLevel = await app.inject({
      method: 'GET',
      url: '/projects/1',
      headers: { host: 'tower.local', 'sec-fetch-dest': 'document', cookie: `${PREVIEW_CONTEXT_COOKIE_NAME}=workspace-2` },
    });
    expect(topLevel.statusCode).toBe(200);
    expect(topLevel.json()).toEqual({ spa: '/projects/1' });

    const foreignReferer = await app.inject({
      method: 'GET',
      url: '/assets/app.js',
      headers: { host: 'tower.local', referer: 'http://other.example.com/view/workspace-1/' },
    });
    expect(foreignReferer.statusCode).toBe(200);
  });

  it('ignores requests that already target the proxy', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/view/workspace-1/assets/app.js',
      headers: { host: 'tower.local', referer: 'http://tower.local/view/workspace-1/' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ proxied: '/view/workspace-1/assets/app.js' });
  });
});
