import type { FastifyInstance } from 'fastify';
import { TunnelService } from '../services/tunnel.service.js';
import { isTunnelRequest } from '../middleware/tunnel-auth.js';

export async function tunnelRoutes(app: FastifyInstance) {
  // 获取隧道状态（本地请求额外返回 token 和 shareableUrl）
  app.get('/tunnel/status', async (request) => {
    const status = TunnelService.getStatus();
    const isLocal = !isTunnelRequest(request);
    const token = isLocal ? TunnelService.getToken() : undefined;

    return {
      ...status,
      token,
      shareableUrl: token && status.url ? `${status.url}?token=${token}` : undefined,
    };
  });

  // 前端启动时用 query token 换取 session cookie（主要覆盖 dev + Vite 首页）
  app.post('/tunnel/bootstrap', async () => ({ ok: true }));

  // 启动隧道
  app.post<{ Body: { port?: number } }>('/tunnel/start', async (request, reply) => {
    try {
      const port = request.body?.port
        ?? (typeof app.server.address() === 'object' && app.server.address()
          ? (app.server.address() as { port: number }).port
          : 0);
      const { url, token } = await TunnelService.start(port);
      return { url, token, shareableUrl: `${url}?token=${token}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start tunnel';
      return reply.code(500).send({ error: message });
    }
  });

  // 停止隧道
  app.post('/tunnel/stop', async () => {
    TunnelService.stop();
    return { ok: true };
  });
}
