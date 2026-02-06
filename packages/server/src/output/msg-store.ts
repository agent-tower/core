/**
 * MsgStore - 消息存储和流式传输
 * 参考 vibe-kanban Rust 实现
 */

import { EventEmitter } from 'events'
import type { LogMsg, JsonPatch } from './types.js'

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

  constructor() {
    super()
    this.setMaxListeners(100)
  }

  /**
   * 推送消息
   */
  push(msg: LogMsg): void {
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
   * 获取所有消息
   */
  getMessages(): LogMsg[] {
    return [...this.messages]
  }

  /**
   * 历史 + 实时流
   * 先返回历史消息，然后切换到实时流
   */
  async *historyPlusStream(): AsyncGenerator<LogMsg> {
    // 先返回历史消息
    for (const msg of this.messages) {
      yield msg
    }

    // 如果已完成，直接返回
    if (this.finished) {
      return
    }

    // 切换到实时流
    const queue: LogMsg[] = []
    let resolve: (() => void) | null = null

    const onMessage = (msg: LogMsg) => {
      queue.push(msg)
      if (resolve) {
        resolve()
        resolve = null
      }
    }

    this.on('message', onMessage)

    try {
      while (true) {
        while (queue.length > 0) {
          const msg = queue.shift()!
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
    for await (const msg of this.historyPlusStream()) {
      if (msg.type === 'patch' || msg.type === 'session_id') {
        yield msg
      }
    }
  }
}

/**
 * Session MsgStore 管理器
 * 管理多个会话的 MsgStore
 */
class SessionMsgStoreManager {
  private stores = new Map<string, MsgStore>()

  /**
   * 创建 MsgStore
   */
  create(sessionId: string, _agentType?: string, _workingDir?: string): MsgStore {
    let store = this.stores.get(sessionId)
    if (!store) {
      store = new MsgStore()
      this.stores.set(sessionId, store)
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
