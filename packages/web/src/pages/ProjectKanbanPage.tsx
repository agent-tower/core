import { useState, useCallback, useRef, useEffect, lazy, Suspense } from 'react'
import { TaskList } from '@/components/task'
import { TaskDetail } from '@/components/task/TaskDetail'
import type { UITaskDetailData } from '@/components/task/types'
import { MOCK_TASKS, MOCK_PROJECTS } from '@/components/task/mock-data'
import type { UITask } from '@/components/task/types'
import { Settings } from 'lucide-react'

// === bundle-dynamic-imports: Modal 组件懒加载 ===
const Modal = lazy(() =>
  import('@/components/ui/modal').then(m => ({ default: m.Modal }))
)

// === rendering-hoist-jsx: 静态 Logo SVG 提升到组件外 ===
const LOGO_ICON = (
  <svg
    width="22"
    height="22"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className="text-neutral-900"
  >
    <path d="M12 2L2 7L12 12L22 7L12 2Z" fill="currentColor" />
    <path
      d="M2 17L12 22L22 17"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M2 12L12 17L22 12"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

// === rendering-hoist-jsx: 静态顶部栏标题文字 ===
const HEADER_TITLE = (
  <span className="text-sm font-bold tracking-tight text-neutral-900">
    Agent Tower
  </span>
)

// === 拖拽 resize 的常量配置 ===
const MIN_SIDEBAR_WIDTH = 260
const MAX_SIDEBAR_WIDTH = 600
const DEFAULT_SIDEBAR_WIDTH = 340

/**
 * 根据 task id 查找对应的 TaskDetail 数据
 * 简化映射：使用 mock 数据
 */
function findTaskDetailData(task: UITask | undefined): UITaskDetailData | null {
  if (!task) return null
  const project = MOCK_PROJECTS.find(p => p.id === task.projectId)
  return {
    id: task.id,
    projectName: project?.name ?? 'Unknown',
    projectColor: project?.color ?? 'text-neutral-500',
    title: task.title,
    status: task.status,
    branch: task.branch,
    description: task.description,
  }
}

export function ProjectKanbanPage() {
  // === 状态 ===
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [filterProjectId, setFilterProjectId] = useState<string | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH)

  // Modal 状态
  const [isCreateProjectOpen, setIsCreateProjectOpen] = useState(false)
  const [isCreateTaskOpen, setIsCreateTaskOpen] = useState(false)
  const [newProjectName, setNewProjectName] = useState('')
  const [newTaskTitle, setNewTaskTitle] = useState('')

  // === rerender-use-ref-transient-values: resize 过程中的 mouse position 使用 ref ===
  const isDraggingRef = useRef(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(DEFAULT_SIDEBAR_WIDTH)
  const containerRef = useRef<HTMLDivElement>(null)

  // === 选中的任务 ===
  const selectedTask = selectedTaskId
    ? MOCK_TASKS.find(t => t.id === selectedTaskId)
    : undefined
  const taskDetailData = findTaskDetailData(selectedTask)

  // === rerender-defer-reads: 侧边栏宽度只在 resize handler 中读取 ===
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isDraggingRef.current = true
    startXRef.current = e.clientX
    startWidthRef.current = sidebarWidth
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [sidebarWidth])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return
      const delta = e.clientX - startXRef.current
      const newWidth = Math.max(
        MIN_SIDEBAR_WIDTH,
        Math.min(MAX_SIDEBAR_WIDTH, startWidthRef.current + delta)
      )
      setSidebarWidth(newWidth)
    }

    const handleMouseUp = () => {
      if (!isDraggingRef.current) return
      isDraggingRef.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [])

  // === Modal 回调 ===
  const handleCreateProject = useCallback(() => {
    setIsCreateProjectOpen(true)
  }, [])

  const handleCreateTask = useCallback(() => {
    setIsCreateTaskOpen(true)
  }, [])

  const handleCloseProjectModal = useCallback(() => {
    setIsCreateProjectOpen(false)
    setNewProjectName('')
  }, [])

  const handleCloseTaskModal = useCallback(() => {
    setIsCreateTaskOpen(false)
    setNewTaskTitle('')
  }, [])

  const handleSubmitProject = useCallback(() => {
    if (!newProjectName.trim()) return
    // TODO: 调用 API 创建项目
    console.log('Create project:', newProjectName)
    handleCloseProjectModal()
  }, [newProjectName, handleCloseProjectModal])

  const handleSubmitTask = useCallback(() => {
    if (!newTaskTitle.trim()) return
    // TODO: 调用 API 创建任务
    console.log('Create task:', newTaskTitle)
    handleCloseTaskModal()
  }, [newTaskTitle, handleCloseTaskModal])

  return (
    <div ref={containerRef} className="h-screen flex flex-col overflow-hidden bg-white">
      {/* === 顶部栏 === */}
      <header className="h-12 flex items-center justify-between px-4 border-b border-neutral-100 bg-white flex-shrink-0 z-30">
        <div className="flex items-center gap-2.5">
          {LOGO_ICON}
          {HEADER_TITLE}
        </div>
        <button className="p-1.5 text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100 rounded-md transition-colors">
          <Settings size={16} />
        </button>
      </header>

      {/* === 主体双栏区域 === */}
      <div className="flex-1 flex overflow-hidden">
        {/* 左侧: TaskList */}
        <TaskList
          tasks={MOCK_TASKS}
          projects={MOCK_PROJECTS}
          selectedTaskId={selectedTaskId}
          onSelectTask={setSelectedTaskId}
          filterProjectId={filterProjectId}
          setFilterProjectId={setFilterProjectId}
          width={sidebarWidth}
          onCreateProject={handleCreateProject}
          onCreateTask={handleCreateTask}
        />

        {/* 拖拽分隔线 */}
        <div
          onMouseDown={handleMouseDown}
          className="w-1 cursor-col-resize hover:bg-blue-200 active:bg-blue-300 transition-colors flex-shrink-0 relative group"
        >
          <div className="absolute inset-y-0 -left-1 -right-1 group-hover:bg-blue-100/50" />
        </div>

        {/* 右侧: TaskDetail */}
        <TaskDetail task={taskDetailData} />
      </div>

      {/* === Modals (懒加载) === */}
      <Suspense fallback={null}>
        {/* 创建项目 Modal */}
        <Modal
          isOpen={isCreateProjectOpen}
          onClose={handleCloseProjectModal}
          title="Create New Project"
          action={
            <>
              <button
                onClick={handleCloseProjectModal}
                className="px-4 py-2 text-sm text-neutral-600 hover:text-neutral-900 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmitProject}
                disabled={!newProjectName.trim()}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-all ${
                  newProjectName.trim()
                    ? 'bg-neutral-900 text-white hover:bg-black'
                    : 'bg-neutral-100 text-neutral-400 cursor-not-allowed'
                }`}
              >
                Create Project
              </button>
            </>
          }
        >
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                Project Name
              </label>
              <input
                type="text"
                value={newProjectName}
                onChange={e => setNewProjectName(e.target.value)}
                placeholder="e.g., Agent Tower"
                className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:border-neutral-400 transition-colors"
                autoFocus
                onKeyDown={e => {
                  if (e.key === 'Enter') handleSubmitProject()
                }}
              />
            </div>
          </div>
        </Modal>

        {/* 创建任务 Modal */}
        <Modal
          isOpen={isCreateTaskOpen}
          onClose={handleCloseTaskModal}
          title="Create New Task"
          action={
            <>
              <button
                onClick={handleCloseTaskModal}
                className="px-4 py-2 text-sm text-neutral-600 hover:text-neutral-900 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmitTask}
                disabled={!newTaskTitle.trim()}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-all ${
                  newTaskTitle.trim()
                    ? 'bg-neutral-900 text-white hover:bg-black'
                    : 'bg-neutral-100 text-neutral-400 cursor-not-allowed'
                }`}
              >
                Create Task
              </button>
            </>
          }
        >
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                Task Title
              </label>
              <input
                type="text"
                value={newTaskTitle}
                onChange={e => setNewTaskTitle(e.target.value)}
                placeholder="e.g., Implement login flow"
                className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:border-neutral-400 transition-colors"
                autoFocus
                onKeyDown={e => {
                  if (e.key === 'Enter') handleSubmitTask()
                }}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                Description
              </label>
              <textarea
                rows={3}
                placeholder="Optional description..."
                className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:border-neutral-400 transition-colors resize-none"
              />
            </div>
          </div>
        </Modal>
      </Suspense>
    </div>
  )
}
