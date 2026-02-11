/**
 * Claude Code stream-json 输出解析器
 * 将 Claude Code 的 JSON 流输出转换为标准化日志
 */

import type { MsgStore } from './msg-store.js'

// Debug 日志开关
const DEBUG_PARSER = process.env.DEBUG_PARSER === 'true' || true;
import {
  type NormalizedEntry,
  type ActionType,
  type ToolStatus,
  createUserMessage,
  createAssistantMessage,
  createToolUse,
  createThinking,
  createErrorMessage,
} from './types.js'
import {
  EntryIndexProvider,
  addNormalizedEntry,
  replaceNormalizedEntry,
  updateEntryContent,
  updateToolStatus,
  setSessionId,
} from './utils/patch.js'
import { stripAnsiSequences } from './utils/ansi.js'

/**
 * Claude Code 消息类型
 */
interface ClaudeCodeMessage {
  type: string
  subtype?: string
  session_id?: string
  message_id?: string
  message?: {
    id?: string
    role?: string
    content?: Array<{
      type: string
      text?: string
      thinking?: string
      name?: string
      input?: unknown
      tool_use_id?: string
    }>
    model?: string
    stop_reason?: string
  }
  tool_use_id?: string
  tool_result?: {
    content?: string
    is_error?: boolean
  }
  content?: string
  error?: string
  event?: {
    type: string
    index?: number
    content_block?: { type: string; thinking?: string; text?: string }
    delta?: { type: string; thinking?: string; text?: string }
    message?: { id?: string; role?: string }
  }
}

/**
 * 工具名称到动作类型的映射
 */
function toolNameToAction(toolName: string): ActionType {
  const mapping: Record<string, ActionType> = {
    Read: 'file_read',
    Edit: 'file_edit',
    Write: 'file_edit',
    Bash: 'command_run',
    Grep: 'search',
    Glob: 'search',
    WebFetch: 'web_fetch',
    Task: 'task_create',
    TodoWrite: 'todo_management',
  }
  return mapping[toolName] || 'tool'
}

/**
 * Streaming content block state
 */
interface StreamingContentBlock {
  kind: 'text' | 'thinking'
  entryIndex: number
  buffer: string
}

/**
 * Streaming message state — 跟踪一个 assistant message 的所有 content blocks
 * 用于在 assistant 汇总消息到达时，通过 content index 找到 stream_event 阶段创建的 entry index
 */
interface StreamingMessageState {
  role: string
  /** content_index → StreamingContentBlock */
  contents: Map<number, StreamingContentBlock>
}

/**
 * Claude Code 解析器
 */
export class ClaudeCodeParser {
  private msgStore: MsgStore
  private buffer: string = ''
  private toolEntryMap: Map<string, number> = new Map() // tool_use_id -> entry index
  private currentAssistantIndex: number | null = null
  private currentAssistantContent: string = ''
  // stream_event state
  private streamingBlocks: Map<number, StreamingContentBlock> = new Map()
  private streamingRole: string | null = null
  // message_id → StreamingMessageState，用于 assistant 消息的 replace 机制
  private streamingMessages: Map<string, StreamingMessageState> = new Map()
  private streamingMessageId: string | null = null

  constructor(msgStore: MsgStore) {
    this.msgStore = msgStore
  }

  /** 使用 MsgStore 共享的索引提供器 */
  private get indexProvider(): EntryIndexProvider {
    return this.msgStore.entryIndex
  }

  /**
   * 处理原始输出数据
   */
  processData(data: string): void {
    const now = Date.now();
    if (DEBUG_PARSER) {
      console.log(`[Parser:processData] t=${now} dataLen=${data.length} bufferLen=${this.buffer.length}`);
    }
    
    this.buffer += data
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() || ''

    if (DEBUG_PARSER && lines.length > 0) {
      console.log(`[Parser:processData] t=${now} linesCount=${lines.length} remainingBuffer=${this.buffer.length}`);
    }

    for (const line of lines) {
      if (line.trim()) {
        this.parseLine(line)
      }
    }
  }

