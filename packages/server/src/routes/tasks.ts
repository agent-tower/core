import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import { TaskService } from '../services/task.service.js';
import { TaskStatus } from '../types/index.js';
import { TaskPriority, TASK_HANDOFF_MAX_LENGTH } from '@agent-tower/shared';
import { TaskHandoffService, type TaskHandoffCaller } from '../services/task-handoff.service.js';
import { requireTranslationOwner } from './translations.js';
import { ServiceError } from '../errors.js';
import {
  getEventBus,
  getSessionManager,
  getTaskCleanupService,
  getWorkspaceBackgroundService,
} from '../core/container.js';

const createTaskSchema = z.object({
  parentTaskId: z.string().uuid().optional(),
  title: z.string().min(1, 'title is required').refine((value) => value.trim().length > 0, 'title is required'),
  description: z.string().optional(),
  baseBranch: z.string().trim().min(1).nullable().optional(),
  priority: z.nativeEnum(TaskPriority).default(TaskPriority.NORMAL),
});

const updateTaskSchema = z.object({
  title: z.string().min(1, 'title cannot be empty').refine((value) => value.trim().length > 0, 'title cannot be empty').optional(),
  description: z.string().optional(),
  priority: z.nativeEnum(TaskPriority).optional(),
});

const updateHandoffSchema = z.object({
  oldString: z.string().max(TASK_HANDOFF_MAX_LENGTH),
  newString: z.string().max(TASK_HANDOFF_MAX_LENGTH),
}).strict();

async function handoffCaller(request: FastifyRequest): Promise<TaskHandoffCaller> {
  if (request.agentTowerAuthKind === 'agent' && request.agentTowerAgentIdentity) {
    return { kind: 'agent', ...request.agentTowerAgentIdentity };
  }
  // The shared owner guard also handles password-disabled browsers and CSRF.
  await requireTranslationOwner(request);
  return { kind: request.agentTowerAuthKind === 'internal' ? 'internal' : 'browser' };
}

const updateStatusSchema = z.object({
  status: z.nativeEnum(TaskStatus, {
    errorMap: () => ({
      message: `status must be one of: ${Object.values(TaskStatus).join(', ')}`,
    }),
  }),
});

const updatePositionSchema = z.object({
  position: z.number().int().min(0, 'position must be non-negative'),
  status: z.nativeEnum(TaskStatus).optional(),
});

