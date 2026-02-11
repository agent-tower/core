/**
 * MsgStore - 消息存储和流式传输
 * 参考 vibe-kanban Rust 实现
 */

import { EventEmitter } from 'events'
import jsonpatch from 'fast-json-patch'
import type { Operation } from 'fast-json-patch'
const { applyPatch } = jsonpatch
import { EntryIndexProvider } from './utils/patch.js'
import type { LogMsg, JsonPatch, NormalizedConversation } from './types.js'

// Debug 日志开关
const DEBUG_MSGSTORE = process.env.DEBUG_MSGSTORE === 'true' || true;

const MAX_MEMORY_BYTES = 100 * 1024 * 1024 // 100MB

/**
 * 估算字符串字节大小
 */
function estimateBytes(str: string): number {
  return str.length * 2 // UTF-16
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
      return 20
  }
}

/**
 * MsgStore 类
 * 管理消息的存储、历史回放和实时流式传输
 */
export class MsgStore extends EventEmitter {
  private messages: LogMsg[] = []
  private totalBytes = 0
  private finished = false

  /** 基础快照 — 从 DB 恢复时设置，getSnapshot 在此基础上重放新 patch */
  private baseSnapshot: NormalizedConversation | null = null

  /** 共享的条目索引提供器，所有 parser 实例共用以保证 entry 索引连续 */
  readonly entryIndex: EntryIndexProvider

  constructor() {
    super()
    this.setMaxListeners(100)
    this.entryIndex = new EntryIndexProvider()
  }

  /**
   * 从持久化快照恢复基础状态
   * 设置 baseSnapshot 和 entryIndex，使新 parser 生成的 patch 索引正确衔接
   */
  restoreFromSnapshot(snapshot: NormalizedConversation): void {
    this.baseSnapshot = snapshot
    this.entryIndex.startFrom(snapshot.entries.length)
    if (DEBUG_MSGSTORE) {
      console.log(`[MsgStore:restoreFromSnapshot] t=${Date.now()} entries=${snapshot.entries.length} entryIndex=${this.entryIndex.current()}`);
    }
  }

  /**
   * 推送消息
   */
  push(msg: LogMsg): void {
    const now = Date.now();
    const bytes = estimateMsgBytes(msg)

    // 内存管理：移除旧消息
    while (this.totalBytes + bytes > MAX_MEMORY_BYTES && this.messages.length > 0) {
      const removed = this.messages.shift()
      if (removed) {
        this.totalBytes -= estimateMsgBytes(removed)
      }
    }

    this.messages.push(msg)
    this.totalBytes += bytes

    if (msg.type === 'finished') {
      this.finished = true
    }

    if (DEBUG_MSGSTORE) {
      const msgPreview = msg.type === 'patch' 
        ? `patch ops=${(msg.patch as unknown[]).length}` 
        : msg.type === 'stdout' 
          ? `stdout len=${msg.data.length}` 
          : msg.type;
      console.log(`[MsgStore:push] t=${now} ${msgPreview} total=${this.messages.length} listenerCount=${this.listenerCount('message')}`);
    }

    this.emit('message', msg)
  }

  /**
   * 推送 stdout 数据
   */
  pushStdout(data: string): void {
    this.push({ type: 'stdout', data })
  }

  /**
   * 推送 stderr 数据
   */
  pushStderr(data: string): void {
    this.push({ type: 'stderr', data })
  }

  /**
   * 推送 patch
   */
  pushPatch(patch: JsonPatch): void {
    this.push({ type: 'patch', patch })
  }

  /**
   * 推送 session ID
   */
  pushSessionId(id: string): void {
    this.push({ type: 'session_id', id })
  }

  /**
   * 推送 message ID
   */
  pushMessageId(id: string): void {
    this.push({ type: 'message_id', id })
  }

  /**
   * 标记完成
   */
  finish(): void {
    this.push({ type: 'finished' })
  }

  /**
   * 标记完成（别名）
   */
  pushFinished(): void {
    this.finish()
  }

  /**
   * 是否已完成
   */
  isFinished(): boolean {
    return this.finished
  }

  /**
   * 重置 finished 状态，允许继续追加消息
   * 用于 sendMessage 在 spawn 新 PTY 前重置，使得新的 PATCH 事件能继续产出
   */
  resetFinished(): void {
    this.finished = false
  }

  /**
   * 获取所有消息
   */
  getMessages(): LogMsg[] {
    return [...this.messages]
  }

  /**
   * 获取当前标准化日志快照
   * 重放所有 patch 和 session_id 消息，构建完整的 NormalizedConversation 状态
   */
  getSnapshot(): NormalizedConversation {
    // 从 baseSnapshot 开始（如果有），在此基础上重放新 patch
    let conversation: NormalizedConversation = this.baseSnapshot
      ? JSON.parse(JSON.stringify(this.baseSnapshot))
      : { entries: [] }

    for (const msg of this.messages) {
      if (msg.type === 'patch') {
        try {
          const result = applyPatch(
            conversation,
            msg.patch as Operation[],
            true,  // validate
            false  // mutate (false = immutable)
          )
          conversation = result.newDocument
        } catch (error) {
          if (DEBUG_MSGSTORE) {
            console.error('[MsgStore:getSnapshot] Failed to apply patch:', error)
          }
        }
      } else if (msg.type === 'session_id') {
        conversation = { ...conversation, sessionId: msg.id }
      }
    }

    // 返回深拷贝以避免外部修改影响内部状态
    return JSON.parse(JSON.stringify(conversation))
  }

