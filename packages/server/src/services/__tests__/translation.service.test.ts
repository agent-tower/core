import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_TRANSLATION_PROMPT_TEMPLATE, type TranslationSettingsDraft } from '@agent-tower/shared';
import { TranslationSettingsService } from '../translation-settings.service.js';
import { TranslationService } from '../translation.service.js';
import { TranslationClient } from '../translation-client.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-translation-'));
const db = new PrismaClient({ datasources: { db: { url: `file:${path.join(dir, 'test.db')}` } } });
const draft: TranslationSettingsDraft = { enabled: true, apiBaseUrl: 'https://translator.test/v1', model: 'first-model', apiKey: { action: 'replace', value: 'translation-secret' }, sendTargetLanguage: 'English', displayTargetLanguage: '简体中文', promptTemplate: '{{target_language}}\n{{text}}', maxConcurrency: 2 };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (true) {
    const value = await read();
    if (check(value)) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for translation state');
    await sleep(5);
  }
}
function response(content: string) { return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] })); }
function source(sessionId: string, text = 'Hello world', blockId = 'block') {
  return { kind: 'SESSION_BLOCK' as const, sessionId, turnId: 'turn', blockId, semanticType: 'assistant_message' as const, text, state: 'SEALED' as const };
}

describe('TranslationService isolated SQLite behavior', () => {
  let settings: TranslationSettingsService;
  let sessionId: string;
  let services: TranslationService[];
  beforeAll(() => {
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', `--schema=${path.join(root, 'prisma/schema.prisma')}`], { cwd: root, env: { ...process.env, AGENT_TOWER_DATABASE_URL: `file:${path.join(dir, 'test.db')}` }, stdio: 'pipe' });
  });
  beforeEach(async () => {
    await db.translationAttempt.deleteMany();
    await db.translationSource.deleteMany();
    await db.translationSettings.deleteMany();
    await db.conversation.deleteMany();
    const conversation = await db.conversation.create({ data: { title: 'Test', directoryName: 'test', workingDir: dir } });
    const session = await db.session.create({ data: { conversationId: conversation.id, context: 'CONVERSATION', agentType: 'CODEX', prompt: 'Original prompt' } });
    sessionId = session.id;
    settings = new TranslationSettingsService(db);
    services = [];
  });
  afterEach(async () => { for (const service of services) await service.shutdown(); });
  afterAll(async () => { await db.$disconnect(); fs.rmSync(dir, { recursive: true, force: true }); });

  function make(fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return response(body.messages.at(-1).content.split('\n').slice(1).join('\n').replace(/Hello/g, '你好'));
  }, limits = {}) {
    // A fetch transport settles its own request when AbortSignal closes it, as Node fetch does.
    const transport: typeof fetch = (url, init) => new Promise<Response>((resolve, reject) => {
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      init?.signal?.addEventListener('abort', abort, { once: true });
      void fetchImpl(url, init).then(resolve, reject).finally(() => init?.signal?.removeEventListener('abort', abort));
    });
    const service = new TranslationService(db, settings, { client: new TranslationClient({ fetchImpl: transport, timeoutMs: 300 }), limits: { tickMs: 10, retryDelays: [20, 30], ...limits } });
    services.push(service);
    return service;
  }
  async function enable(changes: Partial<TranslationSettingsDraft> = {}) {
    const current = await settings.getPublic();
    return settings.save({ ...draft, ...changes, expectedRevision: current.revision });
  }
  const row = (id: string) => db.translationSource.findUniqueOrThrow({ where: { id } });

  it('is off by default; enabling does not replay paused sources, and OPEN/thinking never leave the process', async () => {
    let calls = 0;
    const service = make(async () => { calls++; return response('translated'); });
    await service.start();
    const paused = await service.registerSource(source(sessionId));
    expect(paused.jobState).toBe('PAUSED_DISABLED');
    expect((await settings.getPublic()).enabled).toBe(false);
    await enable();
    const open = await service.registerSource({ ...source(sessionId, 'Open prose', 'open'), state: 'OPEN' });
    await expect(service.registerSource({ ...source(sessionId), semanticType: 'thinking' } as never)).rejects.toMatchObject({ code: 'INELIGIBLE_SOURCE' });
    await sleep(40);
    expect(calls).toBe(0);
    expect((await row(open.id)).jobState).toBe('OPEN');
    await service.retry(paused.id, paused.sourceRevision);
    await until(() => row(paused.id), r => r.jobState === 'SUCCESS');
    expect(calls).toBe(1);
  });

  it('sends only the protected body with a frozen configuration; saves do not revoke an in-flight result', async () => {
    let release!: () => void;
    let payload: any;
    let headers: any;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const service = make(async (_url, init) => {
      payload = JSON.parse(String(init?.body)); headers = init?.headers;
      await gate;
      return response(payload.messages.at(-1).content.split('\n').slice(1).join('\n').replace('Hello', '你好'));
    });
    await enable(); await service.start();
    const original = 'Hello world `secret_code()` with [guide](https://private.test/a)';
    const registered = await service.registerSource(source(sessionId, original));
    await until(async () => payload, Boolean);
    await enable({ model: 'new-model', apiKey: { action: 'replace', value: 'new-secret' } });
    release();
    const done = await until(() => row(registered.id), r => r.jobState === 'SUCCESS');
    const attempt = await db.translationAttempt.findUniqueOrThrow({ where: { id: done.effectiveAttemptId! } });
    expect(payload.model).toBe('first-model');
    expect(payload.stream).toBe(false);
    expect(JSON.stringify(payload)).not.toContain('secret_code');
    expect(JSON.stringify(payload)).not.toContain('private.test');
    expect(JSON.stringify(payload)).not.toContain('Original prompt');
    expect(JSON.stringify(headers)).toContain('translation-secret');
    expect(attempt.resultText).toContain('`secret_code()`');
    expect(attempt.resultText).toContain('(https://private.test/a)');
    expect(attempt.resultText).toContain('你好');
    expect(attempt.sanitizedConfigSnapshot).not.toContain('translation-secret');
    expect((await row(registered.id)).originalText).toBe(original);
  });

  it('isolates out-of-order source revisions and independent sources with identical text', async () => {
    const pending: Array<{ text: string; resolve: (value: Response) => void }> = [];
    const service = make(async (_url, init) => new Promise<Response>(resolve => { pending.push({ text: JSON.parse(String(init?.body)).messages.at(-1).content.split('\n').slice(1).join('\n'), resolve }); }));
    await enable(); await service.start();
    const first = await service.registerSource(source(sessionId, 'Hello old'));
    await until(async () => pending.length, n => n === 1);
    await service.registerSource(source(sessionId, 'Hello new'));
    // The closed transport cannot publish its late response into the newer source generation.
    await until(async () => pending.length, n => n === 2);
    pending[1].resolve(response(pending[1].text.replace('Hello', 'new translated')));
    const latest = await until(() => row(first.id), r => r.jobState === 'SUCCESS');
    pending[0].resolve(response('old translated'));
    await sleep(20);
    expect((await row(first.id)).effectiveAttemptId).toBe(latest.effectiveAttemptId);
    const result = await db.translationAttempt.findUniqueOrThrow({ where: { id: latest.effectiveAttemptId! } });
    expect(result.resultText).toContain('new translated new');
    const other = await service.registerSource(source(sessionId, 'Hello new', 'second'));
    expect(other.id).not.toBe(first.id);
    await service.cancel(other.id);
  });

  it('retries with the current model/key and a new attempt, then releases the capacity', async () => {
    const models: string[] = [];
    const keys: string[] = [];
    let count = 0;
    const service = make(async (_url, init) => {
      const body = JSON.parse(String(init?.body)); models.push(body.model); keys.push(JSON.stringify(init?.headers));
      if (++count === 1) return new Response('secret upstream body', { status: 503 });
      return response(body.messages.at(-1).content.split('\n').slice(1).join('\n'));
    }, { retryDelays: [200, 200], sources: 1, displaySources: 1 });
    await enable(); await service.start();
    const first = await service.registerSource(source(sessionId));
    await until(() => row(first.id), r => r.jobState === 'RETRY_WAIT');
    await enable({ model: 'retry-model', apiKey: { action: 'replace', value: 'retry-secret' } });
    await until(() => row(first.id), r => r.jobState === 'SUCCESS');
    expect(models).toEqual(['first-model', 'retry-model']);
    expect(keys[1]).toContain('retry-secret');
    const attempts = await db.translationAttempt.findMany({ where: { sourceId: first.id }, orderBy: { attemptVersion: 'asc' } });
    expect(attempts.map(a => a.attemptVersion)).toEqual([1, 2]);
    expect(attempts[0].errorCode).toBe('UPSTREAM_ERROR');
    expect(JSON.stringify(attempts)).not.toContain('secret upstream body');
    expect((await service.registerSource(source(sessionId, 'Another body', 'next'))).jobState).toBe('PENDING');
  });

  it('enforces bounded admission, retains overflow original text, and admits an explicit retry after cancellation', async () => {
    const service = make(async () => new Promise<Response>(() => {}), { sources: 1, displaySources: 1, laneSources: 1 });
    await enable(); await service.start();
    const first = await service.registerSource(source(sessionId));
    await until(() => row(first.id), r => r.jobState === 'RUNNING');
    const overflow = await service.registerSource(source(sessionId, 'Keep this original', 'overflow'));
    expect(overflow.jobState).toBe('QUEUE_FULL');
    expect(overflow.originalText).toBe('Keep this original');
    await service.cancel(first.id);
    expect((await service.retry(overflow.id, overflow.sourceRevision)).jobState).toBe('PENDING');
    await service.cancel(overflow.id);
  });

  it('disable/enable aborts old epoch and leaves paused sources for explicit action', async () => {
    let calls = 0;
    const service = make(async (_url, init) => {
      calls++;
      if (calls === 1) return new Promise<Response>(() => {});
      return response(JSON.parse(String(init?.body)).messages.at(-1).content.split('\n').slice(1).join('\n'));
    });
    await enable(); await service.start();
    const first = await service.registerSource(source(sessionId));
    await until(() => row(first.id), r => r.jobState === 'RUNNING');
    await enable({ enabled: false });
    await until(() => row(first.id), r => r.jobState === 'PAUSED_DISABLED');
    await enable(); await sleep(40);
    expect(calls).toBe(1);
    await service.retry(first.id, first.sourceRevision);
    await until(() => row(first.id), r => r.jobState === 'SUCCESS');
    expect(calls).toBe(2);
  });

  it('bounds timeouts and retries, and a subsequent draft test can acquire the released slot', async () => {
    let hanging = true;
    let calls = 0;
    const service = make(async (_url, init) => {
      calls++;
      if (hanging) return new Promise<Response>(() => {});
      return response(JSON.parse(String(init?.body)).messages.at(-1).content.split('\n').slice(1).join('\n'));
    });
    await enable({ maxConcurrency: 1 }); await service.start();
    const first = await service.registerSource(source(sessionId));
    await until(() => row(first.id), r => r.jobState === 'FAILED');
    expect(calls).toBe(3);
    hanging = false;
    expect((await service.testDraft('owner', draft, 'Hello after timeout', 'SEND')).resultText).toBe('Hello after timeout');
  });

  it('recovers interrupted attempts using current settings without replaying success or disabled work', async () => {
    const firstService = make(async () => new Promise<Response>(() => {}));
    await enable(); await firstService.start();
    const registered = await firstService.registerSource(source(sessionId));
    await until(() => row(registered.id), r => r.jobState === 'RUNNING');
    await firstService.shutdown();
    await enable({ model: 'restart-model' });
    const models: string[] = [];
    const second = make(async (_url, init) => {
      const body = JSON.parse(String(init?.body)); models.push(body.model);
      return response(body.messages.at(-1).content.split('\n').slice(1).join('\n'));
    });
    await second.start();
    await until(() => row(registered.id), r => r.jobState === 'SUCCESS');
    expect(models).toEqual(['restart-model']);
    const attempts = await db.translationAttempt.findMany({ where: { sourceId: registered.id }, orderBy: { attemptVersion: 'asc' } });
    expect(attempts.map(a => a.status)).toEqual(['INTERRUPTED', 'SUCCESS']);
    await second.shutdown();
    const third = make(); await third.start(); await sleep(30);
    expect(await db.translationAttempt.count({ where: { sourceId: registered.id } })).toBe(2);
  });

  it('deletion during the request prevents result commit, and private/internal sources are ineligible', async () => {
    let release!: () => void;
    const service = make(async () => { await new Promise<void>(resolve => { release = resolve; }); return response('late result'); });
    await enable(); await service.start();
    const registered = await service.registerSource(source(sessionId));
    await until(async () => release, Boolean);
    await db.conversation.update({ where: { id: (await db.session.findUniqueOrThrow({ where: { id: sessionId } })).conversationId! }, data: { deletedAt: new Date() } });
    release(); await sleep(30);
    expect((await row(registered.id)).effectiveAttemptId).toBeNull();
    expect(await db.translationAttempt.count({ where: { sourceId: registered.id, status: 'SUCCESS' } })).toBe(0);
    await expect(service.registerSource(source(sessionId, 'deleted'))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(DEFAULT_TRANSLATION_PROMPT_TEMPLATE).toContain('{{text}}');
  });

  it('draft tests do not persist sources or attempts and only one test per identity runs at once', async () => {
    let release!: () => void;
    let calls = 0;
    const service = make(async (_url, init) => {
      calls++;
      await new Promise<void>(resolve => { release = resolve; });
      return response(JSON.parse(String(init?.body)).messages.at(-1).content.split('\n').slice(1).join('\n'));
    });
    await service.start();
    const pending = service.testDraft('owner', draft, 'Hello test', 'DISPLAY');
    await until(async () => calls, n => n === 1);
    await expect(service.testDraft('owner', draft, 'Other', 'SEND')).rejects.toMatchObject({ code: 'QUEUE_FULL' });
    release(); await pending;
    expect(await db.translationSource.count()).toBe(0);
    expect(await db.translationAttempt.count()).toBe(0);
    expect((await settings.getPublic()).enabled).toBe(false);
  });

  it.each(['attempt-version', 'lease-owner'] as const)('rejects a late result after persisted %s ownership is replaced', async changed => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const service = make(async (_url, init) => {
      await gate;
      return response(JSON.parse(String(init?.body)).messages.at(-1).content.split('\n').slice(1).join('\n'));
    });
    await enable(); await service.start();
    const registered = await service.registerSource(source(sessionId));
    const running = await until(() => row(registered.id), value => value.jobState === 'RUNNING');
    const attempt = await db.translationAttempt.findUniqueOrThrow({
      where: { sourceId_attemptVersion: { sourceId: registered.id, attemptVersion: running.currentAttemptVersion } },
    });
    if (changed === 'attempt-version') {
      await db.translationSource.update({ where: { id: registered.id }, data: { currentAttemptVersion: { increment: 1 } } });
    } else {
      await db.translationAttempt.update({ where: { id: attempt.id }, data: { leaseOwner: 'replacement-owner' } });
    }
    release();
    if (changed === 'attempt-version') {
      await until(() => db.translationAttempt.findUniqueOrThrow({ where: { id: attempt.id } }), value => value.status === 'SUPERSEDED');
    } else {
      await until(() => row(registered.id), value => value.jobState === 'FAILED');
    }
    expect((await row(registered.id)).effectiveAttemptId).toBeNull();
    expect(await db.translationAttempt.count({ where: { sourceId: registered.id, status: 'SUCCESS' } })).toBe(0);
    expect((await db.translationAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).resultText).toBeNull();
  });

  it('preserves a persisted retry deadline across restart and spends the remaining attempts with current configuration', async () => {
    const models: string[] = [];
    const keys: string[] = [];
    const fail: typeof fetch = async (_url, init) => {
      models.push(JSON.parse(String(init?.body)).model);
      keys.push(JSON.stringify(init?.headers));
      return new Response('private upstream failure', { status: 503 });
    };
    const first = make(fail, { retryDelays: [800, 20] });
    await enable(); await first.start();
    const registered = await first.registerSource(source(sessionId));
    const waiting = await until(() => row(registered.id), value => value.jobState === 'RETRY_WAIT');
    const deadline = waiting.nextRetryAt!.getTime();
    await first.shutdown();
    await enable({ model: 'after-restart', apiKey: { action: 'replace', value: 'after-restart-secret' } });
    const second = make(fail, { retryDelays: [20, 20] });
    await second.start();
    const recovered = await row(registered.id);
    expect(recovered.jobState).toBe('RETRY_WAIT');
    expect(recovered.nextRetryAt!.getTime()).toBe(deadline);
    expect(recovered.retryCount).toBe(1);
    expect(models).toEqual(['first-model']);
    const done = await until(() => row(registered.id), value => value.jobState === 'FAILED');
    expect(done.retryCount).toBe(3);
    expect(models).toEqual(['first-model', 'after-restart', 'after-restart']);
    expect(keys.slice(1).every(key => key.includes('after-restart-secret'))).toBe(true);
    const attempts = await db.translationAttempt.findMany({ where: { sourceId: registered.id }, orderBy: { attemptVersion: 'asc' } });
    expect(attempts.map(attempt => attempt.attemptVersion)).toEqual([1, 2, 3]);
    expect(attempts.map(attempt => attempt.configRevision)).toEqual([1, 2, 2]);
    expect(JSON.stringify(attempts)).not.toContain('private upstream failure');
    await sleep(40);
    expect(models).toHaveLength(3);
  });

  it('completes code-only bodies locally and preserves over-limit originals without external requests', async () => {
    let calls = 0;
    const service = make(async () => { calls++; return response('should never be requested'); });
    await enable(); await service.start();
    const code = '```typescript\nconst secret = "private code";\n```';
    const local = await service.registerSource(source(sessionId, code, 'code-only'));
    const localDone = await until(() => row(local.id), value => value.jobState === 'NOT_REQUIRED');
    const localAttempt = await db.translationAttempt.findUniqueOrThrow({ where: { id: localDone.effectiveAttemptId! } });
    expect(localDone.originalText).toBe(code);
    expect(localAttempt.resultText).toBe(code);
    const original = 'a'.repeat(64 * 1024 + 1);
    const oversized = await service.registerSource(source(sessionId, original, 'too-large'));
    const failed = await until(() => row(oversized.id), value => value.jobState === 'FAILED');
    expect(failed.originalText).toBe(original);
    expect(failed.errorCode).toBe('PAYLOAD_TOO_LARGE');
    expect(failed.effectiveAttemptId).toBeNull();
    expect(calls).toBe(0);
  });

  it('opens a bad-credential circuit for the saved revision and admits requests with a new configuration', async () => {
    const models: string[] = [];
    const service = make(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      models.push(body.model);
      if (models.length === 1) return new Response('private auth failure', { status: 401 });
      return response(body.messages.at(-1).content.split('\n').slice(1).join('\n'));
    });
    await enable(); await service.start();
    const first = await service.registerSource(source(sessionId, 'Hello first', 'bad-key'));
    expect((await until(() => row(first.id), value => value.jobState === 'FAILED')).errorCode).toBe('AUTH_FAILED');
    const blocked = await service.registerSource(source(sessionId, 'Hello blocked', 'circuit-blocked'));
    expect((await until(() => row(blocked.id), value => value.jobState === 'FAILED')).errorCode).toBe('CONFIG_CIRCUIT_OPEN');
    expect(models).toEqual(['first-model']);
    expect(await db.translationAttempt.count({ where: { sourceId: blocked.id } })).toBe(0);
    await enable({ model: 'fixed-model', apiKey: { action: 'replace', value: 'fixed-credential' } });
    const resumed = await service.registerSource(source(sessionId, 'Hello recovered', 'fixed-config'));
    await until(() => row(resumed.id), value => value.jobState === 'SUCCESS');
    expect(models).toEqual(['first-model', 'fixed-model']);
  });

  it('shares a single global HTTP slot between source translation and draft tests', async () => {
    let calls = 0;
    let inflight = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const service = make(async (_url, init) => {
      calls++; inflight++; peak = Math.max(peak, inflight);
      try {
        if (calls === 1) await gate;
        return response(JSON.parse(String(init?.body)).messages.at(-1).content.split('\n').slice(1).join('\n'));
      } finally { inflight--; }
    });
    await enable({ maxConcurrency: 1 }); await service.start();
    const registered = await service.registerSource(source(sessionId));
    await until(async () => calls, value => value === 1);
    const pending = service.testDraft('independent-browser', draft, 'Hello draft', 'DISPLAY');
    await sleep(30);
    expect(calls).toBe(1);
    expect(inflight).toBe(1);
    release();
    expect((await pending).resultText).toBe('Hello draft');
    await until(() => row(registered.id), value => value.jobState === 'SUCCESS');
    expect(calls).toBe(2);
    expect(peak).toBe(1);
    expect(inflight).toBe(0);
    expect(await db.translationSource.count()).toBe(1);
    expect(await db.translationAttempt.count()).toBe(1);
  });

  it('recovers an expired lease without allowing the old request to retain a winner', async () => {
    const models: string[] = [];
    const service = make(async (_url, init) => {
      const body = JSON.parse(String(init?.body)); models.push(body.model);
      if (models.length === 1) return new Promise<Response>(() => {});
      return response(body.messages.at(-1).content.split('\n').slice(1).join('\n'));
    });
    await enable({ maxConcurrency: 1 }); await service.start();
    const registered = await service.registerSource(source(sessionId));
    await until(() => row(registered.id), value => value.jobState === 'RUNNING');
    await enable({ model: 'after-lease-expiry', maxConcurrency: 1 });
    await db.translationAttempt.updateMany({ where: { sourceId: registered.id, status: 'RUNNING' }, data: { leaseExpiresAt: new Date(0) } });
    await service.pump();
    await until(() => row(registered.id), value => value.jobState === 'SUCCESS');
    const attempts = await db.translationAttempt.findMany({ where: { sourceId: registered.id }, orderBy: { attemptVersion: 'asc' } });
    expect(attempts.map(attempt => attempt.status)).toEqual(['INTERRUPTED', 'SUCCESS']);
    expect(attempts[0].resultText).toBeNull();
    expect(models).toEqual(['first-model', 'after-lease-expiry']);
  });
  it('admits later lanes past more than 64 durable sources held in the in-memory queue', async () => {
    await enable({ maxConcurrency: 16 });
    const ids = [sessionId];
    for (const title of ['beta', 'gamma']) {
      const conversation = await db.conversation.create({ data: { title, directoryName: title, workingDir: dir } });
      ids.push((await db.session.create({ data: { conversationId: conversation.id, context: 'CONVERSATION', agentType: 'CODEX', prompt: 'test' } })).id);
    }
    const requests: string[] = []; const releases: Array<() => void> = [];
    const service = make(async (_url, init) => {
      const body = JSON.parse(String(init?.body)).messages.at(-1).content;
      requests.push(body);
      await new Promise<void>(resolve => releases.push(resolve));
      return response(body.split('\n').slice(1).join('\n'));
    }, { tickMs: 10 });
    try {
      for (let lane = 0; lane < 3; lane++) for (let index = 0; index < (lane === 2 ? 1 : 64); index++) {
        await service.registerSource(source(ids[lane], `Hello ${['alpha', 'beta', 'gamma'][lane]} message ${index}`, `block-${index}`));
      }
      await service.start();
      // Queue callbacks claim sources independently; gamma can reach fetch before
      // beta's second claim. Wait for all five admitted handles before counting.
      await until(async () => requests, rows => rows.length >= 5 && rows.some(body => body.includes('gamma')));
      expect(requests.filter(body => body.includes('alpha'))).toHaveLength(2);
      expect(requests.filter(body => body.includes('beta'))).toHaveLength(2);
      expect(requests.filter(body => body.includes('gamma'))).toHaveLength(1);
      for (let index = 0; index < 5; index++) await service.pump();
      expect(new Set(requests).size).toBe(requests.length);
      expect(await db.translationAttempt.count({ where: { status: 'RUNNING' } })).toBe(5);
    } finally {
      const stopped = service.shutdown();
      releases.forEach(resolve => resolve());
      await stopped;
    }
  });

});
