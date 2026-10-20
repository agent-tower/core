import Fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TRANSLATION_PROMPT_TEMPLATE, type TranslationSettingsDraft } from '@agent-tower/shared';
import { TranslationError } from '../../services/translation-errors.js';
import { formatErrorLogEntry } from '../../utils/error-log.js';

const mocks = vi.hoisted(() => ({
  enabled: false,
  getPublic: vi.fn(async () => ({ enabled: false, revision: 0, keyConfigured: true })),
  save: vi.fn(async () => ({ enabled: false, revision: 1, keyConfigured: true })),
  listSessionOverlays: vi.fn(async () => ({ items: [], nextCursor: null })),
  retrySessionOverlay: vi.fn(async () => undefined),
  testDraft: vi.fn(async () => ({ resultText: 'translated draft' })),
}));
vi.mock('../../core/container.js', () => ({
  getTranslationSettingsService: () => ({ getPublic: mocks.getPublic, save: mocks.save }),
  getTranslationService: () => ({ testDraft: mocks.testDraft, listSessionOverlays: mocks.listSessionOverlays, retrySessionOverlay: mocks.retrySessionOverlay }),
}));
vi.mock('../../services/access-auth.service.js', () => ({
  AccessAuthService: {
    isEnabled: async () => mocks.enabled,
    extractCookieFromHeader: (cookie?: string) => cookie ?? null,
    validateBrowserSessionToken: async (cookie: string | null) => cookie?.startsWith('valid-owner-cookie') === true,
    validateSessionToken: async (cookie: string | null) => cookie?.startsWith('valid-owner-cookie') === true,
    validatePreviewAccessToken: async () => false,
  },
}));
vi.mock('../../utils/agent-api-credential.js', () => ({
  AGENT_API_CREDENTIAL_HEADER: 'x-agent-tower-agent-credential',
  validateAgentApiCredential: (credential: string) => credential === 'valid-agent-credential'
    ? { sessionId: 'agent-session', invocationId: 'agent-invocation' } : null,
}));
vi.mock('../../utils/internal-api-token.js', () => ({
  INTERNAL_API_TOKEN_HEADER: 'x-agent-tower-internal-token',
  INTERNAL_API_SESSION_ID_HEADER: 'x-agent-tower-session-id',
  INTERNAL_API_INVOCATION_ID_HEADER: 'x-agent-tower-invocation-id',
  validateInternalApiToken: (token: string) => token === 'valid-internal-token',
}));

const { accessAuthHook } = await import('../../middleware/access-auth.js');
const { translationRoutes } = await import('../translations.js');
const draft: TranslationSettingsDraft = {
  enabled: false, apiBaseUrl: 'http://localhost:7777/v1', model: 'translator',
  sendTargetLanguage: 'English', displayTargetLanguage: '简体中文',
  promptTemplate: DEFAULT_TRANSLATION_PROMPT_TEMPLATE, maxConcurrency: 4,
  apiKey: { action: 'keep' },
};
async function buildApp() {
  const app = Fastify();
  app.addHook('onRequest', accessAuthHook);
  await app.register(translationRoutes, { prefix: '/api' });
  return app;
}

