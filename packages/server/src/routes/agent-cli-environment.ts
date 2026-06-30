import type { FastifyInstance, FastifyReply } from 'fastify';
import { z, ZodError } from 'zod';
import { ServiceError } from '../errors.js';
import { getAgentCliEnvironmentService } from '../core/container.js';
import { agentCliLocalOnlyHook } from '../middleware/agent-cli-local-only.js';

const toolIdSchema = z.enum(['codex', 'claude-code', 'cursor-agent', 'gemini-cli']);

const createPreviewSchema = z.object({
  toolId: toolIdSchema,
}).strict();

const createTaskSchema = z.object({
  previewId: z.string().min(1),
}).strict();

const logsQuerySchema = z.object({
  afterSeq: z.coerce.number().int().min(0).default(0),
});

function handleError(error: unknown, reply: FastifyReply) {
  if (error instanceof ZodError) {
    reply.code(400);
    return { error: 'Validation failed', code: 'VALIDATION_ERROR', details: error.errors };
  }

  if (error instanceof ServiceError) {
    reply.code(error.statusCode);
    return { error: error.message, code: error.code };
  }

  console.error('[agent-cli] Unhandled error:', error);
  reply.code(500);
  return { error: 'Internal server error', code: 'INTERNAL_ERROR' };
}

export async function agentCliEnvironmentRoutes(app: FastifyInstance) {
  const service = getAgentCliEnvironmentService();

  app.get('/agent-cli/manifest', async () => service.getManifest());

  app.get('/agent-cli/status', async () => service.getStatus());

  app.post(
    '/agent-cli/status/refresh',
    { preHandler: agentCliLocalOnlyHook },
    async (_request, reply) => {
      try {
        return await service.refreshStatus();
      } catch (error) {
        return handleError(error, reply);
      }
    }
  );

  app.post(
    '/agent-cli/install-previews',
    { preHandler: agentCliLocalOnlyHook },
    async (request, reply) => {
      try {
        const body = createPreviewSchema.parse(request.body);
        return await service.createPreview(body.toolId);
      } catch (error) {
        return handleError(error, reply);
      }
    }
  );

  app.get<{ Params: { id: string } }>(
    '/agent-cli/install-previews/:id',
    { preHandler: agentCliLocalOnlyHook },
    async (request, reply) => {
      try {
        return await service.getPreview(request.params.id);
      } catch (error) {
        return handleError(error, reply);
      }
    }
  );

  app.post(
    '/agent-cli/install-tasks',
    { preHandler: agentCliLocalOnlyHook },
    async (request, reply) => {
      try {
        const body = createTaskSchema.parse(request.body);
        return await service.createTask(body.previewId);
      } catch (error) {
        return handleError(error, reply);
      }
    }
  );

  app.get<{ Params: { id: string } }>(
    '/agent-cli/install-tasks/:id',
    { preHandler: agentCliLocalOnlyHook },
    async (request, reply) => {
      try {
        return service.getTask(request.params.id);
      } catch (error) {
        return handleError(error, reply);
      }
    }
  );

  app.get<{ Params: { id: string } }>(
    '/agent-cli/install-tasks/:id/logs',
    { preHandler: agentCliLocalOnlyHook },
    async (request, reply) => {
      try {
        const query = logsQuerySchema.parse(request.query);
        return service.getLogs(request.params.id, query.afterSeq);
      } catch (error) {
        return handleError(error, reply);
      }
    }
  );

  app.post<{ Params: { id: string } }>(
    '/agent-cli/install-tasks/:id/cancel',
    { preHandler: agentCliLocalOnlyHook },
    async (request, reply) => {
      try {
        return service.cancelTask(request.params.id);
      } catch (error) {
        return handleError(error, reply);
      }
    }
  );
}
