import Fastify from 'fastify';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitRoutes } from '../git.js';

let tempDir = '';

async function buildTestApp() {
  const app = Fastify();
  await app.register(gitRoutes);
  return app;
}

describe('git routes', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-git-routes-'));
  });

  afterEach(() => {
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['/changes', 'workingDir={dir}'],
    ['/diff', 'workingDir={dir}&path=README.md&type=uncommitted'],
    ['/log', 'workingDir={dir}'],
    ['/commit-files', 'workingDir={dir}&hash=abcd1234'],
    ['/commit-diff', 'workingDir={dir}&hash=abcd1234&path=README.md'],
  ])('rejects non-git workingDir for %s', async (route, queryTemplate) => {
    const app = await buildTestApp();

    try {
      const query = queryTemplate.replace('{dir}', encodeURIComponent(tempDir));
      const response = await app.inject({
        method: 'GET',
        url: `${route}?${query}`,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        code: 'GIT_UNAVAILABLE',
        workingDir: tempDir,
      });
    } finally {
      await app.close();
    }
  });
});