  /**
   * 解析单行 JSON
   */
  private parseLine(line: string): void {
    const now = Date.now();
    try {
      const msg = JSON.parse(line) as ClaudeCodeMessage
      if (DEBUG_PARSER) {
        console.log(`[Parser:parseLine] t=${now} type=${msg.type} subtype=${msg.subtype || '-'}`);
      }
      this.handleMessage(msg)
    } catch {
      // 非 JSON 行 — 剥离 ANSI 转义序列后，如果仍有可读文本则忽略（Claude Code 不输出非 JSON 系统消息）
      if (DEBUG_PARSER && line.length > 0) {
        const stripped = stripAnsiSequences(line).trim();
        console.log(`[Parser:parseLine] t=${now} non-JSON line len=${line.length} stripped="${stripped.slice(0, 50)}${stripped.length > 50 ? '...' : ''}"`);
      }
    }
  }

  /**
   * 处理消息
   */
  private handleMessage(msg: ClaudeCodeMessage): void {
    switch (msg.type) {
      case 'system':
        this.handleSystemMessage(msg)
        break
      case 'assistant':
        this.handleAssistantMessage(msg)
        break
      case 'user':
        this.handleUserMessage(msg)
        break
      case 'result':
        this.handleResultMessage(msg)
        break
      case 'error':
        this.handleErrorMessage(msg)
        break
      case 'stream_event':
        this.handleStreamEvent(msg)
        break
    }
  }

  /**
   * 处理系统消息
   */
  private handleSystemMessage(msg: ClaudeCodeMessage): void {
    if (msg.subtype === 'init' && msg.session_id) {
      this.msgStore.pushSessionId(msg.session_id)
      const patch = setSessionId(msg.session_id)
      this.msgStore.pushPatch(patch)
    }
  }

  /**
   * 处理助手消息
   * 通过 message.id 查找 stream_event 阶段创建的 entry，用完整内容 replace
   * 对于 tool_use（不走 stream_event），直接新建 entry
   */
  private handleAssistantMessage(msg: ClaudeCodeMessage): void {
    if (!msg.message?.content) return

    const messageId = msg.message.id
    const streamingState = messageId ? this.streamingMessages.get(messageId) : undefined

    for (let contentIndex = 0; contentIndex < msg.message.content.length; contentIndex++) {
      const block = msg.message.content[contentIndex]

      if (block.type === 'tool_use' && block.name) {
        this.flushAssistantText()
        // tool_use 可能已有 streaming entry index（虽然目前 Claude 不流式传 tool_use）
        const existingIndex = streamingState?.contents.get(contentIndex)?.entryIndex
        this.handleToolUse(block.name, block.input, msg.message.id, existingIndex)
      } else if (block.type === 'text' && block.text) {
        // 用完整内容 replace stream_event 阶段的 entry
        const existingIndex = streamingState?.contents.get(contentIndex)?.entryIndex
        if (existingIndex != null) {
          const entry = createAssistantMessage(block.text)
          const patch = replaceNormalizedEntry(existingIndex, entry)
          this.msgStore.pushPatch(patch)
        }
        // 如果没有 streaming state（没走 stream_event），不创建新 entry 避免重复
      } else if (block.type === 'thinking' && block.thinking) {
        const existingIndex = streamingState?.contents.get(contentIndex)?.entryIndex
        if (existingIndex != null) {
          const entry = createThinking(block.thinking)
          const patch = replaceNormalizedEntry(existingIndex, entry)
          this.msgStore.pushPatch(patch)
        }
      }
    }

    // 清理已消费的 streaming state
    if (messageId) {
      this.streamingMessages.delete(messageId)
    }
  }

  /**
   * 追加助手文本
   */
  private appendAssistantText(text: string): void {
    if (this.currentAssistantIndex === null) {
      // 创建新的助手消息
      const entry = createAssistantMessage(text)
      const index = this.indexProvider.next()
      this.currentAssistantIndex = index
      this.currentAssistantContent = text
      const patch = addNormalizedEntry(index, entry)
      this.msgStore.pushPatch(patch)
    } else {
      // 追加到现有消息
      this.currentAssistantContent += text
      const patch = updateEntryContent(this.currentAssistantIndex, this.currentAssistantContent)
      this.msgStore.pushPatch(patch)
    }
  }

