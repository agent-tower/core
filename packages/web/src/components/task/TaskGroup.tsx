import { memo, useState, useCallback, useRef, useEffect } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useDroppable, useDraggable } from '@dnd-kit/core'
import { IconReview, IconRunning, IconPending, IconDone, IconCancelled } from '../agent/Icons'
import { useI18n } from '@/lib/i18n'
import type { UITask, UIProject } from './types'
import { UITaskStatus } from './types'

const CONTEXT_MENU_OPTIONS = [
  { status: UITaskStatus.Review, label: 'Review', icon: IconReview, color: 'text-amber-600' },
  { status: UITaskStatus.Running, label: 'Running', icon: IconRunning, color: 'text-blue-600' },
  { status: UITaskStatus.Pending, label: 'Pending', icon: IconPending, color: 'text-neutral-600' },
  { status: UITaskStatus.Done, label: 'Done', icon: IconDone, color: 'text-emerald-600' },
  { status: UITaskStatus.Cancelled, label: 'Cancelled', icon: IconCancelled, color: 'text-neutral-500' },
] as const

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
}: {
  task: UITask
  status: UITaskStatus
  isSelected: boolean
  isAgentActive: boolean
  project: UIProject | undefined
  onSelectTask: (id: string) => void
  onTaskStatusChange?: (taskId: string, newStatus: UITaskStatus) => void
  onDeleteTask?: (taskId: string) => void
}) {
  const { t } = useI18n()
  const isTaskReadOnly = Boolean(task.projectArchivedAt)
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    data: { task, fromStatus: status },
    disabled: isTaskReadOnly,
  })

  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (isTaskReadOnly) return
    if (!onTaskStatusChange && !onDeleteTask) return
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }, [isTaskReadOnly, onTaskStatusChange, onDeleteTask])

  useEffect(() => {
    if (!contextMenu) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setContextMenu(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [contextMenu])

  return (
    <>
      <button
        ref={setNodeRef}
        onClick={() => onSelectTask(task.id)}
        onContextMenu={handleContextMenu}
        className={`flex items-start pl-8 pr-4 py-2 text-sm w-full text-left transition-all border-l-2 group
          ${isDragging ? 'opacity-30' : ''}
          ${isSelected
            ? 'bg-neutral-100 border-neutral-800'
            : 'border-transparent hover:bg-neutral-50 hover:border-neutral-200'
          }`}
        {...(isTaskReadOnly ? {} : listeners)}
        {...(isTaskReadOnly ? {} : attributes)}
      >
        <div className={`mt-0.5 mr-3 flex-shrink-0 ${status === UITaskStatus.Running ? 'text-blue-600' : 'text-neutral-500'}`}>
          {status === UITaskStatus.Review && <IconReview className={isSelected ? "text-amber-600" : "text-neutral-500"} />}
          {status === UITaskStatus.Running && <IconRunning className="animate-pulse" />}
          {status === UITaskStatus.Pending && <IconPending />}
          {status === UITaskStatus.Done && <IconDone className="text-neutral-400" />}
          {status === UITaskStatus.Cancelled && <IconCancelled className="text-neutral-400" />}
        </div>

        <div className="flex-1 min-w-0">
          <div className="mb-0.5">
            <span className={`font-medium mr-1 ${project?.color || 'text-neutral-500'}`}>
              {project?.name}
            </span>
            <span className="text-neutral-400">/</span>
            <span className={`ml-1 ${isSelected ? 'text-neutral-900' : 'text-neutral-700'}`}>
              {task.title}
            </span>
            {task.projectArchivedAt && (
              <span className="ml-1.5 inline-flex items-center rounded-full bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium text-neutral-500">
                {task.projectRepoDeletedAt ? t('源码已删除') : t('已删除')}
              </span>
            )}
            {isAgentActive && (
              <span className="relative inline-flex h-2 w-2 ml-1.5 align-middle">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
              </span>
            )}
          </div>
          {/* Task Description: visible, 2 lines max */}
          <p className={`text-xs line-clamp-2 leading-relaxed ${isSelected ? 'text-neutral-500' : 'text-neutral-400 group-hover:text-neutral-500'}`}>
            {task.description}
          </p>
        </div>
      </button>

      {/* 右键菜单 */}
      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-[100] w-44 bg-white rounded-lg border border-neutral-200 shadow-xl py-1 animate-in fade-in zoom-in-95 duration-100"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {onTaskStatusChange && (
            <>
              <div className="px-3 py-1.5 text-[10px] font-semibold text-neutral-400 uppercase tracking-wider">
                {t('Move to')}
              </div>
              {CONTEXT_MENU_OPTIONS.filter(o => o.status !== status).map(opt => {
                const Icon = opt.icon
                return (
                  <button
                    key={opt.status}
                    onClick={() => { onTaskStatusChange(task.id, opt.status); setContextMenu(null) }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-neutral-50 transition-colors"
                  >
                    <Icon className={`w-3.5 h-3.5 ${opt.color}`} />
                    <span className="text-neutral-700">{t(opt.label)}</span>
                  </button>
                )
              })}
            </>
          )}
          {onDeleteTask && (
            <>
              {onTaskStatusChange && <div className="my-1 border-t border-neutral-100" />}
              <button
                onClick={() => { onDeleteTask(task.id); setContextMenu(null) }}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-600 hover:bg-red-50 transition-colors"
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
        className="flex items-center w-full px-4 py-2 text-sm font-medium text-neutral-600 hover:text-neutral-900 hover:bg-neutral-50 transition-colors"
      >
        <span className="mr-2 text-neutral-400">
          {shouldShowContent ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <span className="flex-1 text-left">{translatedTitle}</span>
        {isReview && !isEmpty ? (
          <span className="px-2 py-0.5 bg-amber-100 text-amber-700 text-xs font-bold rounded-full animate-hop">
            {tasks.length}
          </span>
        ) : (
          <span className="text-xs text-neutral-400 font-normal">({tasks.length})</span>
        )}
      </button>

      {/* 目标分组：拖拽时显示紧凑 drop zone */}
      {isTargetGroup && (
        <div
          ref={setNodeRef}
          className={`mx-3 my-1 flex items-center justify-center rounded-lg border-2 border-dashed transition-all duration-150 h-10
            ${isOver
              ? 'border-blue-400 bg-blue-50 text-blue-600'
              : 'border-neutral-300 bg-neutral-50/50 text-neutral-400'
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
            ${isOver && !isSourceGroup ? 'bg-blue-50 ring-1 ring-blue-200' : ''}
            ${isEmpty && isGlobalDragging ? 'border border-dashed border-neutral-300' : ''}`}
        >
          {isEmpty ? (
            <span className="text-xs text-neutral-300 py-2 pl-8">{t('No tasks')}</span>
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
                />
              )
            })
          )}
        </div>
      )}
    </div>
  )
})
