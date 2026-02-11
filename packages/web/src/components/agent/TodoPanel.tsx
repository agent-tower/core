import { useState, useEffect } from 'react'
import { Circle, Check, CircleDot, ChevronDown } from 'lucide-react'
import type { TodoItem } from '@/hooks/use-todos'

const TODO_PANEL_OPEN_KEY = 'agent-tower-todo-panel-open'

function getStatusIcon(status?: string) {
  const s = (status || '').toLowerCase()
  if (s === 'completed') return <Check aria-hidden className="h-4 w-4 text-emerald-500" />
  if (s === 'in_progress' || s === 'in-progress') return <CircleDot aria-hidden className="h-4 w-4 text-blue-500" />
  if (s === 'cancelled') return <Circle aria-hidden className="h-4 w-4 text-neutral-300" />
  return <Circle aria-hidden className="h-4 w-4 text-neutral-400" />
}

interface TodoPanelProps {
  todos: TodoItem[]
}

export function TodoPanel({ todos }: TodoPanelProps) {
  const [isOpen, setIsOpen] = useState(() => {
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
      <summary className="list-none cursor-pointer select-none">
        <div className="bg-neutral-50 border border-neutral-100 rounded-xl px-4 py-3 text-sm flex items-center justify-between hover:bg-neutral-100 transition-colors">
          <span className="text-neutral-600 font-medium">
            待办事项 ({completedCount}/{todos.length})
          </span>
          <ChevronDown
            aria-hidden
            className="h-4 w-4 text-neutral-400 transition-transform group-open:rotate-180"
          />
        </div>
      </summary>
      <div className="px-3 pt-2 pb-1">
        <ul className="space-y-1.5" role="list" aria-label="Agent todo list">
          {todos.map((todo, index) => (
            <li
              key={`${todo.content}-${index}`}
              className="flex items-start gap-2 py-1"
            >
              <span className="mt-0.5 h-4 w-4 flex items-center justify-center shrink-0">
                {getStatusIcon(todo.status)}
              </span>
              <span className="text-sm leading-5 text-neutral-700 wrap-break-word">
                {todo.status?.toLowerCase() === 'cancelled' ? (
                  <s className="text-neutral-400">{todo.content}</s>
                ) : (
                  todo.content
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </details>
  )
}