  /**
   * 刷新助手文本
   */
  private flushAssistantText(): void {
    this.currentAssistantIndex = null
    this.currentAssistantContent = ''
  }

  /**
   * 处理工具使用
   */
  private handleToolUse(toolName: string, input: unknown, messageId?: string, existingIndex?: number): void {
    const action = toolNameToAction(toolName)
    const content = this.formatToolContent(toolName, input)

    // Extract todos from TodoWrite tool call
    const extras = this.extractTodoExtras(toolName, input)
    const entry = createToolUse(toolName, content, action, messageId, undefined, extras)

    if (existingIndex != null) {
      // replace stream_event 阶段创建的 entry
      const patch = replaceNormalizedEntry(existingIndex, entry)
      this.msgStore.pushPatch(patch)
      if (messageId) {
        this.toolEntryMap.set(messageId, existingIndex)
      }
    } else {
      const index = this.indexProvider.next()
      if (messageId) {
        this.toolEntryMap.set(messageId, index)
      }
      const patch = addNormalizedEntry(index, entry)
      this.msgStore.pushPatch(patch)
    }
  }

  /**
   * 格式化工具内容
   */
  private formatToolContent(toolName: string, input: unknown): string {
    if (!input || typeof input !== 'object') {
      return toolName
    }

    const obj = input as Record<string, unknown>

    switch (toolName) {
      case 'Read':
        return `Reading ${obj.file_path || obj.path || 'file'}`
      case 'Edit':
        return `Editing ${obj.file_path || obj.path || 'file'}`
      case 'Write':
        return `Writing ${obj.file_path || obj.path || 'file'}`
      case 'Bash':
        return `Running: ${obj.command || 'command'}`
      case 'Grep':
        return `Searching for: ${obj.pattern || 'pattern'}`
      case 'Glob':
        return `Finding files: ${obj.pattern || 'pattern'}`
      case 'WebFetch':
        return `Fetching: ${obj.url || 'URL'}`
      case 'Task':
        return `Creating task: ${obj.description || 'task'}`
      case 'TodoWrite':
        return 'Updating todo list'
      default:
        return `${toolName}: ${JSON.stringify(input).slice(0, 100)}`
    }
  }

  /**
   * 从 TodoWrite 工具调用中提取 todo 数据
   */
  private extractTodoExtras(toolName: string, input: unknown): { todos?: Array<{ content: string; status: string; priority?: string | null }>; todoOperation?: string } | undefined {
    if (toolName !== 'TodoWrite' || !input || typeof input !== 'object') return undefined
    const obj = input as Record<string, unknown>
    const todos = obj.todos
    if (!Array.isArray(todos)) return undefined
    return {
      todos: todos.map((t: Record<string, unknown>) => ({
        content: String(t.content || ''),
        status: String(t.status || 'pending'),
        priority: t.priority ? String(t.priority) : null,
      })),
      todoOperation: 'write',
    }
  }

  /**
   * 添加思考内容
   */
  private addThinking(text: string): void {
    const entry = createThinking(text)
    const index = this.indexProvider.next()
    const patch = addNormalizedEntry(index, entry)
    this.msgStore.pushPatch(patch)
  }

  /**
   * 处理用户消息
   * 跳过 — 用户消息已由 session.service.ts 在收到请求时主动推送，
   * 这里如果再处理 Claude Code 回显的 user message 会导致重复
   */
  private handleUserMessage(_msg: ClaudeCodeMessage): void {
    // noop: 避免与 session.service.ts 的 createUserMessage 重复
  }

  /**
   * 处理结果消息
   */
  private handleResultMessage(msg: ClaudeCodeMessage): void {
    if (msg.subtype === 'tool_result' && msg.tool_use_id) {
      const index = this.toolEntryMap.get(msg.tool_use_id)
      if (index !== undefined) {
        const status: ToolStatus = msg.tool_result?.is_error ? 'failed' : 'success'
        const patch = updateToolStatus(index, status)
        this.msgStore.pushPatch(patch)
      }
    }
  }

