import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import Fastify from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  INTERNAL_API_TOKEN_ENV,
  INTERNAL_API_TOKEN_HEADER,
} from '../../utils/internal-api-token.js';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-preview-routes-'));
const dbPath = path.join(testDir, 'test.db');
process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;
process.env.AGENT_TOWER_DATA_DIR = testDir;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, '../../..');
const schemaPath = path.join(serverRoot, 'prisma/schema.prisma');

let prisma: PrismaClient;
let accessAuthHook: typeof import('../../middleware/access-auth.js').accessAuthHook;
let previewRoutes: typeof import('../previews.js').previewRoutes;
let AccessAuthService: typeof import('../../services/access-auth.service.js').AccessAuthService;

async function createPreviewFixtureApp() {
  const upgradeUrls: string[] = [];
  let targetOrigin = '';
  const targetServer = http.createServer((request, response) => {
    if (request.url === '/' && request.method === 'GET') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.setHeader('content-security-policy', "default-src 'self'");
      response.setHeader('x-frame-options', 'DENY');
      response.end('<html><head></head><body><a href="/login">Login</a><script src="/assets/app.js"></script></body></html>');
      return;
    }

    if (request.url === '/assets/app.js' && request.method === 'GET') {
      response.setHeader('content-type', 'application/javascript');
      response.end('window.previewAssetLoaded = true;');
      return;
    }

    if (request.url === '/login-redirect' && request.method === 'GET') {
      response.statusCode = 302;
      response.setHeader('location', '/login');
      response.end();
      return;
    }

    if (request.url === '/absolute-login-redirect' && request.method === 'GET') {
      response.statusCode = 302;
      response.setHeader('location', `${targetOrigin}/login`);
      response.end();
      return;
    }

    if (request.url === '/login' && request.method === 'GET') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end('<html><head></head><body>Local login page</body></html>');
      return;
    }

    if (request.url === '/api/echo' && request.method === 'GET') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ method: 'GET', ok: true }));
      return;
    }

    if (request.url === '/request-headers' && request.method === 'GET') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        cookie: request.headers.cookie ?? null,
        origin: request.headers.origin ?? null,
        referer: request.headers.referer ?? null,
        cfRay: request.headers['cf-ray'] ?? null,
        cfConnectingIp: request.headers['cf-connecting-ip'] ?? null,
        forwarded: request.headers.forwarded ?? null,
        xForwardedFor: request.headers['x-forwarded-for'] ?? null,
        xForwardedHost: request.headers['x-forwarded-host'] ?? null,
        xForwardedProto: request.headers['x-forwarded-proto'] ?? null,
        xRealIp: request.headers['x-real-ip'] ?? null,
      }));
      return;
    }

    if (request.url === '/set-cookie' && request.method === 'GET') {
      response.setHeader('set-cookie', 'preview-session=abc; Domain=127.0.0.1; Path=/; HttpOnly; SameSite=Lax');
      response.end('ok');
      return;
    }

    if (request.url === '/auth/login' && request.method === 'POST') {
      response.setHeader(
        'set-cookie',
        'agent-tower-access=target-session; Path=/; HttpOnly; SameSite=Lax',
      );
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (request.url === '/auth/status' && request.method === 'GET') {
      const cookie = request.headers.cookie ?? '';
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        authenticated: cookie.split(';').some((part) => part.trim() === 'agent-tower-access=target-session'),
        cookie,
      }));
      return;
    }

    if (request.url === '/api/echo' && request.method === 'POST') {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({
          method: 'POST',
          body: Buffer.concat(chunks).toString('utf8'),
          ok: true,
        }));
      });
      return;
    }

    response.statusCode = 404;
    response.end('not found');
  });
  targetServer.on('upgrade', (request, socket) => {
    upgradeUrls.push(request.url ?? '');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.end();
  });

  await new Promise<void>((resolve) => targetServer.listen(0, '127.0.0.1', resolve));
  const address = targetServer.address();
  if (!address || typeof address === 'string') {
    targetServer.close();
    throw new Error('Failed to start preview fixture server');
  }
  targetOrigin = `http://127.0.0.1:${address.port}`;

  const app = Fastify();
  await app.register(fastifyCookie);
  app.addHook('onRequest', accessAuthHook);
  await app.register(previewRoutes);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const appAddress = app.server.address();
  if (!appAddress || typeof appAddress === 'string') {
    await app.close();
    targetServer.close();
    throw new Error('Failed to start preview proxy fixture app');
  }

  return {
    app,
    appUrl: `http://127.0.0.1:${appAddress.port}`,
    targetUrl: targetOrigin,
    upgradeUrls,
    async close() {
      await app.close();
      await new Promise<void>((resolve) => targetServer.close(() => resolve()));
    },
  };
}

