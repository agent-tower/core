import { useState, useCallback, useRef, useMemo, useEffect, useLayoutEffect } from 'react'
import { Link } from 'react-router-dom'
import { SquarePen, FolderPlus, Search, Layers, MessageSquare } from 'lucide-react'
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import type { DragStartEvent, DragEndEvent } from '@dnd-kit/core'
import { useI18n } from '@/lib/i18n'
import { useIsMobile } from '@/hooks/use-mobile'
import { useDesktopTitlebar } from '@/lib/desktop-titlebar'
import { TaskGroup, FlipContext } from './TaskGroup'
import type { FlipHandle } from './TaskGroup'
import { TaskSearchModal } from './TaskSearchModal'
import type { UITask, UIProject } from './types'
import { UITaskStatus } from './types'

const GHOST_DURATION = 260
const GHOST_FALLBACK_DURATION = 220

interface TaskListProps {
  tasks?: UITask[]
  projects?: UIProject[]
  selectedTaskId: string | null
  onSelectTask: (id: string) => void
  filterProjectId: string | null
  setFilterProjectId: (id: string | null) => void
  width?: number | string
  onCreateTask?: () => void
  /** 新建项目入口回调 */
  onCreateProject?: () => void
  /** 右侧当前正在展示创建任务面板（用于点亮入口的选中态） */
  isCreateActive?: boolean
  /** 当前有 Agent 正在运行的任务 ID 集合 */
  activeTaskIds?: Set<string>
  /** 拖拽变更任务状态回调 */
  onTaskStatusChange?: (taskId: string, newStatus: UITaskStatus) => void
  /** 删除任务回调 */
  onDeleteTask?: (taskId: string) => void
}

/**
 * 单次遍历将任务按状态分组
 * 避免多次 filter 遍历
 */
function groupTasksByStatus(tasks: UITask[]) {
  const groups: Record<UITaskStatus, UITask[]> = {
    [UITaskStatus.Review]: [],
    [UITaskStatus.Running]: [],
    [UITaskStatus.Pending]: [],
    [UITaskStatus.Done]: [],
    [UITaskStatus.Cancelled]: [],
  }

  for (const task of tasks) {
    groups[task.status].push(task)
  }

  return groups
}

/** 任务分组展示顺序配置 */
const TASK_GROUP_CONFIG = [
  { status: UITaskStatus.Review, title: 'Review', defaultOpen: true },
  { status: UITaskStatus.Running, title: 'Running', defaultOpen: true },
  { status: UITaskStatus.Pending, title: 'Pending', defaultOpen: false },
  { status: UITaskStatus.Done, title: 'Done', defaultOpen: false },
  { status: UITaskStatus.Cancelled, title: 'Cancelled', defaultOpen: false },
] as const

