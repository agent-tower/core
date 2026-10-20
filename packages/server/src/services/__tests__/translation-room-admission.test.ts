import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { PrismaClient } from '@prisma/client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranslationService } from '../translation.service.js';
import { TranslationClient } from '../translation-client.js';
import { TranslationSettingsService } from '../translation-settings.service.js';
import { EventBus } from '../../core/event-bus.js';
import { synchronizeDatabaseSchema } from '../../utils/database-schema.js';
import type { TranslationSettingsDraft } from '@agent-tower/shared';

const state = vi.hoisted(() => ({ translation: null as TranslationService | null, settings: null as TranslationSettingsService | null, bus: null as EventBus | null }));
vi.mock('../../core/container.js', async original => ({ ...await original<typeof import('../../core/container.js')>(), getTranslationService: () => state.translation!, getTranslationSettingsService: () => state.settings!, getEventBus: () => state.bus!, getSessionManager: () => ({ hasActiveTurn: () => true, hasRuntimeProcessOwner: () => true }) }));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-room-admission-'));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
process.env.AGENT_TOWER_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
process.env.AGENT_TOWER_DATA_DIR = dir;
let db: PrismaClient;
let TeamRunService: typeof import('../team-run.service.js').TeamRunService;
let TeamReconciler: typeof import('../team-reconciler.service.js').TeamReconcilerService;
let publish: InstanceType<typeof TeamRunService>;
let roomId: string;
let memberIds: string[];
const draft: TranslationSettingsDraft = { enabled: true, apiBaseUrl: 'http://controlled.invalid/v1', apiKey: { action: 'replace', value: '' }, model: 'fixture', sendTargetLanguage: 'English', displayTargetLanguage: 'Chinese', promptTemplate: '{{target_language}}\n{{text}}', maxConcurrency: 2 };
let services: TranslationService[] = [];
const fetcher = vi.fn<typeof fetch>();
const queryPages: number[] = [];
let publicationBarrier: { action: 'settings' | 'message'; reached: () => void; wait: Promise<void> } | undefined;
const until = async (check: () => Promise<boolean>) => {
  const end = Date.now() + 8000;
  while (!await check()) { if (Date.now() > end) throw new Error('Controlled fixture timeout'); await new Promise(r => setTimeout(r, 5)); }
};
function make(limits = {}) {
  const result = new TranslationService(db, state.settings!, { client: new TranslationClient({ fetchImpl: fetcher }), limits: { tickMs: 100_000, ...limits } });
  services.push(result); state.translation = result; return result;
}
async function save(changes: Partial<TranslationSettingsDraft> = {}) {
  const current = await state.settings!.getPublic();
  return state.settings!.save({ ...draft, ...changes, expectedRevision: current.revision });
}
async function message(content = 'Hello room', senderType: 'agent' | 'user' | 'system' = 'agent') {
  return publish.createRoomMessage(roomId, { content, senderType, ...(senderType === 'agent' ? { senderId: memberIds[0] } : {}) });
}
const scan = (service: TranslationService) => service['drainRoomMessages']();
const sources = () => db.translationSource.findMany({ orderBy: { sourceKey: 'asc' } });

