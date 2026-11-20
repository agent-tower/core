/**
 * Read paths for a session's conversation log that avoid repeating the
 * expensive work of loading, parsing and re-serializing a multi-MB snapshot.
 *
 * - Live sessions are read from their in-memory MsgStore, as before.
 * - Persisted snapshots (`Session.logSnapshot`) are versioned by
 *   `Session.updatedAt`, which changes whenever the snapshot is written. The
 *   light view and the translation block index of a persisted snapshot are
 *   cached per version, so reopening a task or polling its translations no
 *   longer parses the whole log. The millisecond version is enough because
 *   the snapshot is written only while the session's MsgStore exists
 *   (`SessionManager.persistSnapshot`), the store is released after the final
 *   write, and this cache is consulted only when no store exists: a cached
 *   version always holds the last write of a turn.
 * - Full tool outputs for the light view's omitted entries come from a
 *   short-lived parsed copy, so expanding several items in a row parses once.
 *
 * Callers pass the database client (the global one, a service's injected
 * one or an interactive transaction); the reader never imports one itself.
 */
import {
  getTranslationTextBlocks,
  isTranslatableMessageType,
  type TranslationTextBlock,
} from '@agent-tower/shared';
import { sessionMsgStoreManager, type MsgStore } from '../output/msg-store.js';
import { findEntryContents, toLightConversation, type LogEntryContent, type LogEntryContentRequest } from '../output/log-view.js';
import type { NormalizedConversation, NormalizedEntry } from '../output/types.js';
import type { Prisma } from '@prisma/client';

/** A Prisma client or an interactive transaction's client. */
export type SessionLogDb = Pick<Prisma.TransactionClient, 'session'>;

/** Characters of cached light views and block text kept across all sessions. */
const PERSISTED_CACHE_CHAR_BUDGET = 24 * 1024 * 1024;
/** Parsed snapshots kept for entry-content reads. */
const PARSED_CACHE_SIZE = 2;
const PARSED_CACHE_TTL_MS = 60_000;

export interface TranslationBlockIndex {
  /** Paragraph-level blocks by `JSON.stringify([turnId, blockId])`. */
  blocks: Map<string, TranslationTextBlock>;
  /** Parent text blocks by `JSON.stringify([turnId, blockId])`. */
  parents: Set<string>;
}

interface PersistedCacheEntry {
  version: number;
  light?: string;
  blockIndex?: TranslationBlockIndex;
  chars: number;
}

interface ParsedEntry {
  version: number;
  conversation: NormalizedConversation;
  usedAt: number;
}

type LogVersionRow = { updatedAt: Date };
type PersistedLoad = Promise<{ version: number; conversation: NormalizedConversation } | null>;

function sessionTextBlock(entry: NormalizedEntry) {
  const block = entry?.metadata?.textBlock;
  return entry && isTranslatableMessageType(entry.entryType) && block?.semanticType === entry.entryType ? block : undefined;
}

export function buildTranslationBlockIndex(conversation: NormalizedConversation): TranslationBlockIndex {
  const blocks = new Map<string, TranslationTextBlock>();
  const parents = new Set<string>();
  for (const entry of Array.isArray(conversation.entries) ? conversation.entries : []) {
    const lifecycle = sessionTextBlock(entry);
    if (!lifecycle) continue;
    parents.add(JSON.stringify([lifecycle.turnId, lifecycle.blockId]));
    for (const block of getTranslationTextBlocks(entry.content, lifecycle)) {
      blocks.set(JSON.stringify([block.turnId, block.blockId]), block);
    }
  }
  return { blocks, parents };
}

function blockIndexChars(index: TranslationBlockIndex): number {
  let chars = 0;
  for (const block of index.blocks.values()) chars += block.content.length + 64;
  return chars + index.parents.size * 64;
}

/** Corrupt snapshots read as empty, matching the previous route behavior. */
function parseSnapshot(text: string): NormalizedConversation {
  try {
    const parsed = JSON.parse(text) as NormalizedConversation;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) return { entries: [], seq: 0 };
    if (typeof parsed.seq !== 'number') parsed.seq = 0;
    return parsed;
  } catch {
    return { entries: [], seq: 0 };
  }
}

