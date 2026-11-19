import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-app-settings-'));
process.env.AGENT_TOWER_DATABASE_URL = `file:${path.join(testDir, 'test.db')}`;
process.env.AGENT_TOWER_DATA_DIR = testDir;
const serverRoot = fileURLToPath(new URL('../../../', import.meta.url));
let prisma: PrismaClient;
let appSettingsRoutes: typeof import('../app-settings.js').appSettingsRoutes;

async function appForTest() {
  const app = Fastify();
  await app.register(appSettingsRoutes, { prefix: '/api' });
  return app;
}

describe('app settings: usage-limit resume switch', () => {
  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', `--schema=${path.join(serverRoot, 'prisma/schema.prisma')}`], {
      cwd: serverRoot, env: process.env, stdio: 'pipe',
    });
    ({ prisma } = await import('../../utils/index.js'));
    ({ appSettingsRoutes } = await import('../app-settings.js'));
  }, 120_000);
  beforeEach(async () => { await prisma.appSettings.deleteMany(); });
  afterAll(async () => { await prisma.$disconnect(); fs.rmSync(testDir, { recursive: true, force: true }); });

  it('is on by default, can be turned off, and keeps the other settings', async () => {
    const app = await appForTest();
    try {
      expect((await app.inject({ method: 'GET', url: '/api/app-settings' })).json()).toMatchObject({ autoResumeAfterUsageLimit: true });
      await app.inject({ method: 'PUT', url: '/api/app-settings', payload: { locale: 'en' } });
      expect((await app.inject({ method: 'GET', url: '/api/app-settings' })).json()).toMatchObject({ locale: 'en', autoResumeAfterUsageLimit: true });

      const off = await app.inject({ method: 'PUT', url: '/api/app-settings', payload: { autoResumeAfterUsageLimit: false } });
      expect(off.statusCode).toBe(200);
      expect(off.json()).toMatchObject({ locale: 'en', autoResumeAfterUsageLimit: false });
      expect((await app.inject({ method: 'GET', url: '/api/app-settings' })).json()).toMatchObject({ autoResumeAfterUsageLimit: false });

      const invalid = await app.inject({ method: 'PUT', url: '/api/app-settings', payload: { autoResumeAfterUsageLimit: 'no' } });
      expect(invalid.statusCode).toBeGreaterThanOrEqual(400);
      expect((await app.inject({ method: 'GET', url: '/api/app-settings' })).json()).toMatchObject({ autoResumeAfterUsageLimit: false });
    } finally {
      await app.close();
    }
  });
});
