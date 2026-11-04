import { registerApplicationProcessCleanup } from '../runtime/application-process-cleanup.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { OpenPreviewSessionInput, PreviewSession } from '@agent-tower/shared';
import { PreviewService } from '../services/preview.service.js';
import type { NormalizedPreviewTarget } from '../services/preview.service.js';
import { ServiceError } from '../errors.js';
import { TunnelService } from '../services/tunnel.service.js';
import { extractTunnelSessionTokenFromCookieHeader } from '../utils/tunnel-cookie.js';
import { AccessAuthService } from '../services/access-auth.service.js';
import {
  INTERNAL_API_TOKEN_HEADER,
  validateInternalApiToken,
} from '../utils/internal-api-token.js';
import { buildPreviewPathPrefix, parsePreviewPath } from '../utils/preview-path.js';
import {
  addPreviewAccessToken,
  PreviewRuntimeManager,
  type PreviewGatewaySession,
} from '../services/preview-runtime-manager.js';
import {
  classifyPreviewRequest,
  previewServiceWorkerSegment,
  proxyPreviewHttpRequest,
  proxyPreviewWebSocket,
  shouldServeBootstrap,
  writeBootstrapPage,
  writeServiceWorkerScript,
  writeUpgradeError,
  type PreviewProxyScope,
} from '../services/preview-proxy.js';
import { isTunnelRequest } from '../middleware/tunnel-auth.js';

export { PREVIEW_SANDBOX_CSP } from '../services/preview-proxy.js';

/** Session id returned for the same-origin proxy; it needs no lease or heartbeat. */
export const SAME_ORIGIN_PREVIEW_SESSION_ID = 'same-origin';
const SAME_ORIGIN_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const PROXY_BODY_LIMIT_BYTES = 256 * 1024 * 1024;

const configSchema = z.object({
  target: z.string().nullable(),
});

const previewSessionSchema = z.object({
  mode: z.enum(['local', 'remote']),
  localHostname: z.string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^(?:\[[0-9a-fA-F:]+\]|[0-9a-zA-Z.-]+)$/, 'Invalid preview hostname'),
});

function errorResponse(error: unknown, reply: FastifyReply) {
  if (error instanceof ServiceError) {
    return reply.code(error.statusCode).send({ error: error.message, code: error.code });
  }

  if (error instanceof z.ZodError) {
    return reply.code(400).send({ error: error.message, code: 'VALIDATION_ERROR' });
  }

  reply.log.error(error);
  return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
}

/**
 * Docker and other deployments whose dynamic gateway port is not reachable by
 * browsers force the same-origin proxy. `AGENT_TOWER_PREVIEW_FORCE_TUNNEL` is
 * the previous name of the same switch and is still honoured.
 */
export function forceSameOriginPreview(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AGENT_TOWER_PREVIEW_FORCE_SAME_ORIGIN === 'true'
    || env.AGENT_TOWER_PREVIEW_FORCE_TUNNEL === 'true';
}

export function sameOriginPreviewSession(
  workspaceId: string,
  target: NormalizedPreviewTarget,
  now = Date.now(),
): PreviewSession {
  return {
    id: SAME_ORIGIN_PREVIEW_SESSION_ID,
    target: target.target,
    mode: 'remote',
    kind: 'same-origin',
    viewUrl: `${buildPreviewPathPrefix(workspaceId)}/`,
    expiresAt: new Date(now + SAME_ORIGIN_SESSION_TTL_MS).toISOString(),
  };
}

function requestBodyBuffer(request: FastifyRequest): Buffer | null {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') return null;

  const body = request.body;
  if (body === undefined || body === null) return null;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body);
  return Buffer.from(JSON.stringify(body));
}

