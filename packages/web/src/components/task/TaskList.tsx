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
import { STATUS_STYLES } from './status-styles'
import { sidebarRowClass } from './sidebar-styles'
import type { UITask, UIProject } from './types'
import { UITaskStatus } from './types'
import { TaskPriority } from '@agent-tower/shared'
import { cn } from '@/lib/utils'

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
  /** 拖拽变更任务状态回调 */
  onTaskStatusChange?: (taskId: string, newStatus: UITaskStatus) => void
  /** 删除任务回调 */
  onDeleteTask?: (taskId: string) => void
  /** 修改任务优先级回调 */
  onTaskPriorityChange?: (taskId: string, priority: TaskPriority) => void
  /** 首屏数据加载中：顶部菜单照常可用，列表区显示骨架 */
  isLoading?: boolean
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

  groups[UITaskStatus.Review].sort((a, b) =>
    (b.priority ?? TaskPriority.NORMAL) - (a.priority ?? TaskPriority.NORMAL),
  )

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

/** 列表加载骨架：几何与真实分组标题 / 任务行一致，加载完成时不跳动 */
function TaskRowsSkeleton() {
  return (
    <div className="flex-1 overflow-hidden px-2 pt-3 motion-safe:animate-pulse" aria-hidden>
      {[3, 4].map((rows, group) => (
        <div key={group} className="mb-4">
          <div className="flex h-7 items-center gap-1.5 px-2">
            <div className="size-3.5 shrink-0 rounded-full bg-foreground/[0.06]" />
            <div className="h-2.5 w-12 rounded-full bg-foreground/[0.06]" />
          </div>
          {Array.from({ length: rows }).map((_, i) => (
            <div key={i} className="flex h-8 items-center gap-2.5 px-2 pointer-coarse:h-10">
              <div className="h-3 rounded-full bg-foreground/[0.06]" style={{ width: `${64 - ((i + group) % 3) * 14}%` }} />
              <div className="ml-auto h-2.5 w-8 shrink-0 rounded-full bg-foreground/[0.05]" />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

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
  onTaskStatusChange,
  onDeleteTask,
  onTaskPriorityChange,
  isLoading = false,
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

    return new DOMRect(rect.left, rect.bottom + 2, fromRect.width, fromRect.height)
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
      inner.style.backgroundColor = 'var(--background)'
      inner.style.borderRadius = '0.5rem'
      inner.style.boxShadow = '0 4px 6px rgba(0, 0, 0, 0.08), 0 0 0 1px var(--border)'
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
  const dragStatus = activeDragTask ? STATUS_STYLES[activeDragTask.status] : null

  // ↑/↓ 在侧栏可聚焦项（菜单、分组标题、任务行）之间移动焦点，Enter/空格沿用按钮默认行为
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-sidebar-item]:not(:disabled)'))
    const index = items.indexOf(e.target as HTMLElement)
    if (index === -1) return
    e.preventDefault()
    items[index + (e.key === 'ArrowDown' ? 1 : -1)]?.focus()
  }, [])

  return (
    <div
      className="@container h-full flex flex-col flex-shrink-0"
      style={{ width }}
      onKeyDown={handleKeyDown}
    >
      {/* 顶部菜单组（Codex 侧栏式）：新项目 / 新任务 / 搜索 / 对话 */}
      <div className="px-2 pt-2 pb-1 flex flex-col gap-px flex-shrink-0">
        {onCreateProject && (
          <button type="button" onClick={onCreateProject} data-sidebar-item="" className={sidebarRowClass(false)}>
            <FolderPlus size={16} className="shrink-0 text-muted-foreground" />
            <span className="truncate">{t('New Project')}</span>
          </button>
        )}
        <button
          type="button"
          onClick={onCreateTask}
          disabled={!canCreateTask}
          aria-current={isCreateActive || undefined}
          data-sidebar-item=""
          className={cn(sidebarRowClass(Boolean(isCreateActive)), 'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent')}
          title={canCreateTask ? undefined : t('Deleted projects are read-only')}
        >
          <SquarePen size={16} className="shrink-0 text-muted-foreground" />
          <span className="truncate">{t('New Task')}</span>
        </button>
        <button type="button" onClick={() => setIsSearchOpen(true)} data-sidebar-item="" className={sidebarRowClass(false)}>
          <Search size={16} className="shrink-0 text-muted-foreground" />
          <span className="truncate">{t('Search')}</span>
        </button>
        <Link to={preserveDesktopSearch('/conversations')} data-sidebar-item="" className={sidebarRowClass(false)}>
          <MessageSquare size={16} className="shrink-0 text-muted-foreground" />
          <span className="truncate">{t('对话')}</span>
        </Link>
      </div>

      {isLoading ? (
        <TaskRowsSkeleton />
      ) : filteredTasks.length === 0 ? (
        /* 空状态：当前视图下没有任何任务（略高于几何中心，视觉上更居中） */
        <div className="flex-1 flex flex-col items-center justify-center px-6 pb-[10vh] text-center select-none">
          <Layers size={36} className="text-muted-foreground/40 mb-3" strokeWidth={1.5} />
          <p className="text-sm text-muted-foreground mb-4">{t('No tasks')}</p>
          {canCreateTask && onCreateTask ? (
            <button
              type="button"
              onClick={onCreateTask}
              className="px-3.5 py-1.5 rounded-md bg-brand text-brand-foreground text-xs font-medium hover:bg-brand/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2"
            >
              {t('New Task')}
            </button>
          ) : null}
        </div>
      ) : (
      <FlipContext.Provider value={flipHandle}>
      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        {/* scroll-pt 让出吸顶分组标题的高度，↑/↓ 聚焦的任务行不会被标题盖住 */}
        <div className="flex-1 overflow-y-auto scrollbar-app-thin scroll-pt-8 relative">
          {/* 上下留白放在内层：sticky 会避让滚动容器自身的 padding，吸顶标题上方会漏出滚过去的任务行 */}
          <div className="pt-3 pb-4">
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
                showProject={!filterProjectId}
                isDragging={activeDragTask !== null}
                dragFromStatus={activeDragFromStatus}
                onTaskStatusChange={onTaskStatusChange}
                onDeleteTask={onDeleteTask}
                onTaskPriorityChange={onTaskPriorityChange}
                disableDrag={isMobile}
              />
            ))}
          </div>
        </div>

        {/* 拖拽浮层：与选中态同材质的白卡，Level 3 阴影表达「被拿起」 */}
        <DragOverlay dropAnimation={null}>
          {activeDragTask && dragStatus ? (
            <div className="flex h-8 w-fit max-w-[280px] items-center gap-2.5 rounded-md bg-background px-2 text-sm text-foreground shadow-[0_12px_16px_-4px_rgba(36,36,36,0.08)] ring-1 ring-border/80">
              <dragStatus.icon className={cn('size-4 shrink-0', dragStatus.iconClass)} />
              <span className="truncate" title={activeDragTask.title}>{activeDragTask.title}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      </FlipContext.Provider>
      )}

      {/* Footer */}
      {!isLoading && (
        <div className="h-9 px-4 flex flex-shrink-0 items-center justify-between border-t border-border/60 text-xs text-muted-foreground">
          <span className="tabular-nums">{t('{count} tasks', { count: filteredTasks.length })}</span>
          {filterProjectId ? (
            <button
              type="button"
              onClick={() => setFilterProjectId(null)}
              className="rounded-sm hover:text-foreground underline decoration-border underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              {t('Clear filter')}
            </button>
          ) : null}
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
