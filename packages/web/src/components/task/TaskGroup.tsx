import { memo, useState, useCallback, useRef, useEffect, useLayoutEffect, useContext, createContext } from 'react'
import { Check, ChevronRight, Trash2 } from 'lucide-react'
import { useDroppable, useDraggable } from '@dnd-kit/core'
import { DeleteTaskConfirmDialog } from './DeleteTaskConfirmDialog'
import { STATUS_STYLES, STATUS_ORDER } from './status-styles'
import { sidebarRowClass } from './sidebar-styles'
import { TaskPriority } from '@agent-tower/shared'
import { TaskPriorityIndicator } from './TaskPrioritySelect'
import { TASK_PRIORITY_OPTIONS } from './task-priority'
import { useI18n } from '@/lib/i18n'
import { cn, truncateEnd } from '@/lib/utils'
import type { UITask, UIProject } from './types'
import { UITaskStatus } from './types'

export interface FlipHandle {
  registry: Map<string, HTMLElement>
}
export const FlipContext = createContext<FlipHandle | null>(null)

const TICK_INTERVAL = 30_000

function useTick(interval = TICK_INTERVAL) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(n => n + 1), interval)
    return () => clearInterval(id)
  }, [interval])
}

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 侧栏紧凑相对时间：刚刚 / 3 分钟 / 2 小时 / 5 天；超过一周显示数字日期（9/23），跨年只到月（2025/9） */
function formatUpdatedAt(isoString: string, t: (source: string, values?: Record<string, number>) => string, locale: string): string {
  const time = new Date(isoString)
  const diff = Math.max(0, Math.floor((Date.now() - time.getTime()) / 1000))
  if (diff < MINUTE) return t('now')
  if (diff < HOUR) return t('{count}m', { count: Math.floor(diff / MINUTE) })
  if (diff < DAY) return t('{count}h', { count: Math.floor(diff / HOUR) })
  if (diff < 7 * DAY) return t('{count}d', { count: Math.floor(diff / DAY) })
  const sameYear = time.getFullYear() === new Date().getFullYear()
  return time.toLocaleDateString(locale, sameYear
    ? { month: 'numeric', day: 'numeric' }
    : { year: 'numeric', month: 'numeric' })
}

/** 项目标签只作提示：超过 9 个字宽（中文计 2）时截短并以「..」收尾，优先在连接符处断开（agent-tower → agent..） */
function shortenProjectName(name: string): string {
  const shortened = truncateEnd(name, 9, '..')
  if (shortened === name) return name
  const head = shortened.slice(0, -2)
  const boundary = head.search(/[-_.\s][^-_.\s]*$/)
  return `${boundary >= 3 ? head.slice(0, boundary) : head}..`
}

const MENU_ITEM_CLASS = 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-foreground/80 transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:outline-none'
const MENU_LABEL_CLASS = 'px-2 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground'
const MENU_SEPARATOR = <div className="-mx-1 my-1 h-px bg-border/60" />

interface TaskGroupProps {
  title: string
  tasks: UITask[]
  status: UITaskStatus
  defaultOpen: boolean
  selectedTaskId: string | null
  onSelectTask: (id: string) => void
  projects: UIProject[]
  /** 是否在任务行展示所属项目（按单个项目筛选时冗余，应关闭） */
  showProject?: boolean
  /** 是否有拖拽正在进行 */
  isDragging?: boolean
  /** 拖拽来源状态 */
  dragFromStatus?: UITaskStatus | null
  /** 状态变更回调（右键菜单） */
  onTaskStatusChange?: (taskId: string, newStatus: UITaskStatus) => void
  /** 删除任务回调（右键菜单） */
  onDeleteTask?: (taskId: string) => void
  /** 修改任务优先级回调（右键菜单） */
  onTaskPriorityChange?: (taskId: string, priority: TaskPriority) => void
  /** 移动端禁用拖拽，改用长按菜单 */
  disableDrag?: boolean
}

