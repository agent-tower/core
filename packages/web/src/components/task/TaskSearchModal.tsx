import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { Search } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { STATUS_STYLES } from './status-styles'
import type { UITask, UIProject } from './types'

const RECENT_LIMIT = 12
const RESULT_LIMIT = 50

interface TaskSearchModalProps {
  isOpen: boolean
  onClose: () => void
  tasks: UITask[]
  projects: UIProject[]
  onSelectTask: (id: string) => void
}

/** Codex 式任务搜索浮层：输入过滤 + 近期任务 + ↑↓/Enter 键盘导航 */
export function TaskSearchModal({ isOpen, onClose, tasks, projects, onSelectTask }: TaskSearchModalProps) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isOpen) {
      setQuery('')
      setActiveIndex(0)
    }
  }, [isOpen])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return tasks.slice(0, RECENT_LIMIT)
    return tasks.filter(task => task.title.toLowerCase().includes(q)).slice(0, RESULT_LIMIT)
  }, [tasks, query])

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  // active 项滚动跟随
  useEffect(() => {
    const item = listRef.current?.children[activeIndex] as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const handleSelect = useCallback((taskId: string) => {
    onSelectTask(taskId)
    onClose()
  }, [onSelectTask, onClose])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex(prev => Math.min(prev + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex(prev => Math.max(prev - 1, 0))
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      const task = results[activeIndex]
      if (task) handleSelect(task.id)
    }
  }, [onClose, results, activeIndex, handleSelect])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-90" role="dialog" aria-modal="true">
      {/* 遮罩 */}
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />

      {/* 浮层主体：居中偏上 */}
      <div className="absolute left-1/2 top-[18vh] w-[min(560px,calc(100vw-2rem))] -translate-x-1/2 bg-popover rounded-xl border border-border shadow-lg overflow-hidden animate-in fade-in zoom-in-95 duration-100">
        {/* 搜索输入 */}
        <div className="flex items-center gap-2.5 px-4 border-b border-border/60">
          <Search size={15} className="text-muted-foreground/70 shrink-0" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('Search tasks...')}
            aria-label={t('Search tasks...')}
            autoFocus
            className="flex-1 py-3 bg-transparent border-none focus:outline-none text-sm text-foreground placeholder-muted-foreground/60"
          />
        </div>

        {/* 结果列表 */}
        {results.length > 0 ? (
          <>
            {!query.trim() && (
              <div className="px-4 pt-2.5 pb-1 text-[11px] font-medium text-muted-foreground/70">
                {t('Recent tasks')}
              </div>
            )}
            <div ref={listRef} className="max-h-[46vh] overflow-y-auto scrollbar-app-thin pb-1.5 pt-0.5">
              {results.map((task, index) => {
                const project = projects.find(p => p.id === task.projectId)
                const { icon: StatusIcon, iconClass } = STATUS_STYLES[task.status]
                return (
                  <button
                    key={task.id}
                    onClick={() => handleSelect(task.id)}
                    onMouseEnter={() => setActiveIndex(index)}
                    className={`w-full flex items-center gap-2.5 px-4 py-2 text-left transition-colors
                      ${index === activeIndex ? 'bg-accent' : ''}`}
                  >
                    <StatusIcon className={`${iconClass} shrink-0`} />
                    <span className="flex-1 min-w-0 truncate text-sm text-foreground/90" title={task.title}>
                      {task.title}
                    </span>
                    {project && (
                      <span className="shrink-0 max-w-[120px] truncate text-xs text-muted-foreground/70">
                        {project.name}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          </>
        ) : (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground/70">
            {t('No matching tasks')}
          </div>
        )}
      </div>
    </div>
  )
}
