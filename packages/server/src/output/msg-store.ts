/**
 * MsgStore - conversation state container.
 * Keeps patches/stdout history and snapshot reconstruction.
 */

import jsonpatch from 'fast-json-patch';
import type { Operation } from 'fast-json-patch';
import { EntryIndexProvider } from './utils/patch.js';
import type { LogMsg, JsonPatch, NormalizedConversation } from './types.js';

const { applyPatch } = jsonpatch;
const MAX_MEMORY_BYTES = 100 * 1024 * 1024;

/**
 * 估算字符串字节大小
 */
function estimateBytes(str: string): number {
  return str.length * 2;
}

/**
 * 估算消息字节大小
 */
function estimateMsgBytes(msg: LogMsg): number {
  switch (msg.type) {
    case 'stdout':
    case 'stderr':
      return estimateBytes(msg.data) + 20
    case 'patch':
      return estimateBytes(JSON.stringify(msg.patch)) + 20
    case 'session_id':
    case 'message_id':
      return estimateBytes(msg.id) + 20
    case 'finished':
      return 20;
  }
}

/**
 * MsgStore 类
 * 管理消息的存储、历史回放和实时流式传输
 */
export class MsgStore {
  private messages: LogMsg[] = [];
  private totalBytes = 0;
  private finished = false;
  private baseSnapshot: NormalizedConversation | null = null;
  readonly entryIndex: EntryIndexProvider;
  private sessionIdListeners = new Set<(id: string) => void>();
  private finishedListeners = new Set<() => void>();

  // Incremental snapshot cache: avoid replaying all patches on every getSnapshot() call
  private cachedSnapshot: NormalizedConversation | null = null;
  private cachedUpToIndex = -1; // index of last message applied to cachedSnapshot

  // Monotonic patch sequence — emitted with each patch so clients can dedupe
  // patches that arrived between SUBSCRIBE join and snapshot fetch.
  private patchSeq = 0;
  private patchListeners = new Set<(patch: JsonPatch, seq: number) => void>();

  constructor() {
    this.entryIndex = new EntryIndexProvider();
  }

  /**
   * 从持久化快照恢复基础状态
   * 设置 baseSnapshot 和 entryIndex，使新 parser 生成的 patch 索引正确衔接
   */
  restoreFromSnapshot(snapshot: NormalizedConversation): void {
    this.baseSnapshot = snapshot;
    this.entryIndex.startFrom(snapshot.entries.length);
    // Continue seq from the persisted snapshot so clients can't confuse
    // restored-session patches with a fresh session's seq=1.
    this.patchSeq = snapshot.seq ?? 0;
    // Invalidate cache — will be rebuilt from new base on next getSnapshot()
    this.cachedSnapshot = null;
    this.cachedUpToIndex = -1;
  }

  /**
   * 推送消息
   *
   * 内存控制策略：
   * 1. dedup: streaming 文本/工具状态会用同 path 反复 replace 推送完整新值。
   *    新 replace 进来时，删除先前同 path 的 replace —— 旧值已被覆盖，留着只会 O(n²) 爆内存。
   * 2. FIFO 兜底：dedup 之后仍超过 MAX_MEMORY_BYTES 时，把最旧的消息折叠进 baseSnapshot
   *    再丢弃。这样后续 patch 仍能在正确的 base 上重放，不会因丢失 add 指令而全军覆没。
   */
  push(msg: LogMsg): void {
    if (msg.type === 'patch') {
      this.dropStaleReplaces(msg.patch);
    }

    const bytes = estimateMsgBytes(msg);
    while (this.totalBytes + bytes > MAX_MEMORY_BYTES && this.messages.length > 0) {
      const removed = this.messages.shift()!;
      this.foldEvictedIntoBase(removed);
      this.totalBytes -= estimateMsgBytes(removed);
      // FIFO eviction invalidates the incremental cache — the base messages are gone
      this.cachedSnapshot = null;
      this.cachedUpToIndex = -1;
    }

    this.messages.push(msg);
    this.totalBytes += bytes;

    if (msg.type === 'finished') {
      this.finished = true;
      for (const listener of this.finishedListeners) {
        listener();
      }
    }
    if (msg.type === 'patch') {
      for (const listener of this.patchListeners) {
        listener(msg.patch, msg.seq);
      }
    }
    if (msg.type === 'session_id') {
      for (const listener of this.sessionIdListeners) {
        listener(msg.id);
      }
    }
  }

  /**
   * 推送 stdout 数据
   */
  pushStdout(data: string): void {
    this.push({ type: 'stdout', data });
  }

