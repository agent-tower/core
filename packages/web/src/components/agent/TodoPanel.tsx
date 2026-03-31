import { useState, useEffect } from 'react'
import { Circle, Check, CircleDot, ChevronDown } from 'lucide-react'
import type { TodoItem } from '@/hooks/use-todos'
import { useI18n } from '@/lib/i18n'

const TODO_PANEL_OPEN_KEY = 'agent-tower-todo-panel-open'

function getStatusIcon(status?: string, compact?: boolean) {
  const size = compact ? 'h-3 w-3' : 'h-3.5 w-3.5'
  const s = (status || '').toLowerCase()
  if (s === 'completed') return <Check aria-hidden className={`${size} text-emerald-500`} />
  if (s === 'in_progress' || s === 'in-progress') return <CircleDot aria-hidden className={`${size} text-blue-500`} />
  if (s === 'cancelled') return <Circle aria-hidden className={`${size} text-neutral-300`} />
  return <Circle aria-hidden className={`${size} text-neutral-400`} />
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
  const progressPct = todos.length > 0 ? (completedCount / todos.length) * 100 : 0

  return (
    <details
      className="group"
      open={isOpen}
      onToggle={(e) => setIsOpen((e.target as HTMLDetailsElement).open)}
    >
      {/* [style] hide iOS Safari default disclosure triangle */}
      <summary className="list-none cursor-pointer select-none [&::-webkit-details-marker]:hidden">
        <div className={`bg-neutral-50/80 border border-neutral-100 rounded-lg flex items-center justify-between hover:bg-neutral-100/80 transition-colors ${compact ? 'px-3 py-1.5' : 'px-3 py-2'}`}>
          <div className="flex items-center gap-2 min-w-0">
            <span className={`text-neutral-500 font-medium ${compact ? 'text-xs' : 'text-xs'}`}>
              {t('待办')}
            </span>
            <span className={`text-neutral-400 tabular-nums ${compact ? 'text-xs' : 'text-xs'}`}>
              {completedCount}/{todos.length}
            </span>
            {/* Mini progress bar */}
            <div className="w-12 h-1 bg-neutral-200/60 rounded-full overflow-hidden">
              <div
                className="h-full bg-emerald-400 rounded-full transition-all duration-300"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
          <ChevronDown
            aria-hidden
            className={`text-neutral-400 transition-transform group-open:rotate-180 ${compact ? 'h-3 w-3' : 'h-3.5 w-3.5'}`}
          />
        </div>
      </summary>
      <div className={`pt-1.5 pb-0.5 ${compact ? 'max-h-28 overflow-y-auto px-1' : 'px-1'}`}>
        <ul className="space-y-px" role="list" aria-label="Agent todo list">
          {todos.map((todo, index) => {
            const isCancelled = todo.status?.toLowerCase() === 'cancelled'
            const isCompleted = todo.status?.toLowerCase() === 'completed'
            return (
              <li
                key={`${todo.content}-${index}`}
                className={`flex items-center gap-1.5 rounded-md px-2 ${compact ? 'py-0.5' : 'py-[3px]'} ${isCompleted ? 'opacity-60' : ''}`}
              >
                <span className={`flex items-center justify-center shrink-0 ${compact ? 'h-3 w-3' : 'h-3.5 w-3.5'}`}>
                  {getStatusIcon(todo.status, compact)}
                </span>
                <span className={`${compact ? 'text-[11px] leading-[14px]' : 'text-xs leading-4'} text-neutral-600 wrap-break-word truncate ${isCancelled ? 'line-through text-neutral-400' : ''} ${isCompleted ? 'text-neutral-400' : ''}`}>
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
