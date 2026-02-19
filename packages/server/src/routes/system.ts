import type { FastifyInstance } from 'fastify';
import { AgentType } from '../types/index.js';
import { prisma } from '../utils/index.js';

export async function systemRoutes(app: FastifyInstance) {
  // 健康检查
  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  // 获取可用的 AI 代理列表
  app.get('/agents', async () => {
    return {
      agents: [
        { type: AgentType.CLAUDE_CODE, name: 'Claude Code', available: false },
        { type: AgentType.GEMINI_CLI, name: 'Gemini CLI', available: false },
      ],
    };
  });

  // MCP 上下文检测：根据 cwd 路径查找匹配的活跃工作空间
  app.get('/system/workspace-context', async (request, reply) => {
    const { path: cwdPath } = request.query as { path?: string };
    if (!cwdPath) {
      reply.code(400);
      return { error: 'path query parameter is required' };
    }

    const workspace = await prisma.workspace.findFirst({
      where: { worktreePath: cwdPath, status: 'ACTIVE' },
      include: { task: { include: { project: true } } },
    });

    if (!workspace) {
      reply.code(404);
      return { error: 'No active workspace found for this path' };
    }

    return {
      projectId: workspace.task.project.id,
      projectName: workspace.task.project.name,
      taskId: workspace.task.id,
      taskTitle: workspace.task.title,
      workspaceId: workspace.id,
      workspaceBranch: workspace.branchName,
    };
  });
}
