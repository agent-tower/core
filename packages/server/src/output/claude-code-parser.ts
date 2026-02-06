/**
 * Claude Code stream-json 输出解析器
 * 将 Claude Code 的 JSON 流输出转换为标准化日志
 */

import type { MsgStore } from './msg-store.js'
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
  updateEntryContent,
  updateToolStatus,
  setSessionId,
} from './utils/patch.js'

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
 * Claude Code 解析器
 */
export class ClaudeCodeParser {
  private msgStore: MsgStore
  private indexProvider: EntryIndexProvider
  private buffer: string = ''
  private toolEntryMap: Map<string, number> = new Map() // tool_use_id -> entry index
  private currentAssistantIndex: number | null = null
  private currentAssistantContent: string = ''

  constructor(msgStore: MsgStore) {
    this.msgStore = msgStore
    this.indexProvider = new EntryIndexProvider()
  }

  /**
   * 处理原始输出数据
   */
  processData(data: string): void {
    this.buffer += data
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() || ''

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
    try {
      const msg = JSON.parse(line) as ClaudeCodeMessage
      this.handleMessage(msg)
    } catch {
      // 非 JSON 行，忽略
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
   */
  private handleAssistantMessage(msg: ClaudeCodeMessage): void {
    if (!msg.message?.content) return

    for (const block of msg.message.content) {
      if (block.type === 'text' && block.text) {
        this.appendAssistantText(block.text)
      } else if (block.type === 'tool_use' && block.name) {
        this.flushAssistantText()
        this.handleToolUse(block.name, block.input, msg.message.id)
      } else if (block.type === 'thinking' && block.text) {
        this.flushAssistantText()
        this.addThinking(block.text)
      }
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
  private handleToolUse(toolName: string, input: unknown, messageId?: string): void {
    const action = toolNameToAction(toolName)
    const content = this.formatToolContent(toolName, input)
    const entry = createToolUse(toolName, content, action, messageId)
    const index = this.indexProvider.next()

    if (messageId) {
      this.toolEntryMap.set(messageId, index)
    }

    const patch = addNormalizedEntry(index, entry)
    this.msgStore.pushPatch(patch)
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
   */
  private handleUserMessage(msg: ClaudeCodeMessage): void {
    if (!msg.message?.content) return

    for (const block of msg.message.content) {
      if (block.type === 'text' && block.text) {
        const entry = createUserMessage(block.text)
        const index = this.indexProvider.next()
        const patch = addNormalizedEntry(index, entry)
        this.msgStore.pushPatch(patch)
      }
    }
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
