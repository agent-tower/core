import type { FastifyInstance } from 'fastify';
import { projectRoutes } from './projects.js';
import { taskRoutes } from './tasks.js';
import { workspaceRoutes } from './workspaces.js';
import { sessionRoutes } from './sessions.js';
import { systemRoutes } from './system.js';

export async function registerRoutes(app: FastifyInstance) {
  // 系统路由
  await app.register(systemRoutes, { prefix: '/api' });

  // 项目路由
  await app.register(projectRoutes, { prefix: '/api/projects' });

  // 任务路由
  await app.register(taskRoutes, { prefix: '/api' });

  // 工作空间路由
  await app.register(workspaceRoutes, { prefix: '/api' });

  // 会话路由
  await app.register(sessionRoutes, { prefix: '/api' });
}
