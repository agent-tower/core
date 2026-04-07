import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSessionManager } from '../core/container.js';
import { AgentType } from '../types/index.js';
import { sessionMsgStoreManager } from '../output/index.js';
import { prisma } from '../utils/index.js';
import { getProviderById } from '../executors/index.js';

function buildProjectReadOnlyError(project: {
  name: string;
  archivedAt: Date | null;
  repoDeletedAt: Date | null;
}) {
  if (!project.archivedAt) return null;

  if (project.repoDeletedAt) {
    return {
      error: `Project "${project.name}" is archived and its local repository files were deleted. Restore it with a valid repoPath before continuing.`,
      code: 'PROJECT_ARCHIVED',
    };
  }

  return {
    error: `Project "${project.name}" is archived. Restore it before continuing.`,
    code: 'PROJECT_ARCHIVED',
  };
}

/**
 * Parse tokenUsage JSON string on a session object (or nested sessions).
 * Mutates in-place for convenience; returns the same reference.
 */
export function parseSessionTokenUsage<T extends { tokenUsage?: string | null }>(session: T): T & { tokenUsage?: Record<string, unknown> | null } {
  if (typeof session.tokenUsage === 'string') {
    try {
      (session as Record<string, unknown>).tokenUsage = JSON.parse(session.tokenUsage);
    } catch {
      (session as Record<string, unknown>).tokenUsage = null;
    }
  }
  return session as T & { tokenUsage?: Record<string, unknown> | null };
}

const createSessionSchema = z.object({
  agentType: z.nativeEnum(AgentType).optional(),
  prompt: z.string().min(1),
  variant: z.string().optional(),
  providerId: z.string().optional(),
});

const sendMessageSchema = z.object({
  message: z.string().min(1),
  providerId: z.string().optional(),
});

export async function sessionRoutes(app: FastifyInstance) {
  const sessionService = getSessionManager();

  // 创建会话
  app.post<{ Params: { workspaceId: string } }>(
    '/workspaces/:workspaceId/sessions',
    async (request, reply) => {
      const body = createSessionSchema.parse(request.body);
      const workspace = await prisma.workspace.findUnique({
        where: { id: request.params.workspaceId },
        include: { task: { include: { project: true } } },
      });
      if (!workspace) {
        reply.code(404);
        return { error: 'Workspace not found', code: 'NOT_FOUND' };
      }

      const projectError = buildProjectReadOnlyError(workspace.task.project);
      if (projectError) {
        reply.code(400);
        return projectError;
      }

      // 如果提供了 providerId，从 provider 推导 agentType
      let agentType: AgentType;
      if (body.providerId) {
        const provider = getProviderById(body.providerId);
        if (!provider) {
          reply.code(400);
          return { error: `Provider not found: ${body.providerId}` };
        }
        agentType = provider.agentType as AgentType;
      } else if (body.agentType) {
        agentType = body.agentType;
      } else {
        reply.code(400);
        return { error: 'Either agentType or providerId must be provided' };
      }

      const session = await sessionService.create(
        request.params.workspaceId,
        agentType,
        body.prompt,
        body.variant,
        body.providerId
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
      return parseSessionTokenUsage(session);
    }
  );

  // 启动会话
  app.post<{ Params: { id: string } }>(
    '/sessions/:id/start',
    async (request, reply) => {
      const existing = await prisma.session.findUnique({
        where: { id: request.params.id },
        include: { workspace: { include: { task: { include: { project: true } } } } },
      });
      if (!existing) {
        reply.code(404);
        return { error: 'Session not found' };
      }

      const projectError = buildProjectReadOnlyError(existing.workspace.task.project);
      if (projectError) {
        reply.code(400);
        return projectError;
      }

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

  // 发送消息（统一入口 — 无论 session 是 RUNNING 还是 COMPLETED/CANCELLED）
  app.post<{ Params: { id: string } }>(
    '/sessions/:id/message',
    async (request, reply) => {
      const body = sendMessageSchema.parse(request.body);
      try {
        const existing = await prisma.session.findUnique({
          where: { id: request.params.id },
          include: { workspace: { include: { task: { include: { project: true } } } } },
        });
        if (!existing) {
          reply.code(404);
          return { error: 'Session not found' };
        }

        const projectError = buildProjectReadOnlyError(existing.workspace.task.project);
        if (projectError) {
          reply.code(400);
          return projectError;
        }

        const result = await sessionService.sendMessage(
          request.params.id,
          body.message,
          body.providerId
        );
        if (!result) {
          reply.code(404);
          return { error: 'Session not found' };
        }
        return { success: true };
      } catch (error) {
        console.error(`[sessions] sendMessage failed for session ${request.params.id}:`, error);
        reply.code(500);
        return { error: error instanceof Error ? error.message : 'Failed to send message' };
      }
    }
  );

  // 获取会话日志快照
  app.get<{ Params: { id: string } }>(
    '/sessions/:id/logs',
    async (request, reply) => {
      const { id } = request.params;

      // 检查 session 是否存在
      const session = await prisma.session.findUnique({ where: { id } });
      if (!session) {
        reply.code(404);
        return { error: 'Session not found' };
      }

      // 优先从内存 MsgStore 读取（运行中或刚结束的 session）
      const msgStore = sessionMsgStoreManager.get(id);
      if (msgStore) {
        return msgStore.getSnapshot();
      }

      // 从数据库读取持久化的日志快照
      if (session.logSnapshot) {
        try {
          return JSON.parse(session.logSnapshot);
        } catch {
          return { entries: [] };
        }
      }

      // MsgStore 不存在且无持久化数据，返回空快照
      return { entries: [] };
    }
  );
}
