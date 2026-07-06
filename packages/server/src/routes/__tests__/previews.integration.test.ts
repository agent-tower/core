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
  const targetServer = http.createServer((request, response) => {
    if (request.url === '/api/echo' && request.method === 'GET') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ method: 'GET', ok: true }));
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
    targetUrl: `http://127.0.0.1:${address.port}`,
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

  it('requires browser auth for legacy preview paths and allows tokenized preview API proxy requests', async () => {
    await AccessAuthService.updateSettings({ enabled: true, newPassword: 'secret-pass' });
    const fixture = await createPreviewFixtureApp();

    try {
      await createWorkspace('workspace-1', fixture.targetUrl);
      const token = await AccessAuthService.createPreviewAccessToken('workspace-1');

      const legacyResponse = await fixture.app.inject({
        method: 'GET',
        url: '/view/workspace-1/api/echo',
      });
      expect(legacyResponse.statusCode).toBe(401);

      const getResponse = await fixture.app.inject({
        method: 'GET',
        url: `/view/workspace-1/__agent_tower_preview/${token}/api/echo`,
      });
      expect(getResponse.statusCode).toBe(200);
      expect(getResponse.json()).toEqual({ method: 'GET', ok: true });

      const postResponse = await fixture.app.inject({
        method: 'POST',
        url: `/view/workspace-1/__agent_tower_preview/${token}/api/echo`,
        headers: {
          origin: 'null',
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

      await expect(requestWebSocketUpgrade(
        `${fixture.appUrl}/view/workspace-1/__agent_tower_preview/${token}/ws`,
      )).resolves.toMatchObject({ statusCode: 101 });
      expect(fixture.upgradeUrls).toContain('/ws');
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
