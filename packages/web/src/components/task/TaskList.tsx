import { useState, useCallback } from 'react'
import { SquarePen, FolderPlus, Search, Layers } from 'lucide-react'
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import type { DragStartEvent, DragEndEvent } from '@dnd-kit/core'
import { useI18n } from '@/lib/i18n'
import { useIsMobile } from '@/hooks/use-mobile'
import { TaskGroup } from './TaskGroup'
import { TaskSearchModal } from './TaskSearchModal'
import type { UITask, UIProject } from './types'
import { UITaskStatus } from './types'

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
  const isMobile = useIsMobile()
  const [activeDragTask, setActiveDragTask] = useState<UITask | null>(null)
  const [activeDragFromStatus, setActiveDragFromStatus] = useState<UITaskStatus | null>(null)
  const [isSearchOpen, setIsSearchOpen] = useState(false)

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

  // 直接在 render 中计算派生状态，不使用 useEffect
  const filteredTasks = filterProjectId
    ? tasks.filter(t => t.projectId === filterProjectId)
    : tasks

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
