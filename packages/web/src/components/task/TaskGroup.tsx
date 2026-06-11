import { memo, useState, useCallback, useRef, useEffect } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useDroppable, useDraggable } from '@dnd-kit/core'
import { DeleteTaskConfirmDialog } from './DeleteTaskConfirmDialog'
import { STATUS_STYLES, STATUS_ORDER } from './status-styles'
import { useI18n } from '@/lib/i18n'
import type { UITask, UIProject } from './types'
import { UITaskStatus } from './types'

interface TaskGroupProps {
  title: string
  tasks: UITask[]
  status: UITaskStatus
  defaultOpen: boolean
  selectedTaskId: string | null
  onSelectTask: (id: string) => void
  projects: UIProject[]
  /** 当前有 Agent 正在运行的任务 ID 集合 */
  activeTaskIds?: Set<string>
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
  isAgentActive,
  project,
  onSelectTask,
  onTaskStatusChange,
  onDeleteTask,
  disableDrag,
}: {
  task: UITask
  status: UITaskStatus
  isSelected: boolean
  isAgentActive: boolean
  project: UIProject | undefined
  onSelectTask: (id: string) => void
  onTaskStatusChange?: (taskId: string, newStatus: UITaskStatus) => void
  onDeleteTask?: (taskId: string) => void
  disableDrag?: boolean
}) {
  const { t } = useI18n()
  const isTaskReadOnly = Boolean(task.projectArchivedAt)
  const dragDisabled = isTaskReadOnly || !!disableDrag
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    data: { task, fromStatus: status },
    disabled: dragDisabled,
  })

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

  return (
    <>
      <button
        ref={setNodeRef}
        onClick={() => onSelectTask(task.id)}
        onContextMenu={handleContextMenu}
        onTouchStart={handleTouchStart}
        onTouchEnd={clearLongPress}
        onTouchMove={clearLongPress}
        className={`flex items-start pl-7 pr-4 py-2 text-sm w-full text-left transition-all border-l-2 group
          ${isDragging ? 'opacity-30' : ''}
          ${isSelected
            ? 'bg-background border-brand'
            : 'border-transparent hover:bg-accent/50'
          }`}
        {...(dragDisabled ? {} : listeners)}
        {...(dragDisabled ? {} : attributes)}
      >
        <div className="mt-0.5 mr-3 flex-shrink-0">
          {(() => {
            const { icon: StatusIcon, iconClass } = STATUS_STYLES[status]
            return (
              <StatusIcon
                className={`${iconClass} ${status === UITaskStatus.Running ? 'animate-pulse' : ''}`}
              />
            )
          })()}
        </div>

        <div className="flex-1 min-w-0">
          {/* 第一行：任务标题为视觉主体 */}
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              className={`min-w-0 flex-1 truncate text-[13px] ${isSelected ? 'text-foreground font-medium' : 'text-foreground/90'}`}
              title={task.title}
            >
              {task.title}
            </span>
            {task.projectArchivedAt && (
              <span className="inline-flex shrink-0 items-center rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {task.projectRepoDeletedAt ? t('源码已删除') : t('已删除')}
              </span>
            )}
            {isAgentActive && (
              <span className="relative inline-flex h-2 w-2 shrink-0 align-middle">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-success/70" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-success" />
              </span>
            )}
          </div>
          {/* 第二行：灰色 meta（项目色点 + 项目名 + 分支） */}
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground/70">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${project?.color ? project.color.replace('text-', 'bg-') : 'bg-muted-foreground/40'}`} />
            <span className="truncate max-w-[45%]" title={project?.name}>{project?.name}</span>
            {task.branch && task.branch !== '—' ? (
              <>
                <span className="shrink-0 text-muted-foreground/40">·</span>
                <span className="truncate" title={task.branch}>{task.branch}</span>
              </>
            ) : null}
          </div>
        </div>
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
  activeTaskIds,
  isDragging: isGlobalDragging,
  dragFromStatus,
  onTaskStatusChange,
  onDeleteTask,
  disableDrag,
}: TaskGroupProps) {
  const { t } = useI18n()
  const [isOpen, setIsOpen] = useState(defaultOpen)

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
    <div className="mb-2">
      <button
        onClick={() => !isGlobalDragging && setIsOpen(prev => !prev)}
        className="flex items-center w-full px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
      >
        <span className="mr-2 text-muted-foreground/70">
          {shouldShowContent ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="flex-1 text-left">{translatedTitle}</span>
        {isReview && !isEmpty ? (
          <span className="px-2 py-0.5 bg-warning/15 text-warning text-xs font-bold rounded-full animate-hop">
            {tasks.length}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground/70 font-normal">({tasks.length})</span>
        )}
      </button>

      {/* 目标分组：拖拽时显示紧凑 drop zone */}
      {isTargetGroup && (
        <div
          ref={setNodeRef}
          className={`mx-3 my-1 flex items-center justify-center rounded-lg border-2 border-dashed transition-all duration-150 h-10
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
          className={`flex flex-col mt-1 min-h-[40px] rounded-md mx-2 transition-colors
            ${isOver && !isSourceGroup ? 'bg-info/10 ring-1 ring-info/30' : ''}
            ${isEmpty && isGlobalDragging ? 'border border-dashed border-border' : ''}`}
        >
          {isEmpty ? (
            <span className="text-xs text-muted-foreground/50 py-2 pl-7">{t('No tasks')}</span>
          ) : (
            tasks.map(task => {
              const project = projects.find(p => p.id === task.projectId)
              const isSelected = selectedTaskId === task.id
              const isAgentActive = activeTaskIds?.has(task.id) ?? false

              return (
                <DraggableTaskCard
                  key={task.id}
                  task={task}
                  status={status}
                  isSelected={isSelected}
                  isAgentActive={isAgentActive}
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