  /**
   * 历史 + 实时流
   * 先返回历史消息，然后切换到实时流
   * 
   * 注意：使用监听器先注册的方式避免竞态条件
   */
  async *historyPlusStream(): AsyncGenerator<LogMsg> {
    // 切换到实时流 - 先注册监听器以避免丢失消息
    const queue: LogMsg[] = []
    let resolve: (() => void) | null = null

    const onMessage = (msg: LogMsg) => {
      queue.push(msg)
      if (DEBUG_MSGSTORE) {
        console.log(`[MsgStore:historyPlusStream:onMessage] t=${Date.now()} type=${msg.type} queueLen=${queue.length}`);
      }
      if (resolve) {
        resolve()
        resolve = null
      }
    }

    // 先注册监听器
    this.on('message', onMessage)

    try {
      // 记录注册时的历史消息数量
      const historyCount = this.messages.length
      if (DEBUG_MSGSTORE) {
        console.log(`[MsgStore:historyPlusStream] t=${Date.now()} historyCount=${historyCount} finished=${this.finished}`);
      }

      // 返回历史消息
      for (let i = 0; i < historyCount; i++) {
        yield this.messages[i]
      }

      // 如果已完成，直接返回
      if (this.finished) {
        return
      }

      // 处理实时流
      while (true) {
        while (queue.length > 0) {
          const msg = queue.shift()!
          if (DEBUG_MSGSTORE) {
            console.log(`[MsgStore:historyPlusStream:yield] t=${Date.now()} type=${msg.type} remainingQueue=${queue.length}`);
          }
          yield msg
          if (msg.type === 'finished') {
            return
          }
        }

        // 等待新消息
        await new Promise<void>((r) => {
          resolve = r
        })
      }
    } finally {
      this.off('message', onMessage)
    }
  }

  /**
   * stdout 行流
   * 缓冲不完整的行，只返回完整行
   */
  async *stdoutLinesStream(): AsyncGenerator<string> {
    let buffer = ''

    for await (const msg of this.historyPlusStream()) {
      if (msg.type === 'stdout') {
        buffer += msg.data
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          yield line
        }
      }
    }

    // 返回剩余的缓冲区
    if (buffer) {
      yield buffer
    }
  }

  /**
   * stderr 行流
   */
  async *stderrLinesStream(): AsyncGenerator<string> {
    let buffer = ''

    for await (const msg of this.historyPlusStream()) {
      if (msg.type === 'stderr') {
        buffer += msg.data
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          yield line
        }
      }
    }

    if (buffer) {
      yield buffer
    }
  }

  /**
   * patch 流
   */
  async *patchStream(): AsyncGenerator<JsonPatch> {
    for await (const msg of this.historyPlusStream()) {
      if (msg.type === 'patch') {
        yield msg.patch
      }
    }
  }

  /**
   * 原始日志流
   */
  async *rawLogsStream(): AsyncGenerator<LogMsg> {
    for await (const msg of this.historyPlusStream()) {
      if (msg.type === 'stdout' || msg.type === 'stderr') {
        yield msg
      }
    }
  }

  /**
   * 标准化日志流
   * 返回 patch 和 session_id 消息
   */
  async *normalizedLogsStream(): AsyncGenerator<LogMsg> {
    if (DEBUG_MSGSTORE) {
      console.log(`[MsgStore:normalizedLogsStream] t=${Date.now()} started, history=${this.messages.length}`);
    }
    for await (const msg of this.historyPlusStream()) {
      if (msg.type === 'patch' || msg.type === 'session_id') {
        if (DEBUG_MSGSTORE) {
          const detail = msg.type === 'patch' ? `ops=${(msg.patch as unknown[]).length}` : `id=${msg.id}`;
          console.log(`[MsgStore:normalizedLogsStream] t=${Date.now()} yielding ${msg.type} ${detail}`);
        }
        yield msg
      }
    }
  }
}

/**
 * Session MsgStore 管理器
 * 管理多个会话的 MsgStore
 */
class SessionMsgStoreManager extends EventEmitter {
  private stores = new Map<string, MsgStore>()

  constructor() {
    super()
    this.setMaxListeners(100)
  }

  /**
   * 创建 MsgStore
   */
  create(sessionId: string, _agentType?: string, _workingDir?: string): MsgStore {
    let store = this.stores.get(sessionId)
    if (!store) {
      store = new MsgStore()
      this.stores.set(sessionId, store)
      // 通知监听者（如 TerminalHandler）新 MsgStore 已创建，需要补注册 EventEmitter 监听
      this.emit('store-created', sessionId, store)
    }
    return store
  }

  /**
   * 获取或创建 MsgStore
   */
  getOrCreate(sessionId: string): MsgStore {
    return this.create(sessionId)
  }

  /**
   * 获取 MsgStore
   */
  get(sessionId: string): MsgStore | undefined {
    return this.stores.get(sessionId)
  }

  /**
   * 删除 MsgStore
   */
  delete(sessionId: string): boolean {
    return this.stores.delete(sessionId)
  }

  /**
   * 删除 MsgStore（别名）
   */
  remove(sessionId: string): boolean {
    return this.delete(sessionId)
  }

  /**
   * 检查是否存在
   */
  has(sessionId: string): boolean {
    return this.stores.has(sessionId)
  }
}

// 单例导出
export const sessionMsgStoreManager = new SessionMsgStoreManager()