describe('PUBLIC Agent durable admission through production publication and recovery', () => {
  beforeAll(async () => {
    await synchronizeDatabaseSchema({ dataDir: dir, dbPath: path.join(dir, 'test.db'), schemaPath: path.join(root, 'prisma/schema.prisma'), entryDir: path.join(root, 'src') });
    db = (await import('../../utils/index.js')).prisma;
    await (await import('../../utils/index.js')).initializeDatabaseRuntime();
    TeamRunService = (await import('../team-run.service.js')).TeamRunService;
    TeamReconciler = (await import('../team-reconciler.service.js')).TeamReconcilerService;
    db.$use(async (params, next) => {
      if (params.model === 'TranslationSource' && params.action === 'findMany' && params.args?.where?.sourceKey?.in) queryPages.push(params.args.where.sourceKey.in.length);
      const result = await next(params);
      if (publicationBarrier && (publicationBarrier.action === 'settings' && params.model === 'TranslationSettings' && params.action === 'findUnique' && params.args?.select?.enableEpoch || publicationBarrier.action === 'message' && params.model === 'RoomMessage' && params.action === 'create')) {
        const barrier = publicationBarrier; publicationBarrier = undefined; barrier.reached(); await barrier.wait;
      }
      return result;
    });
  }, 30_000);
  beforeEach(async () => {
    await db.translationSource.deleteMany(); await db.translationSettings.deleteMany(); await db.project.deleteMany(); await db.attachment.deleteMany();
    services = []; queryPages.length = 0; state.bus = new EventBus(); state.settings = new TranslationSettingsService(db); publish = new TeamRunService();
    fetcher.mockReset(); fetcher.mockImplementation(async (_url, init) => {
      const content = JSON.parse(String(init?.body)).messages.at(-1).content.split('\n').slice(1).join('\n').replaceAll('Hello', '你好');
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }));
    });
    const project = await db.project.create({ data: { name: 'Controlled room', repoPath: dir } });
    const task = await db.task.create({ data: { projectId: project.id, title: 'Original task' } });
    const room = await db.teamRun.create({ data: { taskId: task.id, mode: 'CONFIRM' } }); roomId = room.id;
    memberIds = [];
    for (const name of ['Sender', 'Recipient']) {
      const member = await db.teamMember.create({ data: { teamRunId: roomId, name, aliases: '[]', providerId: 'unused', rolePrompt: 'Never executed', capabilities: JSON.stringify({ readRoom: true, postRoomMessage: true, mentionMembers: true }), workspacePolicy: 'shared', triggerPolicy: 'MENTION_ONLY' } }); memberIds.push(member.id);
    }
    make();
  });
  afterEach(async () => { for (const service of services) await service.shutdown(); vi.restoreAllMocks(); });
  afterAll(async () => { await db.$disconnect(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('atomically captures DB epoch 0, leaves missing/disabled/user/system/private unmarked, and never upserts in publication', async () => {
    const absent = await message();
    expect((await db.roomMessage.findUniqueOrThrow({ where: { id: absent.id } })).translationEligibilityEpoch).toBeNull();
    expect(await db.translationSettings.count()).toBe(0);
    await save();
    const marked = await message();
    expect((await db.roomMessage.findUniqueOrThrow({ where: { id: marked.id } })).translationEligibilityEpoch).toBe(0);
    for (const sender of ['user', 'system'] as const) {
      const row = await message('Hello user', sender);
      expect((await db.roomMessage.findUniqueOrThrow({ where: { id: row.id } })).translationEligibilityEpoch).toBeNull();
    }
    const privateRow = await publish.createPrivateRoomMessage(roomId, { content: 'Hello private', senderType: 'agent', senderId: memberIds[0], recipientMemberIds: [memberIds[1]!] });
    expect((await db.roomMessage.findUniqueOrThrow({ where: { id: privateRow.id } })).translationEligibilityEpoch).toBeNull();
    await save({ enabled: false }); const disabled = await message();
    expect((await db.roomMessage.findUniqueOrThrow({ where: { id: disabled.id } })).translationEligibilityEpoch).toBeNull();
    await state.translation!.start();
    expect((await sources()).map(row => [row.messageId, row.enableEpoch, row.jobState])).toEqual([[marked.id, 0, 'PAUSED_DISABLED']]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('repairs commit-before-notification loss without backfilling NULL; old epoch pauses until explicit retry adopts current epoch', async () => {
    await message('Hello static history'); await save();
    vi.spyOn(state.translation!, 'roomMessageCommitted').mockImplementation(() => {});
    const lost = await message('Hello persisted before crash\n\n');
    expect(await sources()).toHaveLength(0);
    await state.translation!.shutdown();
    await save({ enabled: false }); await save();
    const recovered = make(); await recovered.start();
    const [paused] = await sources();
    expect(paused).toMatchObject({ messageId: lost.id, enableEpoch: 0, jobState: 'PAUSED_DISABLED', originalText: 'Hello persisted before crash\n\n' });
    expect(fetcher).not.toHaveBeenCalled();
    await recovered.retryTeamRunOverlay(roomId, paused!.id, paused!.sourceRevision);
    await until(async () => (await sources())[0]!.jobState === 'SUCCESS');
    const done = (await sources())[0]!;
    expect(done.enableEpoch).toBe(1); expect(await db.translationSource.count()).toBe(1);
    await save({ displayTargetLanguage: 'French' }); await save({ enabled: false });
    expect((await recovered.getTeamRunOverlay(roomId, lost.id)).targetLanguage).toBe('Chinese');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('uses real WAL transaction order during concurrent settings disable and publication, without partial message/dispatch', async () => {
    await save();
    const other = new PrismaClient({ datasources: { db: { url: process.env.AGENT_TOWER_DATABASE_URL } } });
    await other.$queryRawUnsafe('PRAGMA busy_timeout = 5000');
    const otherSettings = new TranslationSettingsService(other);
    const releases: Array<() => void> = [];
    const publishMention = () => publish.createRoomMessage(roomId, { content: 'Hello concurrent publication', senderType: 'agent', senderId: memberIds[0], mentions: [{ memberId: memberIds[1]! }] });
    const barrier = (action: 'settings' | 'message') => {
      let release!: () => void; let entered!: () => void;
      const reached = new Promise<void>(resolve => { entered = resolve; });
      publicationBarrier = { action, reached: entered, wait: new Promise<void>(resolve => { release = resolve; }) };
      releases.push(release);
      return { reached, release };
    };
    try {
      // The message holds its real write transaction before disable starts.
      const first = barrier('message'); const published = publishMention(); await first.reached;
      const disabling = otherSettings.save({ ...draft, enabled: false, expectedRevision: 1 });
      first.release(); const row = await published; await disabling;
      expect((await db.roomMessage.findUniqueOrThrow({ where: { id: row.id } })).translationEligibilityEpoch).toBe(0);
      expect(await db.workRequest.count()).toBe(1);
      await scan(state.translation!); expect((await sources())[0]!.jobState).toBe('PAUSED_DISABLED');
      await save();
      // Disable commits after the real admission SELECT but before its write.
      const second = barrier('settings'); const racing = publishMention().then(value => ({ value }), error => ({ error })); await second.reached;
      const current = await otherSettings.getPublic(); await otherSettings.save({ ...draft, enabled: false, expectedRevision: current.revision });
      second.release(); const outcome = await racing;
      // SQLite rejects a stale WAL snapshot upgrade; no half RoomMessage/WR.
      expect(outcome).toHaveProperty('error'); expect(await db.roomMessage.count()).toBe(1); expect(await db.workRequest.count()).toBe(1);
      const after = await publishMention();
      expect((await db.roomMessage.findUniqueOrThrow({ where: { id: after.id } })).translationEligibilityEpoch).toBeNull();
      expect(fetcher).not.toHaveBeenCalled();
      console.log('WAL concurrent publication: message-wins epoch=0; disable-wins stale snapshot rolled back; next publication epoch=NULL');
    } finally { publicationBarrier = undefined; releases.forEach(release => release()); await other.$disconnect(); }
  }, 20_000);

  it('bounds in-flight hot notifications and completes shutdown after a compensation read fails', async () => {
    await save(); const worker = state.translation!; await worker.start();
    let release!: () => void; let entered!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; }); const wait = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(worker as unknown as { recoverRoomMessages(): Promise<void> }, 'recoverRoomMessages').mockImplementationOnce(async () => { entered(); await wait; throw new Error('Controlled SQLite scan failure'); });
    const drains = vi.spyOn(worker as unknown as { drainRoomMessages(): Promise<void> }, 'drainRoomMessages');
    worker.roomMessageCommitted('first'); await reached;
    for (let i = 0; i < 1000; i++) worker.roomMessageCommitted(`in-flight-${i}`);
    expect(worker['pendingRoomMessages'].size).toBe(512); expect(drains).toHaveBeenCalledTimes(1);
    const stop = worker.shutdown(); release(); await stop;
    expect(worker['pendingRoomMessages'].size).toBe(0); expect(worker['roomCursor']).toBeUndefined(); expect(worker['roomUpperBound']).toBeUndefined();
  });

  it('uses bounded candidate pages before missing lookup, advances past poison/existing/tombstones, and wraps for low IDs', async () => {
    await save();
    const worker = state.translation!;
    for (let i = 0; i < 140; i++) await db.roomMessage.create({ data: { id: `row-${String(i).padStart(3, '0')}`, teamRunId: roomId, senderType: 'agent', kind: 'chat', content: 'Hello candidate', mentions: '[]', translationEligibilityEpoch: 0 } });
    const original = worker['registerRoomCandidate'].bind(worker);
    let poison = true;
    vi.spyOn(worker as unknown as { registerRoomCandidate(id: string): Promise<void> }, 'registerRoomCandidate').mockImplementation(async (id: string) => { if (id === 'row-001' && poison) throw new Error('Controlled single row failure'); await original(id); });
    // No attempts/network: all initially admitted sources are explicitly QUEUE_FULL.
    worker['limits'].sources = 0;
    await worker.start();
    expect(await db.translationSource.count()).toBe(63);
    expect(worker['roomCursor']?.id).toBe('row-063');
    expect(worker['roomUpperBound']?.id).toBe('row-139');
    await db.roomMessage.create({ data: { id: '000-low', teamRunId: roomId, senderType: 'agent', kind: 'chat', content: 'Hello late low ID', mentions: '[]', translationEligibilityEpoch: 0 } });
    await db.roomMessage.create({ data: { id: 'zzz-future', teamRunId: roomId, senderType: 'agent', kind: 'chat', content: 'Hello later epoch', mentions: '[]', translationEligibilityEpoch: 1 } });
    const existing = (await sources())[0]!;
    await db.translationSource.update({ where: { id: existing.id }, data: { deletedAt: new Date(), jobState: 'CANCELLED' } });
    await scan(worker); expect(worker['roomCursor']?.id).toBe('row-127');
    expect(worker['roomUpperBound']?.id).toBe('row-139');
    await scan(worker); expect(worker['roomUpperBound']).toBeUndefined();
    expect(await db.translationSource.count({ where: { messageId: 'zzz-future' } })).toBe(0);
    poison = false; await scan(worker); await scan(worker); await scan(worker);
    expect(await db.translationSource.count()).toBe(142);
    expect(await db.translationSource.findFirst({ where: { messageId: 'zzz-future' } })).toMatchObject({ enableEpoch: 1, jobState: 'PAUSED_DISABLED' });
    expect((await db.translationSource.findUniqueOrThrow({ where: { id: existing.id } })).deletedAt).not.toBeNull();
    expect((await sources()).filter(row => row.jobState === 'QUEUE_FULL')).toHaveLength(140);
    expect(queryPages.every(size => size <= 64)).toBe(true); expect(queryPages).toContain(64);
    const before = await sources(); await scan(worker); expect(await sources()).toEqual(before);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('bounds hot IDs and gives compensation a page while notifications keep arriving', async () => {
    await save(); const worker = state.translation!; worker['limits'].sources = 0;
    for (let i = 0; i < 600; i++) worker.roomMessageCommitted(`nonexistent-${i}`);
    expect(worker['pendingRoomMessages'].size).toBe(512);
    await db.roomMessage.create({ data: { id: 'cold-persisted', teamRunId: roomId, senderType: 'agent', kind: 'chat', content: 'Hello cold', mentions: '[]', translationEligibilityEpoch: 0 } });
    await worker.start();
    expect((await sources())[0]?.messageId).toBe('cold-persisted');
    expect(worker['pendingRoomMessages'].size).toBe(480);
    await worker.shutdown(); expect(worker['pendingRoomMessages'].size).toBe(0);
  });

  it('retains a source committed before its notification failure and never resets its failure or success on recovery', async () => {
    await save(); const worker = state.translation!;
    const row = await message();
    const notify = vi.spyOn(worker as unknown as { notify(id: string): Promise<void> }, 'notify').mockRejectedValue(new Error('Controlled post-commit notification loss'));
    await scan(worker);
    expect((await sources())[0]?.jobState).toBe('PENDING');
    notify.mockRestore();
    // A restart owns recovery; the existing unique source is never registered again.
    await worker.shutdown(); const before = (await sources())[0]!;
    const recovered = make(); await recovered.start();
    await until(async () => (await sources())[0]?.jobState === 'SUCCESS');
    expect(await db.translationSource.count()).toBe(1); expect((await sources())[0]!.id).toBe(before.id);
    expect((await recovered.getTeamRunOverlay(roomId, row.id)).originalText).toBe('Hello room');
  });

  it('MCP Agent credential → HTTP → createRoomMessage translates full protected text once without changing dispatch or execution', async () => {
    await save(); const worker = state.translation!;
    const workspace = await db.workspace.create({ data: { taskId: (await db.teamRun.findUniqueOrThrow({ where: { id: roomId } })).taskId, branchName: 'fixture', worktreePath: dir, workingDir: dir } });
    const session = await db.session.create({ data: { workspaceId: workspace.id, agentType: 'CODEX', status: 'RUNNING', prompt: 'Never spawn' } });
    const seed = await message('Invocation trigger', 'user');
    const request = await db.workRequest.create({ data: { teamRunId: roomId, targetMemberId: memberIds[0]!, requesterType: 'user', triggerMessageId: seed.id, instruction: 'Original instruction', status: 'STARTED' } });
    const invocation = await db.agentInvocation.create({ data: { teamRunId: roomId, memberId: memberIds[0]!, workRequestId: request.id, workspaceId: workspace.id, sessionId: session.id, status: 'RUNNING' } });
    const attachment = await db.attachment.create({ data: { originalName: 'proof.txt', mimeType: 'text/plain', storagePath: '/tmp/proof.txt', sizeBytes: 5, hash: 'fixture' } });
    const original = `Hello @Recipient\n\n${'Hello long paragraph. '.repeat(140)}\n\n\`\`\`ts\nconst exact = 1\n\`\`\`\n[proof](/tmp/proof.txt)\n::agent-download{file="output/proof.txt"}\n\n`;
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const transport = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (...args) => { await gate; return transport(...args); });
    const reconcile = vi.spyOn(TeamReconciler.prototype, 'handleAgentRoomMessage');
    const { accessAuthHook } = await import('../../middleware/access-auth.js');
    const { teamRunRoutes } = await import('../../routes/team-runs.js');
    const { systemRoutes } = await import('../../routes/system.js');
    const { createMcpServer } = await import('../../mcp/server.js');
    const { createAgentApiCredential, clearAgentApiCredentials } = await import('../../utils/agent-api-credential.js');
    const app = Fastify(); app.addHook('onRequest', accessAuthHook);
    await app.register(systemRoutes, { prefix: '/api' });
    await app.register(teamRunRoutes, { prefix: '/api', service: publish, scheduler: { startNextSessions: vi.fn() } as never });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address(); if (!address || typeof address === 'string') throw new Error('No fixture address');
    const previous = Object.fromEntries(['AGENT_TOWER_TEAM_RUN_ID', 'AGENT_TOWER_MEMBER_ID', 'AGENT_TOWER_INVOCATION_ID', 'AGENT_TOWER_SESSION_ID'].map(key => [key, process.env[key]]));
    Object.assign(process.env, { AGENT_TOWER_TEAM_RUN_ID: roomId, AGENT_TOWER_MEMBER_ID: memberIds[0], AGENT_TOWER_INVOCATION_ID: invocation.id, AGENT_TOWER_SESSION_ID: session.id });
    const server = await createMcpServer(`http://127.0.0.1:${address.port}`, { agentApiCredential: createAgentApiCredential({ sessionId: session.id, invocationId: invocation.id }) });
    const client = new Client({ name: 'controlled-room-fixture', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
    try {
      await worker.start();
      const result = await client.callTool({ name: 'post_room_message', arguments: { content: original, attachmentIds: [attachment.id], mentions: [{ memberId: memberIds[1]!, label: 'Recipient' }] } });
      expect(result.isError).not.toBe(true);
      const published = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
      expect(published).not.toHaveProperty('translationEligibilityEpoch');
      expect((await db.roomMessage.findUniqueOrThrow({ where: { id: published.id } })).translationEligibilityEpoch).toBe(0);
      const before = { content: (await db.roomMessage.findUniqueOrThrow({ where: { id: published.id } })).content, requests: await db.workRequest.findMany(), invocation: await db.agentInvocation.findUnique({ where: { id: invocation.id } }), session: await db.session.findUnique({ where: { id: session.id } }), reconcile: reconcile.mock.calls.length };
      expect(before.content).toBe(original); expect(before.reconcile).toBe(1);
      release(); await until(async () => (await db.translationSource.findFirst({ where: { messageId: published.id } }))?.jobState === 'SUCCESS');
      const overlay = await worker.getTeamRunOverlay(roomId, published.id);
      expect(overlay.originalText).toBe(original); expect(overlay.translatedText).toContain('你好'); expect(overlay.translatedText?.endsWith('\n\n')).toBe(true);
      expect(overlay.translatedText).toContain('::agent-download{file="output/proof.txt"}');
      expect(await db.workRequest.findMany()).toEqual(before.requests); expect(await db.agentInvocation.findUnique({ where: { id: invocation.id } })).toEqual(before.invocation); expect(await db.session.findUnique({ where: { id: session.id } })).toEqual(before.session); expect(reconcile).toHaveBeenCalledTimes(before.reconcile);
      const full = await client.callTool({ name: 'get_room_message', arguments: { message_id: published.id } });
      expect(JSON.parse((full.content as Array<{ text: string }>)[0]!.text).content).toBe(original);
      await scan(worker); expect(await db.translationSource.count({ where: { messageId: published.id } })).toBe(1);
    } finally {
      release(); await client.close(); await server.close(); await app.close(); clearAgentApiCredentials();
      for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  }, 20_000);
});
