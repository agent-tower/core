import type { FastifyInstance } from 'fastify';
import { TunnelService } from '../services/tunnel.service.js';

export async function tunnelRoutes(app: FastifyInstance) {
  // 获取隧道状态
  app.get('/tunnel/status', async () => {
    return TunnelService.getStatus();
  });

  // 启动隧道
  app.post<{ Body: { port?: number } }>('/tunnel/start', async (request, reply) => {
    try {
      // 优先使用前端传来的端口（开发模式下是 Vite 端口），否则用服务端端口
      const port = request.body?.port
        ?? (typeof app.server.address() === 'object' && app.server.address()
          ? (app.server.address() as { port: number }).port
          : 3001);
      const result = await TunnelService.start(port);
      return result;
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