const taskListQuerySchema = z.object({
  status: z.nativeEnum(TaskStatus).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

const taskBoardQuerySchema = taskListQuerySchema.extend({
  projectId: z.string().uuid().optional(),
}).extend({
  limit: z.coerce.number().int().min(1).max(1000).default(1000),
});

/**
 * 统一错误处理：将 ServiceError / ZodError 转为结构化响应
 */
function handleError(error: unknown, reply: any) {
  if (error instanceof ZodError) {
    const fieldErrors = error.errors.map((e) => ({
      field: e.path.join('.'),
      message: e.message,
    }));
    reply.code(400);
    return { error: 'Validation failed', code: 'VALIDATION_ERROR', details: fieldErrors };
  }

  if (error instanceof ServiceError) {
    reply.code(error.statusCode);
    return { error: error.message, code: error.code };
  }

  console.error('[tasks] Unhandled error:', error);
  reply.code(500);
  return { error: 'Internal server error', code: 'INTERNAL_ERROR' };
}

export async function taskRoutes(app: FastifyInstance) {
  const handoffService = new TaskHandoffService(getEventBus());
  const taskService = new TaskService(
    getEventBus(),
    getSessionManager(),
    getTaskCleanupService(),
    getWorkspaceBackgroundService(),
  );

  app.get('/task-board', async (request, reply) => {
    try {
      const query = taskBoardQuerySchema.parse(request.query);
      return await taskService.findBoard(query);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  // 获取项目的任务列表（支持分页和状态过滤）
  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/tasks',
    async (request, reply) => {
      try {
        const query = taskListQuerySchema.parse(request.query);
        return await taskService.findByProjectId(request.params.projectId, query);
      } catch (error) {
        return handleError(error, reply);
      }
    }
  );

  // 创建任务
  app.post<{ Params: { projectId: string } }>(
    '/projects/:projectId/tasks',
    async (request, reply) => {
      try {
        const body = createTaskSchema.parse(request.body);
        const task = await taskService.create(request.params.projectId, body);
        reply.code(201);
        return task;
      } catch (error) {
        return handleError(error, reply);
      }
    }
  );

  // 获取项目的任务统计
  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/tasks/stats',
    async (request, reply) => {
      try {
        return await taskService.getStatsByProjectId(request.params.projectId);
      } catch (error) {
        return handleError(error, reply);
      }
    }
  );

  // 获取任务详情
  app.get<{ Params: { id: string } }>('/tasks/:id', async (request, reply) => {
    try {
      return await taskService.findById(request.params.id);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get<{ Params: { id: string } }>('/tasks/:id/body', async (request, reply) => {
    try {
      return await taskService.findBodyById(request.params.id);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get<{ Params: { id: string } }>('/tasks/:id/handoff', async (request, reply) => {
    try { return await handoffService.get(request.params.id, await handoffCaller(request)); }
    catch (error) { return handleError(error, reply); }
  });

  app.patch<{ Params: { id: string } }>('/tasks/:id/handoff', async (request, reply) => {
    try { return await handoffService.update(request.params.id, updateHandoffSchema.parse(request.body), await handoffCaller(request)); }
    catch (error) { return handleError(error, reply); }
  });

  app.get<{ Params: { id: string } }>('/tasks/:id/subtasks', async (request, reply) => {
    try {
      return await taskService.findSubtasks(request.params.id, taskListQuerySchema.parse(request.query));
    } catch (error) { return handleError(error, reply); }
  });

  app.get<{ Params: { id: string } }>('/tasks/:id/cleanup', async (request, reply) => {
    try { return await taskService.getCleanupStatus(request.params.id); }
    catch (error) { return handleError(error, reply); }
  });

  app.post<{ Params: { id: string } }>('/tasks/:id/cleanup/retry', async (request, reply) => {
    try { return await taskService.retryCleanup(request.params.id); }
    catch (error) { return handleError(error, reply); }
  });

  // 更新任务
  app.put<{ Params: { id: string } }>('/tasks/:id', async (request, reply) => {
    try {
      const body = updateTaskSchema.parse(request.body);
      return await taskService.update(request.params.id, body);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  // 更新任务状态（含状态流转校验）
  app.patch<{ Params: { id: string } }>(
    '/tasks/:id/status',
    async (request, reply) => {
      try {
        const body = updateStatusSchema.parse(request.body);
        return await taskService.updateStatus(request.params.id, body.status);
      } catch (error) {
        return handleError(error, reply);
      }
    }
  );

  // 更新任务位置
  app.patch<{ Params: { id: string } }>(
    '/tasks/:id/position',
    async (request, reply) => {
      try {
        const body = updatePositionSchema.parse(request.body);
        return await taskService.updatePosition(
          request.params.id,
          body.position,
          body.status
        );
      } catch (error) {
        return handleError(error, reply);
      }
    }
  );

  // 删除任务
  app.delete<{ Params: { id: string } }>(
    '/tasks/:id',
    async (request, reply) => {
      try {
        const query = z.object({ expectedSubtaskCount: z.coerce.number().int().min(0).optional() }).parse(request.query);
        await taskService.delete(request.params.id, query.expectedSubtaskCount);
        reply.code(204);
        return;
      } catch (error) {
        return handleError(error, reply);
      }
    }
  );

  // 重试任务（归档当前 Workspace，重置状态为 TODO）
  app.post<{ Params: { id: string } }>(
    '/tasks/:id/retry',
    async (request, reply) => {
      try {
        return await taskService.retry(request.params.id);
      } catch (error) {
        return handleError(error, reply);
      }
    }
  );
}
