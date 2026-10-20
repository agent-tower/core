import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEAM_RUN_TRANSLATION_PREVIEW_LENGTH, type TranslationSettingsDraft, type TranslationInvalidatedPayload } from '@agent-tower/shared';
import { ClientEvents, ServerEvents } from '@agent-tower/shared/socket';
import { EventBus } from '../../core/event-bus.js';
import { TranslationService } from '../../services/translation.service.js';
import { TranslationClient } from '../../services/translation-client.js';
import { TranslationSettingsService } from '../../services/translation-settings.service.js';

const fixture = vi.hoisted(() => ({ service: null as TranslationService | null, settings: null as TranslationSettingsService | null, bus: null as EventBus | null }));
vi.mock('../../core/container.js', () => ({
  getTranslationService: () => fixture.service!, getTranslationSettingsService: () => fixture.settings!, getEventBus: () => fixture.bus!,
}));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-room-translation-'));
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
process.env.AGENT_TOWER_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
process.env.AGENT_TOWER_DATA_DIR = dir;
let db: PrismaClient;
let auth: typeof import('../../services/access-auth.service.js').AccessAuthService;
let routes: typeof import('../translations.js').translationRoutes;
let accessHook: typeof import('../../middleware/access-auth.js').accessAuthHook;
let credentials: typeof import('../../utils/agent-api-credential.js');
let Gateway: typeof import('../../socket/socket-gateway.js').SocketGateway;
const draft: TranslationSettingsDraft = { enabled: true, apiBaseUrl: 'https://translator.test/v1', model: 'initial', apiKey: { action: 'replace', value: '' }, sendTargetLanguage: 'English', displayTargetLanguage: 'Chinese', promptTemplate: '{{target_language}}\n{{text}}', maxConcurrency: 2 };
const queries: string[] = [];
const transport = vi.fn<typeof fetch>();
let room: { id: string; taskId: string; projectId: string };
const service = () => fixture.service!;
const settings = () => fixture.settings!;

async function newRoom() {
  const project = await db.project.create({ data: { name: 'Fixture', repoPath: dir } });
  const task = await db.task.create({ data: { title: 'Unchanged task', projectId: project.id } });
  const team = await db.teamRun.create({ data: { taskId: task.id, mode: 'AUTO' } });
  return { id: team.id, taskId: task.id, projectId: project.id };
}
async function message(teamRunId = room.id, content = 'Hello room') {
  return db.roomMessage.create({ data: { teamRunId, senderType: 'agent', kind: 'artifact', content, mentions: '[]', translationEligibilityEpoch: (await settings().getPublic()).enableEpoch } });
}
// Internal registered fixtures only. No production room-message admission is enabled by this test.
async function sourceFor(messageId: string, resultText?: string) {
  const row = await service().registerSource({ kind: 'ROOM_MESSAGE', messageId });
  await db.translationSource.update({ where: { id: row.id }, data: { sourceRevision: 3, overlayRevision: 7, jobState: resultText === undefined ? 'FAILED' : 'SUCCESS', errorCode: resultText === undefined ? 'AUTH_FAILED' : null } });
  if (resultText !== undefined) {
    const attempt = await db.translationAttempt.create({ data: { sourceId: row.id, sourceRevision: 3, sourceHash: row.sourceHash, attemptVersion: 1, configRevision: 1, credentialRevision: 0, targetLanguage: 'Chinese', sanitizedConfigSnapshot: '{}', protectionVersion: '1', status: 'SUCCESS', resultText, generation: row.generation, enableEpoch: row.enableEpoch } });
    await db.translationSource.update({ where: { id: row.id }, data: { effectiveAttemptId: attempt.id, currentAttemptVersion: 1 } });
  }
  return db.translationSource.findUniqueOrThrow({ where: { id: row.id } });
}
async function app() {
  const instance = Fastify(); instance.addHook('onRequest', accessHook);
  await instance.register(routes, { prefix: '/api' });
  return instance;
}
async function counts() {
  return Promise.all([db.translationSource.count(), db.translationAttempt.count(), db.messageDelivery.count(), db.roomMessage.count(), db.workRequest.count(), db.agentInvocation.count(), db.session.count()]);
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!await check()) { if (Date.now() > deadline) throw new Error('Fixture state timeout'); await new Promise(resolve => setTimeout(resolve, 5)); }
}