export function TaskList({
  tasks = [],
  projects = [],
  selectedTaskId,
  onSelectTask,
  filterProjectId,
  setFilterProjectId,
  width = 320,
  onCreateTask,
  onCreateProject,
  isCreateActive,
  activeTaskIds,
  onTaskStatusChange,
  onDeleteTask,
}: TaskListProps) {
  const { t } = useI18n()
  const { preserveDesktopSearch } = useDesktopTitlebar()
  const isMobile = useIsMobile()
  const [activeDragTask, setActiveDragTask] = useState<UITask | null>(null)
  const [activeDragFromStatus, setActiveDragFromStatus] = useState<UITaskStatus | null>(null)
  const [isSearchOpen, setIsSearchOpen] = useState(false)

  const flipRegistryRef = useRef<Map<string, HTMLElement>>(new Map())
  const activeGhostsRef = useRef<Set<HTMLDivElement>>(new Set())
  const previousCardsRef = useRef<Map<string, { status: UITaskStatus; rect: DOMRect; html: string }>>(new Map())

  const flipHandle = useMemo<FlipHandle>(() => ({
    registry: flipRegistryRef.current,
  }), [])

  const removeGhost = useCallback((ghost: HTMLDivElement) => {
    ghost.remove()
    activeGhostsRef.current.delete(ghost)
  }, [])

  // 直接在 render 中计算派生状态，不使用 useEffect
  const filteredTasks = filterProjectId
    ? tasks.filter(t => t.projectId === filterProjectId)
    : tasks

  const getGroupFallbackRect = useCallback((status: UITaskStatus, fromRect: DOMRect): DOMRect | null => {
    const group = document.querySelector<HTMLElement>(`[data-task-group-status="${status}"]`)
    if (!group) return null

    const header = group.querySelector<HTMLElement>('button')
    const rect = (header ?? group).getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null

    return new DOMRect(rect.left + 8, rect.bottom + 4, fromRect.width, fromRect.height)
  }, [])

  const createStatusMoveGhost = useCallback((fromRect: DOMRect, toRect: DOMRect, html: string, isFallbackTarget = false) => {
    const ghost = document.createElement('div')
    ghost.setAttribute('aria-hidden', 'true')
    ghost.innerHTML = html
    const inner = ghost.firstElementChild as HTMLElement | null
    if (inner) {
      inner.style.cssText = ''
      inner.className = inner.className
        .replace(/\bopacity-\S*/g, '')
        .replace(/\banimate-task-enter\b/g, '')
      inner.style.pointerEvents = 'none'
      inner.style.width = `${fromRect.width}px`
      inner.style.height = `${fromRect.height}px`
      inner.style.margin = '0'
      inner.style.backgroundColor = 'var(--sidebar-accent)'
      inner.style.borderRadius = '0.375rem'
      inner.style.boxShadow = '0 6px 16px rgba(15, 23, 42, 0.10), 0 1px 3px rgba(15, 23, 42, 0.08)'
      inner.style.opacity = '0.96'
      inner.style.transition = 'none'
      inner.setAttribute('tabindex', '-1')
    }

    Object.assign(ghost.style, {
      position: 'fixed',
      left: `${fromRect.left}px`,
      top: `${fromRect.top}px`,
      width: `${fromRect.width}px`,
      height: `${fromRect.height}px`,
      zIndex: '9999',
      pointerEvents: 'none',
      overflow: 'visible',
      transformOrigin: 'top left',
      willChange: 'transform, opacity',
    })

    document.body.appendChild(ghost)
    activeGhostsRef.current.add(ghost)

    const dx = toRect.left - fromRect.left
    const dy = toRect.top - fromRect.top

    const animation = ghost.animate(
      [
        {
          transform: 'translate(0, 0)',
          opacity: 0.96,
          offset: 0,
        },
        {
          transform: `translate(${dx}px, ${dy}px)`,
          opacity: isFallbackTarget ? 0.12 : 0.96,
          offset: 1,
        },
      ],
      {
        duration: isFallbackTarget ? GHOST_FALLBACK_DURATION : GHOST_DURATION,
        easing: 'cubic-bezier(0.2, 0, 0, 1)',
        fill: 'forwards',
      },
    )

    animation.finished.then(
      () => removeGhost(ghost),
      () => removeGhost(ghost),
    )
  }, [removeGhost])

  useLayoutEffect(() => {
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const nextCards = new Map<string, { status: UITaskStatus; rect: DOMRect; html: string }>()

    for (const task of filteredTasks) {
      const el = flipRegistryRef.current.get(task.id)
      if (!el) continue

      const current = {
        status: task.status,
        rect: el.getBoundingClientRect(),
        html: el.outerHTML,
      }
      nextCards.set(task.id, current)

      if (prefersReduced) continue

      const previous = previousCardsRef.current.get(task.id)
      if (!previous || previous.status === task.status) continue

      const dx = current.rect.left - previous.rect.left
      const dy = current.rect.top - previous.rect.top
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue

      createStatusMoveGhost(previous.rect, current.rect, previous.html)
    }

    if (!prefersReduced) {
      for (const [taskId, previous] of previousCardsRef.current) {
        if (nextCards.has(taskId)) continue
        const nextTask = filteredTasks.find(task => task.id === taskId)
        if (!nextTask || nextTask.status === previous.status) continue

        const fallbackRect = getGroupFallbackRect(nextTask.status, previous.rect)
        if (!fallbackRect) continue
        createStatusMoveGhost(previous.rect, fallbackRect, previous.html, true)
      }
    }

    previousCardsRef.current = nextCards
  }, [filteredTasks, createStatusMoveGhost, getGroupFallbackRect])

  useEffect(() => () => {
    for (const ghost of activeGhostsRef.current) ghost.remove()
    activeGhostsRef.current.clear()
  }, [])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  )

  const handleDragStart = useCallback((event: DragStartEvent) => {
    const task = event.active.data.current?.task as UITask | undefined
    const fromStatus = event.active.data.current?.fromStatus as UITaskStatus | undefined
    if (task) setActiveDragTask(task)
    if (fromStatus) setActiveDragFromStatus(fromStatus)
  }, [])

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveDragTask(null)
    setActiveDragFromStatus(null)

    const { active, over } = event
    if (!over) return

    const task = active.data.current?.task as UITask | undefined
    const fromStatus = active.data.current?.fromStatus as UITaskStatus | undefined
    const toStatus = over.data.current?.status as UITaskStatus | undefined

    if (!task || !fromStatus || !toStatus) return
    if (task.projectArchivedAt) return
    if (fromStatus === toStatus) return

    onTaskStatusChange?.(task.id, toStatus)
  }, [onTaskStatusChange])

  const currentProject = filterProjectId
    ? projects.find(p => p.id === filterProjectId) ?? null
    : null
  const isCurrentProjectArchived = Boolean(currentProject?.archivedAt)
  const canCreateTask = !isCurrentProjectArchived

  // 单次遍历分组
  const grouped = groupTasksByStatus(filteredTasks)

  return (
    <div
      className="h-full flex flex-col flex-shrink-0"
      style={{ width }}
    >
      {/* 顶部菜单组（Codex 侧栏式）：新项目 / 新任务 / 搜索 */}
      <div className="px-2 pt-2 pb-1 flex-shrink-0">
        {onCreateProject && (
          <button
            onClick={onCreateProject}
            className="w-full flex items-center gap-2.5 px-2 py-2 rounded-md text-sm text-foreground/80 hover:bg-accent/50 transition-colors"
            title={t('New Project')}
          >
            <FolderPlus size={16} className="text-muted-foreground" />
            <span>{t('New Project')}</span>
          </button>
        )}
        <button
          onClick={onCreateTask}
          disabled={!canCreateTask}
          className={`w-full flex items-center gap-2.5 px-2 py-2 rounded-md text-sm transition-colors disabled:opacity-30 disabled:cursor-not-allowed
            ${isCreateActive
              ? 'bg-accent text-foreground'
              : 'text-foreground/80 hover:bg-accent/50'
            }`}
          title={canCreateTask ? t('New Task') : t('Deleted projects are read-only')}
        >
          <SquarePen size={16} className="text-muted-foreground" />
          <span>{t('New Task')}</span>
        </button>
        <button
          onClick={() => setIsSearchOpen(true)}
          className="w-full flex items-center gap-2.5 px-2 py-2 rounded-md text-sm text-foreground/80 hover:bg-accent/50 transition-colors"
          title={t('Search')}
        >
          <Search size={16} className="text-muted-foreground" />
          <span>{t('Search')}</span>
        </button>
        <Link
          to={preserveDesktopSearch('/conversations')}
          className="w-full flex items-center gap-2.5 px-2 py-2 rounded-md text-sm text-foreground/80 hover:bg-accent/50 transition-colors"
          title={t('对话')}
        >
          <MessageSquare size={16} className="text-muted-foreground" />
          <span>{t('对话')}</span>
        </Link>
      </div>

      {/* 空状态：当前视图下没有任何任务 */}
      {filteredTasks.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center px-6 text-center select-none">
          <Layers size={36} className="text-muted-foreground/40 mb-3" strokeWidth={1.5} />
          <p className="text-sm text-muted-foreground mb-4">{t('No tasks')}</p>
          {canCreateTask && onCreateTask ? (
            <button
              onClick={onCreateTask}
              className="px-3.5 py-1.5 rounded-md bg-brand text-brand-foreground text-xs font-medium hover:bg-brand/90 transition-colors"
            >
              {t('New Task')}
            </button>
          ) : null}
        </div>
      ) : (
      <FlipContext.Provider value={flipHandle}>
      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className="flex-1 overflow-y-auto scrollbar-app-thin pt-3 pb-4 relative">
          {TASK_GROUP_CONFIG.map(({ status, title, defaultOpen }) => (
            <TaskGroup
              key={status}
              title={title}
              tasks={grouped[status]}
              status={status}
              defaultOpen={defaultOpen}
              selectedTaskId={selectedTaskId}
              onSelectTask={onSelectTask}
              projects={projects}
              activeTaskIds={activeTaskIds}
              isDragging={activeDragTask !== null}
              dragFromStatus={activeDragFromStatus}
              onTaskStatusChange={onTaskStatusChange}
              onDeleteTask={onDeleteTask}
              disableDrag={isMobile}
            />
          ))}
        </div>

        <DragOverlay dropAnimation={null}>
          {activeDragTask ? (
            <div className="bg-popover shadow-lg rounded-md border border-border px-4 py-2 text-sm max-w-[280px] opacity-90">
              <span className="block truncate font-medium text-foreground/80" title={activeDragTask.title}>
                {activeDragTask.title}
              </span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      </FlipContext.Provider>
      )}

      {/* Footer */}
      {filteredTasks.length > 0 ? (
        <div className="px-4 py-3 border-t border-border/60 text-xs text-muted-foreground/70 flex items-center justify-between">
          <span>{t('{count} tasks', { count: filteredTasks.length })}</span>
          {filterProjectId ? (
            <button
              onClick={() => setFilterProjectId(null)}
              className="hover:text-foreground underline decoration-border underline-offset-2"
            >
              {t('Clear filter')}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="px-4 py-3 border-t border-border/60 text-xs text-muted-foreground/70 flex items-center justify-between">
          <span>{t('{count} tasks', { count: 0 })}</span>
        </div>
      )}

      {/* 任务搜索浮层 */}
      <TaskSearchModal
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        tasks={filteredTasks}
        projects={projects}
        onSelectTask={onSelectTask}
      />
    </div>
  )
}
