import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-access-auth-middleware-'));
const dbPath = path.join(testDir, 'test.db');
process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;
process.env.AGENT_TOWER_DATA_DIR = testDir;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, '../../..');
const schemaPath = path.join(serverRoot, 'prisma/schema.prisma');

let prisma: PrismaClient;
let accessAuthHook: typeof import('../access-auth.js').accessAuthHook;
let accessAuthRoutes: typeof import('../../routes/access-auth.js').accessAuthRoutes;
let AccessAuthService: typeof import('../../services/access-auth.service.js').AccessAuthService;
let INTERNAL_API_TOKEN_HEADER: typeof import('../../utils/internal-api-token.js').INTERNAL_API_TOKEN_HEADER;
let INTERNAL_API_TOKEN_ENV: typeof import('../../utils/internal-api-token.js').INTERNAL_API_TOKEN_ENV;
let getOrCreateInternalApiToken: typeof import('../../utils/internal-api-token.js').getOrCreateInternalApiToken;

async function buildTestApp() {
  const app = Fastify();
  await app.register(fastifyCookie);
  app.addHook('onRequest', accessAuthHook);
  await app.register(accessAuthRoutes, { prefix: '/api' });
  app.get('/api/private', async () => ({ ok: true }));
  app.post('/api/private', async () => ({ ok: true }));
  app.get('/api/tunnel/bootstrap', async () => ({ ok: true }));
  app.get('/view/:workspaceId/*', async () => ({ ok: true }));
  return app;
}

