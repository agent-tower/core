import Fastify from 'fastify';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { filesRoutes } from '../files.js';

let tempRoot = '';
let workspaceDir = '';
let dataDir = '';
const originalDataDir = process.env.AGENT_TOWER_DATA_DIR;

async function buildTestApp() {
  const app = Fastify();
  await app.register(filesRoutes);
  return app;
}

describe('files routes', () => {
  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-files-route-'));
    workspaceDir = path.join(tempRoot, 'workspace');
    dataDir = path.join(tempRoot, 'data');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    process.env.AGENT_TOWER_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (originalDataDir === undefined) {
      delete process.env.AGENT_TOWER_DATA_DIR;
    } else {
      process.env.AGENT_TOWER_DATA_DIR = originalDataDir;
    }
    if (tempRoot) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('reads regular workspace files', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'hello.txt'), 'hello\n', 'utf-8');
    const app = await buildTestApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/read?workingDir=${encodeURIComponent(workspaceDir)}&path=hello.txt`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ content: 'hello\n' });
    } finally {
      await app.close();
    }
  });

  it('serves images from absolute filesystem paths without a workingDir', async () => {
    const imagePath = path.join(tempRoot, 'result.png');
    const imageContent = Buffer.from('absolute-image-content');
    fs.writeFileSync(imagePath, imageContent);
    const app = await buildTestApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/image?path=${encodeURIComponent(imagePath)}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('image/png');
      expect(response.rawPayload).toEqual(imageContent);
    } finally {
      await app.close();
    }
  });

  it('still requires a workingDir for relative image paths', async () => {
    const app = await buildTestApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/image?path=artifacts%2Fresult.png',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: 'WORKING_DIR_REQUIRED' });
    } finally {
      await app.close();
    }
  });

  it('blocks browser-readable file APIs from reading the internal API token', async () => {
    fs.writeFileSync(path.join(dataDir, 'internal-api-token'), 'secret-internal-token\n', 'utf-8');
    const app = await buildTestApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/read?workingDir=${encodeURIComponent(dataDir)}&path=internal-api-token`,
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'INTERNAL_PATH_FORBIDDEN' });
      expect(response.body).not.toContain('secret-internal-token');
    } finally {
      await app.close();
    }
  });

  it('blocks workspace symlinks that point at internal Agent Tower files', async () => {
    fs.writeFileSync(path.join(dataDir, 'internal-api-token'), 'secret-internal-token\n', 'utf-8');
    fs.symlinkSync(path.join(dataDir, 'internal-api-token'), path.join(workspaceDir, 'linked-token'), 'file');
    const app = await buildTestApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/read?workingDir=${encodeURIComponent(workspaceDir)}&path=linked-token`,
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'INTERNAL_PATH_FORBIDDEN' });
      expect(response.body).not.toContain('secret-internal-token');
    } finally {
      await app.close();
    }
  });

  it('blocks listing Agent Tower dataDir contents', async () => {
    fs.writeFileSync(path.join(dataDir, 'data.db'), 'sqlite bytes', 'utf-8');
    const app = await buildTestApp();

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/tree?workingDir=${encodeURIComponent(dataDir)}&path=/`,
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'INTERNAL_PATH_FORBIDDEN' });
      expect(response.body).not.toContain('data.db');
    } finally {
      await app.close();
    }
  });
});