export class SessionLogReader {
  private readonly persisted = new Map<string, PersistedCacheEntry>();
  private persistedChars = 0;
  private readonly parsed = new Map<string, ParsedEntry>();
  private readonly liveBlocks = new WeakMap<MsgStore, { seq: number; index: TranslationBlockIndex }>();
  /** In-flight snapshot loads per client, so concurrent reads parse once. */
  private loads = new WeakMap<SessionLogDb, Map<string, PersistedLoad>>();

  /** `null` when the session does not exist. */
  async readLogView(db: SessionLogDb, sessionId: string, view: 'full' | 'light'): Promise<
    | null
    | { kind: 'object'; value: NormalizedConversation }
    | { kind: 'json'; value: string }
  > {
    const row = await this.versionRow(db, sessionId);
    if (!row) return null;
    const store = sessionMsgStoreManager.get(sessionId);
    if (store) {
      const snapshot = store.getSnapshot();
      return { kind: 'object', value: view === 'light' ? toLightConversation(snapshot) : snapshot };
    }
    const version = row.updatedAt.getTime();
    if (view === 'light') {
      const cached = this.persistedEntry(sessionId, version);
      if (cached?.light !== undefined) return { kind: 'json', value: cached.light };
    }
    const loaded = await this.loadPersisted(db, sessionId);
    if (!loaded) return { kind: 'object', value: { entries: [], seq: 0 } };
    if (view === 'full') return { kind: 'object', value: loaded.conversation };
    const light = JSON.stringify(toLightConversation(loaded.conversation));
    this.storePersisted(sessionId, loaded.version, { light });
    return { kind: 'json', value: light };
  }

  /** Full contents of light-view entries; `null` when the session does not exist. */
  async readEntryContents(db: SessionLogDb, sessionId: string, requests: LogEntryContentRequest[]): Promise<LogEntryContent[] | null> {
    const row = await this.versionRow(db, sessionId);
    if (!row) return null;
    const store = sessionMsgStoreManager.get(sessionId);
    if (store) return findEntryContents(store.getSnapshot().entries, requests);
    const version = row.updatedAt.getTime();
    const parsed = this.parsed.get(sessionId);
    if (parsed && parsed.version === version) {
      parsed.usedAt = Date.now();
      return findEntryContents(parsed.conversation.entries, requests);
    }
    const loaded = await this.loadPersisted(db, sessionId);
    if (!loaded) return [];
    return findEntryContents(loaded.conversation.entries, requests);
  }

  /**
   * Translation blocks of the current transcript, or `null` when the session
   * has neither a live store nor a persisted snapshot.
   */
  async readTranslationBlocks(db: SessionLogDb, sessionId: string): Promise<TranslationBlockIndex | null> {
    const store = sessionMsgStoreManager.get(sessionId);
    if (store) {
      const snapshot = store.getSnapshot();
      const seq = typeof snapshot.seq === 'number' ? snapshot.seq : -1;
      const cached = this.liveBlocks.get(store);
      if (cached && cached.seq === seq && seq >= 0) return cached.index;
      const index = buildTranslationBlockIndex(snapshot);
      this.liveBlocks.set(store, { seq, index });
      return index;
    }
    const row = await this.versionRow(db, sessionId);
    if (!row) return null;
    const cached = this.persistedEntry(sessionId, row.updatedAt.getTime());
    if (cached?.blockIndex) return cached.blockIndex;
    const loaded = await this.loadPersisted(db, sessionId);
    if (!loaded) return null;
    const blockIndex = buildTranslationBlockIndex(loaded.conversation);
    this.storePersisted(sessionId, loaded.version, { blockIndex });
    return blockIndex;
  }

  /** Test hook and memory release. */
  clear(): void {
    this.persisted.clear();
    this.persistedChars = 0;
    this.parsed.clear();
    this.loads = new WeakMap();
  }

