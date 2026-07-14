import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-attachments-'));
const dbPath = path.join(testDir, 'test.db');
process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;
process.env.AGENT_TOWER_DATA_DIR = testDir;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, '../../..');
const schemaPath = path.join(serverRoot, 'prisma/schema.prisma');

let attachmentRoutes: typeof import('../attachments.js').attachmentRoutes;
let prisma: PrismaClient;

async function buildTestApp() {
  const app = Fastify();
  await app.register(attachmentRoutes);
  return app;
}

describe('attachment routes', () => {
  beforeAll(async () => {
    execFileSync(
      'pnpm',
      ['exec', 'prisma', 'db', 'push', '--skip-generate', `--schema=${schemaPath}`],
      {
        cwd: serverRoot,
        env: { ...process.env, AGENT_TOWER_DATABASE_URL: `file:${dbPath}` },
        stdio: 'pipe',
      }
    );

    const routeModule = await import('../attachments.js');
    const utilsModule = await import('../../utils/index.js');
    attachmentRoutes = routeModule.attachmentRoutes;
    prisma = utilsModule.prisma;
  });

  beforeEach(async () => {
    await prisma.attachment.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('returns attachment metadata in requested order', async () => {
    const first = await prisma.attachment.create({
      data: {
        originalName: 'first.png',
        mimeType: 'image/png',
        sizeBytes: 10,
        storagePath: path.join(testDir, 'first.png'),
        hash: 'first-hash',
      },
    });
    const second = await prisma.attachment.create({
      data: {
        originalName: 'second.txt',
        mimeType: 'text/plain',
        sizeBytes: 20,
        storagePath: path.join(testDir, 'second.txt'),
        hash: 'second-hash',
      },
    });
    const app = await buildTestApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/metadata?ids=${second.id},missing,${first.id}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject([
        {
          id: second.id,
          originalName: 'second.txt',
          url: `/attachments/${second.id}/file`,
        },
        {
          id: first.id,
          originalName: 'first.png',
          url: `/attachments/${first.id}/file`,
        },
      ]);
    } finally {
      await app.close();
    }
  });

  it('serves files from the conversation artifact directory', async () => {
    const artifactPath = path.join(testDir, 'conversations', 'thread-1', 'result.png');
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, Buffer.from('image-content'));
    const app = await buildTestApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/by-path?path=${encodeURIComponent(artifactPath)}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('image/png');
      expect(response.body).toBe('image-content');
    } finally {
      await app.close();
    }
  });

  it('rejects files from directories that only share an artifact path prefix', async () => {
    const outsidePath = path.join(testDir, 'conversations-private', 'secret.txt');
    fs.mkdirSync(path.dirname(outsidePath), { recursive: true });
    fs.writeFileSync(outsidePath, 'secret');
    const app = await buildTestApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/by-path?path=${encodeURIComponent(outsidePath)}`,
      });

      expect(response.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});
