import { memo, useState, useCallback, useRef, useEffect, useLayoutEffect, useContext, useId } from 'react'
import { Check, ChevronRight, ListTree, Plus, Trash2 } from 'lucide-react'
import { useDroppable, useDraggable } from '@dnd-kit/core'
import { useSubtasks } from '@/hooks/use-tasks'
import { adaptTaskBoardItemForList } from './adapters'
import { FlipContext } from './task-list-flip'
import { DeleteTaskConfirmDialog } from './DeleteTaskConfirmDialog'
import { STATUS_STYLES, STATUS_ORDER } from './status-styles'
import { sidebarRowClass } from './sidebar-styles'
import { TaskPriority, canCreateSubtask } from '@agent-tower/shared'
import { TaskPriorityIndicator } from './TaskPrioritySelect'
import { TASK_PRIORITY_OPTIONS } from './task-priority'
import { formatTaskUpdatedAt } from './task-time'
import { getTaskActivitySummary, getTaskStatusSummary } from './task-status-summary'
import { TaskGradientText } from './TaskGradientText'
import { useI18n } from '@/lib/i18n'
import { cn, truncateEnd } from '@/lib/utils'
import type { UITask, UIProject } from './types'
import { UITaskStatus } from './types'

const TICK_INTERVAL = 30_000

function useTick(interval = TICK_INTERVAL) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(n => n + 1), interval)
    return () => clearInterval(id)
  }, [interval])
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
const MENU_LABEL_CLASS = 'px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground'
const MENU_SEPARATOR = <div className="-mx-1 my-1 h-px bg-border/60" />

