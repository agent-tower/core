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
import { getTaskCleanupService, getWorkspaceGitWatcherService } from './core/container.js';
import { tunnelAuthHook } from './middleware/tunnel-auth.js';
import { accessAuthHook } from './middleware/access-auth.js';
import { writeErrorLog } from './utils/error-log.js';

let hibernationScheduler: HibernationScheduler | null = null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
    bodyLimit: 10 * 1024 * 1024,
  });

  app.addHook('onError', async (request, _reply, error) => {
    writeErrorLog({
      level: 'error',
      source: 'server.fastify.onError',
      message: error.message,
      error,
      metadata: {
        method: request.method,
        url: request.url,
      },
    });
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

  // 访问密码认证钩子（启用后保护浏览器业务入口）
  app.addHook('onRequest', accessAuthHook);

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
    const readyStartedAt = Date.now();
    const elapsed = () => `${Date.now() - readyStartedAt}ms`;

    app.log.info(`[startup:onReady] enter elapsed=${elapsed()}`);
    app.log.info(`[startup:onReady] initializeSocket start elapsed=${elapsed()}`);
    await initializeSocket(app);
    app.log.info(`[startup:onReady] initializeSocket done elapsed=${elapsed()}`);

    // 启动时清理过期 worktree 引用
    app.log.info(`[startup:onReady] pruneAllWorktrees schedule start elapsed=${elapsed()}`);
    WorkspaceService.pruneAllWorktrees().catch((err) => {
      app.log.warn(`Worktree prune on startup failed: ${err instanceof Error ? err.message : err}`);
    });
    app.log.info(`[startup:onReady] pruneAllWorktrees scheduled elapsed=${elapsed()}`);

    // 启动空闲 workspace 自动休眠调度器
    app.log.info(`[startup:onReady] hibernationScheduler start elapsed=${elapsed()}`);
    hibernationScheduler = new HibernationScheduler();
    hibernationScheduler.start();
    app.log.info(`[startup:onReady] hibernationScheduler started elapsed=${elapsed()}`);

    // 启动任务删除后台资源清理 worker
    app.log.info(`[startup:onReady] taskCleanupService start elapsed=${elapsed()}`);
    getTaskCleanupService().start();
    app.log.info(`[startup:onReady] taskCleanupService started elapsed=${elapsed()}`);

    // 启动 workspace git 变化监听，补齐外部终端/IDE 手动 git 操作的实时刷新链路。
    // 全量 watcher 初始化会扫描所有 ACTIVE worktree，不能阻塞 Fastify ready/listen。
    app.log.info(`[startup:onReady] workspaceGitWatcher start scheduled elapsed=${elapsed()}`);
    void getWorkspaceGitWatcherService().start().catch((err) => {
      app.log.warn(`Workspace git watcher startup failed: ${err instanceof Error ? err.message : err}`);
    });
    app.log.info(`[startup:onReady] complete elapsed=${elapsed()}`);
  });

  // 服务器关闭时清理 Socket.IO、Tunnel、HibernationScheduler 和 watcher
  app.addHook('onClose', async () => {
    hibernationScheduler?.stop();
    getTaskCleanupService().stop();
    getWorkspaceGitWatcherService().stop();
    TunnelService.stop();
    await closeSocket();
  });

  return app;
}
