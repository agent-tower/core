import Fastify from 'fastify';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { filesystemRoutes } from '../filesystem.js';

let tempDir = '';

async function buildTestApp() {
  const app = Fastify();
  await app.register(filesystemRoutes);
  return app;
}

describe('filesystem routes', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-fs-'));
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('marks an empty non-git directory as initializable', async () => {
    const app = await buildTestApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/validate?path=${encodeURIComponent(tempDir)}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        valid: false,
        path: tempDir,
        reason: 'no_git',
        isEmpty: true,
      });
    } finally {
      await app.close();
    }
  });

  it('does not ignore hidden files when checking whether a directory is empty', async () => {
    fs.writeFileSync(path.join(tempDir, '.env'), 'SECRET=value\n', 'utf-8');
    const app = await buildTestApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/validate?path=${encodeURIComponent(tempDir)}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        valid: false,
        path: tempDir,
        reason: 'no_git',
        isEmpty: false,
      });
    } finally {
      await app.close();
    }
  });

  it('accepts a directory with git metadata', async () => {
    fs.mkdirSync(path.join(tempDir, '.git'));
    const app = await buildTestApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/validate?path=${encodeURIComponent(tempDir)}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        valid: true,
        path: tempDir,
      });
    } finally {
      await app.close();
    }
  });
});
