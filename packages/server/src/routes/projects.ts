import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { ProjectService } from '../services/project.service.js';
import { ServiceError } from '../errors.js';
import { GitError } from '../git/git-cli.js';

const createProjectSchema = z.object({
  name: z.string().min(1, 'name is required'),
  description: z.string().optional(),
  repoPath: z.string().min(1, 'repoPath is required'),
  mainBranch: z.string().default('main'),
  copyFiles: z.string().optional(),
  setupScript: z.string().optional(),
  quickCommands: z.string().optional(),
});

const updateProjectSchema = z.object({
  name: z.string().min(1, 'name cannot be empty').optional(),
  description: z.string().optional(),
  mainBranch: z.string().optional(),
  copyFiles: z.string().nullable().optional(),
  setupScript: z.string().nullable().optional(),
  quickCommands: z.string().nullable().optional(),
});

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  includeArchived: z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .optional()
    .transform((value) => value === true || value === 'true'),
});

const archiveProjectSchema = z.object({
  deleteRepo: z.boolean().optional().default(false),
});

const restoreProjectSchema = z.object({
  repoPath: z.string().min(1).optional(),
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

  if (error instanceof GitError) {
    reply.code(400);
    return { error: error.message, code: error.code };
  }

  console.error('[projects] Unhandled error:', error);
  reply.code(500);
  return { error: 'Internal server error', code: 'INTERNAL_ERROR' };
}

export async function projectRoutes(app: FastifyInstance) {
  const projectService = new ProjectService();

  // 获取项目列表（支持分页）
  app.get('/', async (request, reply) => {
    try {
      const query = paginationSchema.parse(request.query);
      return await projectService.findAll(query);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  // 创建项目
  app.post('/', async (request, reply) => {
    try {
      const body = createProjectSchema.parse(request.body);
      const project = await projectService.create(body);
      reply.code(201);
      return project;
    } catch (error) {
      return handleError(error, reply);
    }
  });

  // 获取项目详情（含任务统计）
  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    try {
      return await projectService.findById(request.params.id);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  // 更新项目
  app.put<{ Params: { id: string } }>('/:id', async (request, reply) => {
    try {
      const body = updateProjectSchema.parse(request.body);
      return await projectService.update(request.params.id, body);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  // 归档项目（软删除）
  app.post<{ Params: { id: string } }>('/:id/archive', async (request, reply) => {
    try {
      const body = archiveProjectSchema.parse(request.body ?? {});
      return await projectService.archive(request.params.id, body);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  // 恢复项目
  app.post<{ Params: { id: string } }>('/:id/restore', async (request, reply) => {
    try {
      const body = restoreProjectSchema.parse(request.body ?? {});
      return await projectService.restore(request.params.id, body);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  // 删除项目（兼容旧语义，实际执行归档）
  app.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    try {
      await projectService.delete(request.params.id);
      reply.code(204);
      return;
    } catch (error) {
      return handleError(error, reply);
    }
  });
}