  /**
   * 推送 stderr 数据
   */
  pushStderr(data: string): void {
    this.push({ type: 'stderr', data });
  }

  /**
   * 推送 patch
   * @returns 分配给此 patch 的 seq（调用方需要直接 emit 时使用）
   */
  pushPatch(patch: JsonPatch): number {
    const seq = ++this.patchSeq;
    this.push({ type: 'patch', patch, seq });
    return seq;
  }

  /**
   * 同 path 的 replace 是覆盖语义：旧值会被新值压过去，留在 messages 数组里
   * 只会浪费内存（streaming 文本/工具状态会反复触发同 path replace）。
   *
   * 注意：仅修改 messages 数组（服务端重建快照所用），不影响已 emit 给前端的事件。
   * 前端用 seq 单调去重，旧 patch 已抵达即已 apply，删除内存副本不影响一致性。
   */
  private dropStaleReplaces(newPatch: JsonPatch): void {
    const replacePaths = new Set<string>();
    for (const op of newPatch) {
      if (op.op === 'replace') replacePaths.add(op.path);
    }
    if (replacePaths.size === 0) return;

    // Fast path: 紧邻同 path replace 是热路径（streaming 文本/工具状态、单 PTY chunk 内连续 delta）。
    // 仅当 last 消息是 patch、所有 op 都是 replace 且全部 path 都被新 patch 覆盖时，
    // 直接整条替换，省掉全数组扫描。
    const last = this.messages[this.messages.length - 1];
    if (
      last?.type === 'patch' &&
      last.patch.length > 0 &&
      last.patch.every(
        (op) => op.op === 'replace' && replacePaths.has(op.path)
      )
    ) {
      this.totalBytes -= estimateMsgBytes(last);
      this.messages.pop();
      this.cachedSnapshot = null;
      this.cachedUpToIndex = -1;
      return;
    }

    // Slow path: 跨 stdout/跨 PTY chunk 的非紧邻同 path replace 仍需倒序扫全数组。
    let mutated = false;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.type !== 'patch') continue;
      const filtered = m.patch.filter(
        (op) => !(op.op === 'replace' && replacePaths.has(op.path))
      );
      if (filtered.length === m.patch.length) continue;

