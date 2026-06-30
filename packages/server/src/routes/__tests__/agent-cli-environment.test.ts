import Fastify from 'fastify';
import type { AgentCliPublicInstallManifestItem } from '@agent-tower/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const publicManifest: AgentCliPublicInstallManifestItem[] = [
  {
    id: 'codex',
    displayName: 'Codex',
    legacy: false,
    officialSources: [{ label: 'Codex installer', url: 'https://chatgpt.com/codex/install.sh' }],
    supportedPlatforms: ['darwin', 'linux'],
    install: {
      kind: 'downloaded-script',
      downloadUrl: 'https://chatgpt.com/codex/install.sh',
      allowedRedirectHosts: ['chatgpt.com'],
      allowedExactPaths: ['/codex/install.sh'],
      allowedPathPrefixes: [],
      interpreters: {
        darwin: { command: '/bin/sh', args: [] },
      },
      fixedArgs: [],
      maxBytes: 1024,
      riskNotes: ['test risk'],
    },
    detectionCommands: [{ command: 'codex', args: ['--version'], timeoutMs: 5000 }],
    versionCommand: { command: 'codex', args: ['--version'], timeoutMs: 5000 },
    lastVerifiedAt: '2026-06-18',
  },
];

const getManifest = vi.fn(() => publicManifest);
const getStatus = vi.fn(() => ({
  tools: [],
  checkedAt: null,
  stale: true,
}));
const refreshStatus = vi.fn(async () => ({
  tools: [],
  checkedAt: '2026-06-18T00:00:00.000Z',
  stale: false,
}));
const createPreview = vi.fn();
const getPreview = vi.fn();
const createTask = vi.fn();
const getTask = vi.fn();
const getLogs = vi.fn();
const cancelTask = vi.fn();

vi.mock('../../core/container.js', () => ({
  getAgentCliEnvironmentService: () => ({
    getManifest,
    getStatus,
    refreshStatus,
    createPreview,
    getPreview,
    createTask,
    getTask,
    getLogs,
    cancelTask,
  }),
}));

const { agentCliEnvironmentRoutes } = await import('../agent-cli-environment.js');

async function buildApp() {
  const app = Fastify();
  await app.register(agentCliEnvironmentRoutes, { prefix: '/api' });
  return app;
}

describe('agentCliEnvironmentRoutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /status only reads cached status', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/agent-cli/status',
      });

      expect(response.statusCode).toBe(200);
      expect(getStatus).toHaveBeenCalledTimes(1);
      expect(refreshStatus).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('GET /manifest returns public manifest without verifyCommand', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/agent-cli/manifest',
      });

      expect(response.statusCode).toBe(200);
      expect(getManifest).toHaveBeenCalledTimes(1);
      expect(response.json()).toEqual(publicManifest);
      expect(response.body).not.toContain('verifyCommand');
    } finally {
      await app.close();
    }
  });

  it('POST /status/refresh is local-only and triggers refresh', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/agent-cli/status/refresh',
        remoteAddress: '127.0.0.1',
        headers: {
          host: 'localhost:12580',
          origin: 'http://localhost:12580',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(refreshStatus).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('POST /status/refresh rejects remote tunnel requests before refresh', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/agent-cli/status/refresh',
        remoteAddress: '127.0.0.1',
        headers: {
          host: 'localhost:12580',
          origin: 'http://localhost:12580',
          'cf-ray': 'abc123',
        },
      });

      expect(response.statusCode).toBe(403);
      expect(refreshStatus).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