  private async versionRow(db: SessionLogDb, sessionId: string): Promise<LogVersionRow | null> {
    return db.session.findUnique({ where: { id: sessionId }, select: { updatedAt: true } });
  }

  /**
   * Loads and parses `logSnapshot`. `null`: no snapshot. Concurrent reads
   * through the same client share one load; a transaction never shares the
   * global client's load, so it sees its own view of the row.
   */
  private loadPersisted(db: SessionLogDb, sessionId: string): PersistedLoad {
    let pendingLoads = this.loads.get(db);
    if (!pendingLoads) {
      pendingLoads = new Map();
      this.loads.set(db, pendingLoads);
    }
    const pending = pendingLoads.get(sessionId);
    if (pending) return pending;
    const loads = pendingLoads;
    const load: PersistedLoad = (async () => {
      const row = await db.session.findUnique({
        where: { id: sessionId },
        select: { logSnapshot: true, updatedAt: true },
      });
      if (!row?.logSnapshot) return null;
      const version = row.updatedAt.getTime();
      const conversation = parseSnapshot(row.logSnapshot);
      this.rememberParsed(sessionId, version, conversation);
      return { version, conversation };
    })().finally(() => {
      if (loads.get(sessionId) === load) loads.delete(sessionId);
    });
    loads.set(sessionId, load);
    return load;
  }

  private rememberParsed(sessionId: string, version: number, conversation: NormalizedConversation): void {
    const now = Date.now();
    for (const [id, entry] of this.parsed) {
      if (now - entry.usedAt > PARSED_CACHE_TTL_MS) this.parsed.delete(id);
    }
    this.parsed.delete(sessionId);
    this.parsed.set(sessionId, { version, conversation, usedAt: now });
    while (this.parsed.size > PARSED_CACHE_SIZE) {
      const oldest = this.parsed.keys().next().value as string;
      this.parsed.delete(oldest);
    }
    const timer = setTimeout(() => {
      const entry = this.parsed.get(sessionId);
      if (entry && Date.now() - entry.usedAt >= PARSED_CACHE_TTL_MS) this.parsed.delete(sessionId);
    }, PARSED_CACHE_TTL_MS + 1000);
    timer.unref?.();
  }

  private persistedEntry(sessionId: string, version: number): PersistedCacheEntry | undefined {
    const entry = this.persisted.get(sessionId);
    if (!entry) return undefined;
    if (entry.version !== version) {
      this.dropPersisted(sessionId);
      return undefined;
    }
    // Refresh LRU order.
    this.persisted.delete(sessionId);
    this.persisted.set(sessionId, entry);
    return entry;
  }

  private storePersisted(sessionId: string, version: number, value: { light?: string; blockIndex?: TranslationBlockIndex }): void {
    let entry = this.persisted.get(sessionId);
    if (entry && entry.version !== version) {
      // A newer write may already be cached; never let an older read replace it.
      if (entry.version > version) return;
      this.dropPersisted(sessionId);
      entry = undefined;
    }
    if (!entry) entry = { version, chars: 0 };
    this.persistedChars -= entry.chars;
    if (value.light !== undefined) entry.light = value.light;
    if (value.blockIndex !== undefined) entry.blockIndex = value.blockIndex;
    entry.chars = (entry.light?.length ?? 0) + (entry.blockIndex ? blockIndexChars(entry.blockIndex) : 0);
    this.persisted.delete(sessionId);
    this.persisted.set(sessionId, entry);
    this.persistedChars += entry.chars;
    while (this.persistedChars > PERSISTED_CACHE_CHAR_BUDGET && this.persisted.size > 1) {
      const oldest = this.persisted.keys().next().value as string;
      if (oldest === sessionId) break;
      this.dropPersisted(oldest);
    }
  }

  private dropPersisted(sessionId: string): void {
    const entry = this.persisted.get(sessionId);
    if (!entry) return;
    this.persistedChars -= entry.chars;
    this.persisted.delete(sessionId);
  }
}

export const sessionLogReader = new SessionLogReader();
