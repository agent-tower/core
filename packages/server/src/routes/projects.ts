import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ProjectService } from '../services/project.service.js';

const createProjectSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  repoPath: z.string().min(1),
  mainBranch: z.string().default('main'),
});

const updateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  mainBranch: z.string().optional(),
});

export async function projectRoutes(app: FastifyInstance) {
  const projectService = new ProjectService();

  // 获取项目列表
  app.get('/', async () => {
    return projectService.findAll();
  });

  // 创建项目
  app.post('/', async (request, reply) => {
    const body = createProjectSchema.parse(request.body);
    const project = await projectService.create(body);
    reply.code(201);
    return project;
  });

  // 获取项目详情
  app.get<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const project = await projectService.findById(request.params.id);
    if (!project) {
      reply.code(404);
      return { error: 'Project not found' };
    }
    return project;
  });

  // 更新项目
  app.put<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const body = updateProjectSchema.parse(request.body);
    const project = await projectService.update(request.params.id, body);
    if (!project) {
      reply.code(404);
      return { error: 'Project not found' };
    }
    return project;
  });

  // 删除项目
  app.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const deleted = await projectService.delete(request.params.id);
    if (!deleted) {
      reply.code(404);
      return { error: 'Project not found' };
    }
    reply.code(204);
    return;
  });
}
