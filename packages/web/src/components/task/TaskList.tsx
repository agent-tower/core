import { useState, useCallback } from 'react'
import { ChevronDown, Plus, Layers, Check } from 'lucide-react'
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors } from '@dnd-kit/core'
import type { DragStartEvent, DragEndEvent } from '@dnd-kit/core'
import { useI18n } from '@/lib/i18n'
import { TaskGroup } from './TaskGroup'
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
  onCreateProject?: () => void
  onCreateTask?: () => void
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
  onCreateProject,
  onCreateTask,
  activeTaskIds,
  onTaskStatusChange,
  onDeleteTask,
}: TaskListProps) {
  const { t } = useI18n()
  const [isFilterOpen, setIsFilterOpen] = useState(false)
  const [activeDragTask, setActiveDragTask] = useState<UITask | null>(null)
  const [activeDragFromStatus, setActiveDragFromStatus] = useState<UITaskStatus | null>(null)

  // 需要一定拖拽距离才触发，避免点击误触
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

  // 单次遍历分组
  const grouped = groupTasksByStatus(filteredTasks)

  const isFullWidth = width === '100%'

  return (
    <div
      className={`h-full flex flex-col bg-white flex-shrink-0 ${isFullWidth ? '' : 'border-r border-neutral-200'}`}
      style={{ width }}
    >
      {/* Header: 项目筛选下拉 */}
      <div className="h-14 flex items-center justify-between px-3 border-b border-neutral-100 flex-shrink-0 relative z-20">
        <div className="relative flex-1 mr-2">
          <button
            onClick={() => setIsFilterOpen(prev => !prev)}
            className="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm font-semibold text-neutral-900 hover:bg-neutral-100 transition-colors w-full text-left group"
          >
            {filterProjectId && currentProject ? (
              <>
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${currentProject.color.replace('text-', 'bg-')}`} />
                <span className="truncate">{currentProject.name}</span>
              </>
            ) : (
              <>
                <Layers size={16} className="text-neutral-500 group-hover:text-neutral-800" />
                <span>{t('All Projects')}</span>
              </>
            )}
            <ChevronDown
              size={14}
              className={`text-neutral-400 ml-auto transition-transform duration-200 ${isFilterOpen ? 'rotate-180' : ''}`}
            />
          </button>

          {/* 下拉菜单 */}
          {isFilterOpen ? (
            <>
              {/* Backdrop */}
              <div className="fixed inset-0 z-30" onClick={() => setIsFilterOpen(false)} />

              {/* Menu */}
              <div className="absolute left-0 top-full mt-1 w-56 bg-white border border-neutral-200 rounded-lg shadow-xl shadow-neutral-200/50 z-40 py-1 animate-in fade-in zoom-in-95 duration-100 origin-top-left">
                <div className="px-3 py-2 text-[10px] font-semibold text-neutral-400 uppercase tracking-wider">
                  {t('Select View')}
                </div>

                <button
                  onClick={() => { setFilterProjectId(null); setIsFilterOpen(false) }}
                  className="w-full text-left px-3 py-2 text-xs flex items-center justify-between hover:bg-neutral-50 transition-colors group"
                >
                  <div className="flex items-center gap-2">
                    <div className="w-5 h-5 flex items-center justify-center rounded border border-neutral-200 bg-neutral-50 text-neutral-500 group-hover:border-neutral-300">
                      <Layers size={12} />
                    </div>
                    <span className={filterProjectId === null ? 'text-neutral-900 font-medium' : 'text-neutral-600'}>
                      {t('All Projects')}
                    </span>
                  </div>
                  {filterProjectId === null ? <Check size={14} className="text-neutral-900" /> : null}
                </button>

                <div className="h-px bg-neutral-100 my-1 mx-2" />

                {projects.map(p => {
                  const isActive = filterProjectId === p.id
                  const bgClass = p.color.replace('text-', 'bg-')

                  return (
                    <button
                      key={p.id}
                      onClick={() => { setFilterProjectId(p.id); setIsFilterOpen(false) }}
                      className="w-full text-left px-3 py-2 text-xs flex items-center justify-between hover:bg-neutral-50 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ml-1.5 mr-1.5 ${bgClass}`} />
                        <span className={isActive ? 'text-neutral-900 font-medium' : 'text-neutral-600'}>
                          {p.name}
                        </span>
                      </div>
                      {isActive ? <Check size={14} className="text-neutral-900" /> : null}
                    </button>
                  )
                })}

                <div className="h-px bg-neutral-100 my-1 mx-2" />

                {/* 创建项目入口 */}
                <button
                  onClick={() => { setIsFilterOpen(false); onCreateProject?.() }}
                  className="w-full text-left px-3 py-2 text-xs flex items-center gap-2 text-neutral-500 hover:text-neutral-900 hover:bg-neutral-50 transition-colors"
                >
                  <Plus size={14} />
                  <span>{t('Create New Project...')}</span>
                </button>
              </div>
            </>
          ) : null}
        </div>

        <button
          onClick={onCreateTask}
          className="p-1.5 text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100 rounded-md transition-colors flex-shrink-0"
          title={t('New Task')}
        >
          <Plus size={18} />
        </button>
      </div>

      {/* 任务分组列表 */}
      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className="flex-1 overflow-y-auto py-4 relative">
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
            />
          ))}
        </div>

        <DragOverlay dropAnimation={null}>
          {activeDragTask ? (
            <div className="bg-white shadow-lg rounded-md border border-neutral-200 px-4 py-2 text-sm max-w-[280px] opacity-90">
              <span className="text-neutral-700 font-medium">{activeDragTask.title}</span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Footer */}
      {filteredTasks.length > 0 ? (
        <div className="p-4 border-t border-neutral-100 text-xs text-neutral-400 flex items-center justify-between">
          <span>{t('{count} tasks', { count: filteredTasks.length })}</span>
          {filterProjectId ? (
            <button
              onClick={() => setFilterProjectId(null)}
              className="hover:text-neutral-800 underline decoration-neutral-300 underline-offset-2"
            >
              {t('Clear filter')}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="p-4 border-t border-neutral-100 text-xs text-neutral-400 flex items-center justify-between">
          <span>{t('{count} tasks', { count: 0 })}</span>
        </div>
      )}
    </div>
  )
}
