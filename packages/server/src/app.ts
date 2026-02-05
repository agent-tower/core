import Fastify from 'fastify';
import cors from '@fastify/cors';
import { registerRoutes } from './routes/index.js';
import { initializeSocket, closeSocket } from './socket/index.js';

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

  // 注册路由
  await registerRoutes(app);

  // 服务器启动后初始化 Socket.IO
  app.addHook('onReady', async () => {
    initializeSocket(app);
  });

  // 服务器关闭时清理 Socket.IO
  app.addHook('onClose', async () => {
    await closeSocket();
  });

  return app;
}