async function authorizeWebSocketUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  workspaceId: string,
  previewToken: string | null,
): Promise<boolean> {
  const isTunnel = Boolean(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);
  if (isTunnel && TunnelService.isRunning()) {
    const token = extractTunnelSessionTokenFromCookieHeader(req.headers.cookie);
    if (!token || !TunnelService.validateToken(token)) {
      writeUpgradeError(socket, 401, 'Unauthorized');
      return false;
    }
  }

  const internalToken = req.headers[INTERNAL_API_TOKEN_HEADER];
  const normalizedInternalToken = Array.isArray(internalToken) ? internalToken[0] : internalToken;
  if (internalToken !== undefined) {
    if (!validateInternalApiToken(normalizedInternalToken)) {
      writeUpgradeError(socket, 401, 'Invalid Internal Token');
      return false;
    }
    return true;
  }

  if (previewToken && await AccessAuthService.validatePreviewAccessToken(previewToken, workspaceId)) {
    return true;
  }

  const accessToken = AccessAuthService.extractCookieFromHeader(req.headers.cookie);
  if (!await AccessAuthService.validateSessionToken(accessToken)) {
    writeUpgradeError(socket, 401, 'Unauthorized');
    return false;
  }
  return true;
}

function registerPreviewWebSocketProxy(app: FastifyInstance, previewService: PreviewService): void {
  app.server.on('upgrade', (req, socket, head) => {
    const parsed = parsePreviewPath(req.url ?? '');
    if (!parsed) return;

    void (async () => {
      if (!await authorizeWebSocketUpgrade(req, socket, parsed.workspaceId, parsed.previewToken)) return;

      const target = await previewService.getTarget(parsed.workspaceId);
      if (!target) {
        writeUpgradeError(socket, 404, 'Not Found');
        return;
      }
      proxyPreviewWebSocket(
        req,
        socket,
        head,
        { workspaceId: parsed.workspaceId, target, previewToken: parsed.previewToken },
        parsed.suffix,
        parsed.search,
      );
    })().catch(() => {
      writeUpgradeError(socket, 502, 'Bad Gateway');
    });
  });
}

