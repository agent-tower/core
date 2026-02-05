import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { registerRoutes } from './routes/index.js';

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

  await app.register(websocket);

  // 注册路由
  await registerRoutes(app);

  return app;
}
