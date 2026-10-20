import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { TEAM_RUN_TRANSLATION_MAX_MESSAGE_IDS } from '@agent-tower/shared';
import { getTranslationService, getTranslationSettingsService, getMessageDeliveryService } from '../core/container.js';
import { ServiceError, ValidationError } from '../errors.js';
import { hasValidSameOriginSignal } from '../middleware/access-auth.js';
import { AccessAuthService } from '../services/access-auth.service.js';
import { TranslationError } from '../services/translation-errors.js';
import { QueueError } from '../services/translation-queue.js';
import { translationSettingsDraftSchema, translationSettingsUpdateSchema } from '../services/translation-settings.service.js';

const draftTestSchema = z.object({
  draft: translationSettingsDraftSchema,
  text: z.string().min(1).max(256 * 1024),
  direction: z.enum(['SEND', 'DISPLAY']),
}).strict();

function parseRequest<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ValidationError('Invalid translation request');
  return parsed.data;
}

async function safeTranslationRequest<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (error instanceof ServiceError || error instanceof TranslationError || error instanceof QueueError) throw error;
    // Sanitize before Fastify's app-wide onError logger sees an unexpected failure.
    throw new ServiceError('Translation request failed', 'TRANSLATION_REQUEST_FAILED', 500);
  }
}

export async function requireTranslationOwner(request: FastifyRequest): Promise<string> {
  const identity = request.agentTowerAuthKind;
  if (identity === 'agent') {
    throw new ServiceError('Translation management is unavailable to Agent credentials', 'TRANSLATION_OWNER_REQUIRED', 403);
  }
  if (identity === 'internal') return 'internal';
  if (identity !== 'browser' && await AccessAuthService.isEnabled()) {
    throw new ServiceError('Access password required', 'ACCESS_AUTH_REQUIRED', 401);
  }
  if (request.method !== 'GET' && request.method !== 'HEAD' && !hasValidSameOriginSignal(request)) {
    throw new ServiceError('Request origin is not allowed', 'ACCESS_AUTH_CSRF_REJECTED', 403);
  }
  if (identity === 'browser') {
    const cookie = AccessAuthService.extractCookieFromHeader(request.headers.cookie);
    // The access hook verified this cookie; use an opaque identity for per-browser draft admission.
    return cookie ? `browser:${createHash('sha256').update(cookie).digest('hex')}` : 'owner';
  }
  return 'owner';
}

