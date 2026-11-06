import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { getSessionWakeupService } from '../core/container.js';
import { ServiceError } from '../errors.js';
import type { SessionWakeupService } from '../services/session-wakeup.service.js';
import { INTERNAL_API_SESSION_ID_HEADER } from '../utils/internal-api-token.js';

const sessionParamsSchema = z.object({ id: z.string().min(1) });
const serviceParamsSchema = z.object({ workspaceId: z.string().min(1), name: z.string().min(1) });
const timerSchema = z.object({
  delaySeconds: z.number().int().min(1),
  reason: z.string().min(1).max(500),
}).strict();
const waitSchema = z.object({ reason: z.string().max(500).optional() }).strict();

export interface SessionWakeupRoutesOptions {
  wakeups?: SessionWakeupService;
}

interface CallerRequest {
  agentTowerAuthKind?: 'unauthenticated' | 'browser' | 'agent' | 'internal';
  agentTowerAgentIdentity?: { sessionId: string; invocationId: string | null };
  headers: Record<string, unknown>;
}

/** Wake-ups are requested by the Agent for its own session; browsers may only read them. */
function requireAgentSession(request: CallerRequest): string {
  if (request.agentTowerAuthKind === 'agent' && request.agentTowerAgentIdentity) {
    return request.agentTowerAgentIdentity.sessionId;
  }
  if (request.agentTowerAuthKind === 'internal') {
    const value = request.headers[INTERNAL_API_SESSION_ID_HEADER];
    if (typeof value === 'string' && value.length > 0) return value;
    throw new ServiceError('Internal wake-up requests require a session identity', 'INTERNAL_SESSION_REQUIRED', 400);
  }
  throw new ServiceError('Wake-ups require Agent authentication', 'WAKEUP_AUTH_REQUIRED', request.agentTowerAuthKind === 'browser' ? 403 : 401);
}

function handleError(error: unknown, reply: { code(statusCode: number): unknown }) {
  if (error instanceof ZodError) {
    reply.code(400);
    return { error: 'Validation failed', code: 'VALIDATION_ERROR' };
  }
  if (error instanceof ServiceError) {
    reply.code(error.statusCode);
    return { error: error.message, code: error.code };
  }
  reply.code(500);
  return { error: 'Internal server error', code: 'INTERNAL_ERROR' };
}

export async function sessionWakeupRoutes(app: FastifyInstance, options: SessionWakeupRoutesOptions = {}) {
  const service = () => options.wakeups ?? getSessionWakeupService();

  // Schedule a timer wake-up for the calling Agent's own session.
  app.post('/sessions/:id/wakeups', async (request, reply) => {
    try {
      const { id } = sessionParamsSchema.parse(request.params);
      const body = timerSchema.parse(request.body ?? {});
      const sessionId = requireAgentSession(request as CallerRequest);
      if (sessionId !== id) {
        throw new ServiceError('Wake-ups can only be scheduled for the calling session', 'WAKEUP_SESSION_MISMATCH', 403);
      }
      const wakeup = await service().scheduleTimer({ sessionId, delaySeconds: body.delaySeconds, reason: body.reason });
      reply.code(201);
      return wakeup;
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get('/sessions/:id/wakeups', async (request, reply) => {
    try {
      const { id } = sessionParamsSchema.parse(request.params);
      const kind = (request as CallerRequest).agentTowerAuthKind;
      if (kind !== 'browser' && kind !== 'internal') {
        const sessionId = requireAgentSession(request as CallerRequest);
        if (sessionId !== id) throw new ServiceError('Wake-ups are visible to their own session only', 'WAKEUP_SESSION_MISMATCH', 403);
      }
      return await service().listForSession(id);
    } catch (error) {
      return handleError(error, reply);
    }
  });

  // Wake the calling Agent's session when a workspace service exits.
  app.post('/workspaces/:workspaceId/services/:name/wait', async (request, reply) => {
    try {
      const { workspaceId, name } = serviceParamsSchema.parse(request.params);
      const body = waitSchema.parse(request.body ?? {});
      const sessionId = requireAgentSession(request as CallerRequest);
      const wakeup = await service().waitForService({ sessionId, workspaceId, serviceName: name, reason: body.reason });
      reply.code(201);
      return wakeup;
    } catch (error) {
      return handleError(error, reply);
    }
  });
}
