import { memo, useState, useCallback, useRef, useEffect, useContext, createContext } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useDroppable, useDraggable } from '@dnd-kit/core'
import { DeleteTaskConfirmDialog } from './DeleteTaskConfirmDialog'
import { STATUS_STYLES, STATUS_ORDER } from './status-styles'
import { useI18n, translate } from '@/lib/i18n'
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

function timeAgo(isoString: string): string {
  const diff = Math.max(0, Math.floor((Date.now() - new Date(isoString).getTime()) / 1000))
  if (diff < 60) return translate('{count}s ago', { count: diff })
  if (diff < 3600) return translate('{count}m ago', { count: Math.floor(diff / 60) })
  if (diff < 86400) return translate('{count}h ago', { count: Math.floor(diff / 3600) })
  return translate('{count}d ago', { count: Math.floor(diff / 86400) })
}

interface TaskGroupProps {
  title: string
  tasks: UITask[]
  status: UITaskStatus
  defaultOpen: boolean
  selectedTaskId: string | null
  onSelectTask: (id: string) => void
  projects: UIProject[]
  /** 是否有拖拽正在进行 */
  isDragging?: boolean
  /** 拖拽来源状态 */
  dragFromStatus?: UITaskStatus | null
  /** 状态变更回调（右键菜单） */
  onTaskStatusChange?: (taskId: string, newStatus: UITaskStatus) => void
  /** 删除任务回调（右键菜单） */
  onDeleteTask?: (taskId: string) => void
  /** 移动端禁用拖拽，改用长按菜单 */
  disableDrag?: boolean
}

