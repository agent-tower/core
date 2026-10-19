import { useState, useEffect } from 'react'
import { ChevronDown } from 'lucide-react'
import { TodoStateIcon, Track, type TodoState } from '@/design-system'
import type { TodoItem } from '@/hooks/use-todos'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

const TODO_PANEL_OPEN_KEY = 'agent-tower-todo-panel-open'

/** Agent 上报的状态 → 设计系统的待办状态（图标、颜色与任务状态同一套） */
function toTodoState(status?: string): TodoState {
  const s = (status || '').toLowerCase()
  if (s === 'completed') return 'done'
  if (s === 'in_progress' || s === 'in-progress') return 'doing'
  if (s === 'cancelled') return 'cancelled'
  return 'todo'
}

interface TodoPanelProps {
  todos: TodoItem[]
  /** Compact mode for mobile — defaults to collapsed, constrained height */
  compact?: boolean
}

export function TodoPanel({ todos, compact }: TodoPanelProps) {
  const { t } = useI18n()
  const [isOpen, setIsOpen] = useState(() => {
    if (compact) return false
    const stored = localStorage.getItem(TODO_PANEL_OPEN_KEY)
    return stored === null ? true : stored === 'true'
  })

  useEffect(() => {
    localStorage.setItem(TODO_PANEL_OPEN_KEY, String(isOpen))
  }, [isOpen])

  if (!todos || todos.length === 0) return null

  const completedCount = todos.filter(t => t.status?.toLowerCase() === 'completed').length

  return (
    <details
      className="group"
      open={isOpen}
      onToggle={(e) => setIsOpen((e.target as HTMLDetailsElement).open)}
    >
      {/* [style] hide iOS Safari default disclosure triangle */}
      <summary className="list-none cursor-pointer select-none [&::-webkit-details-marker]:hidden">
        <div className={cn('flex items-center justify-between rounded-lg border border-border/60 bg-muted/50 transition-colors hover:bg-muted', compact ? 'px-3 py-1.5' : 'px-3 py-2')}>
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs font-medium text-muted-foreground">
              {t('待办')}
            </span>
            <span className="text-xs tabular-nums text-muted-foreground">
              {completedCount}/{todos.length}
            </span>
            {/* 进度条用墨色：这里的进度不代表风险，不上状态色 */}
            <Track value={completedCount} max={todos.length} size="xs" className="w-12" />
          </div>
          <ChevronDown
            aria-hidden
            className={cn('text-muted-foreground transition-transform group-open:rotate-180', compact ? 'size-3' : 'size-3.5')}
          />
        </div>
      </summary>
      <div className={`pt-1.5 pb-0.5 ${compact ? 'max-h-28 overflow-y-auto px-1' : 'px-1'}`}>
        <ul className="space-y-px" role="list" aria-label="Agent todo list">
          {todos.map((todo, index) => {
            const state = toTodoState(todo.status)
            // 已完成、已取消都划线变灰，但不隐藏
            const finished = state === 'done' || state === 'cancelled'
            return (
              <li
                key={`${todo.content}-${index}`}
                className={cn('flex items-center gap-1.5 rounded-md px-2', compact ? 'py-0.5' : 'py-[3px]')}
              >
                <TodoStateIcon state={state} className={compact ? 'size-3' : 'size-3.5'} />
                <span className={cn('truncate text-xs leading-4', finished ? 'text-muted-foreground line-through decoration-foreground/30' : 'text-foreground/80')}>
                  {todo.content}
                </span>
              </li>
            )
          })}
        </ul>
      </div>
    </details>
  )
}