function DraggableTaskCard({
  task,
  status,
  isSelected,
  project,
  showProject,
  onSelectTask,
  onTaskStatusChange,
  onDeleteTask,
  onTaskPriorityChange,
  disableDrag,
}: {
  task: UITask
  status: UITaskStatus
  isSelected: boolean
  project: UIProject | undefined
  showProject: boolean
  onSelectTask: (id: string) => void
  onTaskStatusChange?: (taskId: string, newStatus: UITaskStatus) => void
  onDeleteTask?: (taskId: string) => void
  onTaskPriorityChange?: (taskId: string, priority: TaskPriority) => void
  disableDrag?: boolean
}) {
  const { t, locale } = useI18n()
  const flip = useContext(FlipContext)
  const cardRef = useRef<HTMLButtonElement | null>(null)
  const isTaskReadOnly = Boolean(task.projectArchivedAt)
  const dragDisabled = isTaskReadOnly || !!disableDrag
  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({
    id: task.id,
    data: { task, fromStatus: status },
    disabled: dragDisabled,
  })

  const mergedRef = useCallback((node: HTMLButtonElement | null) => {
    cardRef.current = node
    setDragRef(node)
    if (flip) {
      if (node) flip.registry.set(task.id, node)
      else flip.registry.delete(task.id)
    }
  }, [setDragRef, flip, task.id])

  useEffect(() => {
    return () => { flip?.registry.delete(task.id) }
  }, [task.id, flip])

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (isTaskReadOnly) return
    if (!onTaskStatusChange && !onDeleteTask && !onTaskPriorityChange) return
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }, [isTaskReadOnly, onTaskStatusChange, onDeleteTask, onTaskPriorityChange])

  const clearLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }, [])

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (!disableDrag || isTaskReadOnly || (!onTaskStatusChange && !onDeleteTask)) return
    const touch = e.touches[0]
    if (!touch) return
    const { clientX, clientY } = touch
    longPressTimer.current = setTimeout(() => {
      longPressTimer.current = null
      setContextMenu({ x: clientX, y: clientY })
    }, 500)
  }, [disableDrag, isTaskReadOnly, onTaskStatusChange, onDeleteTask])

  useEffect(() => {
    if (!contextMenu) return
    const close = () => setContextMenu(null)
    const handlePointer = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) close()
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', handlePointer)
    document.addEventListener('touchstart', handlePointer)
    document.addEventListener('keydown', handleKeyDown)
    // 菜单是 fixed 定位，列表滚动或窗口变化后会与任务行错位，直接收起
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', handlePointer)
      document.removeEventListener('touchstart', handlePointer)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [contextMenu])

  // 按菜单实际尺寸夹在视口内：在底部/右侧附近右键时向内收，避免被裁切
  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!contextMenu || !menu) return
    const margin = 8
    menu.style.left = `${Math.max(margin, Math.min(contextMenu.x, window.innerWidth - menu.offsetWidth - margin))}px`
    menu.style.top = `${Math.max(margin, Math.min(contextMenu.y, window.innerHeight - menu.offsetHeight - margin))}px`
  }, [contextMenu])

  const projectLabel = project ? project.name : undefined
  const projectTag = showProject ? project : undefined
  const updatedLabel = task.updatedAt ? formatUpdatedAt(task.updatedAt, t, locale) : null
  const { icon: StatusIcon, iconClass } = STATUS_STYLES[status]

  return (
    <>
      <button
        ref={mergedRef}
        type="button"
        onClick={() => onSelectTask(task.id)}
        onContextMenu={handleContextMenu}
        onTouchStart={handleTouchStart}
        onTouchEnd={clearLongPress}
        onTouchMove={clearLongPress}
        title={projectTag ? `${task.title} · ${projectTag.name}` : task.title}
        aria-label={projectLabel ? `${task.title} — ${projectLabel}` : task.title}
        aria-current={isSelected || undefined}
        data-sidebar-item=""
        className={cn('task-row animate-task-enter', sidebarRowClass(isSelected), isDragging && 'opacity-30')}
        {...(dragDisabled ? {} : listeners)}
        {...(dragDisabled ? {} : attributes)}
      >
        <StatusIcon
          className={cn('shrink-0', iconClass, status === UITaskStatus.Running && 'motion-safe:animate-pulse')}
        />

        <span className="min-w-0 flex-1 truncate">{task.title}</span>

        {task.priority !== undefined && task.priority !== TaskPriority.NORMAL && (
          <TaskPriorityIndicator priority={task.priority} />
        )}
        {task.projectArchivedAt && (
          <span className="inline-flex shrink-0 items-center rounded-full bg-foreground/[0.06] px-1.5 py-0.5 text-[10px] font-medium leading-none text-muted-foreground">
            {task.projectRepoDeletedAt ? t('源码已删除') : t('已删除')}
          </span>
        )}
        {(updatedLabel || projectTag) && (
          // 悬停时收起，把整行宽度让给标题（见 index.css .task-row-meta）
          <span className="task-row-meta">
            <span className="flex items-center gap-1">
              {projectTag && (
                // 项目名只作提示：JS 截短让标签贴合文字（完整名称见悬停提示）；侧栏过窄时隐藏，宽度优先留给标题。
                // 文字从项目色渐变到灰色，不占额外宽度也能按颜色区分项目（currentColor 取自项目色类名）
                <span className="shrink-0 whitespace-nowrap rounded bg-foreground/[0.05] px-1 py-0.5 text-[10px] font-medium leading-none @max-[22rem]:hidden">
                  <span className={cn(projectTag.color, 'bg-[linear-gradient(90deg,currentColor_0.6em,var(--muted-foreground)_2.6em)] bg-clip-text [-webkit-text-fill-color:transparent]')}>
                    {shortenProjectName(projectTag.name)}
                  </span>
                </span>
              )}
              {updatedLabel && (
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{updatedLabel}</span>
              )}
            </span>
          </span>
        )}
      </button>

      {/* 右键菜单（位置由上方 layout effect 写入） */}
      {contextMenu && (
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-[100] w-48 rounded-lg border border-border bg-popover p-1 shadow-lg shadow-black/5 animate-in fade-in zoom-in-95 duration-100"
        >
          {onTaskStatusChange && (
            <>
              <div className={MENU_LABEL_CLASS}>{t('Move to')}</div>
              {STATUS_ORDER.filter(s => s !== status).map(optStatus => {
                const { icon: Icon, label, accentClass } = STATUS_STYLES[optStatus]
                return (
                  <button
                    key={optStatus}
                    type="button"
                    role="menuitem"
                    onClick={() => { onTaskStatusChange(task.id, optStatus); setContextMenu(null) }}
                    className={MENU_ITEM_CLASS}
                  >
                    <Icon className={cn('size-3.5 shrink-0', accentClass)} />
                    <span>{t(label)}</span>
                  </button>
                )
              })}
            </>
          )}
          {onTaskPriorityChange && (
            <>
              {onTaskStatusChange && MENU_SEPARATOR}
              <div className={MENU_LABEL_CLASS}>{t('Priority')}</div>
              {TASK_PRIORITY_OPTIONS.map(option => {
                const isCurrent = (task.priority ?? TaskPriority.NORMAL) === option.value
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isCurrent}
                    onClick={() => { onTaskPriorityChange(task.id, option.value); setContextMenu(null) }}
                    className={MENU_ITEM_CLASS}
                  >
                    <TaskPriorityIndicator priority={option.value} />
                    <span className="flex-1">{t(option.label)}</span>
                    {isCurrent && <Check className="size-3.5 shrink-0 text-foreground" aria-hidden />}
                  </button>
                )
              })}
            </>
          )}
          {onDeleteTask && (
            <>
              {(onTaskStatusChange || onTaskPriorityChange) && MENU_SEPARATOR}
              <button
                type="button"
                role="menuitem"
                onClick={() => { setIsDeleteConfirmOpen(true); setContextMenu(null) }}
                className={cn(MENU_ITEM_CLASS, 'text-destructive hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10')}
              >
                <Trash2 className="size-3.5 shrink-0" aria-hidden />
                <span>{t('Delete Task')}</span>
              </button>
            </>
          )}
        </div>
      )}

      <DeleteTaskConfirmDialog
        isOpen={isDeleteConfirmOpen}
        onClose={() => setIsDeleteConfirmOpen(false)}
        onConfirm={() => {
          onDeleteTask?.(task.id)
          setIsDeleteConfirmOpen(false)
        }}
        taskId={task.id}
        taskTitle={task.title}
      />
    </>
  )
}

