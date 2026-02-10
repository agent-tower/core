import type { FastifyInstance } from 'fastify';
import { projectRoutes } from './projects.js';
import { taskRoutes } from './tasks.js';
import { workspaceRoutes } from './workspaces.js';
import { sessionRoutes } from './sessions.js';
import { systemRoutes } from './system.js';
import { demoRoutes } from './demo.js';
import { filesystemRoutes } from './filesystem.js';
import { filesRoutes } from './files.js';

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

  // Demo 路由 (MVP)
  await app.register(demoRoutes, { prefix: '/api' });

  // 文件系统浏览路由
  await app.register(filesystemRoutes, { prefix: '/api/filesystem' });

  // Editor Tab 文件读写路由
  await app.register(filesRoutes, { prefix: '/api/files' });
}
