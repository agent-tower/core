import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerRoutes } from './routes/index.js';
import { initializeSocket, closeSocket } from './socket/index.js';
import { WorkspaceService } from './services/workspace.service.js';
import { TunnelService } from './services/tunnel.service.js';
import { tunnelAuthHook } from './middleware/tunnel-auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
  });

  // 注册插件
  await app.register(cors, {
    origin: true,
  });

  await app.register(multipart, {
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  });

  // 隧道 token 认证钩子（仅拦截经 Cloudflare 隧道的请求）
  app.addHook('onRequest', tunnelAuthHook);

  // 注册路由
  await registerRoutes(app);

  // 生产模式：托管前端静态文件
  if (process.env.NODE_ENV === 'production') {
    // npm 发布包: dist/web/  |  monorepo 开发: ../../web/dist
    const webDistPath = path.resolve(
      __dirname,
      process.env.AGENT_TOWER_WEB_DIR || '../../web/dist',
    );
    await app.register(fastifyStatic, {
      root: webDistPath,
      prefix: '/',
      wildcard: false,
    });

    // SPA fallback：非 API/socket 路由返回 index.html
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api') || req.url.startsWith('/socket.io')) {
        return reply.code(404).send({ error: 'Not Found' });
      }
      return reply.sendFile('index.html');
    });
  }

  // 服务器启动后初始化 Socket.IO 并清理过期 worktree
  app.addHook('onReady', async () => {
    await initializeSocket(app);

    // 启动时清理过期 worktree 引用
    WorkspaceService.pruneAllWorktrees().catch((err) => {
      app.log.warn(`Worktree prune on startup failed: ${err instanceof Error ? err.message : err}`);
    });
  });

  // 服务器关闭时清理 Socket.IO 和 Tunnel
  app.addHook('onClose', async () => {
    TunnelService.stop();
    await closeSocket();
  });

  return app;
}