export const TaskGroup = memo(function TaskGroup({
  title,
  tasks,
  status,
  defaultOpen,
  selectedTaskId,
  onSelectTask,
  projects,
  showProject = true,
  isDragging: isGlobalDragging,
  dragFromStatus,
  onTaskStatusChange,
  onDeleteTask,
  onTaskPriorityChange,
  disableDrag,
}: TaskGroupProps) {
  const { t } = useI18n()
  const [isOpen, setIsOpen] = useState(defaultOpen)
  useTick()

  const isEmpty = tasks.length === 0

  const isSourceGroup = isGlobalDragging && dragFromStatus === status
  const isTargetGroup = isGlobalDragging && dragFromStatus !== status

  const { setNodeRef, isOver } = useDroppable({
    id: `group-${status}`,
    data: { status },
  })

  const isReview = status === UITaskStatus.Review
  const translatedTitle = t(title)

  // 来源分组：保持原样展示（拖走的卡片会半透明）
  // 目标分组：折叠为紧凑 drop zone
  // 非拖拽状态：正常展开/折叠
  const shouldShowContent = isGlobalDragging ? isSourceGroup : isOpen

  return (
    <div className="mb-2" data-task-group-status={status}>
      <div className="px-2">
        <button
          type="button"
          onClick={() => !isGlobalDragging && setIsOpen(prev => !prev)}
          aria-expanded={isOpen}
          data-sidebar-item=""
          className="group/header flex h-7 w-full items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <span className="truncate">{translatedTitle}</span>
          <ChevronRight
            size={12}
            aria-hidden
            className={cn(
              'shrink-0 text-muted-foreground/60 transition-transform duration-150 group-hover/header:text-muted-foreground',
              shouldShowContent && 'rotate-90',
            )}
          />
          {/* 待审查是唯一需要用户介入的分组，计数用暖色徽章突出 */}
          {isReview && !isEmpty ? (
            <span className="ml-auto rounded-full bg-warning/15 px-1.5 text-[11px] font-semibold leading-4 tabular-nums text-warning">
              {tasks.length}
            </span>
          ) : (
            <span className="ml-auto text-[11px] font-normal tabular-nums text-muted-foreground/80">{tasks.length}</span>
          )}
        </button>
      </div>

      {/* 目标分组：拖拽时显示紧凑 drop zone */}
      {isTargetGroup && (
        <div
          ref={setNodeRef}
          className={cn(
            'mx-2 mt-0.5 flex h-9 items-center justify-center rounded-md border border-dashed text-xs font-medium transition-colors duration-150',
            isOver ? 'border-info/50 bg-info/5 text-info' : 'border-border bg-foreground/[0.02] text-muted-foreground',
          )}
        >
          {isOver ? t('Drop into {title}', { title: translatedTitle }) : t('Drop here')}
        </div>
      )}

      {/* 来源分组 / 正常状态：展示任务列表；空分组只保留标题与计数 0 */}
      {shouldShowContent && !isTargetGroup && !isEmpty && (
        <div
          ref={isSourceGroup ? undefined : setNodeRef}
          className="mt-0.5 flex flex-col gap-px px-2"
        >
          {tasks.map(task => {
            const isSelected = selectedTaskId === task.id
            const project = task.projectId ? projects.find(p => p.id === task.projectId) : undefined
            return (
              <DraggableTaskCard
                key={task.id}
                task={task}
                status={status}
                isSelected={isSelected}
                project={project}
                showProject={showProject}
                onSelectTask={onSelectTask}
                onTaskStatusChange={task.projectArchivedAt ? undefined : onTaskStatusChange}
                onDeleteTask={task.projectArchivedAt ? undefined : onDeleteTask}
                onTaskPriorityChange={task.projectArchivedAt ? undefined : onTaskPriorityChange}
                disableDrag={disableDrag}
              />
            )
          })}
        </div>
      )}
    </div>
  )
})