      const oldBytes = estimateMsgBytes(m);
      if (filtered.length === 0) {
        this.messages.splice(i, 1);
        this.totalBytes -= oldBytes;
      } else {
        m.patch = filtered;
        const newBytes = estimateMsgBytes(m);
        this.totalBytes -= oldBytes - newBytes;
      }
      mutated = true;
    }

    if (mutated) {
      this.cachedSnapshot = null;
      this.cachedUpToIndex = -1;
    }
  }

  /**
   * 把被 FIFO 驱逐的消息折叠进 baseSnapshot。
   * 这样 messages 数组不再持有该消息的字节，但其对 entries 的状态贡献被永久保留在 base 上。
   * 后续 getSnapshot() 重建时仍然得到完整状态，避免出现 entries=[] 但 seq 飞涨的灾难性结果。
   */
  private foldEvictedIntoBase(removed: LogMsg): void {
    if (removed.type === 'patch') {
      const base: NormalizedConversation = this.baseSnapshot
        ? (JSON.parse(JSON.stringify(this.baseSnapshot)) as NormalizedConversation)
        : { entries: [] };
      try {
        const result = applyPatch(base, removed.patch as Operation[], true, true);
        this.baseSnapshot = result.newDocument as NormalizedConversation;
      } catch (error) {
        const first = (removed.patch as Array<{ op?: string; path?: string }>)[0];
        console.warn(
          `[MsgStore:foldEvictedIntoBase] failed to fold evicted patch op=${first?.op ?? '?'} path=${first?.path ?? '?'} err=${error instanceof Error ? error.message : String(error)}`
        );
      }
      return;
    }
    if (removed.type === 'session_id') {
      this.baseSnapshot = {
        ...(this.baseSnapshot ?? { entries: [] }),
        sessionId: removed.id,
      };
    }
    // stdout / stderr / message_id / finished 不影响 entries 状态，安全丢弃
  }

  /**
   * 推送 session ID
   */
  pushSessionId(id: string): void {
    this.push({ type: 'session_id', id });
  }

  /**
   * 推送 message ID
   */
  pushMessageId(id: string): void {
    this.push({ type: 'message_id', id });
  }

  /**
   * 标记完成
   */
  finish(): void {
    this.push({ type: 'finished' });
  }

  /**
   * 标记完成（别名）
   */
  pushFinished(): void {
    this.finish();
  }

  /**
   * 是否已完成
   */
  isFinished(): boolean {
    return this.finished;
  }

  /**
   * 获取所有消息
   */
  getMessages(): LogMsg[] {
    return [...this.messages];
  }

  /**
   * 获取当前标准化日志快照
   * 使用增量缓存：只重放上次快照之后的新 patch，避免每次从头重放
   */
  getSnapshot(): NormalizedConversation {
    // If cache is valid, only apply new messages since last snapshot
    if (this.cachedSnapshot && this.cachedUpToIndex >= 0) {
      let conversation = this.cachedSnapshot;
      let changed = false;

      for (let i = this.cachedUpToIndex + 1; i < this.messages.length; i++) {
        const msg = this.messages[i];
        if (msg.type === 'patch') {
          try {
            const result = applyPatch(conversation, msg.patch as Operation[], true, true);
            conversation = result.newDocument;
            changed = true;
          } catch (error) {
            const first = (msg.patch as Array<{ op?: string; path?: string }>)[0];
            console.warn(
              `[MsgStore:getSnapshot] incremental patch apply failed entries=${conversation.entries.length} op=${first?.op ?? '?'} path=${first?.path ?? '?'} err=${error instanceof Error ? error.message : String(error)}`
            );
          }
        } else if (msg.type === 'session_id') {
          conversation = { ...conversation, sessionId: msg.id };
          changed = true;
        }
      }

      this.cachedSnapshot = conversation;
      this.cachedUpToIndex = this.messages.length - 1;

      // Return a shallow copy so callers can't mutate our cache
      return { ...conversation, entries: [...conversation.entries], seq: this.patchSeq };
    }

    // No cache — full rebuild from baseSnapshot
    let conversation: NormalizedConversation = this.baseSnapshot
      ? JSON.parse(JSON.stringify(this.baseSnapshot))
      : { entries: [] };

    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];
      if (msg.type === 'patch') {
        try {
          const result = applyPatch(conversation, msg.patch as Operation[], true, true);
          conversation = result.newDocument;
        } catch (error) {
          const first = (msg.patch as Array<{ op?: string; path?: string }>)[0];
          console.warn(
            `[MsgStore:getSnapshot] full patch apply failed entries=${conversation.entries.length} op=${first?.op ?? '?'} path=${first?.path ?? '?'} err=${error instanceof Error ? error.message : String(error)}`
          );
        }
      } else if (msg.type === 'session_id') {
        conversation = { ...conversation, sessionId: msg.id };
      }
    }

    // Cache the result for incremental updates
    this.cachedSnapshot = conversation;
    this.cachedUpToIndex = this.messages.length - 1;

    return { ...conversation, entries: [...conversation.entries], seq: this.patchSeq };
  }

  onPatch(handler: (patch: JsonPatch, seq: number) => void): () => void {
    this.patchListeners.add(handler);
    return () => this.patchListeners.delete(handler);
  }

  onSessionId(handler: (id: string) => void): () => void {
    this.sessionIdListeners.add(handler);
    return () => this.sessionIdListeners.delete(handler);
  }

  onFinished(handler: () => void): () => void {
    this.finishedListeners.add(handler);
    return () => this.finishedListeners.delete(handler);
  }
}

/**
 * Session MsgStore 管理器
 * 管理多个会话的 MsgStore
 */
class SessionMsgStoreManager {
  private stores = new Map<string, MsgStore>();

  /**
   * 创建 MsgStore
   */
  create(sessionId: string, _agentType?: string, _workingDir?: string): MsgStore {
    let store = this.stores.get(sessionId);
    if (!store) {
      store = new MsgStore();
      this.stores.set(sessionId, store);
    }
    return store;
  }

  /**
   * 获取或创建 MsgStore
   */
  getOrCreate(sessionId: string): MsgStore {
    return this.create(sessionId);
  }

  /**
   * 获取 MsgStore
   */
  get(sessionId: string): MsgStore | undefined {
    return this.stores.get(sessionId);
  }

  /**
   * 删除 MsgStore
   */
  delete(sessionId: string): boolean {
    return this.stores.delete(sessionId);
  }

  /**
   * 删除 MsgStore（别名）
   */
  remove(sessionId: string): boolean {
    return this.delete(sessionId);
  }

  /**
   * 检查是否存在
   */
  has(sessionId: string): boolean {
    return this.stores.has(sessionId);
  }
}

// 单例导出
export const sessionMsgStoreManager = new SessionMsgStoreManager();
