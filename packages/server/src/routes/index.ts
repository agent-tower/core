import type { FastifyInstance } from 'fastify';
import { projectRoutes } from './projects.js';
import { taskRoutes } from './tasks.js';
import { workspaceRoutes } from './workspaces.js';
import { sessionRoutes } from './sessions.js';
import { systemRoutes } from './system.js';
import { demoRoutes } from './demo.js';
import { filesystemRoutes } from './filesystem.js';
import { filesRoutes } from './files.js';
import { gitRoutes } from './git.js';
import { profileRoutes } from './profiles.js';
import { providerRoutes } from './providers.js';
import { terminalRoutes } from './terminals.js';
import { tunnelRoutes } from './tunnel.js';
import { attachmentRoutes } from './attachments.js';
import { appSettingsRoutes } from './app-settings.js';
import { notificationRoutes } from './notifications.js';

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

  // Git 变更查看路由
  await app.register(gitRoutes, { prefix: '/api/git' });

  // Profile 配置路由 (deprecated)
  await app.register(profileRoutes, { prefix: '/api' });

  // Provider 配置路由
  await app.register(providerRoutes, { prefix: '/api' });

  // Standalone terminal 路由
  await app.register(terminalRoutes, { prefix: '/api' });

  // Tunnel 路由
  await app.register(tunnelRoutes, { prefix: '/api' });

  // 附件路由
  await app.register(attachmentRoutes, { prefix: '/api/attachments' });

  // 应用设置路由
  await app.register(appSettingsRoutes, { prefix: '/api' });

  // 通知配置路由
  await app.register(notificationRoutes, { prefix: '/api' });
}
