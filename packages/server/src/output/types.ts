/**
 * 日志标准化类型系统
 * 参考 vibe-kanban Rust 实现
 */

// JSON Patch 类型 (RFC 6902)
export interface JsonPatchOperation {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test'
  path: string
  value?: unknown
  from?: string
}

export type JsonPatch = JsonPatchOperation[]

// 日志消息类型
export type LogMsg =
  | { type: 'stdout'; data: string }
  | { type: 'stderr'; data: string }
  | { type: 'patch'; patch: JsonPatch; seq: number }
  | { type: 'session_id'; id: string }
  | { type: 'message_id'; id: string }
  | { type: 'finished' }

// 标准化条目类型
export type NormalizedEntryType =
  | 'user_message'
  | 'user_feedback'
  | 'assistant_message'
  | 'tool_use'
  | 'system_message'
  | 'error_message'
  | 'thinking'
  | 'loading'
  | 'next_action'
  | 'token_usage_info'

// 动作类型
export type ActionType =
  | 'file_read'
  | 'file_edit'
  | 'command_run'
  | 'search'
  | 'web_fetch'
  | 'tool'
  | 'task_create'
  | 'plan_presentation'
  | 'todo_management'
  | 'other'

// 工具状态
export type ToolStatus =
  | 'created'
  | 'success'
  | 'failed'
  | 'denied'
  | 'pending_approval'
  | 'timed_out'

// 文件变更类型
export type FileChange =
  | { type: 'write'; path: string; content?: string }
  | { type: 'delete'; path: string }
  | { type: 'rename'; from: string; to: string }
  | { type: 'edit'; path: string; diff?: string }

// Todo 项
export interface TodoItem {
  content: string
  status: string
  priority?: string | null
}

// 标准化条目
export interface NormalizedEntry {
  id: string
  timestamp: number
  entryType: NormalizedEntryType
  content: string
  metadata?: {
    action?: ActionType
    toolName?: string
    toolId?: string
    status?: ToolStatus
    fileChanges?: FileChange[]
    tokenUsage?: {
      totalTokens?: number
      modelContextWindow?: number
    }
    error?: string
    /** Agent todo list (for todo_management action) */
    todos?: TodoItem[]
    todoOperation?: string
  }
}

// 标准化对话
export interface NormalizedConversation {
  sessionId?: string
  entries: NormalizedEntry[]
  /** Monotonic sequence number of the last patch applied to this snapshot.
   * Clients use this to dedupe patches received between SUBSCRIBE and snapshot fetch. */
  seq?: number
}

// 辅助函数：创建用户消息
export function createUserMessage(content: string, id?: string): NormalizedEntry {
  return {
    id: id || crypto.randomUUID(),
    timestamp: Date.now(),
    entryType: 'user_message',
    content,
  }
}

// 辅助函数：创建助手消息
export function createAssistantMessage(content: string, id?: string): NormalizedEntry {
  return {
    id: id || crypto.randomUUID(),
    timestamp: Date.now(),
    entryType: 'assistant_message',
    content,
  }
}

// 辅助函数：创建思考消息
export function createThinking(content: string, id?: string): NormalizedEntry {
  return {
    id: id || crypto.randomUUID(),
    timestamp: Date.now(),
    entryType: 'thinking',
    content,
  }
}

// 辅助函数：创建系统消息
export function createSystemMessage(content: string, id?: string): NormalizedEntry {
  return {
    id: id || crypto.randomUUID(),
    timestamp: Date.now(),
    entryType: 'system_message',
    content,
  }
}

// 辅助函数：创建错误消息
export function createErrorMessage(content: string, error?: string, id?: string): NormalizedEntry {
  return {
    id: id || crypto.randomUUID(),
    timestamp: Date.now(),
    entryType: 'error_message',
    content,
    metadata: error ? { error } : undefined,
  }
}

// 辅助函数：创建工具使用条目
export function createToolUse(
  toolName: string,
  content: string,
  action: ActionType,
  toolId?: string,
  id?: string,
  extras?: { todos?: TodoItem[]; todoOperation?: string }
): NormalizedEntry {
  return {
    id: id || crypto.randomUUID(),
    timestamp: Date.now(),
    entryType: 'tool_use',
    content,
    metadata: {
      action,
      toolName,
      status: 'created',
      ...(toolId ? { toolId } : {}),
      ...(extras?.todos ? { todos: extras.todos } : {}),
      ...(extras?.todoOperation ? { todoOperation: extras.todoOperation } : {}),
    },
  }
}

// 辅助函数：创建 token 使用信息
export function createTokenUsageInfo(
  totalTokens: number,
  modelContextWindow?: number,
  id?: string
): NormalizedEntry {
  return {
    id: id || crypto.randomUUID(),
    timestamp: Date.now(),
    entryType: 'token_usage_info',
    content: `Tokens: ${totalTokens}${modelContextWindow ? ` / ${modelContextWindow}` : ''}`,
    metadata: {
      tokenUsage: {
        totalTokens,
        ...(modelContextWindow != null ? { modelContextWindow } : {}),
      },
    },
  }
}

// 辅助函数：更新工具状态（不可变）
export function withToolStatus(entry: NormalizedEntry, status: ToolStatus): NormalizedEntry {
  return {
    ...entry,
    metadata: {
      ...entry.metadata,
      status,
    },
  }
}