async function requestWebSocketUpgrade(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; statusMessage: string }> {
  const parsed = new URL(url);

  return new Promise((resolve, reject) => {
    const request = http.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port,
      method: 'GET',
      path: `${parsed.pathname}${parsed.search}`,
      headers: {
        'connection': 'Upgrade',
        'upgrade': 'websocket',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
        ...headers,
      },
    });

    request.on('upgrade', (response, socket) => {
      socket.destroy();
      resolve({
        statusCode: response.statusCode ?? 0,
        statusMessage: response.statusMessage ?? '',
      });
    });
    request.on('response', (response) => {
      response.resume();
      resolve({
        statusCode: response.statusCode ?? 0,
        statusMessage: response.statusMessage ?? '',
      });
    });
    request.on('error', reject);
    request.end();
  });
}

async function createWorkspace(workspaceId: string, previewTarget: string) {
  const project = await prisma.project.create({
    data: {
      name: `Preview project ${workspaceId}`,
      repoPath: testDir,
    },
  });
  const task = await prisma.task.create({
    data: {
      title: `Preview task ${workspaceId}`,
      projectId: project.id,
    },
  });
  await prisma.workspace.create({
    data: {
      id: workspaceId,
      taskId: task.id,
      branchName: `preview-${workspaceId}`,
      worktreePath: testDir,
      workingDir: testDir,
      previewTarget,
    },
  });
}

