import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { WorkspaceService } from '../services/workspace.service.js';

const createWorkspaceSchema = z.object({
  branchName: z.string().min(1).optional(),
});

export async function workspaceRoutes(app: FastifyInstance) {
  const workspaceService = new WorkspaceService();

  // 创建工作空间
  app.post<{ Params: { taskId: string } }>(
    '/tasks/:taskId/workspaces',
    async (request, reply) => {
      const body = createWorkspaceSchema.parse(request.body || {});
      const workspace = await workspaceService.create(
        request.params.taskId,
        body.branchName
      );
      reply.code(201);
      return workspace;
    }
  );

  // 获取工作空间详情
  app.get<{ Params: { id: string } }>(
    '/workspaces/:id',
    async (request, reply) => {
      const workspace = await workspaceService.findById(request.params.id);
      if (!workspace) {
        reply.code(404);
        return { error: 'Workspace not found' };
      }
      return workspace;
    }
  );

  // 获取工作空间的 diff
  app.get<{ Params: { id: string } }>(
    '/workspaces/:id/diff',
    async (request, reply) => {
      const diff = await workspaceService.getDiff(request.params.id);
      if (diff === null) {
        reply.code(404);
        return { error: 'Workspace not found' };
      }
      return { diff };
    }
  );

  // 合并工作空间到主分支
  app.post<{ Params: { id: string } }>(
    '/workspaces/:id/merge',
    async (request, reply) => {
      const result = await workspaceService.merge(request.params.id);
      if (!result) {
        reply.code(404);
        return { error: 'Workspace not found' };
      }
      return { success: true };
    }
  );

  // 删除工作空间
  app.delete<{ Params: { id: string } }>(
    '/workspaces/:id',
    async (request, reply) => {
      const deleted = await workspaceService.delete(request.params.id);
      if (!deleted) {
        reply.code(404);
        return { error: 'Workspace not found' };
      }
      reply.code(204);
      return;
    }
  );
}