describe('translation settings owner routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enabled = false;
  });

  it('allows an owner without a cookie when access password is disabled', async () => {
    const app = await buildApp();
    try {
      expect((await app.inject({ method: 'GET', url: '/api/translation-settings' })).statusCode).toBe(200);
      const save = await app.inject({ method: 'PUT', url: '/api/translation-settings', payload: { ...draft, expectedRevision: 0 } });
      expect(save.statusCode).toBe(200);
      expect(save.json()).not.toHaveProperty('apiKey');
      expect(mocks.save).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });

  it('requires browser authentication in password-enabled deployments', async () => {
    mocks.enabled = true;
    const app = await buildApp();
    try {
      expect((await app.inject({ method: 'GET', url: '/api/translation-settings' })).statusCode).toBe(401);
      expect(mocks.getPublic).not.toHaveBeenCalled();
      expect((await app.inject({ method: 'GET', url: '/api/translation-settings', headers: { cookie: 'valid-owner-cookie' } })).statusCode).toBe(200);
    } finally { await app.close(); }
  });

  it.each([false, true])('rejects Agent credentials on every management endpoint (password enabled=%s)', async enabled => {
    mocks.enabled = enabled;
    const app = await buildApp();
    try {
      for (const request of [
        { method: 'GET' as const, url: '/api/sessions/s/translations' },
        { method: 'POST' as const, url: '/api/sessions/s/translations/source/retry', payload: { expectedRevision: 1 } },
        { method: 'GET' as const, url: '/api/translation-settings' },
        { method: 'PUT' as const, url: '/api/translation-settings', payload: { ...draft, expectedRevision: 0 } },
        { method: 'POST' as const, url: '/api/translation-settings/test', payload: { draft, text: 'draft', direction: 'SEND' } },
      ]) {
        const response = await app.inject({ ...request, headers: { 'x-agent-tower-agent-credential': 'valid-agent-credential' } });
        expect(response.statusCode).toBe(403);
      }
      expect(mocks.getPublic).not.toHaveBeenCalled();
      expect(mocks.save).not.toHaveBeenCalled();
      expect(mocks.testDraft).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('accepts trusted internal credentials and rejects caller-controlled identity fields', async () => {
    mocks.enabled = true;
    const app = await buildApp();
    try {
      const headers = { 'x-agent-tower-internal-token': 'valid-internal-token' };
      const accepted = await app.inject({ method: 'POST', url: '/api/translation-settings/test', headers, payload: { draft, text: 'draft', direction: 'DISPLAY' } });
      expect(accepted.statusCode).toBe(200);
      expect(mocks.testDraft).toHaveBeenCalledWith('internal', draft, 'draft', 'DISPLAY');
      const rejected = await app.inject({ method: 'POST', url: '/api/translation-settings/test', headers, payload: { draft, text: 'draft', direction: 'DISPLAY', memberId: 'spoofed' } });
      expect(rejected.statusCode).toBe(400);
      expect(mocks.testDraft).toHaveBeenCalledTimes(1);
      expect(mocks.save).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it.each([false, true])('rejects cross-origin writes even without password (password enabled=%s)', async enabled => {
    mocks.enabled = enabled;
    const app = await buildApp();
    try {
      const headers = {
        host: 'localhost:12580', origin: 'https://unrelated.example',
        ...(enabled ? { cookie: 'valid-owner-cookie' } : {}),
      };
      const response = await app.inject({ method: 'PUT', url: '/api/translation-settings', headers, payload: { ...draft, expectedRevision: 0 } });
      expect(response.statusCode).toBe(403);
      expect(mocks.save).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('refuses illegal node configuration without echoing a submitted key', async () => {
    const app = await buildApp();
    try {
      const response = await app.inject({
        method: 'PUT', url: '/api/translation-settings',
        payload: { ...draft, expectedRevision: 0, thinking: true, apiKey: { action: 'replace', value: 'private-key-never-echoed' } },
      });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain('private-key-never-echoed');
      expect(mocks.save).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it('derives a stable, distinct draft-test identity from each verified browser cookie', async () => {
    mocks.enabled = true;
    const app = await buildApp();
    try {
      for (const cookie of ['valid-owner-cookie-1', 'valid-owner-cookie-2', 'valid-owner-cookie-1']) {
        const response = await app.inject({
          method: 'POST', url: '/api/translation-settings/test', headers: { cookie },
          payload: { draft, text: 'draft', direction: 'SEND' },
        });
        expect(response.statusCode).toBe(200);
      }
      const identities = mocks.testDraft.mock.calls.map(call => (call as unknown[])[0]);
      expect(identities[0]).toMatch(/^browser:[a-f0-9]{64}$/);
      expect(identities[0]).toBe(identities[2]);
      expect(identities[0]).not.toBe(identities[1]);
      expect(JSON.stringify(identities)).not.toContain('valid-owner-cookie');
    } finally { await app.close(); }
  });

  it('returns a bounded translation error category without echoing key or text', async () => {
    const app = await buildApp();
    try {
      mocks.testDraft.mockRejectedValueOnce(new TranslationError('AUTH_FAILED', { status: 401 }));
      const response = await app.inject({
        method: 'POST', url: '/api/translation-settings/test',
        payload: { draft: { ...draft, apiKey: { action: 'replace', value: 'secret-key' } }, text: 'private-body', direction: 'SEND' },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({ error: 'Translation failed', code: 'AUTH_FAILED' });
      expect(response.body).not.toContain('secret-key');
      expect(response.body).not.toContain('private-body');
    } finally { await app.close(); }
  });

  it('sanitizes unexpected failures before the app error logger receives them', async () => {
    const app = Fastify();
    const logged: string[] = [];
    app.addHook('onRequest', accessAuthHook);
    app.addHook('onError', async (_request, _reply, error) => { logged.push(error.message); });
    await app.register(translationRoutes, { prefix: '/api' });
    try {
      mocks.testDraft.mockRejectedValueOnce(new Error('upstream echoed secret-key and private-body'));
      const response = await app.inject({ method: 'POST', url: '/api/translation-settings/test', payload: { draft, text: 'private-body', direction: 'SEND' } });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('secret-key');
      expect(logged).toEqual(['Translation request failed']);
    } finally { await app.close(); }
  });
  it('bounds overlay queries and exposes retry only for an existing scoped source without caller text', async () => {
    const app = await buildApp();
    try {
      expect((await app.inject({ method: 'GET', url: '/api/sessions/session/translations?blockIds=a,b&cursor=last' })).statusCode).toBe(200);
      expect(mocks.listSessionOverlays).toHaveBeenCalledWith('session', { blockIds: ['a', 'b'], cursor: 'last' });
      expect((await app.inject({ method: 'GET', url: `/api/sessions/session/translations?blockIds=${Array(101).fill('a').join(',')}` })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/api/sessions/session/translations/source/retry', payload: { expectedRevision: 2, text: 'forged' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/api/sessions/session/translations/source/retry', payload: { expectedRevision: 2 } })).statusCode).toBe(200);
      expect(mocks.retrySessionOverlay).toHaveBeenCalledWith('session', 'source', 2);
      expect((await app.inject({ method: 'POST', url: '/api/sessions/session/translations/source/retry', headers: { origin: 'https://foreign.test', host: 'localhost' }, payload: { expectedRevision: 2 } })).statusCode).toBe(403);
    } finally { await app.close(); }
  });

  it.each(['/api/translation-settings', '/api/translation-settings/test'])('sanitizes malformed JSON before inherited error logging at %s', async url => {
    const app = Fastify(); const logged: string[] = []; const errors: Error[] = [];
    app.addHook('onRequest', accessAuthHook);
    app.addHook('onError', async (_req, _reply, error) => {
      errors.push(error);
      logged.push(formatErrorLogEntry({ level: 'error', source: 'test', message: error.message, error }));
    });
    await app.register(translationRoutes, { prefix: '/api' });
    try {
      const response = await app.inject({ method: url.endsWith('/test') ? 'POST' : 'PUT', url, headers: { 'content-type': 'application/json; charset=utf-8' }, payload: '{"apiKey":{"action":"replace","value":skLeakSentinel},"text":"privateBodySentinel"}' });
      expect(response.statusCode).toBe(400); expect(logged).toHaveLength(1);
      expect(response.json()).toEqual({ error: 'Invalid translation request', code: 'VALIDATION_ERROR' });
      expect(errors[0].message).toBe('Invalid translation request');
      expect(errors[0].cause).toBeUndefined();
      for (const value of [response.body, ...logged, errors[0].stack!]) expect(value).not.toMatch(/skLeak|privateBody|"apiKey"|"value"/);
      expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.testDraft).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it.each(['error', 'remove'] as const)('preserves Fastify JSON poisoning policy (%s) within the translation scope', async policy => {
    const app = Fastify({ onProtoPoisoning: policy, onConstructorPoisoning: policy });
    await app.register(async scoped => {
      await translationRoutes(scoped);
      scoped.post('/json-parser-probe', request => request.body);
    }, { prefix: '/api' });
    try {
      for (const field of ['"__proto__":{"polluted":true}', '"constructor":{"prototype":{"polluted":true}}']) {
        const response = await app.inject({ method: 'POST', url: '/api/json-parser-probe', headers: { 'content-type': 'application/json' }, payload: `{${field},"ordinary":"ok"}` });
        expect(response.statusCode).toBe(policy === 'error' ? 400 : 200);
        expect(response.json()).toEqual(policy === 'error'
          ? { error: 'Invalid translation request', code: 'VALIDATION_ERROR' }
          : { ordinary: 'ok' });
      }
    } finally { await app.close(); }
  });

  it('keeps body limits and leaves the parent JSON parser unchanged', async () => {
    const app = Fastify({ bodyLimit: 64 }); const errors: Array<{ url: string; code?: string; name: string }> = [];
    app.addHook('onError', async (request, _reply, error) => { errors.push({ url: request.url, code: error.code, name: error.name }); });
    app.post('/outside-json', request => request.body);
    await app.register(translationRoutes, { prefix: '/api' });
    try {
      expect((await app.inject({ method: 'PUT', url: '/api/translation-settings', payload: { apiKey: 'oversized'.repeat(20) } })).statusCode).toBe(413);
      expect(errors).toContainEqual({ url: '/api/translation-settings', code: 'FST_ERR_CTP_BODY_TOO_LARGE', name: 'FastifyError' });
      expect(mocks.save).not.toHaveBeenCalled();
      expect((await app.inject({ method: 'POST', url: '/outside-json', headers: { 'content-type': 'application/json' }, payload: '{"a":LEAK42}' })).statusCode).toBe(400);
      expect(errors).toContainEqual({ url: '/outside-json', code: undefined, name: 'SyntaxError' });
      expect((await app.inject({ method: 'POST', url: '/outside-json', payload: { a: 'ok' } })).json()).toEqual({ a: 'ok' });
    } finally { await app.close(); }
  });

});