class FakeSocket {
  request = { headers: {} as Record<string, string> };
  accessAuthSessionSecretGeneration = auth.getSessionSecretGeneration();
  disconnected = false;
  emitted: Array<{ event: string; payload: unknown }> = [];
  handlers = new Map<string, (...args: any[]) => void>();
  constructor(readonly id: string, readonly nsp: FakeNamespace) { nsp.sockets.set(id, this); }
  on(event: string, fn: (...args: any[]) => void) { this.handlers.set(event, fn); return this; }
  emit(event: string, payload: unknown) { this.emitted.push({ event, payload }); return true; }
  join(roomName: string) { const ids = this.nsp.adapter.rooms.get(roomName) ?? new Set<string>(); ids.add(this.id); this.nsp.adapter.rooms.set(roomName, ids); }
  leave(roomName: string) { this.nsp.adapter.rooms.get(roomName)?.delete(this.id); }
  disconnect() { this.disconnected = true; }
  receive(event: string, payload: unknown, ack?: (value: unknown) => void) { this.handlers.get(event)?.(payload, ack); }
}
class FakeNamespace { sockets = new Map<string, FakeSocket>(); adapter = { rooms: new Map<string, Set<string>>() }; }
function gatewayFixture() {
  const nsp = new FakeNamespace();
  const gateway = new Gateway(nsp as never, fixture.bus!, {} as never, { cleanupBySocket: vi.fn() } as never);
  const socket = (id: string) => { const result = new FakeSocket(id, nsp); gateway.register(result as never); return result; };
  const subscribe = (target: FakeSocket, id?: string) => new Promise<unknown>(resolve => target.receive(ClientEvents.SUBSCRIBE, { topic: 'team-run', id }, resolve));
  const notifications = (target: FakeSocket) => target.emitted.filter(item => item.event === ServerEvents.TRANSLATION_INVALIDATED);
  return { gateway, nsp, socket, subscribe, notifications };
}

