/**
 * NormalizedEntry → LogEntry 类型映射
 * 将后端标准化日志转换为前端 UI 组件可用的格式
 */

// ============ UI 层日志类型 (来自 design/agent-tower/types.ts) ============

export enum LogType {
  Action = 'Action',     // ◆ Agent Action
  Assistant = 'Assistant', // ◆ Assistant Message (markdown)
  Info = 'Info',         // ◇ Agent Explanation/Thinking
  Tool = 'Tool',         // ▶ Tool Call
  User = 'User',         // User Message
  Cursor = 'Cursor'      // █ Output Cursor
}

export interface LogEntry {
  id: string
  type: LogType
  content: string
  title?: string
  isCollapsed?: boolean
  children?: LogEntry[]
}

// ============ 标准化类型 (来自 server/output/types.ts) ============

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

export type ToolStatus =
  | 'created'
  | 'success'
  | 'failed'
  | 'denied'
  | 'pending_approval'
  | 'timed_out'

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
    fileChanges?: Array<{
      type: 'write' | 'delete' | 'rename' | 'edit'
      path: string
      content?: string
      diff?: string
      from?: string
      to?: string
    }>
    tokenUsage?: {
      inputTokens?: number
      outputTokens?: number
      cacheReadTokens?: number
      cacheWriteTokens?: number
    }
    error?: string
  }
}

// ============ 映射函数 ============

/**
 * 获取工具调用的显示标题
 */
function getToolTitle(entry: NormalizedEntry): string {
  const toolName = entry.metadata?.toolName || 'Tool'
  const action = entry.metadata?.action
  const status = entry.metadata?.status

  // 根据 action 类型生成更友好的标题
  const actionLabels: Record<ActionType, string> = {
    file_read: 'Read File',
    file_edit: 'Edit File',
    command_run: 'Run Command',
    search: 'Search',
    web_fetch: 'Fetch URL',
    tool: 'Tool',
    task_create: 'Create Task',
    plan_presentation: 'Present Plan',
    todo_management: 'Manage Todo',
    other: 'Action',
  }

  const label = action ? actionLabels[action] : toolName

  // 添加状态后缀
  if (status === 'success') {
    return `${label} ✓`
  } else if (status === 'failed') {
    return `${label} ✗`
  } else if (status === 'pending_approval') {
    return `${label} (待审批)`
  }

  return label
}

/**
 * 将单个 NormalizedEntry 转换为 LogEntry
 */
export function normalizedEntryToLogEntry(entry: NormalizedEntry): LogEntry | null {
  switch (entry.entryType) {
    case 'user_message':
    case 'user_feedback':
      return {
        id: entry.id,
        type: LogType.User,
        content: entry.content,
      }

    case 'assistant_message':
      return {
        id: entry.id,
        type: LogType.Assistant,
        content: entry.content,
      }

    case 'next_action':
      return {
        id: entry.id,
        type: LogType.Action,
        content: entry.content,
      }

    case 'thinking':
      return {
        id: entry.id,
        type: LogType.Info,
        content: entry.content,
      }

    case 'tool_use':
      return {
        id: entry.id,
        type: LogType.Tool,
        title: getToolTitle(entry),
        content: entry.content,
        isCollapsed: entry.metadata?.status === 'success',
      }

    case 'error_message':
      return {
        id: entry.id,
        type: LogType.Info,
        content: `❌ ${entry.content}${entry.metadata?.error ? `\n${entry.metadata.error}` : ''}`,
      }

    case 'system_message':
      return {
        id: entry.id,
        type: LogType.Info,
        content: entry.content,
      }

    case 'loading':
      // loading 状态可以用 Cursor 表示
      return {
        id: entry.id,
        type: LogType.Cursor,
        content: '',
      }

    case 'token_usage_info':
      // token 使用信息可以选择性显示
      if (entry.metadata?.tokenUsage) {
        const { inputTokens, outputTokens } = entry.metadata.tokenUsage
        return {
          id: entry.id,
          type: LogType.Info,
          content: `Token 使用: 输入 ${inputTokens || 0}, 输出 ${outputTokens || 0}`,
        }
      }
      return null

    default:
      return null
  }
}

/**
 * 批量转换 NormalizedEntry 数组为 LogEntry 数组
 */
export function normalizedEntriesToLogEntries(entries: NormalizedEntry[]): LogEntry[] {
  return entries
    .map(normalizedEntryToLogEntry)
    .filter((entry): entry is LogEntry => entry !== null)
}

/**
 * 创建一个 loading cursor entry
 */
export function createCursorEntry(): LogEntry {
  return {
    id: `cursor-${Date.now()}`,
    type: LogType.Cursor,
    content: '',
  }
}
