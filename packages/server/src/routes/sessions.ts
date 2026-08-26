import type { FastifyInstance } from 'fastify';
import { createReadStream } from 'node:fs';
import { z } from 'zod';
import { getSessionManager } from '../core/container.js';
import { AgentType, SessionContext } from '../types/index.js';
import { sessionMsgStoreManager } from '../output/index.js';
import { prisma } from '../utils/index.js';
import { getProviderById } from '../executors/index.js';
import { RuntimeType } from '@agent-tower/shared';
import { ServiceError } from '../errors.js';
import {
  AgentVisualizationError,
  AgentVisualizationService,
} from '../services/agent-visualization.service.js';
import {
  AgentArtifactError,
  AgentArtifactService,
} from '../services/agent-artifact.service.js';
import { TeamSchedulerService } from '../services/team-scheduler.service.js';
import { INTERNAL_API_INVOCATION_ID_HEADER } from '../utils/internal-api-token.js';

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

const resolvePermissionSchema = z.object({
  optionId: z.string().min(1).max(512),
});

const visualizationParamsSchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1).max(255),
});

const artifactDownloadParamsSchema = z.object({
  id: z.string().min(1),
});

const artifactDownloadQuerySchema = z.object({
  path: z.string().min(1).max(1024),
});

const VISUALIZATION_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://esm.sh https://cdn.jsdelivr.net https://unpkg.com",
  "style-src 'unsafe-inline' https://fonts.googleapis.com https://fonts.bunny.net",
  "font-src data: https://fonts.gstatic.com https://fonts.bunny.net",
  "img-src data: blob: https://cdnjs.cloudflare.com https://esm.sh https://cdn.jsdelivr.net https://unpkg.com",
  "media-src data: blob:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "frame-ancestors 'self'",
  'sandbox allow-scripts',
].join('; ');

function isConversationSession(session: { context?: string | null; conversationId?: string | null }) {
  return session.context === SessionContext.CONVERSATION || Boolean(session.conversationId);
}