interface TaskGroupProps {
  title: string
  tasks: UITask[]
  status: UITaskStatus
  defaultOpen: boolean
  selectedTaskId: string | null
  selectedParentTaskId?: string | null
  selectionPath?: UITask[]
  onCreateSubtask?: (taskId: string) => void
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
  onDeleteTask?: (taskId: string, expectedSubtaskCount?: number) => void
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
  onCreateSubtask,
  selectedTaskId,
  expandForSelection,
  selectionPath,
}: {
  onCreateSubtask?: (taskId: string) => void
  selectedTaskId?: string | null
  expandForSelection?: boolean
  selectionPath?: UITask[]
  task: UITask
  status: UITaskStatus
  isSelected: boolean
  project: UIProject | undefined
  showProject: boolean
  onSelectTask: (id: string) => void
  onTaskStatusChange?: (taskId: string, newStatus: UITaskStatus) => void
  onDeleteTask?: (taskId: string, expectedSubtaskCount?: number) => void
  onTaskPriorityChange?: (taskId: string, priority: TaskPriority) => void
  disableDrag?: boolean
}) {
  const { t, locale } = useI18n()
  const [childrenExpansion, setChildrenExpansion] = useState<{ selection?: string | null; open: boolean }>({ open: false })
  const childrenOpen = childrenExpansion.open || Boolean(expandForSelection && childrenExpansion.selection !== selectedTaskId)
  const children = useSubtasks(task.id, childrenOpen && canCreateSubtask(task))
  const childCount = children.data?.pages[0]?.total ?? task.subtaskCount ?? 0
  const childRows = children.data?.pages.flatMap(page => page.data).map(child => adaptTaskBoardItemForList(child)) ?? []
  // Keep every edge of a selected path visible, even beyond the first child page.
  const selectedChildTask = selectionPath?.find(node => node.parentTaskId === task.id)
  if (selectedChildTask?.parentTaskId === task.id && !childRows.some(child => child.id === selectedChildTask.id)) {
    childRows.push(selectedChildTask)
  }
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
    if (!onTaskStatusChange && !onDeleteTask && !onTaskPriorityChange && !onCreateSubtask) return
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }, [isTaskReadOnly, onTaskStatusChange, onDeleteTask, onTaskPriorityChange, onCreateSubtask, setContextMenu])

  const clearLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }, [])

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (!disableDrag || isTaskReadOnly || (!onTaskStatusChange && !onDeleteTask && !onCreateSubtask)) return
    const touch = e.touches[0]
    if (!touch) return
    const { clientX, clientY } = touch
    longPressTimer.current = setTimeout(() => {
      longPressTimer.current = null
      setContextMenu({ x: clientX, y: clientY })
    }, 500)
  }, [disableDrag, isTaskReadOnly, onTaskStatusChange, onDeleteTask, onCreateSubtask, setContextMenu])

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
  const updatedLabel = task.updatedAt ? formatTaskUpdatedAt(task.updatedAt, t, locale) : null
  const { titleClass } = STATUS_STYLES[status]
  const statusSummary = getTaskStatusSummary(task, t)

  return (
    <>
      <div className="flex min-w-0 items-center gap-0.5">
      <button
        ref={mergedRef}
        type="button"
        onClick={() => onSelectTask(task.id)}
        onContextMenu={handleContextMenu}
        onTouchStart={handleTouchStart}
        onTouchEnd={clearLongPress}
        onTouchMove={clearLongPress}
        title={[projectTag ? `${task.title} · ${projectTag.name}` : task.title, statusSummary].filter(Boolean).join('\n')}
        aria-label={projectLabel ? `${task.title} — ${projectLabel}` : task.title}
        aria-current={isSelected || undefined}
        data-sidebar-item=""
        className={cn('task-row animate-task-enter', sidebarRowClass(isSelected), 'min-w-0 flex-1', isDragging && 'opacity-30')}
        {...(dragDisabled ? {} : listeners)}
        {...(dragDisabled ? {} : attributes)}
      >
        {task.parentTaskId && (() => {
          const { icon: StatusIcon, accentClass, label } = STATUS_STYLES[status]
          return <span className="shrink-0" title={t(label)} aria-label={t(label)}><StatusIcon className={cn('size-3.5', accentClass)} /></span>
        })()}
        {/* 行首不放状态图标，宽度全部留给标题；状态由分组标题表达，标题样式只区分「多需要你介入」 */}
        {status === UITaskStatus.Running ? (
          <TaskGradientText text={task.title} variant="running" animate={!isSelected} className={cn('min-w-0 flex-1 truncate', titleClass)} />
        ) : (
          <span className={cn('min-w-0 flex-1 truncate', titleClass)}>{task.title}</span>
        )}

        {task.priority !== undefined && task.priority !== TaskPriority.NORMAL && (
          <TaskPriorityIndicator priority={task.priority} />
        )}
        {task.projectArchivedAt && (
          <span className="inline-flex shrink-0 items-center rounded-full bg-foreground/[0.06] px-1.5 py-0.5 text-xs font-medium leading-none text-muted-foreground">
            {task.projectRepoDeletedAt ? t('源码已删除') : t('已删除')}
          </span>
        )}
        {(updatedLabel || projectTag) && (
          // 悬停时收起，把整行宽度让给标题（见 index.css .task-row-meta）
          <span className="task-row-meta">
            <span className="flex items-center gap-1">
              {projectTag && (
                // 项目名只作提示：JS 截短让标签贴合文字（完整名称见悬停提示）；侧栏过窄时隐藏，宽度优先留给标题。
                // 仅为屏幕内的文字绘制渐变，避免长列表创建大量文字裁剪蒙版。
                <span className="shrink-0 whitespace-nowrap rounded bg-foreground/[0.05] px-1 py-0.5 text-[10px] font-medium leading-none @max-[22rem]:hidden">
                  <TaskGradientText text={shortenProjectName(projectTag.name)} variant="project" className={projectTag.color} />
                </span>
              )}
              {updatedLabel && (
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{updatedLabel}</span>
              )}
            </span>
          </span>
        )}
      </button>
      {canCreateSubtask(task) && childCount > 0 && (
        <button type="button" data-sidebar-item="" aria-expanded={childrenOpen}
          aria-label={t('Subtasks of {title}', { title: task.title })}
          title={[t('{count} subtasks', { count: childCount }), getTaskActivitySummary(task, t)].filter(Boolean).join('\n')}
          onClick={() => setChildrenExpansion({ selection: selectedTaskId, open: !childrenOpen })}
          className="flex h-8 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:h-10">
          <ListTree size={14} /><span className="tabular-nums">{childCount}</span>
          <ChevronRight size={12} className={cn('transition-transform', childrenOpen && 'rotate-90')} />
        </button>
      )}
      </div>
      {canCreateSubtask(task) && childrenOpen && (
        <div className="ml-4 border-l border-border/60 pl-1" role="group" aria-label={t('Subtasks of {title}', { title: task.title })}>
          {children.isLoading && <p className="px-2 py-1 text-xs text-muted-foreground">{t('Loading...')}</p>}
          {children.isError && <button type="button" className={MENU_ITEM_CLASS} onClick={() => children.refetch()}>{t('Could not load subtasks. Retry')}</button>}
          {childRows.map(row => {
            return <DraggableTaskCard key={row.id} task={{ ...row, projectArchivedAt: task.projectArchivedAt }} status={row.status}
              isSelected={selectedTaskId === row.id} project={project} showProject={false}
              selectedTaskId={selectedTaskId} selectionPath={selectionPath}
              expandForSelection={selectionPath?.some(node => node.parentTaskId === row.id)}
              onCreateSubtask={onCreateSubtask}
              onSelectTask={onSelectTask} onTaskStatusChange={onTaskStatusChange}
              onDeleteTask={onDeleteTask} onTaskPriorityChange={onTaskPriorityChange} disableDrag={disableDrag} />
          })}
          {children.hasNextPage && <button type="button" className={MENU_ITEM_CLASS} disabled={children.isFetchingNextPage} onClick={() => children.fetchNextPage()}>{t('Load more')}</button>}
        </div>
      )}

      {/* 右键菜单（位置由上方 layout effect 写入） */}
      {contextMenu && (
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-[100] w-48 rounded-lg border border-border bg-popover p-1 shadow-popover shadow-black/5 animate-in fade-in zoom-in-95 duration-100"
        >
          {onCreateSubtask && canCreateSubtask(task) && (
            <>
              <button type="button" role="menuitem" className={MENU_ITEM_CLASS}
                onClick={() => { onCreateSubtask(task.id); setContextMenu(null) }}>
                <Plus className="size-3.5 shrink-0" /><span>{t('Create subtask')}</span>
              </button>
              {MENU_SEPARATOR}
            </>
          )}
          {onTaskStatusChange && (
            <>
              <div className={MENU_LABEL_CLASS}>{task.ownStatus && task.ownStatus !== status
                ? t('Own status: {status}', { status: t(task.ownStatus) }) : t('Move to')}</div>
              {STATUS_ORDER.filter(s => s !== (task.ownStatus ?? status)).map(optStatus => {
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
                className={cn(MENU_ITEM_CLASS, 'text-destructive-ink hover:bg-destructive/10 hover:text-destructive-ink focus-visible:bg-destructive/10')}
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
        onConfirm={(count) => {
          onDeleteTask?.(task.id, count)
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
  selectedParentTaskId,
  selectionPath,
  onCreateSubtask,
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
  const [expansion, setExpansion] = useState<{ selection: string | null; open: boolean }>({ selection: null, open: defaultOpen })
  const isOpen = expansion.open || Boolean(selectedTaskId && expansion.selection !== selectedTaskId
    && tasks.some(task => task.id === selectedTaskId || task.id === selectedParentTaskId || selectionPath?.some(node => node.id === task.id)))
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
  const { icon: StatusIcon, accentClass } = STATUS_STYLES[status]
  const labelId = useId()

  // 来源分组：保持原样展示（拖走的卡片会半透明）
  // 目标分组：折叠为紧凑 drop zone
  // 非拖拽状态：正常展开/折叠
  const shouldShowContent = isGlobalDragging ? isSourceGroup : isOpen
  const showRows = shouldShowContent && !isTargetGroup && !isEmpty

  return (
    // 展开的分组下方留 16px（组内行距 1px），只靠间距就能看出分组边界
    <div className={showRows ? 'mb-4' : 'mb-2'} data-task-group-status={status}>
      {/* 分组标题吸顶：任务行不再带状态图标，滚动长列表时靠它知道当前在哪个分组 */}
      <div className="sticky top-0 z-10 bg-sidebar px-2">
        <button
          type="button"
          onClick={() => !isGlobalDragging && setExpansion({ selection: selectedTaskId, open: !isOpen })}
          aria-expanded={isOpen}
          data-sidebar-item=""
          // 与任务行同字号、同行高，只靠灰色常规体和任务标题区分层级
          className="group/header flex h-8 w-full items-center gap-1 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:h-10 pointer-coarse:text-[15px]"
        >
          {/* 状态图标每组只出现一次，与右键「移动到」菜单同一套图标；左缘与任务标题同在 16px 线上，文字与顶部菜单的文字对齐。
              14–15px 的中文字形比行框中心高约 1.5px，图标上移 1px 才看着齐（取整像素，1x / 2x / 3x 屏都不发虚） */}
          <StatusIcon className={cn('mr-1.5 size-4 shrink-0 -translate-y-px', accentClass)} />
          <span id={labelId} className="truncate">{translatedTitle}</span>
          <ChevronRight
            size={14}
            aria-hidden
            className={cn(
              'shrink-0 text-muted-foreground transition-transform duration-150 group-hover/header:text-muted-foreground',
              shouldShowContent && 'rotate-90',
            )}
          />
          {/* 待审查是唯一需要用户介入的分组，计数用暖色徽章突出 */}
          {isReview && !isEmpty ? (
            <span className="ml-auto rounded-full bg-warning/15 px-1.5 text-xs font-semibold leading-5 tabular-nums text-warning-ink">
              {tasks.length}
            </span>
          ) : (
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">{tasks.length}</span>
          )}
        </button>
      </div>

      {/* 目标分组：拖拽时显示紧凑 drop zone */}
      {isTargetGroup && (
        <div
          ref={setNodeRef}
          className={cn(
            'mx-2 mt-0.5 flex h-9 items-center justify-center rounded-md border border-dashed text-xs font-medium transition-colors duration-150',
            isOver ? 'border-foreground/30 bg-foreground/[0.04] text-foreground/80' : 'border-border bg-foreground/[0.02] text-muted-foreground',
          )}
        >
          {isOver ? t('Drop into {title}', { title: translatedTitle }) : t('Drop here')}
        </div>
      )}

      {/* 来源分组 / 正常状态：展示任务列表；空分组只保留标题与计数 0 */}
      {showRows && (
        <div
          ref={isSourceGroup ? undefined : setNodeRef}
          role="group"
          aria-labelledby={labelId}
          className="mt-0.5 flex flex-col gap-px px-2"
        >
          {tasks.map(task => {
            const isSelected = selectedTaskId === task.id
            const project = task.projectId ? projects.find(p => p.id === task.projectId) : undefined
            return (
              <DraggableTaskCard
                key={task.id}
                selectedTaskId={selectedTaskId}
                selectionPath={selectionPath}
                expandForSelection={selectedParentTaskId === task.id || selectionPath?.some(node => node.parentTaskId === task.id)}
                onCreateSubtask={task.projectArchivedAt ? undefined : onCreateSubtask}
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