describe('accessAuthHook', () => {
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

    const middlewareModule = await import('../access-auth.js');
    const routesModule = await import('../../routes/access-auth.js');
    const serviceModule = await import('../../services/access-auth.service.js');
    const tokenModule = await import('../../utils/internal-api-token.js');
    const utilsModule = await import('../../utils/index.js');
    accessAuthHook = middlewareModule.accessAuthHook;
    accessAuthRoutes = routesModule.accessAuthRoutes;
    AccessAuthService = serviceModule.AccessAuthService;
    INTERNAL_API_TOKEN_HEADER = tokenModule.INTERNAL_API_TOKEN_HEADER;
    INTERNAL_API_TOKEN_ENV = tokenModule.INTERNAL_API_TOKEN_ENV;
    getOrCreateInternalApiToken = tokenModule.getOrCreateInternalApiToken;
    prisma = utilsModule.prisma;
  });

  beforeEach(async () => {
    await prisma.accessAuthSettings.deleteMany();
    delete process.env.AGENT_TOWER_INTERNAL_TOKEN;
    AccessAuthService.__test.resetLoginRateLimit();
    AccessAuthService.__test.resetSessionSecretGeneration();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('allows API requests when access password is disabled', async () => {
    const app = await buildTestApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/api/private' });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('handles concurrent initial access auth status requests on a fresh database', async () => {
    const app = await buildTestApp();
    try {
      const responses = await Promise.all(
        Array.from({ length: 8 }, () => app.inject({ method: 'GET', url: '/api/access-auth/status' })),
      );

      expect(responses.map((response) => response.statusCode)).toEqual(Array.from({ length: 8 }, () => 200));
      for (const response of responses) {
        expect(response.json()).toEqual({ enabled: false, authenticated: true });
      }
      await expect(prisma.accessAuthSettings.count()).resolves.toBe(1);
    } finally {
      await app.close();
    }
  });

  it('rejects protected APIs when enabled and allows status/login/tunnel bootstrap', async () => {
    await AccessAuthService.updateSettings({ enabled: true, newPassword: 'secret-pass' });
    const app = await buildTestApp();

    try {
      const privateResponse = await app.inject({ method: 'GET', url: '/api/private' });
      expect(privateResponse.statusCode).toBe(401);
      expect(privateResponse.json()).toMatchObject({ code: 'ACCESS_AUTH_REQUIRED' });

      const statusResponse = await app.inject({ method: 'GET', url: '/api/access-auth/status' });
      expect(statusResponse.statusCode).toBe(200);
      expect(statusResponse.json()).toEqual({ enabled: true, authenticated: false });

      const tunnelResponse = await app.inject({ method: 'GET', url: '/api/tunnel/bootstrap' });
      expect(tunnelResponse.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it('sets a session cookie on login and allows same-origin writes', async () => {
    await AccessAuthService.updateSettings({ enabled: true, newPassword: 'secret-pass' });
    const app = await buildTestApp();

    try {
      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/access-auth/login',
        payload: { password: 'secret-pass' },
      });
      expect(loginResponse.statusCode).toBe(200);
      const cookie = String(loginResponse.headers['set-cookie']);
      expect(cookie).toContain('agent-tower-access=');

      const writeResponse = await app.inject({
        method: 'POST',
        url: '/api/private',
        headers: {
          cookie,
          origin: 'http://localhost:12580',
          host: 'localhost:12580',
        },
      });
      expect(writeResponse.statusCode).toBe(200);

      const csrfResponse = await app.inject({
        method: 'POST',
        url: '/api/private',
        headers: {
          cookie,
          origin: 'http://evil.example',
          host: 'localhost:12580',
        },
      });
      expect(csrfResponse.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('allows internal token requests without a browser session', async () => {
    await AccessAuthService.updateSettings({ enabled: true, newPassword: 'secret-pass' });
    const app = await buildTestApp();
    const originalDataDir = process.env.AGENT_TOWER_DATA_DIR;
    const token = getOrCreateInternalApiToken(testDir);
    process.env[INTERNAL_API_TOKEN_ENV] = token;
    process.env.AGENT_TOWER_DATA_DIR = path.join(testDir, 'wrong-data-dir');

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/private',
        headers: {
          [INTERNAL_API_TOKEN_HEADER]: token,
        },
      });
      expect(response.statusCode).toBe(200);
    } finally {
      if (originalDataDir === undefined) {
        delete process.env.AGENT_TOWER_DATA_DIR;
      } else {
        process.env.AGENT_TOWER_DATA_DIR = originalDataDir;
      }
      await app.close();
    }
  });

  it('rejects missing or incorrect internal token requests when access password is enabled', async () => {
    await AccessAuthService.updateSettings({ enabled: true, newPassword: 'secret-pass' });
    process.env[INTERNAL_API_TOKEN_ENV] = 'expected-internal-token';
    const app = await buildTestApp();

    try {
      const missingResponse = await app.inject({
        method: 'GET',
        url: '/api/private',
      });
      expect(missingResponse.statusCode).toBe(401);
      expect(missingResponse.json()).toMatchObject({ code: 'ACCESS_AUTH_REQUIRED' });

      const wrongResponse = await app.inject({
        method: 'GET',
        url: '/api/private',
        headers: {
          [INTERNAL_API_TOKEN_HEADER]: 'wrong-internal-token',
        },
      });
      expect(wrongResponse.statusCode).toBe(401);
      expect(wrongResponse.json()).toMatchObject({ code: 'ACCESS_AUTH_INVALID_INTERNAL_TOKEN' });
    } finally {
      await app.close();
    }
  });

  it('allows tokenized preview proxy requests without allowing main API requests', async () => {
    await AccessAuthService.updateSettings({ enabled: true, newPassword: 'secret-pass' });
    const previewToken = await AccessAuthService.createPreviewAccessToken('workspace-1');
    const app = await buildTestApp();

    try {
      const previewResponse = await app.inject({
        method: 'GET',
        url: `/view/workspace-1/__agent_tower_preview/${previewToken}/api/echo`,
      });
      expect(previewResponse.statusCode).toBe(200);

      const mismatchedPreviewResponse = await app.inject({
        method: 'GET',
        url: `/view/workspace-2/__agent_tower_preview/${previewToken}/api/echo`,
      });
      expect(mismatchedPreviewResponse.statusCode).toBe(401);

      const apiResponse = await app.inject({
        method: 'GET',
        url: '/api/private',
        headers: {
          'x-preview-token': previewToken,
        },
      });
      expect(apiResponse.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it('rate limits repeated login failures at the route boundary', async () => {
    await AccessAuthService.updateSettings({ enabled: true, newPassword: 'secret-pass' });
    const app = await buildTestApp();

    try {
      for (let i = 0; i < AccessAuthService.__test.MAX_FAILED_LOGIN_ATTEMPTS; i += 1) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/access-auth/login',
          payload: { password: 'wrong-pass' },
        });
        expect(response.statusCode).toBe(401);
      }

      const limited = await app.inject({
        method: 'POST',
        url: '/api/access-auth/login',
        payload: { password: 'secret-pass' },
      });

      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({ code: 'ACCESS_AUTH_RATE_LIMITED' });
      expect(limited.headers['set-cookie']).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