function contentDispositionAttachment(fileName: string): string {
  const fallback = fileName
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_')
    || 'download';
  const encoded = encodeURIComponent(fileName).replace(/[!'()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function validateWorkspaceBackedSession(existing: {
  context?: string | null;
  conversationId?: string | null;
  workspace?: {
    task: {
      deletedAt?: Date | null;
      project: { name: string; archivedAt: Date | null; repoDeletedAt: Date | null };
    };
  } | null;
}, reply: any): null | Record<string, string> {
  if (isConversationSession(existing)) {
    return null;
  }

  if (!existing.workspace) {
    reply.code(404);
    return { error: 'Workspace not found', code: 'NOT_FOUND' };
  }

  if (existing.workspace.task.deletedAt) {
    reply.code(404);
    return { error: 'Task not found', code: 'NOT_FOUND' };
  }

  const projectError = buildProjectReadOnlyError(existing.workspace.task.project);
  if (projectError) {
    reply.code(400);
    return projectError;
  }

  return null;
}

export async function sessionRoutes(app: FastifyInstance) {
  const sessionService = getSessionManager();
  const visualizationService = new AgentVisualizationService();
  const artifactService = new AgentArtifactService();

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
      if (workspace.task.deletedAt) {
        reply.code(404);
        return { error: 'Task not found', code: 'NOT_FOUND' };
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

      try {
        const session = await sessionService.create(
          request.params.workspaceId,
          agentType,
          body.prompt,
          body.variant,
          body.providerId
        );
        reply.code(201);
        return session;
      } catch (error) {
        if (error instanceof ServiceError) {
          reply.code(error.statusCode);
          return { error: error.message, code: error.code };
        }
        throw error;
      }
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

  app.get<{ Params: { id: string; file: string } }>(
    '/sessions/:id/visualizations/:file',
    async (request, reply) => {
      const parsedParams = visualizationParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        reply.code(400);
        return { error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsedParams.error.errors };
      }
      try {
        const html = await visualizationService.read(parsedParams.data.id, parsedParams.data.file);
        reply.header('Content-Security-Policy', VISUALIZATION_CSP);
        reply.header('Cache-Control', 'no-store');
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.type('text/html; charset=utf-8');
        return reply.send(html);
      } catch (error) {
        if (error instanceof AgentVisualizationError) {
          reply.code(error.statusCode);
          return { error: error.message, code: error.code };
        }
        throw error;
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { path: string } }>(
    '/sessions/:id/artifacts/download',
    async (request, reply) => {
      const parsedParams = artifactDownloadParamsSchema.safeParse(request.params);
      const parsedQuery = artifactDownloadQuerySchema.safeParse(request.query);
      if (!parsedParams.success || !parsedQuery.success) {
        reply.code(400);
        return {
          error: 'Validation failed',
          code: 'VALIDATION_ERROR',
          details: !parsedParams.success
            ? parsedParams.error.errors
            : !parsedQuery.success
              ? parsedQuery.error.errors
              : [],
        };
      }

      try {
        const artifact = await artifactService.findOrPublish(
          parsedParams.data.id,
          parsedQuery.data.path,
        );
        return reply
          .type(artifact.mimeType)
          .header('Content-Disposition', contentDispositionAttachment(artifact.originalName))
          .header('Content-Length', String(artifact.sizeBytes))
          .header('Cache-Control', 'private, no-store')
          .header('X-Content-Type-Options', 'nosniff')
          .send(createReadStream(artifact.storagePath));
      } catch (error) {
        if (error instanceof AgentArtifactError) {
          reply.code(error.statusCode);
          return { error: error.message, code: error.code };
        }
        throw error;
      }
    },
  );

  // 启动会话
  app.post<{ Params: { id: string } }>(
    '/sessions/:id/start',
    async (request, reply) => {
      const existing = await prisma.session.findUnique({
        where: { id: request.params.id },
        include: {
          workspace: { include: { task: { include: { project: true } } } },
          conversation: true,
        },
      });
      if (!existing) {
        reply.code(404);
        return { error: 'Session not found' };
      }
      const workspaceError = validateWorkspaceBackedSession(existing, reply);
      if (workspaceError) return workspaceError;

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
      const result = await new TeamSchedulerService().stopSession(request.params.id);
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
          include: {
            workspace: { include: { task: { include: { project: true } } } },
            conversation: true,
          },
        });
        if (!existing) {
          reply.code(404);
          return { error: 'Session not found' };
        }
        const workspaceError = validateWorkspaceBackedSession(existing, reply);
        if (workspaceError) return workspaceError;

        const headerInvocationId = request.headers[INTERNAL_API_INVOCATION_ID_HEADER];
        const trustedInvocationId = request.agentTowerAgentIdentity?.invocationId
          ?? (request.agentTowerAuthKind === 'internal' && typeof headerInvocationId === 'string'
            ? headerInvocationId
            : undefined);
        const result = await sessionService.sendMessage(
          request.params.id,
          body.message,
          body.providerId,
          trustedInvocationId,
        );
        if (!result) {
          reply.code(404);
          return { error: 'Session not found' };
        }
        return { success: true };
      } catch (error) {
        console.error(`[sessions] sendMessage failed for session ${request.params.id}:`, error);
        if (error instanceof ServiceError) {
          reply.code(error.statusCode);
          return { error: error.message, code: error.code };
        }
        reply.code(500);
        return { error: error instanceof Error ? error.message : 'Failed to send message' };
      }
    }
  );

  // Runtime state is authoritative for reconnect recovery. Permission
  // resolvers remain in memory and are never inferred from Socket state.
  app.get<{ Params: { id: string } }>(
    '/sessions/:id/runtime',
    async (request, reply) => {
      const session = await prisma.session.findUnique({
        where: { id: request.params.id },
        select: { id: true, runtimeType: true },
      });
      if (!session) {
        reply.code(404);
        return { error: 'Session not found' };
      }
      const runtimeType = session.runtimeType === RuntimeType.ACP ? RuntimeType.ACP : RuntimeType.CLI;
      return sessionService.getRuntimeState(session.id, runtimeType);
    },
  );

  app.post<{ Params: { id: string; requestId: string } }>(
    '/sessions/:id/permissions/:requestId/resolve',
    async (request, reply) => {
      const body = resolvePermissionSchema.parse(request.body);
      const session = await prisma.session.findUnique({
        where: { id: request.params.id },
        select: { id: true },
      });
      if (!session) {
        reply.code(404);
        return { error: 'Session not found' };
      }
      try {
        await sessionService.resolveRuntimePermission(
          session.id,
          request.params.requestId,
          body.optionId,
        );
        return { success: true };
      } catch (error) {
        reply.code(409);
        return { error: error instanceof Error ? error.message : 'Permission request is no longer active' };
      }
    },
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
          const parsed = JSON.parse(session.logSnapshot);
          // Terminal sessions: no more patches arrive; client sees this as fully synced.
          if (typeof parsed.seq !== 'number') parsed.seq = 0;
          return parsed;
        } catch {
          return { entries: [], seq: 0 };
        }
      }

      // MsgStore 不存在且无持久化数据，返回空快照
      return { entries: [], seq: 0 };
    }
  );
}
