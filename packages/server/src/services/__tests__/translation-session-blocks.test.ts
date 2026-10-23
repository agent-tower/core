import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TranslationService } from '../translation.service.js';
import { TranslationSettingsService } from '../translation-settings.service.js';
import { TranslationClient } from '../translation-client.js';
import { TranslationQueue } from '../translation-queue.js';
import { sessionMsgStoreManager } from '../../output/msg-store.js';
import { GeminiParser } from '../../output/gemini-parser.js';
import { createAssistantMessage } from '../../output/types.js';
import { addNormalizedEntry, updateEntryContent } from '../../output/utils/patch.js';
import { reconcileAcpHistoryEntries } from '../../runtime/acp/history-reconciler.js';
import { AcpProjector } from '../../runtime/acp/projector.js';
import { MsgStore } from '../../output/msg-store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-block-overlay-'));
const url = `file:${path.join(dir, 'test.db')}`;
const db = new PrismaClient({ datasources: { db: { url } } });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 4000;
  while (!await check()) { if (Date.now() > deadline) throw new Error('Timed out'); await pause(5); }
}
function response(content: string) { return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] })); }

describe('durable Session block overlays', () => {
  let settings: TranslationSettingsService;
  let service: TranslationService;
  let sessionId: string;
  let release: Array<() => void>;
  let payloads: string[];
  let persist: Promise<void>;
  let failOnce: Set<string>;
  beforeAll(() => {
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', `--schema=${path.join(root, 'prisma/schema.prisma')}`], { cwd: root, env: { ...process.env, AGENT_TOWER_DATABASE_URL: url }, stdio: 'pipe' });
  });
  beforeEach(async () => {
    await db.translationAttempt.deleteMany(); await db.translationSource.deleteMany(); await db.translationSettings.deleteMany(); await db.conversation.deleteMany();
    const conversation = await db.conversation.create({ data: { title: 'Overlay', directoryName: 'overlay', workingDir: dir } });
    sessionId = (await db.session.create({ data: { conversationId: conversation.id, context: 'CONVERSATION', agentType: 'GEMINI_CLI', prompt: 'user', status: 'RUNNING' } })).id;
    settings = new TranslationSettingsService(db);
    await settings.save({ expectedRevision: 0, enabled: true, apiBaseUrl: 'https://translator.test/v1', apiKey: { action: 'replace', value: '' }, model: 'translation', sendTargetLanguage: 'English', displayTargetLanguage: 'Chinese', promptTemplate: '{{target_language}}\n{{text}}', maxConcurrency: 2 });
    release = []; payloads = []; persist = Promise.resolve(); failOnce = new Set();
    service = make(); await service.start();
  });
  function make(queue?: TranslationQueue, retryDelays = [10, 10]) {
    return new TranslationService(db, settings, { queue, client: new TranslationClient({ fetchImpl: async (_url, init) => {
      const text = JSON.parse(String(init?.body)).messages.at(-1).content.split('\n').slice(1).join('\n');
      payloads.push(text);
      if (failOnce.delete(text)) return new Response('', { status: 503 });
      await new Promise<void>(resolve => release.push(resolve));
      // Preserve protection boundary tokens, as a conforming translator does.
      const start = text.match(/^⟦AT_[a-f0-9]{24}_\d+⟧/)?.[0] ?? '';
      return response(start + 'Translated ' + text.slice(start.length));
    }, timeoutMs: 1000 }), limits: { tickMs: 10, retryDelays } });
  }
  afterEach(async () => { for (const resolve of release) resolve(); await persist; await service.shutdown(); sessionMsgStoreManager.delete(sessionId); });
  afterAll(async () => { await db.$disconnect(); fs.rmSync(dir, { recursive: true, force: true }); });
  function store() {
    const store = sessionMsgStoreManager.getOrCreate(sessionId);
    store.textBlocks.admission = service.getAdmissionEpoch;
    store.textBlocks.begin('turn');
    store.onTextBlock(entry => {
      if (entry.metadata?.textBlock?.state === 'OPEN' && entry.metadata.textBlock.sourceRevision === 1 && !entry.metadata.textBlock.paragraphs?.length) return;
      // Same boundary contract used by SessionManager: one durable original checkpoint,
      // then independent observer admission. Nothing on the raw output path awaits it.
      persist = persist.then(async () => {
        await db.session.update({ where: { id: sessionId }, data: { logSnapshot: JSON.stringify(store.getSnapshot()) } });
        service.checkpointCommitted(sessionId);
      });
    });
    return store;
  }
  async function overlays() { return (await service.listSessionOverlays(sessionId)).items; }

  it('publishes each paragraph while the final answer is still streaming and recovers without duplicate requests', async () => {
    const msgStore = store();
    const first = 'The first complete paragraph. '.repeat(12) + '\n\n';
    msgStore.pushPatch(addNormalizedEntry(0, createAssistantMessage(first + 'Unfinished tail')));
    await until(async () => payloads.length === 1);
    expect(payloads[0]).toContain('The first complete paragraph');
    expect(payloads[0]).not.toContain('Unfinished');
    release[0]();
    await until(async () => (await overlays()).some(row => row.originalText === first && row.state === 'SUCCESS'));
    const completed = (await overlays()).find(row => row.originalText === first)!;
    expect(completed.translatedText).toBe('Translated ' + first);
    expect(msgStore.getSnapshot().entries[0].metadata!.textBlock!.state).toBe('OPEN');
    msgStore.pushPatch(updateEntryContent(0, first + 'The final tail'));
    msgStore.textBlocks.end();
    await until(async () => payloads.length === 2);
    expect(payloads[1]).toBe('The final tail'); release[1]();
    await until(async () => (await overlays()).filter(row => row.state === 'SUCCESS').length === 2);
    expect((await overlays()).find(row => row.sourceId === completed.sourceId)).toEqual(completed);
    await persist; await service.shutdown(); sessionMsgStoreManager.delete(sessionId);
    service = make(); await service.start(); await service.syncSessionCheckpoint(sessionId);
    expect(payloads).toHaveLength(2); expect(await db.translationAttempt.count()).toBe(2);
    expect((await overlays()).map(row => row.originalText).sort()).toEqual([first, 'The final tail'].sort());
  });

  it('rejects a paragraph result after a prefix rewrite and lets the revised paragraph reuse its source', async () => {
    const msgStore = store();
    const first = 'Original paragraph. '.repeat(20) + '\n\n';
    msgStore.pushPatch(addNormalizedEntry(0, createAssistantMessage(first + 'tail')));
    await until(async () => payloads.length === 1);
    const source = (await overlays()).find(row => row.originalText === first)!;
    msgStore.pushPatch(updateEntryContent(0, 'Revised prefix'));
    release[0]();
    await persist; await service.syncSessionCheckpoint(sessionId);
    expect((await overlays()).some(row => row.translatedText)).toBe(false);
    const revised = 'Revised paragraph. '.repeat(20) + '\n\n';
    msgStore.pushPatch(updateEntryContent(0, revised + 'tail'));
    await until(async () => payloads.length === 2); release[1]();
    await until(async () => (await overlays()).some(row => row.originalText === revised && row.state === 'SUCCESS'));
    expect((await overlays()).find(row => row.originalText === revised)).toMatchObject({ sourceId: source.sourceId, sourceRevision: 2 });
    expect((await db.translationSource.findUniqueOrThrow({ where: { id: source.sourceId } })).deletedAt).toBeNull();
  });

  it('retains completed paragraph translations when a streaming reply is cancelled and never sends its tail', async () => {
    const msgStore = store();
    const first = 'Complete paragraph before cancellation. '.repeat(10) + '\n\n';
    msgStore.pushPatch(addNormalizedEntry(0, createAssistantMessage(first + 'cancelled unfinished tail')));
    await until(async () => payloads.length === 1);
    msgStore.textBlocks.end(true); release[0]();
    await until(async () => (await overlays()).some(row => row.state === 'SUCCESS'));
    await persist; await service.syncSessionCheckpoint(sessionId); await service.pump();
    expect(payloads).toHaveLength(1);
    expect((await overlays()).find(row => row.originalText === first)?.translatedText).toBe('Translated ' + first);
  });

  it.each(['PENDING', 'RETRY_WAIT'])('does not tombstone a queued %s version revised before its checkpoint', async (state) => {
    await service.shutdown();
    const { id: _id, revision, enableEpoch: _epoch, credentialRevision: _credential, keyConfigured: _key, ...config } = await settings.getPublic();
    await settings.save({ ...config, expectedRevision: revision, maxConcurrency: 1, apiKey: { action: 'keep' } });
    const queue = new TranslationQueue({ maxConcurrency: 1 });
    service = make(queue, [60_000]); await service.start();
    // Deliberately omit the checkpoint observer: the in-memory revision wins the race.
    const msgStore = sessionMsgStoreManager.getOrCreate(sessionId);
    msgStore.textBlocks.admission = service.getAdmissionEpoch; msgStore.textBlocks.begin('queued-turn');
    const checkpoint = async () => {
      await db.session.update({ where: { id: sessionId }, data: { logSnapshot: JSON.stringify(msgStore.getSnapshot()) } });
      await service.syncSessionCheckpoint(sessionId);
    };
    if (state === 'RETRY_WAIT') {
      failOnce.add('Queued old body');
      msgStore.pushPatch(addNormalizedEntry(0, createAssistantMessage('Queued old body'))); msgStore.textBlocks.complete(0);
      await checkpoint();
      await until(async () => (await db.translationSource.findFirst())?.jobState === 'RETRY_WAIT');
      await db.translationSource.updateMany({ data: { nextRetryAt: new Date(Date.now() + 60_000) } });
    }
    const blockerIndex = state === 'RETRY_WAIT' ? 1 : 0;
    msgStore.pushPatch(addNormalizedEntry(blockerIndex, createAssistantMessage('Blocker body'))); msgStore.textBlocks.complete(blockerIndex);
    await checkpoint(); await until(async () => payloads.includes('Blocker body'));
    const targetIndex = state === 'RETRY_WAIT' ? 0 : 1;
    if (state === 'PENDING') {
      msgStore.pushPatch(addNormalizedEntry(targetIndex, createAssistantMessage('Queued old body'))); msgStore.textBlocks.complete(targetIndex);
      await checkpoint();
    } else await db.translationSource.updateMany({ where: { originalText: 'Queued old body' }, data: { nextRetryAt: new Date(0) } });
    await service.pump(); await until(async () => queue.stats.pending === 1);
    const original = await db.translationSource.findFirstOrThrow({ where: { originalText: 'Queued old body' } });
    expect(original.jobState).toBe(state);
    msgStore.pushPatch(updateEntryContent(targetIndex, 'Queued revised body')); msgStore.textBlocks.complete(targetIndex);
    const oldRequests = payloads.filter(text => text === 'Queued old body').length;
    expect(oldRequests).toBe(state === 'RETRY_WAIT' ? 1 : 0);
    release[0]();
    await until(async () => (await db.translationSource.findUniqueOrThrow({ where: { id: original.id } })).jobState === 'CANCELLED');
    const stale = await db.translationSource.findUniqueOrThrow({ where: { id: original.id } });
    expect(stale.deletedAt).toBeNull(); expect(stale.errorCode).toBe('SOURCE_CHANGED');
    expect(payloads.filter(text => text === 'Queued old body')).toHaveLength(oldRequests);
    await checkpoint(); await until(async () => payloads.includes('Queued revised body')); release.at(-1)!();
    await until(async () => (await db.translationSource.findUniqueOrThrow({ where: { id: original.id } })).jobState === 'SUCCESS');
    const next = await db.translationSource.findUniqueOrThrow({ where: { id: original.id } });
    expect(next.blockId).toBe(original.blockId); expect(next.sourceRevision).toBe(2); expect(next.deletedAt).toBeNull();
  });

  it('starts A while tools continue, closes B on turn end, and completion never mutates runtime logs/status', async () => {
    const msgStore = store(); const parser = new GeminiParser(msgStore);
    let patches = 0; msgStore.onPatch(() => patches++);
    const notifications: unknown[] = []; service.onInvalidated(payload => notifications.push(payload));
    const feed = (value: object) => parser.processData(`${JSON.stringify(value)}\n`);
    feed({ type: 'message', role: 'assistant', content: 'First body', delta: true });
    expect(payloads).toHaveLength(0);
    feed({ type: 'tool_use', tool_id: 't', tool_name: 'shell', parameters: { command: 'TOOL_ARGUMENT_SECRET' } });
    await until(async () => payloads.length === 1);
    expect(payloads[0]).toBe('First body');
    feed({ type: 'tool_result', tool_id: 't', status: 'success', output: 'TOOL_RESULT_SECRET' });
    feed({ type: 'message', role: 'assistant', content: 'Last body', delta: true });
    expect(payloads).toHaveLength(1);
    msgStore.textBlocks.end();
    await db.session.update({ where: { id: sessionId }, data: { status: 'COMPLETED' } });
    await until(async () => payloads.length === 2);
    const before = patches; const snapshot = JSON.stringify(msgStore.getSnapshot());
    release.forEach(resolve => resolve());
    await until(async () => (await overlays()).filter(row => row.state === 'SUCCESS').length === 2);
    expect(patches).toBe(before); expect(JSON.stringify(msgStore.getSnapshot())).toBe(snapshot);
    expect((await db.session.findUniqueOrThrow({ where: { id: sessionId } })).status).toBe('COMPLETED');
    expect(JSON.stringify(payloads)).not.toContain('SECRET');
    expect(notifications.length).toBeGreaterThan(0); expect(JSON.stringify(notifications)).not.toContain('body');
  });

  it('rejects a late result immediately after in-memory source revision, before checkpoint observer catches up', async () => {
    const msgStore = store();
    msgStore.pushPatch(addNormalizedEntry(0, createAssistantMessage('Original body'))); msgStore.textBlocks.complete(0);
    await until(async () => payloads.length === 1);
    const original = (await overlays())[0];
    msgStore.pushPatch(updateEntryContent(0, 'Revised body'));
    release[0]();
    await pause(25);
    expect((await overlays()).some(row => row.translatedText?.includes('Original'))).toBe(false);
    msgStore.textBlocks.complete(0);
    await until(async () => payloads.length === 2); release[1]();
    await until(async () => (await overlays())[0]?.state === 'SUCCESS');
    const next = (await overlays())[0];
    expect(next.sourceId).toBe(original.sourceId); expect(next.blockId).toBe(original.blockId);
    expect(next.sourceRevision).toBe(2); expect(next.translatedText).toBe('Translated Revised body');
  });

  it('restarts from marked boundary checkpoints, dedupes success/replay, and leaves static history alone', async () => {
    const msgStore = store();
    msgStore.pushPatch(addNormalizedEntry(0, createAssistantMessage('Recover this body'))); msgStore.textBlocks.complete(0);
    await until(async () => payloads.length === 1); release[0]();
    await until(async () => (await overlays())[0]?.state === 'SUCCESS');
    const previous = (await overlays())[0]; await persist; await service.shutdown();
    // ACP session/load replay must preserve the original block identity on equal text.
    const replay = reconcileAcpHistoryEntries(msgStore.getSnapshot().entries, [createAssistantMessage('Recover this body')]);
    expect(replay).toBeUndefined();
    sessionMsgStoreManager.delete(sessionId);
    const staticConversation = await db.conversation.create({ data: { title: 'Static', directoryName: 'static', workingDir: dir } });
    await db.session.create({ data: { conversationId: staticConversation.id, context: 'CONVERSATION', agentType: 'CODEX', prompt: 'old', logSnapshot: JSON.stringify({ entries: [createAssistantMessage('Static history secret')] }) } });
    service = make(); await service.start(); await pause(25);
    expect(payloads).toHaveLength(1); expect((await overlays())[0]).toEqual(previous);
    expect(await db.translationSource.count()).toBe(1);
  });

  it('invalidates a successful overlay on a real ACP load revision without translating historical replay', async () => {
    const msgStore = store();
    const project = (target: MsgStore, text: string) => new AcpProjector(target, { stream() {}, async process() {} }).project({
      sessionId: 'native', update: { sessionUpdate: 'agent_message_chunk', messageId: 'message-1', content: { type: 'text', text } },
    } as never);
    project(msgStore, 'The answer is incorrect'); msgStore.textBlocks.end();
    await until(async () => payloads.length === 1); release[0]();
    await until(async () => (await overlays())[0]?.state === 'SUCCESS'); await persist;
    const original = (await overlays())[0]; const replay = new MsgStore(); project(replay, 'The answer is corrected');
    const entries = reconcileAcpHistoryEntries(msgStore.getSnapshot().entries, replay.getSnapshot().entries)!;
    expect(entries).toHaveLength(1);
    expect(entries[0].metadata!.textBlock).toMatchObject({ blockId: original.blockId, sourceRevision: 2 });
    msgStore.pushPatch([{ op: 'replace', path: '/entries', value: entries }]);
    expect(await overlays()).toEqual([]);
    await db.session.update({ where: { id: sessionId }, data: { logSnapshot: JSON.stringify(msgStore.getSnapshot()) } });
    await service.syncSessionCheckpoint(sessionId); await service.pump();
    expect(payloads).toHaveLength(1); expect(await db.translationSource.count()).toBe(1);
  });

  it.each(['user turn boundary', 'later exact identity'])('rejects old SQLite overlays after ACP recovery with %s', async (scenario) => {
    const msgStore = store();
    const projector = () => new AcpProjector(msgStore, { stream() {}, async process() {} });
    const send = (target: AcpProjector, messageId: string, text: string, sessionUpdate = 'agent_message_chunk') => target.project({
      sessionId: 'native', update: { sessionUpdate, messageId, content: { type: 'text', text } },
    } as never);
    if (scenario === 'user turn boundary') {
      for (let turn = 1; turn <= 2; turn++) {
        if (turn === 2) msgStore.textBlocks.begin('turn-2');
        const live = projector();
        send(live, `user-${turn}`, `User ${turn}`, 'user_message_chunk');
        send(live, 'reused', `Original answer ${turn}`);
        msgStore.textBlocks.end();
      }
    } else {
      const live = projector();
      send(live, 'a', 'First'); send(live, 'b', 'Shared'); msgStore.textBlocks.end();
    }
    await until(async () => payloads.length === 2); release.forEach(resolve => resolve());
    await until(async () => (await overlays()).filter(row => row.state === 'SUCCESS').length === 2);
    await persist;
    const original = msgStore.getSnapshot().entries;
    const sources = await db.translationSource.findMany({ orderBy: { originalText: 'asc' } });
    expect(sources).toHaveLength(2);
    const replay = new MsgStore();
    const load = new AcpProjector(replay, { stream() {}, async process() {} });
    const corrected = scenario === 'user turn boundary' ? ['Revised answer 1', 'Revised answer 2'] : ['First corrected', 'Shared corrected'];
    if (scenario === 'user turn boundary') {
      for (let turn = 1; turn <= 2; turn++) {
        send(load, `user-${turn}`, `User ${turn}`, 'user_message_chunk');
        send(load, 'reused', corrected[turn - 1]);
      }
    } else {
      send(load, 'new', 'Shared'); send(load, 'a', corrected[0]); send(load, 'b', corrected[1]);
    }
    const entries = reconcileAcpHistoryEntries(original, replay.getSnapshot().entries)!;
    msgStore.pushPatch([{ op: 'replace', path: '/entries', value: entries }]);
    // Read against the real current MsgStore before the durable checkpoint catches up.
    expect(await overlays()).toEqual([]);
    expect(entries.map(e => e.content)).toEqual([...corrected, ...(scenario === 'later exact identity' ? ['Shared'] : [])]);
    for (let index = 0; index < original.length; index++) {
      expect(entries[index].id).toBe(original[index].id);
      expect(entries[index].metadata!.textBlock).toMatchObject({
        blockId: original[index].metadata!.textBlock!.blockId,
        turnId: original[index].metadata!.textBlock!.turnId,
        runtimeGeneration: original[index].metadata!.textBlock!.runtimeGeneration,
        sourceRevision: 2, state: 'OPEN',
      });
      expect(entries[index].metadata!.textBlock!.sealedReason).toBeUndefined();
      expect(entries[index].metadata!.textBlock!.translationEpoch).toBeUndefined();
    }
    expect(reconcileAcpHistoryEntries(entries, replay.getSnapshot().entries)).toBeUndefined();
    await db.session.update({ where: { id: sessionId }, data: { logSnapshot: JSON.stringify(msgStore.getSnapshot()) } });
    await service.syncSessionCheckpoint(sessionId); await service.pump();
    // Also read through SQLite alone, with no live store to mask a stale snapshot.
    sessionMsgStoreManager.delete(sessionId);
    expect(await overlays()).toEqual([]);
    expect(payloads).toHaveLength(2);
    expect(await db.translationAttempt.count()).toBe(2);
    expect(await db.translationSource.findMany({ orderBy: { originalText: 'asc' } })).toEqual(sources);
  });

  it('recovers a SEALED checkpoint whose observer failed before registration; repeated recovery creates one source', async () => {
    const msgStore = sessionMsgStoreManager.getOrCreate(sessionId);
    msgStore.textBlocks.admission = service.getAdmissionEpoch; msgStore.textBlocks.begin('crash-turn');
    msgStore.pushPatch(addNormalizedEntry(0, createAssistantMessage('Durable unregistered body'))); msgStore.textBlocks.complete(0);
    await db.session.update({ where: { id: sessionId }, data: { logSnapshot: JSON.stringify(msgStore.getSnapshot()) } });
    await service.shutdown(); sessionMsgStoreManager.delete(sessionId);
    service = make(); await service.start(); await service.syncSessionCheckpoint(sessionId);
    await until(async () => payloads.length === 1); release[0]();
    await until(async () => (await overlays())[0]?.state === 'SUCCESS');
    expect(await db.translationSource.count()).toBe(1); expect(await db.translationAttempt.count()).toBe(1);
  });

  it('omits removed blocks, rejects foreign retries, and rejects deleted conversations before returning overlays', async () => {
    const msgStore = store(); msgStore.pushPatch(addNormalizedEntry(0, createAssistantMessage('Body'))); msgStore.textBlocks.complete(0);
    await until(async () => payloads.length === 1);
    const source = (await overlays())[0];
    await expect(service.retrySessionOverlay(sessionId, 'foreign-source', 1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    msgStore.pushPatch([{ op: 'replace', path: '/entries', value: [] }]); release[0]();
    await pause(25); expect(await overlays()).toEqual([]);
    await db.session.update({ where: { id: sessionId }, data: { logSnapshot: JSON.stringify(msgStore.getSnapshot()) } });
    await service.syncSessionCheckpoint(sessionId);
    expect((await db.translationSource.findUniqueOrThrow({ where: { id: source.sourceId } })).deletedAt).not.toBeNull();
    const session = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
    await db.conversation.update({ where: { id: session.conversationId! }, data: { deletedAt: new Date() } });
    await expect(overlays()).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('disabled and internal output never obtains admission markers or new sources', async () => {
    const { id: _id, revision, enableEpoch: _epoch, credentialRevision: _credential, keyConfigured: _key, ...fields } = await settings.getPublic();
    await settings.save({ ...fields, expectedRevision: revision, enabled: false, apiKey: { action: 'keep' } });
    const msgStore = store(); msgStore.pushPatch(addNormalizedEntry(0, createAssistantMessage('Disabled body'))); msgStore.textBlocks.end();
    await persist; await service.syncSessionCheckpoint(sessionId); expect(await db.translationSource.count()).toBe(0); expect(payloads).toHaveLength(0);
    await db.session.update({ where: { id: sessionId }, data: { purpose: 'COMMIT_MESSAGE' } });
    await expect(service.listSessionOverlays(sessionId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
