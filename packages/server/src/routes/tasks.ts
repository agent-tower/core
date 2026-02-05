import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TaskService } from '../services/task.service.js';
import { TaskStatus } from '../types/index.js';

const createTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  priority: z.number().default(0),
});

const updateTaskSchema = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  priority: z.number().optional(),
});

const updateStatusSchema = z.object({
  status: z.nativeEnum(TaskStatus),
});

const updatePositionSchema = z.object({
  position: z.number(),
  status: z.nativeEnum(TaskStatus).optional(),
});

export async function taskRoutes(app: FastifyInstance) {
  const taskService = new TaskService();

  // 获取项目的任务列表
  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/tasks',
    async (request) => {
      return taskService.findByProjectId(request.params.projectId);
    }
  );

  // 创建任务
  app.post<{ Params: { projectId: string } }>(
    '/projects/:projectId/tasks',
    async (request, reply) => {
      const body = createTaskSchema.parse(request.body);
      const task = await taskService.create(request.params.projectId, body);
      reply.code(201);
      return task;
    }
  );

  // 获取任务详情
  app.get<{ Params: { id: string } }>('/tasks/:id', async (request, reply) => {
    const task = await taskService.findById(request.params.id);
    if (!task) {
      reply.code(404);
      return { error: 'Task not found' };
    }
    return task;
  });

  // 更新任务
  app.put<{ Params: { id: string } }>('/tasks/:id', async (request, reply) => {
    const body = updateTaskSchema.parse(request.body);
    const task = await taskService.update(request.params.id, body);
    if (!task) {
      reply.code(404);
      return { error: 'Task not found' };
    }
    return task;
  });

  // 更新任务状态
  app.patch<{ Params: { id: string } }>(
    '/tasks/:id/status',
    async (request, reply) => {
      const body = updateStatusSchema.parse(request.body);
      const task = await taskService.updateStatus(request.params.id, body.status);
      if (!task) {
        reply.code(404);
        return { error: 'Task not found' };
      }
      return task;
    }
  );

  // 更新任务位置
  app.patch<{ Params: { id: string } }>(
    '/tasks/:id/position',
    async (request, reply) => {
      const body = updatePositionSchema.parse(request.body);
      const task = await taskService.updatePosition(
        request.params.id,
        body.position,
        body.status
      );
      if (!task) {
        reply.code(404);
        return { error: 'Task not found' };
      }
      return task;
    }
  );

  // 删除任务
  app.delete<{ Params: { id: string } }>(
    '/tasks/:id',
    async (request, reply) => {
      const deleted = await taskService.delete(request.params.id);
      if (!deleted) {
        reply.code(404);
        return { error: 'Task not found' };
      }
      reply.code(204);
      return;
    }
  );
}