export async function previewRoutes(app: FastifyInstance) {
  const previewService = new PreviewService();
  const previewRuntimeManager = new PreviewRuntimeManager();
  const cleanupPreview = async () => {
    await previewRuntimeManager.stopAll();
    unregisterCleanup();
  };
  const unregisterCleanup = registerApplicationProcessCleanup(cleanupPreview);
  registerPreviewWebSocketProxy(app, previewService);

  const gatewaySessionResponse = async (session: PreviewGatewaySession): Promise<PreviewSession> => {
    const accessToken = await AccessAuthService.createPreviewAccessToken(session.workspaceId);
    return {
      id: session.id,
      target: session.target,
      mode: 'local',
      kind: 'gateway',
      viewUrl: addPreviewAccessToken(session.viewBaseUrl, accessToken),
      expiresAt: session.expiresAt,
    };
  };

  app.addHook('onClose', cleanupPreview);

  app.get<{ Params: { workspaceId: string } }>(
    '/api/previews/:workspaceId/status',
    async (request, reply) => {
      try {
        return await previewService.getStatus(request.params.workspaceId);
      } catch (err) {
        return errorResponse(err, reply);
      }
    },
  );

  app.put<{ Params: { workspaceId: string }; Body: { target: string | null } }>(
    '/api/previews/:workspaceId/config',
    async (request, reply) => {
      try {
        const body = configSchema.parse(request.body);
        const target = await previewService.setTarget(request.params.workspaceId, body.target);
        await previewRuntimeManager.invalidate(request.params.workspaceId);
        const status = await previewService.getStatus(request.params.workspaceId);
        return {
          ...status,
          target: target?.target ?? null,
        };
      } catch (err) {
        return errorResponse(err, reply);
      }
    },
  );

  app.post<{
    Params: { workspaceId: string };
    Body: OpenPreviewSessionInput;
  }>('/api/previews/:workspaceId/sessions', async (request, reply) => {
    try {
      const body = previewSessionSchema.parse(request.body);
      const target = await previewService.getTarget(request.params.workspaceId);
      if (!target) {
        return reply.code(404).send({
          error: 'Preview target is not configured',
          code: 'PREVIEW_NOT_CONFIGURED',
        });
      }

      // Browsers that can only reach Agent Tower itself (tunnel, HTTPS reverse
      // proxy, Docker) use the same-origin proxy; everything else gets a
      // dedicated gateway origin on the Agent Tower host.
      const sameOrigin = body.mode === 'remote' || isTunnelRequest(request) || forceSameOriginPreview();
      if (sameOrigin) {
        return sameOriginPreviewSession(request.params.workspaceId, target);
      }

      const session = await previewRuntimeManager.acquire(
        request.params.workspaceId,
        target,
        body.localHostname,
      );
      return await gatewaySessionResponse(session);
    } catch (err) {
      return errorResponse(err, reply);
    }
  });

  app.post<{
    Params: { workspaceId: string; sessionId: string };
  }>('/api/previews/:workspaceId/sessions/:sessionId/heartbeat', async (request, reply) => {
    try {
      if (request.params.sessionId === SAME_ORIGIN_PREVIEW_SESSION_ID) {
        const target = await previewService.getTarget(request.params.workspaceId);
        if (!target) {
          return reply.code(404).send({
            error: 'Preview target is not configured',
            code: 'PREVIEW_NOT_CONFIGURED',
          });
        }
        return sameOriginPreviewSession(request.params.workspaceId, target);
      }

      const session = await previewRuntimeManager.heartbeat(
        request.params.workspaceId,
        request.params.sessionId,
      );
      if (!session) {
        return reply.code(404).send({
          error: 'Preview session expired',
          code: 'PREVIEW_SESSION_EXPIRED',
        });
      }
      return await gatewaySessionResponse(session);
    } catch (err) {
      return errorResponse(err, reply);
    }
  });

  app.delete<{
    Params: { workspaceId: string; sessionId: string };
  }>('/api/previews/:workspaceId/sessions/:sessionId', async (request, reply) => {
    if (request.params.sessionId !== SAME_ORIGIN_PREVIEW_SESSION_ID) {
      previewRuntimeManager.release(request.params.workspaceId, request.params.sessionId);
    }
    return reply.code(204).send();
  });

  // The proxy must forward request bodies of any content type untouched.
  await app.register(async (proxyApp) => {
    proxyApp.removeAllContentTypeParsers();
    proxyApp.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: PROXY_BODY_LIMIT_BYTES }, (_request, body, done) => {
      done(null, body);
    });

    const handler = async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = parsePreviewPath(request.raw.url ?? '');
      if (!parsed) return reply.code(404).send({ error: 'Preview route not found', code: 'NOT_FOUND' });

      try {
        const target = await previewService.getTarget(parsed.workspaceId);
        if (!target) {
          return reply.code(404).send({ error: 'Preview target is not configured', code: 'PREVIEW_NOT_CONFIGURED' });
        }

        const scope: PreviewProxyScope = {
          workspaceId: parsed.workspaceId,
          target,
          previewToken: parsed.previewToken,
        };
        const context = classifyPreviewRequest(request.method, request.headers, parsed.search);

        reply.hijack();
        if (request.method.toUpperCase() === 'GET' && previewServiceWorkerSegment(parsed.suffix)) {
          writeServiceWorkerScript(reply.raw);
          return;
        }
        if (shouldServeBootstrap(context, request.method)) {
          writeBootstrapPage(reply.raw, scope);
          return;
        }

        await proxyPreviewHttpRequest({
          request: request.raw,
          response: reply.raw,
          scope,
          suffix: parsed.suffix,
          search: parsed.search,
          context,
          body: requestBodyBuffer(request),
        });
      } catch (err) {
        if (!reply.sent) return errorResponse(err, reply);
        reply.raw.end();
      }
    };

    proxyApp.route({
      method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
      url: '/view/:workspaceId',
      bodyLimit: PROXY_BODY_LIMIT_BYTES,
      handler,
    });

    proxyApp.route({
      method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
      url: '/view/:workspaceId/*',
      bodyLimit: PROXY_BODY_LIMIT_BYTES,
      handler,
    });
  });
}