  /**
   * 处理错误消息
   */
  private handleErrorMessage(msg: ClaudeCodeMessage): void {
    const entry = createErrorMessage(msg.error || 'Unknown error', msg.error)
    const index = this.indexProvider.next()
    const patch = addNormalizedEntry(index, entry)
    this.msgStore.pushPatch(patch)
  }

  /**
   * 处理 stream_event（增量流式消息）
   */
  private handleStreamEvent(msg: ClaudeCodeMessage): void {
    const event = msg.event
    if (!event) return

    switch (event.type) {
      case 'message_start': {
        this.streamingRole = event.message?.role || null
        const messageId = event.message?.id
        if (messageId && this.streamingRole === 'assistant') {
          this.streamingMessageId = messageId
          this.streamingMessages.set(messageId, { role: 'assistant', contents: new Map() })
        } else {
          this.streamingMessageId = null
        }
        break
      }

      case 'content_block_start': {
        const index = event.index
        const block = event.content_block
        if (index == null || !block) break

        const kind = block.type === 'thinking' ? 'thinking' : 'text'
        const initial = kind === 'thinking' ? (block.thinking || '') : (block.text || '')

        // Create the entry immediately
        let entryIndex: number
        if (kind === 'thinking') {
          this.flushAssistantText()
          const entry = createThinking(initial)
          entryIndex = this.indexProvider.next()
          const patch = addNormalizedEntry(entryIndex, entry)
          this.msgStore.pushPatch(patch)
        } else {
          // text block — start or reuse assistant message
          if (this.currentAssistantIndex === null) {
            const entry = createAssistantMessage(initial)
            entryIndex = this.indexProvider.next()
            this.currentAssistantIndex = entryIndex
            this.currentAssistantContent = initial
            const patch = addNormalizedEntry(entryIndex, entry)
            this.msgStore.pushPatch(patch)
          } else {
            entryIndex = this.currentAssistantIndex
            if (initial) {
              this.currentAssistantContent += initial
              const patch = updateEntryContent(entryIndex, this.currentAssistantContent)
              this.msgStore.pushPatch(patch)
            }
          }
        }

        const streamBlock: StreamingContentBlock = { kind, entryIndex, buffer: initial }
        this.streamingBlocks.set(index, streamBlock)

        // 记录到 StreamingMessageState
        if (this.streamingMessageId) {
          const state = this.streamingMessages.get(this.streamingMessageId)
          if (state) {
            state.contents.set(index, streamBlock)
          }
        }
        break
      }

      case 'content_block_delta': {
        const index = event.index
        const delta = event.delta
        if (index == null || !delta) break

        const block = this.streamingBlocks.get(index)
        if (!block) break

        const chunk = delta.type === 'thinking_delta' ? (delta.thinking || '') : (delta.text || '')
        if (!chunk) break

        block.buffer += chunk

        if (block.kind === 'thinking') {
          const patch = updateEntryContent(block.entryIndex, block.buffer)
          this.msgStore.pushPatch(patch)
        } else {
          this.currentAssistantContent = block.buffer
          const patch = updateEntryContent(block.entryIndex, this.currentAssistantContent)
          this.msgStore.pushPatch(patch)
        }
        break
      }

      case 'content_block_stop': {
        const index = event.index
        if (index == null) break

        const block = this.streamingBlocks.get(index)
        if (!block) break

        if (block.kind === 'text') {
          // Keep currentAssistantIndex so next text block appends,
          // but flush will be called by next thinking block or tool_use
        }
        this.streamingBlocks.delete(index)
        break
      }

      case 'message_stop': {
        this.flushAssistantText()
        this.streamingBlocks.clear()
        this.streamingRole = null
        // 不清理 streamingMessages — 保留到 handleAssistantMessage 消费
        this.streamingMessageId = null
        break
      }
    }
  }

  /**
   * 完成解析
   */
  finish(): void {
    // 处理剩余的缓冲区
    if (this.buffer.trim()) {
      this.parseLine(this.buffer)
    }
    this.flushAssistantText()
  }
}

/**
 * 创建解析器并连接到 PTY
 */
export function createClaudeCodeParser(msgStore: MsgStore): ClaudeCodeParser {
  return new ClaudeCodeParser(msgStore)
}
