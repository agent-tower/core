import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { agentCliLocalOnlyHook } from '../agent-cli-local-only.js';

async function buildApp() {
  const app = Fastify();
  app.addHook('preHandler', agentCliLocalOnlyHook);
  app.get('/api/agent-cli/install-tasks/:id/logs', async () => ({ ok: true }));
  app.post('/api/agent-cli/install-tasks', async () => ({ ok: true }));
  return app;
}

describe('agentCliLocalOnlyHook', () => {
  it('rejects Cloudflare tunnel requests even when the route is otherwise local', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/agent-cli/install-tasks',
        remoteAddress: '127.0.0.1',
        headers: {
          host: 'localhost:12580',
          origin: 'http://localhost:12580',
          'cf-ray': 'abc123',
        },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        code: 'AGENT_CLI_INSTALL_LOCAL_ONLY',
        message: '请在本机 Agent Tower 打开执行。',
      });
    } finally {
      await app.close();
    }
  });

  it('rejects non-loopback Host', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/agent-cli/install-tasks',
        remoteAddress: '127.0.0.1',
        headers: { host: 'example.com' },
      });

      expect(response.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('rejects non-loopback remoteAddress', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/agent-cli/install-tasks',
        remoteAddress: '192.168.1.10',
        headers: { host: 'localhost:12580' },
      });

      expect(response.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('rejects cross-origin GET logs even though the method is safe', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/agent-cli/install-tasks/task-1/logs',
        remoteAddress: '127.0.0.1',
        headers: {
          host: 'localhost:12580',
          origin: 'http://localhost:5173',
        },
      });

      expect(response.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('allows same-origin loopback requests with Origin', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/agent-cli/install-tasks/task-1/logs',
        remoteAddress: '::ffff:127.0.0.1',
        headers: {
          host: 'localhost:12580',
          origin: 'http://localhost:12580',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  it('allows local requests without Origin', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/agent-cli/install-tasks',
        remoteAddress: '127.0.0.1',
        headers: { host: '127.0.0.1:12580' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });
});
