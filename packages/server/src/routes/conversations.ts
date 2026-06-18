import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { ConversationService } from '../services/conversation.service.js';
import { ServiceError } from '../errors.js';
import { getSessionManager } from '../core/container.js';

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const createConversationSchema = z.object({
  prompt: z.string().min(1),
  providerId: z.string().min(1),
  variant: z.string().optional(),
  attachmentIds: z.array(z.string().min(1)).optional(),
});

const sendMessageSchema = z.object({
  message: z.string().min(1),
  providerId: z.string().optional(),
  attachmentIds: z.array(z.string().min(1)).optional(),
});

function handleError(error: unknown, reply: any) {
  if (error instanceof ZodError) {
    reply.code(400);
    return {
      error: 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: error.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      })),
    };
  }

  if (error instanceof ServiceError) {
    reply.code(error.statusCode);
    return { error: error.message, code: error.code };
  }

  console.error('[conversations] Unhandled error:', error);
  reply.code(500);
  return { error: 'Internal server error', code: 'INTERNAL_ERROR' };
}

export async function conversationRoutes(app: FastifyInstance) {
  const conversationService = new ConversationService(getSessionManager());

  app.get('/conversations', async (request, reply) => {
    try {
      const query = listQuerySchema.parse(request.query);
      return await conversationService.list(query.limit);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post('/conversations', async (request, reply) => {
    try {
      const body = createConversationSchema.parse(request.body);
      const conversation = await conversationService.create(body);
      reply.code(201);
      return conversation;
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get<{ Params: { id: string } }>('/conversations/:id', async (request, reply) => {
    try {
      const conversation = await conversationService.findById(request.params.id);
      if (!conversation) {
        reply.code(404);
        return { error: 'Conversation not found', code: 'NOT_FOUND' };
      }
      return conversation;
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post<{ Params: { id: string } }>('/conversations/:id/message', async (request, reply) => {
    try {
      const body = sendMessageSchema.parse(request.body);
      return await conversationService.sendMessage(request.params.id, body);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.post<{ Params: { id: string } }>('/conversations/:id/stop', async (request, reply) => {
    try {
      return await conversationService.stop(request.params.id);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.delete<{ Params: { id: string } }>('/conversations/:id', async (request, reply) => {
    try {
      await conversationService.delete(request.params.id);
      reply.code(204);
      return;
    } catch (error) {
      return handleError(error, reply);
    }
  });
}