export async function translationRoutes(app: FastifyInstance): Promise<void> {
  // Parsing runs before handlers and inherited onError logging. Keep Fastify's
  // body limits and poisoning policy, but never pass its body-bearing syntax
  // errors (including their stacks) to the parent logger.
  const parseJson = app.getDefaultJsonParser(app.initialConfig.onProtoPoisoning ?? 'error', app.initialConfig.onConstructorPoisoning ?? 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser<string>('application/json', { parseAs: 'string' }, (request, body, done) => {
    parseJson(request, body, (error, value) => {
      done(error ? new ValidationError('Invalid translation request') : null, value);
    });
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({ error: 'Translation request is too large', code: 'PAYLOAD_TOO_LARGE' });
    }
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: 'Invalid translation request', code: 'VALIDATION_ERROR' });
    }
    if (error instanceof ServiceError) {
      return reply.code(error.statusCode).send({ error: error.message, code: error.code });
    }
    if (error instanceof TranslationError) {
      const status = error.errorCode === 'PAYLOAD_TOO_LARGE' ? 413
        : error.errorCode === 'RATE_LIMITED' ? 429
        : error.errorCode === 'TIMEOUT' ? 504
        : error.errorCode === 'CANCELLED' ? 409 : 422;
      return reply.code(status).send({ error: 'Translation failed', code: error.errorCode });
    }
    if (error instanceof QueueError) {
      return reply.code(error.code === 'QUEUE_FULL' ? 429 : 409).send({ error: error.message, code: error.code });
    }
    // An upstream error can include response bodies, URLs or headers; never serialize it.
    return reply.code(500).send({ error: 'Translation request failed', code: 'TRANSLATION_REQUEST_FAILED' });
  });
  app.get('/message-deliveries', request => safeTranslationRequest(async () => {
    await requireTranslationOwner(request);
    const query = parseRequest(z.object({ scopeType: z.enum(['SESSION', 'CONVERSATION', 'TEAM_TASK']), scopeId: z.string().min(1), cursor: z.string().regex(/^\d+$/).refine(value => Number.isSafeInteger(Number(value))).optional(), filter: z.enum(['pending', 'sent']).optional() }).strict(), request.query);
    return getMessageDeliveryService().list(query.scopeType, query.scopeId, query.cursor, query.filter);
  }));
  app.get<{ Params: { id: string } }>('/message-deliveries/:id', request => safeTranslationRequest(async () => {
    await requireTranslationOwner(request); return getMessageDeliveryService().get(request.params.id);
  }));
  app.post<{ Params: { id: string } }>('/message-deliveries/:id/actions', request => safeTranslationRequest(async () => {
    await requireTranslationOwner(request);
    const body = parseRequest(z.object({ action: z.enum(['retry_translation', 'send_original', 'retry_delivery', 'cancel', 'confirm_not_sent', 'end_unknown']), expectedRevision: z.number().int().positive(), actionId: z.string().uuid() }).strict(), request.body);
    return getMessageDeliveryService().action(request.params.id, body.action, body.expectedRevision, body.actionId);
  }));
  app.get<{ Params: { id: string } }>('/sessions/:id/translations', request => safeTranslationRequest(async () => {
    await requireTranslationOwner(request);
    const query = parseRequest(z.object({ blockIds: z.string().max(10000).optional(), cursor: z.string().max(200).optional() }).strict(), request.query);
    const blockIds = query.blockIds?.split(',').filter(Boolean);
    if (blockIds && blockIds.length > 100) throw new ValidationError('Too many block IDs');
    return getTranslationService().listSessionOverlays(request.params.id, { blockIds, cursor: query.cursor });
  }));
  app.post<{ Params: { id: string; sourceId: string } }>('/sessions/:id/translations/:sourceId/retry', request => safeTranslationRequest(async () => {
    await requireTranslationOwner(request);
    const body = parseRequest(z.object({ expectedRevision: z.number().int().positive() }).strict(), request.body);
    await getTranslationService().retrySessionOverlay(request.params.id, request.params.sourceId, body.expectedRevision);
    return { ok: true };
  }));
  app.get<{ Params: { id: string } }>('/team-runs/:id/translations', request => safeTranslationRequest(async () => {
    await requireTranslationOwner(request);
    const query = parseRequest(z.object({ messageIds: z.string().max(10000) }).strict(), request.query);
    const messageIds = [...new Set(query.messageIds.split(',').filter(Boolean))];
    if (messageIds.length > TEAM_RUN_TRANSLATION_MAX_MESSAGE_IDS) throw new ValidationError('Too many message IDs');
    return getTranslationService().listTeamRunOverlays(request.params.id, messageIds);
  }));
  app.get<{ Params: { id: string; messageId: string } }>('/team-runs/:id/messages/:messageId/translation', request => safeTranslationRequest(async () => {
    await requireTranslationOwner(request);
    parseRequest(z.object({}).strict(), request.query);
    return getTranslationService().getTeamRunOverlay(request.params.id, request.params.messageId);
  }));
  app.post<{ Params: { id: string; sourceId: string } }>('/team-runs/:id/translations/:sourceId/retry', request => safeTranslationRequest(async () => {
    await requireTranslationOwner(request);
    const body = parseRequest(z.object({ expectedRevision: z.number().int().positive() }).strict(), request.body);
    await getTranslationService().retryTeamRunOverlay(request.params.id, request.params.sourceId, body.expectedRevision);
    return { ok: true };
  }));
  app.get('/translation-settings', request => safeTranslationRequest(async () => {
    await requireTranslationOwner(request);
    return getTranslationSettingsService().getPublic();
  }));
  app.put('/translation-settings', request => safeTranslationRequest(async () => {
    await requireTranslationOwner(request);
    return getTranslationSettingsService().save(parseRequest(translationSettingsUpdateSchema, request.body));
  }));
  app.post('/translation-settings/test', request => safeTranslationRequest(async () => {
    const identity = await requireTranslationOwner(request);
    const { draft, text, direction } = parseRequest(draftTestSchema, request.body);
    return getTranslationService().testDraft(identity, draft, text, direction);
  }));
}
