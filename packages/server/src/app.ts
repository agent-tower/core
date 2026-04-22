import Fastify from 'fastify';
import fastifyCookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerRoutes } from './routes/index.js';
import { initializeSocket, closeSocket } from './socket/index.js';
import { WorkspaceService } from './services/workspace.service.js';
import { HibernationScheduler } from './services/hibernation-scheduler.js';
import { TunnelService } from './services/tunnel.service.js';
import { tunnelAuthHook } from './middleware/tunnel-auth.js';

let hibernationScheduler: HibernationScheduler | null = null;

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

  await app.register(fastifyCookie);

  await app.register(multipart, {
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  });

  // 隧道 token 认证钩子（仅拦截经 Cloudflare 隧道的请求）
  app.addHook('onRequest', tunnelAuthHook);

  // 注册路由
  await registerRoutes(app);

  // 显式指定前端构建目录时，托管静态文件
  if (process.env.AGENT_TOWER_WEB_DIR) {
    const webDistPath = path.resolve(
      __dirname,
      process.env.AGENT_TOWER_WEB_DIR,
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

    // 启动空闲 workspace 自动休眠调度器
    hibernationScheduler = new HibernationScheduler();
    hibernationScheduler.start();
  });

  // 服务器关闭时清理 Socket.IO、Tunnel 和 HibernationScheduler
  app.addHook('onClose', async () => {
    hibernationScheduler?.stop();
    TunnelService.stop();
    await closeSocket();
  });

  return app;
}
