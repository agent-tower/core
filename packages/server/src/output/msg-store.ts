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
  private patchListeners = new Set<(patch: JsonPatch) => void>();
  private sessionIdListeners = new Set<(id: string) => void>();
  private finishedListeners = new Set<() => void>();

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
  }

  /**
   * 推送消息
   */
  push(msg: LogMsg): void {
    const bytes = estimateMsgBytes(msg);
    while (this.totalBytes + bytes > MAX_MEMORY_BYTES && this.messages.length > 0) {
      const removed = this.messages.shift();
      if (removed) {
        this.totalBytes -= estimateMsgBytes(removed);
      }
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
        listener(msg.patch);
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
   */
  pushPatch(patch: JsonPatch): void {
    this.push({ type: 'patch', patch });
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
   * 重放所有 patch 和 session_id 消息，构建完整的 NormalizedConversation 状态
   */
  getSnapshot(): NormalizedConversation {
    // 从 baseSnapshot 开始（如果有），在此基础上重放新 patch
    let conversation: NormalizedConversation = this.baseSnapshot
      ? JSON.parse(JSON.stringify(this.baseSnapshot))
      : { entries: [] };

    for (const msg of this.messages) {
      if (msg.type === 'patch') {
        try {
          const result = applyPatch(conversation, msg.patch as Operation[], true, false);
          conversation = result.newDocument;
        } catch {
          // invalid patch chunks are ignored to avoid breaking the whole snapshot
        }
      } else if (msg.type === 'session_id') {
        conversation = { ...conversation, sessionId: msg.id };
      }
    }

    return JSON.parse(JSON.stringify(conversation));
  }

  onPatch(handler: (patch: JsonPatch) => void): () => void {
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
