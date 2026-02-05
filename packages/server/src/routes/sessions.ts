import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SessionService } from '../services/session.service.js';
import { AgentType } from '../types/index.js';

const createSessionSchema = z.object({
  agentType: z.nativeEnum(AgentType),
  prompt: z.string().min(1),
});

const sendMessageSchema = z.object({
  message: z.string().min(1),
});

export async function sessionRoutes(app: FastifyInstance) {
  const sessionService = new SessionService();

  // 创建会话
  app.post<{ Params: { workspaceId: string } }>(
    '/workspaces/:workspaceId/sessions',
    async (request, reply) => {
      const body = createSessionSchema.parse(request.body);
      const session = await sessionService.create(
        request.params.workspaceId,
        body.agentType,
        body.prompt
      );
      reply.code(201);
      return session;
    }
  );

  // 获取会话详情
  app.get<{ Params: { id: string } }>(
    '/sessions/:id',
    async (request, reply) => {
      const session = await sessionService.findById(request.params.id);
      if (!session) {
        reply.code(404);
        return { error: 'Session not found' };
      }
      return session;
    }
  );

  // 启动会话
  app.post<{ Params: { id: string } }>(
    '/sessions/:id/start',
    async (request, reply) => {
      const result = await sessionService.start(request.params.id);
      if (!result) {
        reply.code(404);
        return { error: 'Session not found' };
      }
      return { success: true };
    }
  );

  // 停止会话
  app.post<{ Params: { id: string } }>(
    '/sessions/:id/stop',
    async (request, reply) => {
      const result = await sessionService.stop(request.params.id);
      if (!result) {
        reply.code(404);
        return { error: 'Session not found' };
      }
      return { success: true };
    }
  );

  // 发送后续消息
  app.post<{ Params: { id: string } }>(
    '/sessions/:id/message',
    async (request, reply) => {
      const body = sendMessageSchema.parse(request.body);
      const result = await sessionService.sendMessage(
        request.params.id,
        body.message
      );
      if (!result) {
        reply.code(404);
        return { error: 'Session not found' };
      }
      return { success: true };
    }
  );
}
