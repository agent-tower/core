import { useMemo } from 'react'
import type { NormalizedEntry } from '@agent-tower/shared/log-adapter'

export interface TodoItem {
  content: string
  status: string
  priority?: string | null
}

interface UseTodosResult {
  todos: TodoItem[]
  inProgressTodo: TodoItem | null
}

/**
 * 从标准化日志条目中提取最新的 Agent Todo 列表
 * Agent (Claude Code / Cursor / Gemini) 在执行任务时会通过 TodoWrite 等工具
 * 输出自己的待办清单，此 hook 从 entries 流中提取最新的 todo 状态
 */
export function useTodos(entries: NormalizedEntry[]): UseTodosResult {
  return useMemo(() => {
    let latestTodos: TodoItem[] = []
    let latestTimestamp = 0

    for (const entry of entries) {
      if (
        entry.entryType === 'tool_use' &&
        entry.metadata?.action === 'todo_management' &&
        entry.metadata.todos &&
        entry.metadata.todos.length > 0
      ) {
        // Only update if todos have meaningful content
        const todos = entry.metadata.todos
        const hasMeaningful = todos.every(
          t => t.content && t.content.trim().length > 0 && t.status
        )
        if (hasMeaningful && entry.timestamp >= latestTimestamp) {
          latestTodos = todos
          latestTimestamp = entry.timestamp
        }
      }
    }

    const inProgressTodo = latestTodos.find(t => {
      const s = t.status?.toLowerCase()
      return s === 'in_progress' || s === 'in-progress'
    }) ?? null

    return { todos: latestTodos, inProgressTodo }
  }, [entries])
}