describe('previewRoutes access auth integration', () => {
  beforeAll(async () => {
    execFileSync(
      'pnpm',
      ['exec', 'prisma', 'db', 'push', '--skip-generate', `--schema=${schemaPath}`],
      {
        cwd: serverRoot,
        env: { ...process.env, AGENT_TOWER_DATABASE_URL: `file:${dbPath}` },
        stdio: 'pipe',
      },
    );

    const middlewareModule = await import('../../middleware/access-auth.js');
    const routesModule = await import('../previews.js');
    const serviceModule = await import('../../services/access-auth.service.js');
    const utilsModule = await import('../../utils/index.js');
    accessAuthHook = middlewareModule.accessAuthHook;
    previewRoutes = routesModule.previewRoutes;
    AccessAuthService = serviceModule.AccessAuthService;
    prisma = utilsModule.prisma;
  });

  beforeEach(async () => {
    await prisma.workspace.deleteMany();
    await prisma.task.deleteMany();
    await prisma.project.deleteMany();
    await prisma.accessAuthSettings.deleteMany();
    AccessAuthService.__test.resetSettingsCache();
    delete process.env[INTERNAL_API_TOKEN_ENV];
    AccessAuthService.__test.resetLoginRateLimit();
  });

  afterEach(() => {
    delete process.env[INTERNAL_API_TOKEN_ENV];
  });

  afterAll(async () => {
    await prisma.$disconnect();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('uses the browser session for stable trusted preview URLs', async () => {
    await AccessAuthService.updateSettings({ enabled: true, newPassword: 'secret-pass' });
    const login = await AccessAuthService.login('secret-pass');
    const cookie = `${AccessAuthService.cookieName}=${encodeURIComponent(login.sessionToken ?? '')}`;
    const fixture = await createPreviewFixtureApp();

    try {
      await createWorkspace('workspace-1', fixture.targetUrl);

      const unauthorizedResponse = await fixture.app.inject({
        method: 'GET',
        url: '/view/workspace-1/api/echo',
      });
      expect(unauthorizedResponse.statusCode).toBe(401);

      const statusResponse = await fixture.app.inject({
        method: 'GET',
        url: '/api/previews/workspace-1/status',
        headers: { cookie },
      });
      expect(statusResponse.statusCode).toBe(200);
      expect(statusResponse.json()).toMatchObject({
        ready: true,
        viewUrl: '/view/workspace-1/',
      });

      const getResponse = await fixture.app.inject({
        method: 'GET',
        url: '/view/workspace-1/api/echo',
        headers: { cookie },
      });
      expect(getResponse.statusCode).toBe(200);
      expect(getResponse.json()).toEqual({ method: 'GET', ok: true });

      const postResponse = await fixture.app.inject({
        method: 'POST',
        url: '/view/workspace-1/api/echo',
        headers: {
          host: 'tower.local',
          origin: 'http://tower.local',
          cookie,
          'content-type': 'application/json',
          'x-custom-header': 'preview',
        },
        payload: { value: 42 },
      });
      expect(postResponse.statusCode).toBe(200);
      expect(postResponse.json()).toEqual({
        method: 'POST',
        body: JSON.stringify({ value: 42 }),
        ok: true,
      });
      expect(postResponse.headers['access-control-allow-origin']).toBe('*');
      expect(postResponse.headers['access-control-allow-credentials']).toBeUndefined();

      const headersResponse = await fixture.app.inject({
        method: 'GET',
        url: '/view/workspace-1/request-headers',
        headers: {
          host: 'tower.local',
          origin: 'http://tower.local',
          referer: 'http://tower.local/view/workspace-1/dashboard',
          cookie: `${cookie}; preview-session=abc`,
        },
      });
      expect(headersResponse.json()).toEqual({
        cookie: 'preview-session=abc',
        origin: fixture.targetUrl,
        referer: `${fixture.targetUrl}/request-headers`,
        cfRay: null,
        cfConnectingIp: null,
        forwarded: null,
        xForwardedFor: null,
        xForwardedHost: new URL(fixture.targetUrl).host,
        xForwardedProto: 'http',
        xRealIp: null,
      });

      await expect(requestWebSocketUpgrade(
        `${fixture.appUrl}/view/workspace-1/ws`,
        { cookie },
      )).resolves.toMatchObject({ statusCode: 101 });
      expect(fixture.upgradeUrls).toContain('/ws');

      const cookieResponse = await fixture.app.inject({
        method: 'GET',
        url: '/view/workspace-1/set-cookie',
        headers: { cookie },
      });
      expect(String(cookieResponse.headers['set-cookie']))
        .toContain('preview-session=abc; Path=/view/workspace-1/');
      expect(String(cookieResponse.headers['set-cookie'])).not.toContain('Domain=');
    } finally {
      await fixture.close();
    }
  });

  it('opens an independent preview origin where root redirects and assets work without path rewriting', async () => {
    await AccessAuthService.updateSettings({ enabled: true, newPassword: 'secret-pass' });
    const login = await AccessAuthService.login('secret-pass');
    const accessCookie = `${AccessAuthService.cookieName}=${encodeURIComponent(login.sessionToken ?? '')}`;
    const fixture = await createPreviewFixtureApp();

    try {
      await createWorkspace('workspace-gateway', fixture.targetUrl);

      const sessionResponse = await fixture.app.inject({
        method: 'POST',
        url: '/api/previews/workspace-gateway/sessions',
        headers: { cookie: accessCookie },
        payload: { mode: 'local', localHostname: '127.0.0.1' },
      });
      expect(sessionResponse.statusCode).toBe(200);
      const session = sessionResponse.json() as {
        id: string;
        mode: string;
        target: string;
        viewUrl: string;
      };
      expect(session.mode).toBe('local');
      expect(session.target).toBe(fixture.targetUrl);

      const initialUrl = new URL(session.viewUrl);
      const bootstrapResponse = await fetch(initialUrl, { redirect: 'manual' });
      expect(bootstrapResponse.status).toBe(302);
      expect(bootstrapResponse.headers.get('location')).toBe('/');
      const gatewayCookie = bootstrapResponse.headers.get('set-cookie')?.split(';')[0];
      expect(gatewayCookie).toContain('agent-tower-preview-');

      const previewOrigin = initialUrl.origin;
      const repeatedBootstrapResponse = await fetch(initialUrl, {
        headers: { cookie: gatewayCookie ?? '' },
        redirect: 'manual',
      });
      expect(repeatedBootstrapResponse.status).toBe(302);
      expect(repeatedBootstrapResponse.headers.get('location')).toBe('/');

      const htmlResponse = await fetch(`${previewOrigin}/`, {
        headers: { cookie: gatewayCookie ?? '' },
      });
      const html = await htmlResponse.text();
      expect(htmlResponse.status).toBe(200);
      expect(htmlResponse.headers.get('content-security-policy')).toBeNull();
      expect(htmlResponse.headers.get('x-frame-options')).toBeNull();
      expect(html).toContain('data-agent-tower-preview-bridge');
      expect(html).toContain('src="/assets/app.js"');
      expect(html).not.toContain('/view/workspace-gateway');

      const assetResponse = await fetch(`${previewOrigin}/assets/app.js`, {
        headers: { cookie: gatewayCookie ?? '' },
      });
      expect(await assetResponse.text()).toContain('previewAssetLoaded');

      const cookieResponse = await fetch(`${previewOrigin}/set-cookie`, {
        headers: { cookie: gatewayCookie ?? '' },
      });
      const targetCookie = cookieResponse.headers.get('set-cookie');
      expect(targetCookie).toContain('preview-session=abc; Path=/');
      expect(targetCookie).not.toContain('Domain=');

      const authLoginResponse = await fetch(`${previewOrigin}/auth/login`, {
        method: 'POST',
        headers: {
          cookie: gatewayCookie ?? '',
          origin: previewOrigin,
        },
      });
      expect(authLoginResponse.status).toBe(200);
      const scopedAccessCookie = authLoginResponse.headers.get('set-cookie')?.split(';')[0];
      expect(scopedAccessCookie).toContain('agent-tower-preview-');
      expect(scopedAccessCookie).toContain('-target-');
      expect(scopedAccessCookie).not.toMatch(/^agent-tower-access=/);

      const authStatusResponse = await fetch(`${previewOrigin}/auth/status`, {
        headers: {
          cookie: [
            gatewayCookie,
            'agent-tower-access=outer-session',
            scopedAccessCookie,
          ].filter(Boolean).join('; '),
        },
      });
      expect(await authStatusResponse.json()).toEqual({
        authenticated: true,
        cookie: 'agent-tower-access=target-session',
      });

      const remoteHeadersResponse = await fetch(`${previewOrigin}/request-headers`, {
        headers: {
          cookie: gatewayCookie ?? '',
          origin: 'https://preview.remote.example',
          referer: 'https://preview.remote.example/settings',
          'cf-ray': 'preview-tunnel-ray',
          'cf-connecting-ip': '203.0.113.10',
          forwarded: 'for=203.0.113.10;proto=https',
          'x-forwarded-for': '203.0.113.10',
          'x-forwarded-proto': 'https',
          'x-real-ip': '203.0.113.10',
        },
      });
      expect(await remoteHeadersResponse.json()).toMatchObject({
        origin: fixture.targetUrl,
        cfRay: null,
        cfConnectingIp: null,
        forwarded: null,
        xForwardedFor: null,
        xForwardedHost: new URL(previewOrigin).host,
        xForwardedProto: 'https',
        xRealIp: null,
      });

      const remoteCookieResponse = await fetch(`${previewOrigin}/set-cookie`, {
        headers: {
          cookie: gatewayCookie ?? '',
          'cf-ray': 'preview-tunnel-ray',
          'x-forwarded-proto': 'https',
        },
      });
      const remoteTargetCookie = remoteCookieResponse.headers.get('set-cookie');
      expect(remoteTargetCookie).toContain('Secure');
      expect(remoteTargetCookie).toContain('SameSite=None');
      expect(remoteTargetCookie).toContain('Partitioned');
      expect(remoteTargetCookie).not.toContain('SameSite=Lax');

      const redirectResponse = await fetch(`${previewOrigin}/login-redirect`, {
        headers: { cookie: gatewayCookie ?? '' },
        redirect: 'manual',
      });
      expect(redirectResponse.status).toBe(302);
      expect(redirectResponse.headers.get('location')).toBe('/login');

      const absoluteRedirectResponse = await fetch(`${previewOrigin}/absolute-login-redirect`, {
        headers: { cookie: gatewayCookie ?? '' },
        redirect: 'manual',
      });
      expect(absoluteRedirectResponse.headers.get('location')).toBe(`${previewOrigin}/login`);

      const loginResponse = await fetch(`${previewOrigin}/login`, {
        headers: { cookie: gatewayCookie ?? '' },
      });
      expect(await loginResponse.text()).toContain('Local login page');

      await expect(requestWebSocketUpgrade(
        `${previewOrigin}/ws`,
        { cookie: gatewayCookie ?? '' },
      )).resolves.toMatchObject({ statusCode: 101 });
      expect(fixture.upgradeUrls).toContain('/ws');

      const heartbeatResponse = await fixture.app.inject({
        method: 'POST',
        url: `/api/previews/workspace-gateway/sessions/${session.id}/heartbeat`,
        headers: { cookie: accessCookie },
      });
      expect(heartbeatResponse.statusCode).toBe(200);
      expect(new URL(heartbeatResponse.json().viewUrl).origin).toBe(previewOrigin);

      const releaseResponse = await fixture.app.inject({
        method: 'DELETE',
        url: `/api/previews/workspace-gateway/sessions/${session.id}`,
        headers: { cookie: accessCookie },
      });
      expect(releaseResponse.statusCode).toBe(204);
    } finally {
      await fixture.close();
    }
  });

  it('rejects preview websocket upgrades with invalid internal token even when preview token is valid', async () => {
    await AccessAuthService.updateSettings({ enabled: true, newPassword: 'secret-pass' });
    process.env[INTERNAL_API_TOKEN_ENV] = 'expected-internal-token';
    const fixture = await createPreviewFixtureApp();

    try {
      await createWorkspace('workspace-preview-token', fixture.targetUrl);
      const token = await AccessAuthService.createPreviewAccessToken('workspace-preview-token');

      await expect(requestWebSocketUpgrade(
        `${fixture.appUrl}/view/workspace-preview-token/__agent_tower_preview/${token}/ws`,
        { [INTERNAL_API_TOKEN_HEADER]: 'wrong-internal-token' },
      )).resolves.toMatchObject({
        statusCode: 401,
        statusMessage: 'Invalid Internal Token',
      });
      expect(fixture.upgradeUrls).not.toContain('/ws');

      await expect(requestWebSocketUpgrade(
        `${fixture.appUrl}/view/workspace-preview-token/__agent_tower_preview/${token}/ws`,
      )).resolves.toMatchObject({ statusCode: 101 });
      expect(fixture.upgradeUrls).toContain('/ws');
    } finally {
      await fixture.close();
    }
  });

  it('rejects preview websocket upgrades with invalid internal token even when access auth cookie is valid', async () => {
    await AccessAuthService.updateSettings({ enabled: true, newPassword: 'secret-pass' });
    const login = await AccessAuthService.login('secret-pass');
    expect(login.sessionToken).toBeTruthy();
    process.env[INTERNAL_API_TOKEN_ENV] = 'expected-internal-token';
    const fixture = await createPreviewFixtureApp();

    try {
      await createWorkspace('workspace-cookie', fixture.targetUrl);
      const cookie = `${AccessAuthService.cookieName}=${encodeURIComponent(login.sessionToken ?? '')}`;

      await expect(requestWebSocketUpgrade(
        `${fixture.appUrl}/view/workspace-cookie/ws`,
        {
          [INTERNAL_API_TOKEN_HEADER]: 'wrong-internal-token',
          cookie,
        },
      )).resolves.toMatchObject({
        statusCode: 401,
        statusMessage: 'Invalid Internal Token',
      });
      expect(fixture.upgradeUrls).not.toContain('/ws');

      await expect(requestWebSocketUpgrade(
        `${fixture.appUrl}/view/workspace-cookie/ws`,
        { cookie },
      )).resolves.toMatchObject({ statusCode: 101 });
      expect(fixture.upgradeUrls).toContain('/ws');
    } finally {
      await fixture.close();
    }
  });

  it('accepts preview websocket upgrades with a valid internal token without browser auth', async () => {
    await AccessAuthService.updateSettings({ enabled: true, newPassword: 'secret-pass' });
    process.env[INTERNAL_API_TOKEN_ENV] = 'expected-internal-token';
    const fixture = await createPreviewFixtureApp();

    try {
      await createWorkspace('workspace-internal-token', fixture.targetUrl);

      await expect(requestWebSocketUpgrade(
        `${fixture.appUrl}/view/workspace-internal-token/ws`,
        { [INTERNAL_API_TOKEN_HEADER]: 'expected-internal-token' },
      )).resolves.toMatchObject({ statusCode: 101 });
      expect(fixture.upgradeUrls).toContain('/ws');
    } finally {
      await fixture.close();
    }
  });
});