describe('owner TeamRun translation read model, isolated SQLite and real access auth', () => {
  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', `--schema=${path.join(serverRoot, 'prisma/schema.prisma')}`], { cwd: serverRoot, env: { ...process.env }, stdio: 'pipe' });
    db = (await import('../../utils/index.js')).prisma;
    auth = (await import('../../services/access-auth.service.js')).AccessAuthService;
    routes = (await import('../translations.js')).translationRoutes;
    accessHook = (await import('../../middleware/access-auth.js')).accessAuthHook;
    credentials = await import('../../utils/agent-api-credential.js');
    Gateway = (await import('../../socket/socket-gateway.js')).SocketGateway;
    db.$use(async (params, next) => { queries.push(`${params.model ?? ''}:${params.action}`); return next(params); });
  });
  beforeEach(async () => {
    await db.translationSource.deleteMany(); await db.translationSettings.deleteMany(); await db.project.deleteMany(); await db.accessAuthSettings.deleteMany();
    auth.__test.resetSettingsCache(); auth.__test.resetSessionSecretGeneration(); credentials.clearAgentApiCredentials();
    fixture.bus = new EventBus(); fixture.settings = new TranslationSettingsService(db);
    await settings().save({ ...draft, expectedRevision: 0 });
    transport.mockReset(); transport.mockImplementation(async (_url, init) => {
      const prompt = JSON.parse(String(init?.body)).messages.at(-1).content;
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: prompt.split('\n').slice(1).join('\n').replace('Hello', 'Bonjour') } }] }));
    });
    fixture.service = new TranslationService(db, settings(), { client: new TranslationClient({ fetchImpl: transport }), limits: { tickMs: 10 } });
    service().onInvalidated(payload => fixture.bus!.emit('translation:invalidated', payload));
    room = await newRoom(); queries.length = 0;
  });
  afterEach(async () => { await fixture.service?.shutdown(); vi.restoreAllMocks(); });
  afterAll(async () => { await db.$disconnect(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('projects bounded long-text previews in one batch, fetches full text on demand, and reads create/deliver nothing', async () => {
    const original = '原文'.repeat(5000); const translated = '译文'.repeat(5000);
    const msg = await message(room.id, original); const src = await sourceFor(msg.id, translated);
    const unknown = await message(room.id, 'Static history with no source');
    const before = await counts(); queries.length = 0;
    const list = await service().listTeamRunOverlays(room.id, [msg.id, msg.id, unknown.id]);
    expect(queries).toEqual(['TeamRun:findFirst', ':queryRaw']);
    expect(list.items).toEqual([{ sourceId: src.id, teamRunId: room.id, messageId: msg.id, sourceRevision: 3, overlayRevision: 7, state: 'SUCCESS', originalTextPreview: original.slice(0, TEAM_RUN_TRANSLATION_PREVIEW_LENGTH), translatedTextPreview: translated.slice(0, TEAM_RUN_TRANSLATION_PREVIEW_LENGTH), originalTextTruncated: true, translatedTextTruncated: true, targetLanguage: 'Chinese', errorCode: null }]);
    const instance = await app();
    try {
      const detail = await instance.inject(`/api/team-runs/${room.id}/messages/${msg.id}/translation`);
      expect(detail.statusCode).toBe(200); expect(detail.json()).toMatchObject({ originalText: original, translatedText: translated, sourceRevision: 3, overlayRevision: 7 });
      expect(detail.json()).not.toHaveProperty('originalTextPreview');
      expect((await instance.inject(`/api/team-runs/${room.id}/translations?messageIds=${msg.id},${unknown.id}`)).json()).toEqual(list);
      expect((await instance.inject(`/api/team-runs/${room.id}/messages/${unknown.id}/translation`)).statusCode).toBe(404);
      expect((await instance.inject(`/api/team-runs/${room.id}/translations?messageIds=`)).json()).toEqual({ items: [] });
    } finally { await instance.close(); }
    expect(await counts()).toEqual(before); expect(transport).not.toHaveBeenCalled();
    expect(await db.roomMessage.findUnique({ where: { id: msg.id } })).toEqual(msg);
  });

  it('deduplicates before the 100-ID limit and rejects missing/unbounded/extra query parameters', async () => {
    const msg = await message(); await sourceFor(msg.id, '你好'); const instance = await app();
    try {
      const prefix = `/api/team-runs/${room.id}/translations`;
      expect((await instance.inject(`${prefix}?messageIds=${Array(101).fill(msg.id).join(',')}`)).json().items).toHaveLength(1);
      expect((await instance.inject(`${prefix}?messageIds=${Array.from({ length: 100 }, (_, i) => `id${i}`).join(',')}`)).statusCode).toBe(200);
      expect((await instance.inject(`${prefix}?messageIds=${Array.from({ length: 101 }, (_, i) => `id${i}`).join(',')}`)).statusCode).toBe(400);
      expect((await instance.inject(prefix)).statusCode).toBe(400);
      expect((await instance.inject(`${prefix}?messageIds=${msg.id}&cursor=all`)).statusCode).toBe(400);
      expect((await instance.inject(`${prefix}?messageIds=a&messageIds=b`)).statusCode).toBe(400);
    } finally { await instance.close(); }
  });

  it('retains successful historical overlays across target/model changes and disable', async () => {
    const msg = await message(); const src = await sourceFor(msg.id, '历史译文');
    await settings().save({ ...draft, model: 'new-model', displayTargetLanguage: 'French', expectedRevision: 1 });
    await settings().save({ ...draft, enabled: false, expectedRevision: 2 });
    const before = await counts();
    expect((await service().listTeamRunOverlays(room.id, [msg.id])).items[0]).toMatchObject({ sourceId: src.id, translatedTextPreview: '历史译文', targetLanguage: 'Chinese', state: 'SUCCESS' });
    expect(await service().getTeamRunOverlay(room.id, msg.id)).toMatchObject({ translatedText: '历史译文', targetLanguage: 'Chinese' });
    expect(await counts()).toEqual(before); expect(transport).not.toHaveBeenCalled();
  });

  it('retries only one existing failed source using sourceRevision CAS and the current configuration', async () => {
    const first = await message(); const second = await message();
    const src = await sourceFor(first.id); const other = await sourceFor(second.id);
    await settings().save({ ...draft, model: 'current-model', displayTargetLanguage: 'French', expectedRevision: 1 });
    const instance = await app(); const retry = `/api/team-runs/${room.id}/translations/${src.id}/retry`;
    try {
      expect((await instance.inject({ method: 'POST', url: retry, payload: { expectedRevision: src.overlayRevision } })).statusCode).toBe(409);
      expect((await instance.inject({ method: 'POST', url: retry, payload: { expectedRevision: 3, text: 'forged' } })).statusCode).toBe(400);
      const attempts = await Promise.all([1, 2].map(() => instance.inject({ method: 'POST', url: retry, payload: { expectedRevision: 3 } })));
      expect(attempts.map(response => response.statusCode).sort()).toEqual([200, 409]);
      await service().start();
      await until(async () => (await db.translationSource.findUniqueOrThrow({ where: { id: src.id } })).jobState === 'SUCCESS');
      expect(transport).toHaveBeenCalledTimes(1);
      const body = JSON.parse(String(transport.mock.calls[0][1]?.body)); expect(body.model).toBe('current-model'); expect(body.messages.at(-1).content).toBe('French\nHello room');
      expect(await service().getTeamRunOverlay(room.id, first.id)).toMatchObject({ translatedText: 'Bonjour room', targetLanguage: 'French' });
      expect(await db.translationSource.findUnique({ where: { id: other.id } })).toEqual(other);
      expect((await instance.inject({ method: 'POST', url: retry, payload: { expectedRevision: 3 } })).statusCode).toBe(409);
      expect(await counts()).toEqual([2, 1, 0, 2, 0, 0, 0]);
    } finally { await instance.close(); }
  });

  it('rejects absent, cross-room and Session sources; disabled retries do not admit work', async () => {
    const msg = await message(); const src = await sourceFor(msg.id); const another = await newRoom();
    const conversation = await db.conversation.create({ data: { title: 'Session', directoryName: 'fixture', workingDir: dir } });
    const session = await db.session.create({ data: { conversationId: conversation.id, context: 'CONVERSATION', agentType: 'CODEX', prompt: 'Original' } });
    const sessionSrc = await service().registerSource({ kind: 'SESSION_BLOCK', sessionId: session.id, turnId: 'turn', blockId: 'block', semanticType: 'assistant_message', text: 'Hello', state: 'SEALED' });
    for (const [teamRunId, sourceId] of [[another.id, src.id], [room.id, 'absent'], [room.id, sessionSrc.id]]) await expect(service().retryTeamRunOverlay(teamRunId, sourceId, 3)).rejects.toMatchObject({ statusCode: 404 });
    expect((await service().listTeamRunOverlays(another.id, [msg.id])).items).toEqual([]);
    await expect(service().getTeamRunOverlay(another.id, msg.id)).rejects.toMatchObject({ statusCode: 404 });
    await settings().save({ ...draft, enabled: false, expectedRevision: 1 });
    await expect(service().retryTeamRunOverlay(room.id, src.id, 3)).rejects.toMatchObject({ statusCode: 409, code: 'TRANSLATION_DISABLED' });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(['PRIVATE', 'user', 'system', 'deleted-message', 'deleted-source', 'deleted-task', 'archived-project', 'changed-text', 'wrong-scope', 'wrong-key', 'wrong-message', 'wrong-direction'] as const)('rechecks current room/message/source eligibility: %s', async invalid => {
    const msg = await message(); const src = await sourceFor(msg.id, 'Never leak');
    if (invalid === 'PRIVATE') await db.roomMessage.update({ where: { id: msg.id }, data: { visibility: 'PRIVATE' } });
    if (invalid === 'user' || invalid === 'system') await db.roomMessage.update({ where: { id: msg.id }, data: { senderType: invalid } });
    if (invalid === 'deleted-message') await db.roomMessage.delete({ where: { id: msg.id } });
    if (invalid === 'deleted-source') await db.translationSource.update({ where: { id: src.id }, data: { deletedAt: new Date() } });
    if (invalid === 'deleted-task') await db.task.update({ where: { id: room.taskId }, data: { deletedAt: new Date() } });
    if (invalid === 'archived-project') await db.project.update({ where: { id: room.projectId }, data: { archivedAt: new Date() } });
    if (invalid === 'changed-text') await db.roomMessage.update({ where: { id: msg.id }, data: { content: 'Changed body' } });
    if (invalid === 'wrong-scope') await db.translationSource.update({ where: { id: src.id }, data: { scopeId: (await newRoom()).id } });
    if (invalid === 'wrong-key') await db.translationSource.update({ where: { id: src.id }, data: { sourceKey: 'different-message' } });
    if (invalid === 'wrong-message') await db.translationSource.update({ where: { id: src.id }, data: { messageId: (await message()).id } });
    if (invalid === 'wrong-direction') await db.translationSource.update({ where: { id: src.id }, data: { direction: 'SEND' } });
    await db.translationSource.update({ where: { id: src.id }, data: { jobState: 'FAILED' } });
    const before = await counts(); const instance = await app();
    try {
      const list = await instance.inject(`/api/team-runs/${room.id}/translations?messageIds=${msg.id}`);
      expect(list.statusCode).toBe(['deleted-task', 'archived-project'].includes(invalid) ? 404 : 200);
      if (list.statusCode === 200) expect(list.json()).toEqual({ items: [] });
      expect((await instance.inject(`/api/team-runs/${room.id}/messages/${msg.id}/translation`)).statusCode).toBe(404);
      expect((await instance.inject({ method: 'POST', url: `/api/team-runs/${room.id}/translations/${src.id}/retry`, payload: { expectedRevision: 3 } })).statusCode).toBe(404);
      await expect(service().assertReadableRoomTranslation(room.id, msg.id, src.id)).rejects.toMatchObject({ statusCode: 404 });
    } finally { await instance.close(); }
    expect(await counts()).toEqual(before); expect(transport).not.toHaveBeenCalled();
  });

  it('does not select a foreign or superseded effective attempt', async () => {
    const first = await message(); const src = await sourceFor(first.id, 'Current');
    const second = await message(); const other = await sourceFor(second.id, 'Foreign');
    for (const patch of [{ effectiveAttemptId: other.effectiveAttemptId }, { effectiveAttemptId: src.effectiveAttemptId, sourceRevision: 4 }]) {
      await db.translationSource.update({ where: { id: src.id }, data: patch });
      expect((await service().listTeamRunOverlays(room.id, [first.id])).items[0].translatedTextPreview).toBeNull();
      expect((await service().getTeamRunOverlay(room.id, first.id)).translatedText).toBeNull();
    }
  });

  it.each([false, true])('keeps owner auth, Agent denial and same-origin writes with password=%s', async enabled => {
    await db.accessAuthSettings.create({ data: { enabled, sessionSecret: 'isolated-auth-secret' } }); auth.__test.resetSettingsCache();
    const cookie = `agent-tower-access=${await auth.createBrowserSessionToken()}`;
    const msg = await message(); const src = await sourceFor(msg.id);
    const agentCredential = credentials.createAgentApiCredential({ sessionId: 'fixture-agent', invocationId: null });
    const instance = await app();
    const requests = [
      { method: 'GET' as const, url: `/api/team-runs/${room.id}/translations?messageIds=${msg.id}` },
      { method: 'GET' as const, url: `/api/team-runs/${room.id}/messages/${msg.id}/translation` },
      { method: 'POST' as const, url: `/api/team-runs/${room.id}/translations/${src.id}/retry`, payload: { expectedRevision: 3 } },
    ];
    try {
      for (const request of requests) expect((await instance.inject({ ...request, headers: { 'x-agent-tower-agent-credential': agentCredential } })).statusCode).toBe(403);
      expect((await instance.inject(requests[0])).statusCode).toBe(enabled ? 401 : 200);
      expect((await instance.inject({ ...requests[1], headers: { cookie } })).statusCode).toBe(200);
      expect((await instance.inject({ ...requests[2], headers: { cookie, host: 'localhost', origin: 'https://foreign.test' } })).statusCode).toBe(403);
      expect((await instance.inject({ ...requests[2], headers: { cookie, host: 'localhost', origin: 'http://localhost' } })).statusCode).toBe(200);
    } finally { await instance.close(); }
  });

  it('routes body-free invalidations only to the concrete room and current owner; rechecks scope on every forward', async () => {
    const msg = await message(); const src = await sourceFor(msg.id); const another = await newRoom();
    const { gateway, socket, subscribe, notifications, nsp } = gatewayFixture();
    const owner = socket('owner'); const other = socket('other'); const all = socket('all'); const agent = socket('agent'); const internal = socket('internal'); const stale = socket('stale');
    agent.request.headers['x-agent-tower-agent-credential'] = 'fixture'; internal.request.headers['x-agent-tower-internal-token'] = 'fixture'; stale.accessAuthSessionSecretGeneration = -1;
    const event: TranslationInvalidatedPayload = { teamRunId: room.id, messageId: msg.id, sourceId: src.id, sourceRevision: 3, overlayRevision: 8 };
    const emit = async (payload = event) => { fixture.bus!.emit('translation:invalidated', payload); await until(async () => (await service().listTeamRunOverlays(room.id, [])).items.length === 0); await new Promise(resolve => setTimeout(resolve, 20)); };
    try {
      expect(await subscribe(owner, room.id)).toEqual({ success: true }); expect(await subscribe(other, another.id)).toEqual({ success: true });
      for (const [target, id] of [[all, undefined], [all, 'all'], [agent, room.id], [internal, room.id], [stale, room.id]] as const) expect(await subscribe(target, id)).toMatchObject({ success: false });
      await service().retryTeamRunOverlay(room.id, src.id, 3); await until(async () => notifications(owner).length === 1);
      expect(notifications(owner)).toEqual([{ event: ServerEvents.TRANSLATION_INVALIDATED, payload: event }]);
      for (const target of [other, all, agent, internal, stale]) expect(notifications(target)).toEqual([]);
      expect(owner.emitted.map(item => item.event)).toEqual([ServerEvents.TRANSLATION_INVALIDATED]);
      await emit({ ...event, sourceId: 'foreign-source' }); expect(notifications(owner)).toHaveLength(1);
      await emit({ ...event, messageId: (await message()).id }); expect(notifications(owner)).toHaveLength(1);
      await new Promise(resolve => owner.receive(ClientEvents.UNSUBSCRIBE, { topic: 'team-run', id: room.id }, resolve));
      expect(nsp.adapter.rooms.get(`team-run:${room.id}`)?.has(owner.id)).toBe(false);
      await emit(); expect(notifications(owner)).toHaveLength(1);
      await subscribe(owner, room.id); owner.request.headers['x-agent-tower-agent-credential'] = 'late-agent'; await emit(); expect(notifications(owner)).toHaveLength(1);
      delete owner.request.headers['x-agent-tower-agent-credential'];
      await db.roomMessage.update({ where: { id: msg.id }, data: { visibility: 'PRIVATE' } }); await emit(); expect(notifications(owner)).toHaveLength(1);
      auth.__test.notifySessionSecretRotated(); await emit(); expect(notifications(owner)).toHaveLength(1);
      gateway.destroy();
    } finally { gateway.destroy(); }
  });

  it('rejects naturally expired Socket cookies on subscribe and forward without a secret rotation', async () => {
    const record = await db.accessAuthSettings.create({ data: { enabled: true, sessionSecret: 'isolated-auth-secret' } }); auth.__test.resetSettingsCache();
    const baseTime = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(baseTime);
    const token = auth.__test.createSessionToken(record);
    const msg = await message(); const src = await sourceFor(msg.id);
    const { gateway, socket, subscribe, notifications } = gatewayFixture(); const owner = socket('owner'); owner.request.headers.cookie = `agent-tower-access=${token}`;
    try {
      expect(await subscribe(owner, room.id)).toEqual({ success: true }); const generation = auth.getSessionSecretGeneration();
      fixture.bus!.emit('translation:invalidated', { teamRunId: room.id, messageId: msg.id, sourceId: src.id, sourceRevision: 3, overlayRevision: 7 });
      await until(async () => notifications(owner).length === 1);
      clock.mockReturnValue(baseTime + 8 * 24 * 60 * 60 * 1000);
      expect(auth.getSessionSecretGeneration()).toBe(generation);
      fixture.bus!.emit('translation:invalidated', { teamRunId: room.id, messageId: msg.id, sourceId: src.id, sourceRevision: 3, overlayRevision: 8 });
      await new Promise(resolve => setTimeout(resolve, 30)); expect(notifications(owner)).toHaveLength(1);
      expect(await subscribe(owner, room.id)).toMatchObject({ success: false });
    } finally { clock.mockRestore(); gateway.destroy(); }
  });

  it('does not join a room after pending subscribe is revoked or auth becomes stale', async () => {
    const { gateway, socket, subscribe, nsp } = gatewayFixture(); const owner = socket('owner');
    let finish: () => void = () => {};
    vi.spyOn(service(), 'assertReadableTeamRun').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    try {
      const first = subscribe(owner, room.id); await until(async () => vi.mocked(service().assertReadableTeamRun).mock.calls.length === 1);
      owner.receive(ClientEvents.UNSUBSCRIBE, { topic: 'team-run', id: room.id }); finish();
      expect(await first).toMatchObject({ success: false }); expect(nsp.adapter.rooms.get(`team-run:${room.id}`)?.has(owner.id) ?? false).toBe(false);
      const second = subscribe(owner, room.id); await until(async () => vi.mocked(service().assertReadableTeamRun).mock.calls.length === 2);
      auth.__test.notifySessionSecretRotated(); finish();
      expect(await second).toMatchObject({ success: false }); expect(nsp.adapter.rooms.get(`team-run:${room.id}`)?.has(owner.id) ?? false).toBe(false);
    } finally { gateway.destroy(); }
  });
});