function DraggableTaskCard({
  task,
  status,
  isSelected,
  project,
  onSelectTask,
  onTaskStatusChange,
  onDeleteTask,
  disableDrag,
}: {
  task: UITask
  status: UITaskStatus
  isSelected: boolean
  project: UIProject | undefined
  onSelectTask: (id: string) => void
  onTaskStatusChange?: (taskId: string, newStatus: UITaskStatus) => void
  onDeleteTask?: (taskId: string) => void
  disableDrag?: boolean
}) {
  const { t } = useI18n()
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
    if (!onTaskStatusChange && !onDeleteTask) return
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }, [isTaskReadOnly, onTaskStatusChange, onDeleteTask])

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
    const handler = (e: MouseEvent | TouchEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setContextMenu(null)
    }
    document.addEventListener('mousedown', handler)
    document.addEventListener('touchstart', handler)
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('touchstart', handler)
    }
  }, [contextMenu])

  const projectLabel = project ? project.name : undefined

  return (
    <>
      <button
        ref={mergedRef}
        onClick={() => onSelectTask(task.id)}
        onContextMenu={handleContextMenu}
        onTouchStart={handleTouchStart}
        onTouchEnd={clearLongPress}
        onTouchMove={clearLongPress}
        title={projectLabel}
        aria-label={projectLabel ? `${task.title} — ${projectLabel}` : task.title}
        className={`flex items-center gap-2.5 ml-4 mr-2 px-2 py-2 rounded-md text-sm text-left transition-colors group animate-task-enter
          ${isDragging ? 'opacity-30' : ''}
          ${isSelected ? 'bg-accent' : 'hover:bg-accent/50'}`}
        {...(dragDisabled ? {} : listeners)}
        {...(dragDisabled ? {} : attributes)}
      >
        <span className="shrink-0 flex items-center">
          {(() => {
            const { icon: StatusIcon, iconClass } = STATUS_STYLES[status]
            return (
              <StatusIcon
                className={`${iconClass} ${status === UITaskStatus.Running ? 'animate-pulse' : ''}`}
              />
            )
          })()}
        </span>

        <span
          className={`min-w-0 flex-1 truncate ${isSelected ? 'text-foreground font-medium' : 'text-foreground/90'}`}
        >
          {task.title}
        </span>
        {task.projectArchivedAt && (
          <span className="inline-flex shrink-0 items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            {task.projectRepoDeletedAt ? t('源码已删除') : t('已删除')}
          </span>
        )}
        {task.updatedAt && (
          <span
            className="shrink-0 text-[11px] text-muted-foreground/50 tabular-nums"
          >
            {timeAgo(task.updatedAt)}
          </span>
        )}
        {project && (
          <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${project.color.replace('text-', 'bg-')}`} />
        )}
      </button>

      {/* 右键菜单 */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-[100] w-44 bg-popover rounded-lg border border-border shadow-lg py-1 animate-in fade-in zoom-in-95 duration-100"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {onTaskStatusChange && (
            <>
              <div className="px-3 py-1.5 text-[10px] font-semibold text-muted-foreground/70 uppercase tracking-wider">
                {t('Move to')}
              </div>
              {STATUS_ORDER.filter(s => s !== status).map(optStatus => {
                const { icon: Icon, label, accentClass } = STATUS_STYLES[optStatus]
                return (
                  <button
                    key={optStatus}
                    onClick={() => { onTaskStatusChange(task.id, optStatus); setContextMenu(null) }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-accent/50 transition-colors"
                  >
                    <Icon className={`w-3.5 h-3.5 ${accentClass}`} />
                    <span className="text-foreground/80">{t(label)}</span>
                  </button>
                )
              })}
            </>
          )}
          {onDeleteTask && (
            <>
              {onTaskStatusChange && <div className="my-1 border-t border-border/60" />}
              <button
                onClick={() => { setIsDeleteConfirmOpen(true); setContextMenu(null) }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-destructive hover:bg-destructive/10 transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-3.5 h-3.5">
                  <path d="M3 6h18" /><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" /><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                </svg>
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
  isDragging: isGlobalDragging,
  dragFromStatus,
  onTaskStatusChange,
  onDeleteTask,
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
  const shouldShowContent = isGlobalDragging ? isSourceGroup && (isOpen || true) : isOpen

  return (
    <div className="mb-2" data-task-group-status={status}>
      <button
        onClick={() => !isGlobalDragging && setIsOpen(prev => !prev)}
        className="flex items-center gap-1.5 w-full px-4 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors group/header"
      >
        <span className="flex-1 text-left">{translatedTitle}</span>
        {isReview && !isEmpty ? (
          <span className="px-1.5 py-0.5 bg-warning/15 text-warning text-[11px] font-semibold rounded-full animate-hop">
            {tasks.length}
          </span>
        ) : (
          <span className="text-[11px] text-muted-foreground/50 font-normal tabular-nums">{tasks.length}</span>
        )}
        <span className="text-muted-foreground/50">
          {shouldShowContent ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
      </button>

      {/* 目标分组：拖拽时显示紧凑 drop zone */}
      {isTargetGroup && (
        <div
          ref={setNodeRef}
          className={`mx-2 my-1 flex items-center justify-center rounded-lg border-2 border-dashed transition-all duration-150 h-10
            ${isOver
              ? 'border-info bg-info/10 text-info'
              : 'border-border bg-muted/30 text-muted-foreground/70'
            }`}
        >
          <span className="text-xs font-medium">
            {isOver ? t('Drop into {title}', { title: translatedTitle }) : t('Drop here')}
          </span>
        </div>
      )}

      {/* 来源分组 / 正常状态：展示任务列表 */}
      {shouldShowContent && !isTargetGroup && (
        <div
          ref={isSourceGroup ? undefined : setNodeRef}
          className={`flex flex-col mt-0.5 min-h-[40px] rounded-md transition-colors
            ${isOver && !isSourceGroup ? 'bg-info/10 ring-1 ring-info/30' : ''}
            ${isEmpty && isGlobalDragging ? 'border border-dashed border-border mx-2' : ''}`}
        >
          {isEmpty ? (
            <span className="text-xs text-muted-foreground/50 py-2 px-4">{t('No tasks')}</span>
          ) : (
            tasks.map(task => {
              const isSelected = selectedTaskId === task.id
              const project = task.projectId ? projects.find(p => p.id === task.projectId) : undefined
              return (
                <DraggableTaskCard
                  key={task.id}
                  task={task}
                  status={status}
                  isSelected={isSelected}
                  project={project}
                  onSelectTask={onSelectTask}
                  onTaskStatusChange={task.projectArchivedAt ? undefined : onTaskStatusChange}
                  onDeleteTask={task.projectArchivedAt ? undefined : onDeleteTask}
                  disableDrag={disableDrag}
                />
              )
            })
          )}
        </div>
      )}
    </div>
  )
})
