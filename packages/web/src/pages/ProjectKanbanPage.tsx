import { useState, useCallback, useRef, useEffect, useMemo, lazy, Suspense } from 'react'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import type { Task } from '@agent-tower/shared'
import { TaskList } from '@/components/task'
import { TaskDetail } from '@/components/task/TaskDetail'
import type { UITaskDetailData } from '@/components/task/types'
import { adaptProject, adaptTaskForList } from '@/components/task/adapters'
import { useProjects, useCreateProject } from '@/hooks/use-projects'
import { useTasks, useCreateTask } from '@/hooks/use-tasks'
import { apiClient } from '@/lib/api-client'
import { queryKeys } from '@/hooks/query-keys'
import { useAgentStatus } from '@/lib/socket/hooks/useAgentStatus'
import { useAgentStore } from '@/stores/agent-store'
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

/** 分页响应类型 */
interface PaginatedResponse<T> {
  data: T[]
  total: number
  page: number
  limit: number
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
  const [newProjectRepoPath, setNewProjectRepoPath] = useState('')
  const [newTaskTitle, setNewTaskTitle] = useState('')
  const [newTaskDescription, setNewTaskDescription] = useState('')
  const [newTaskProjectId, setNewTaskProjectId] = useState<string>('')

  // === rerender-use-ref-transient-values: resize 过程中的 mouse position 使用 ref ===
  const isDraggingRef = useRef(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(DEFAULT_SIDEBAR_WIDTH)
  const containerRef = useRef<HTMLDivElement>(null)

  // === Agent 状态订阅 & 自动刷新 ===
  const queryClient = useQueryClient()
  useAgentStatus() // 订阅所有 Agent 状态变化，更新到 agent-store
  const agents = useAgentStore((s) => s.agents)

  // 当 Agent 状态变为 stopped/error 时，invalidate 任务列表触发重新获取
  const prevAgentsRef = useRef<Map<string, { status: string }>>(new Map())
  useEffect(() => {
    const prev = prevAgentsRef.current
    for (const [agentId, agent] of agents) {
      const prevStatus = prev.get(agentId)?.status
      if (prevStatus && prevStatus !== agent.status && (agent.status === 'stopped' || agent.status === 'error')) {
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all })
        break
      }
    }
    // 快照当前状态用于下次比较
    const snapshot = new Map<string, { status: string }>()
    for (const [id, a] of agents) {
      snapshot.set(id, { status: a.status })
    }
    prevAgentsRef.current = snapshot
  }, [agents, queryClient])

  // === API 数据 ===
  const { data: projectsData, isLoading: isProjectsLoading } = useProjects()
  const projects = projectsData?.data ?? []
  const uiProjects = useMemo(() => projects.map(adaptProject), [projects])

  // 当选中了某个项目时，直接用 useTasks 获取该项目的任务
  const { data: filteredTasksData, isLoading: isFilteredTasksLoading } = useTasks(
    filterProjectId ?? '',
  )

  // 当未选中项目时（All Projects），为每个项目获取任务
  const allProjectTaskQueries = useQueries({
    queries: filterProjectId
      ? [] // 已选中项目时不需要这些查询
      : projects.map(p => ({
          queryKey: queryKeys.tasks.list(p.id),
          queryFn: () =>
            apiClient.get<PaginatedResponse<Task>>(
              `/projects/${p.id}/tasks`,
              { params: { limit: '100' } },
            ),
        })),
  })

  const isAllTasksLoading = !filterProjectId && allProjectTaskQueries.some(q => q.isLoading)

  // 合并任务数据（同时保留原始 Task 用于 session 匹配）
  const rawTasks = useMemo<Task[]>(() => {
    if (filterProjectId) {
      return filteredTasksData?.data ?? []
    }
    const allTasks: Task[] = []
    for (const q of allProjectTaskQueries) {
      if (q.data?.data) {
        allTasks.push(...q.data.data)
      }
    }
    return allTasks
  }, [filterProjectId, filteredTasksData, allProjectTaskQueries])

  const uiTasks = useMemo(() => rawTasks.map(adaptTaskForList), [rawTasks])

  // 根据 agent-store 中正在运行的 session 计算活跃任务 ID 集合
  const activeTaskIds = useMemo(() => {
    const runningSessionIds = new Set<string>()
    for (const [, agent] of agents) {
      if (agent.status === 'running' || agent.status === 'starting') {
        runningSessionIds.add(agent.sessionId)
      }
    }
    if (runningSessionIds.size === 0) return new Set<string>()

    const ids = new Set<string>()
    for (const task of rawTasks) {
      if (!task.workspaces) continue
      for (const ws of task.workspaces) {
        if (!ws.sessions) continue
        for (const session of ws.sessions) {
          if (runningSessionIds.has(session.id)) {
            ids.add(task.id)
          }
        }
      }
    }
    return ids
  }, [agents, rawTasks])

  // === 选中的任务详情 ===
  const taskDetailData = useMemo<UITaskDetailData | null>(() => {
    if (!selectedTaskId) return null
    const uiTask = uiTasks.find(t => t.id === selectedTaskId)
    if (!uiTask) return null
    const project = projects.find(p => p.id === uiTask.projectId)
    return {
      id: uiTask.id,
      projectName: project?.name ?? 'Unknown',
      projectColor: project?.color ?? 'text-neutral-500',
      title: uiTask.title,
      status: uiTask.status,
      branch: uiTask.branch,
      description: uiTask.description,
    }
  }, [selectedTaskId, uiTasks, projects])

  // === Mutations ===
  const createProject = useCreateProject()
  const createTask = useCreateTask(newTaskProjectId)

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
    // 默认选中当前筛选的项目，或第一个项目
    setNewTaskProjectId(filterProjectId ?? projects[0]?.id ?? '')
    setIsCreateTaskOpen(true)
  }, [filterProjectId, projects])

  const handleCloseProjectModal = useCallback(() => {
    setIsCreateProjectOpen(false)
    setNewProjectName('')
    setNewProjectRepoPath('')
  }, [])

  const handleCloseTaskModal = useCallback(() => {
    setIsCreateTaskOpen(false)
    setNewTaskTitle('')
    setNewTaskDescription('')
    setNewTaskProjectId('')
  }, [])

  const handleSubmitProject = useCallback(async () => {
    if (!newProjectName.trim() || !newProjectRepoPath.trim()) return
    try {
      await createProject.mutateAsync({
        name: newProjectName.trim(),
        repoPath: newProjectRepoPath.trim(),
      })
      handleCloseProjectModal()
    } catch {
      // mutation error 由 TanStack Query 管理
    }
  }, [newProjectName, newProjectRepoPath, createProject, handleCloseProjectModal])

  const handleSubmitTask = useCallback(async () => {
    if (!newTaskTitle.trim() || !newTaskProjectId) return
    try {
      await createTask.mutateAsync({
        title: newTaskTitle.trim(),
        description: newTaskDescription.trim() || undefined,
      })
      handleCloseTaskModal()
    } catch {
      // mutation error 由 TanStack Query 管理
    }
  }, [newTaskTitle, newTaskDescription, newTaskProjectId, createTask, handleCloseTaskModal])

  const isLoading = isProjectsLoading || isFilteredTasksLoading || isAllTasksLoading

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
        {isLoading && uiTasks.length === 0 ? (
          <div
            className="h-full flex items-center justify-center text-sm text-neutral-400 border-r border-neutral-200 flex-shrink-0"
            style={{ width: sidebarWidth }}
          >
            Loading...
          </div>
        ) : (
          <TaskList
            tasks={uiTasks}
            projects={uiProjects}
            selectedTaskId={selectedTaskId}
            onSelectTask={setSelectedTaskId}
            filterProjectId={filterProjectId}
            setFilterProjectId={setFilterProjectId}
            width={sidebarWidth}
            onCreateProject={handleCreateProject}
            onCreateTask={handleCreateTask}
            activeTaskIds={activeTaskIds}
          />
        )}

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
                disabled={!newProjectName.trim() || !newProjectRepoPath.trim() || createProject.isPending}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-all ${
                  newProjectName.trim() && newProjectRepoPath.trim() && !createProject.isPending
                    ? 'bg-neutral-900 text-white hover:bg-black'
                    : 'bg-neutral-100 text-neutral-400 cursor-not-allowed'
                }`}
              >
                {createProject.isPending ? 'Creating...' : 'Create Project'}
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
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                Repository Path
              </label>
              <input
                type="text"
                value={newProjectRepoPath}
                onChange={e => setNewProjectRepoPath(e.target.value)}
                placeholder="e.g., /Users/me/projects/my-repo"
                className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:border-neutral-400 transition-colors font-mono"
                onKeyDown={e => {
                  if (e.key === 'Enter') handleSubmitProject()
                }}
              />
              <p className="mt-1 text-xs text-neutral-400">Must be a valid Git repository</p>
            </div>
            {createProject.isError && (
              <p className="text-xs text-red-500">
                {createProject.error instanceof Error ? createProject.error.message : 'Failed to create project'}
              </p>
            )}
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
                disabled={!newTaskTitle.trim() || !newTaskProjectId || createTask.isPending}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-all ${
                  newTaskTitle.trim() && newTaskProjectId && !createTask.isPending
                    ? 'bg-neutral-900 text-white hover:bg-black'
                    : 'bg-neutral-100 text-neutral-400 cursor-not-allowed'
                }`}
              >
                {createTask.isPending ? 'Creating...' : 'Create Task'}
              </button>
            </>
          }
        >
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                Project
              </label>
              <select
                value={newTaskProjectId}
                onChange={e => setNewTaskProjectId(e.target.value)}
                className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:border-neutral-400 transition-colors bg-white"
              >
                <option value="">Select a project...</option>
                {projects.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
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
                value={newTaskDescription}
                onChange={e => setNewTaskDescription(e.target.value)}
                placeholder="Optional description..."
                className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:border-neutral-400 transition-colors resize-none"
              />
            </div>
            {createTask.isError && (
              <p className="text-xs text-red-500">
                {createTask.error instanceof Error ? createTask.error.message : 'Failed to create task'}
              </p>
            )}
          </div>
        </Modal>
      </Suspense>
    </div>
  )
}
