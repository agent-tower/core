import { useState, useCallback, useRef, useEffect, useMemo, lazy, Suspense } from 'react'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import type { Task } from '@agent-tower/shared'
import { TaskList } from '@/components/task'
import { TaskDetail } from '@/components/task/TaskDetail'
import type { UITaskDetailData } from '@/components/task/types'
import { UITaskStatus } from '@/components/task/types'
import { toast } from 'sonner'
import { adaptProject, adaptTaskForList, mapUIStatusToTask } from '@/components/task/adapters'
import { useProjects, useCreateProject } from '@/hooks/use-projects'
import { useTasks, useCreateTask, useDeleteTask, useUpdateTaskStatus } from '@/hooks/use-tasks'
import { useStartSession } from '@/hooks/use-sessions'
import { useTaskRealtimeSync } from '@/lib/socket/hooks/useTaskRealtimeSync'
import { apiClient } from '@/lib/api-client'
import { queryKeys } from '@/hooks/query-keys'
import { Settings, Paperclip } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useIsMobile } from '@/hooks/use-mobile'
import { MobileTaskDetail } from '@/components/mobile'
import { TunnelButton } from '@/components/TunnelButton'
import { Select } from '@/components/ui/select'
import { useProviders } from '@/hooks/use-providers'
import { useAttachments } from '@/hooks/use-attachments'
import { AttachmentPreview } from '@/components/ui/AttachmentPreview'

type CreateStep = 'idle' | 'creating-task' | 'creating-workspace' | 'creating-session' | 'starting-session'

const CREATE_STEP_LABEL: Record<CreateStep, string> = {
  idle: 'Create & Start',
  'creating-task': 'Creating Task...',
  'creating-workspace': 'Creating Workspace...',
  'creating-session': 'Creating Session...',
  'starting-session': 'Starting Agent...',
}

// === bundle-dynamic-imports: Modal 组件懒加载 ===
const Modal = lazy(() =>
  import('@/components/ui/modal').then(m => ({ default: m.Modal }))
)
const FolderPicker = lazy(() =>
  import('@/components/ui/folder-picker').then(m => ({ default: m.FolderPicker }))
)

// === rendering-hoist-jsx: 静态 Logo SVG 提升到组件外 ===
const LOGO_ICON = (
  <svg
    width="20"
    height="20"
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
  <span className="font-bold text-neutral-900 tracking-tight text-base">
    Agent Tower
  </span>
)

// === 拖拽 resize 的常量配置 ===
const MIN_SIDEBAR_WIDTH = 260
const MAX_SIDEBAR_WIDTH = 600
const DEFAULT_SIDEBAR_WIDTH = 400

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
  const [newTaskProviderId, setNewTaskProviderId] = useState<string>('')
  const [createStep, setCreateStep] = useState<CreateStep>('idle')

  // Attachments for task creation
  const { files: attachmentFiles, addFiles, removeFile, clear: clearAttachments, buildMarkdownLinks, isUploading } = useAttachments()
  const fileInputRef = useRef<HTMLInputElement>(null)

  // === rerender-use-ref-transient-values: resize 过程中的 mouse position 使用 ref ===
  const isDraggingRef = useRef(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(DEFAULT_SIDEBAR_WIDTH)
  const containerRef = useRef<HTMLDivElement>(null)

  const queryClient = useQueryClient()
  const { data: providersData, isLoading: isProvidersLoading } = useProviders()

  // === API 数据 ===
  const { data: projectsData, isLoading: isProjectsLoading } = useProjects()
  const projects = projectsData?.data ?? []
  const uiProjects = useMemo(() => projects.map(adaptProject), [projects])

  // === 实时同步：订阅 project rooms，监听 task:updated / task:deleted 事件 ===
  const projectIdsForSync = useMemo(() => projects.map(p => p.id), [projects])
  useTaskRealtimeSync(projectIdsForSync)

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

  // 按活跃度排序 projects：根据最近创建的任务时间
  const sortedProjects = useMemo(() => {
    // 计算每个 project 的最新任务时间
    const projectLastTaskTime = new Map<string, number>()
    for (const task of rawTasks) {
      const taskTime = task.createdAt ? new Date(task.createdAt).getTime() : 0
      const currentMax = projectLastTaskTime.get(task.projectId) ?? 0
      if (taskTime > currentMax) {
        projectLastTaskTime.set(task.projectId, taskTime)
      }
    }

    // 排序：有任务的项目按最新任务时间降序，没有任务的项目按创建时间降序
    return [...projects].sort((a, b) => {
      const aTime = projectLastTaskTime.get(a.id) ?? (a.createdAt ? new Date(a.createdAt).getTime() : 0)
      const bTime = projectLastTaskTime.get(b.id) ?? (b.createdAt ? new Date(b.createdAt).getTime() : 0)
      return bTime - aTime
    })
  }, [projects, rawTasks])

  // 按使用频率排序 providers：根据 localStorage 中记录的使用次数
  const sortedProviders = useMemo(() => {
    if (!providersData) return []

    // 从 localStorage 读取使用次数
    const usageCountStr = localStorage.getItem('providerUsageCount')
    const usageCount: Record<string, number> = usageCountStr ? JSON.parse(usageCountStr) : {}

    // 排序：可用的 provider 按使用次数降序，不可用的排在最后
    return [...providersData].sort((a, b) => {
      const aAvailable = a.availability.type !== 'NOT_FOUND'
      const bAvailable = b.availability.type !== 'NOT_FOUND'

      // 不可用的排在最后
      if (aAvailable !== bAvailable) {
        return aAvailable ? -1 : 1
      }

      // 都可用或都不可用时，按使用次数降序
      const aCount = usageCount[a.provider.id] ?? 0
      const bCount = usageCount[b.provider.id] ?? 0
      return bCount - aCount
    })
  }, [providersData])

  const uiTasks = useMemo(() => rawTasks.map(adaptTaskForList), [rawTasks])

  // 根据 agent-store 中正在运行的 session 计算活跃任务 ID 集合
  const activeTaskIds = useMemo(() => new Set<string>(), [])

  // === 选中的任务详情 ===
  const taskDetailData = useMemo<UITaskDetailData | null>(() => {
    if (!selectedTaskId) return null
    const uiTask = uiTasks.find(t => t.id === selectedTaskId)
    if (!uiTask) return null
    const project = projects.find(p => p.id === uiTask.projectId)
    return {
      id: uiTask.id,
      projectId: uiTask.projectId,
      projectName: project?.name ?? 'Unknown',
      projectColor: project?.color ?? 'text-neutral-500',
      title: uiTask.title,
      status: uiTask.status,
      branch: uiTask.branch,
      mainBranch: project?.mainBranch ?? 'main',
      description: uiTask.description,
    }
  }, [selectedTaskId, uiTasks, projects])

  // === Mutations ===
  const createProject = useCreateProject()
  const createTask = useCreateTask(newTaskProjectId)
  const deleteTask = useDeleteTask()
  const updateTaskStatus = useUpdateTaskStatus()

  const handleDeleteTask = useCallback((taskId: string) => {
    deleteTask.mutate(taskId, {
      onSuccess: () => {
        // 删除后清除选中状态
        if (selectedTaskId === taskId) {
          setSelectedTaskId(null)
        }
        // 刷新所有任务列表
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all })
      },
    })
  }, [deleteTask, selectedTaskId, queryClient])

  const handleTaskStatusChange = useCallback((taskId: string, newStatus: UITaskStatus) => {
    updateTaskStatus.mutate(
      { id: taskId, status: mapUIStatusToTask(newStatus) },
      {
        onError: () => {
          toast.error('状态变更失败，该操作不被允许')
        },
      },
    )
  }, [updateTaskStatus])

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
    // 从 localStorage 读取上次选择
    const lastProjectId = localStorage.getItem('lastSelectedProjectId')
    const lastProviderId = localStorage.getItem('lastSelectedProviderId')

    // 优先使用上次选择，其次是当前筛选的项目，最后是第一个项目（已排序）
    const projectId = (lastProjectId && sortedProjects.find(p => p.id === lastProjectId))
      ? lastProjectId
      : (filterProjectId ?? sortedProjects[0]?.id ?? '')
    setNewTaskProjectId(projectId)

    // 优先使用上次选择的 provider，其次是第一个可用的 provider（已排序）
    const available = sortedProviders?.find(p => p.availability.type !== 'NOT_FOUND')
    const providerId = (lastProviderId && sortedProviders?.find(p => p.provider.id === lastProviderId && p.availability.type !== 'NOT_FOUND'))
      ? lastProviderId
      : (available?.provider.id ?? '')
    setNewTaskProviderId(providerId)

    setCreateStep('idle')
    setIsCreateTaskOpen(true)
  }, [filterProjectId, sortedProjects, sortedProviders])

  const handleCloseProjectModal = useCallback(() => {
    setIsCreateProjectOpen(false)
    setNewProjectName('')
    setNewProjectRepoPath('')
  }, [])

  const handleCloseTaskModal = useCallback(() => {
    if (createStep !== 'idle') return
    setIsCreateTaskOpen(false)
    setNewTaskTitle('')
    setNewTaskDescription('')
    setNewTaskProjectId('')
    setNewTaskProviderId('')
    setCreateStep('idle')
    clearAttachments()
  }, [createStep, clearAttachments])

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

  const startSession = useStartSession()

  const handleSubmitTask = useCallback(async () => {
    if (!newTaskTitle.trim() || !newTaskProjectId) return
    try {
      // 拼接附件 markdown 链接到 description 末尾
      const attachmentLinks = buildMarkdownLinks()
      const description = [newTaskDescription.trim(), attachmentLinks].filter(Boolean).join('\n\n')

      // Step 1: 创建任务
      setCreateStep('creating-task')
      const task = await createTask.mutateAsync({
        title: newTaskTitle.trim(),
        description: description || undefined,
      })

      // 保存本次选择到 localStorage
      localStorage.setItem('lastSelectedProjectId', newTaskProjectId)
      if (newTaskProviderId) {
        localStorage.setItem('lastSelectedProviderId', newTaskProviderId)

        // 更新 provider 使用次数
        const usageCountStr = localStorage.getItem('providerUsageCount')
        const usageCount: Record<string, number> = usageCountStr ? JSON.parse(usageCountStr) : {}
        usageCount[newTaskProviderId] = (usageCount[newTaskProviderId] ?? 0) + 1
        localStorage.setItem('providerUsageCount', JSON.stringify(usageCount))
      }

      // 如果选了 provider，自动启动
      if (newTaskProviderId) {
        const prompt = [newTaskTitle.trim(), description].filter(Boolean).join('\n\n')

        // Step 2: 创建 workspace
        setCreateStep('creating-workspace')
        const workspace = await apiClient.post<{ id: string }>(`/tasks/${task.id}/workspaces`, {})

        // Step 3: 创建 session (使用 providerId)
        setCreateStep('creating-session')
        const session = await apiClient.post<{ id: string }>(
          `/workspaces/${workspace.id}/sessions`,
          { providerId: newTaskProviderId, prompt },
        )

        // Step 4: 启动 session
        setCreateStep('starting-session')
        await startSession.mutateAsync(session.id)

        await queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.list(task.id) })
      }

      // 选中新创建的任务
      setSelectedTaskId(task.id)
      setCreateStep('idle')
      setIsCreateTaskOpen(false)
      setNewTaskTitle('')
      setNewTaskDescription('')
      setNewTaskProjectId('')
      setNewTaskProviderId('')
      clearAttachments()
    } catch {
      setCreateStep('idle')
    }
  }, [newTaskTitle, newTaskDescription, newTaskProjectId, newTaskProviderId, createTask, startSession, queryClient, buildMarkdownLinks, clearAttachments])

  // ============ File Upload Handlers ============

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files
    if (fileList && fileList.length > 0) {
      addFiles(Array.from(fileList))
    }
    e.target.value = ''
  }, [addFiles])

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData.items
    const files: File[] = []
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile()
        if (file) files.push(file)
      }
    }
    if (files.length > 0) {
      e.preventDefault()
      addFiles(files)
    }
  }, [addFiles])

  const [isDragOver, setIsDragOver] = useState(false)

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    const fileList = e.dataTransfer.files
    if (fileList.length > 0) {
      addFiles(Array.from(fileList))
    }
  }, [addFiles])

  const isLoading = isProjectsLoading || isFilteredTasksLoading || isAllTasksLoading

  const isMobile = useIsMobile()

  // === Mobile: 任务列表 → 点击任务 → 全屏详情页 ===
  if (isMobile) {
    // Mobile task detail — 选中任务时全屏展示
    if (selectedTaskId && taskDetailData) {
      return (
        <>
          <MobileTaskDetail
            task={taskDetailData}
            onBack={() => setSelectedTaskId(null)}
            onDeleteTask={handleDeleteTask}
            isDeleting={deleteTask.isPending}
          />
          {/* Modals 在移动端也需要 */}
          <Suspense fallback={null}>
            <Modal isOpen={isCreateProjectOpen} onClose={handleCloseProjectModal} title="Create New Project"
              action={<>
                <button onClick={handleCloseProjectModal} className="px-4 py-2 text-sm text-neutral-600">Cancel</button>
                <button onClick={handleSubmitProject} disabled={!newProjectName.trim() || !newProjectRepoPath.trim() || createProject.isPending}
                  className={`px-4 py-2 text-sm font-medium rounded-lg ${newProjectName.trim() && newProjectRepoPath.trim() && !createProject.isPending ? 'bg-neutral-900 text-white' : 'bg-neutral-100 text-neutral-400 cursor-not-allowed'}`}>
                  {createProject.isPending ? 'Creating...' : 'Create'}
                </button>
              </>}>
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-neutral-700 mb-1.5">Project Name</label>
                  <input type="text" value={newProjectName} onChange={e => setNewProjectName(e.target.value)} placeholder="e.g., Agent Tower"
                    className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:border-neutral-400" autoFocus />
                </div>
                <div>
                  <label className="block text-sm font-medium text-neutral-700 mb-1.5">Repository Path</label>
                  <FolderPicker value={newProjectRepoPath} onChange={setNewProjectRepoPath} />
                </div>
              </div>
            </Modal>
          </Suspense>
        </>
      )
    }

    // Mobile task list — 复用桌面端 TaskList，全宽 + 隐藏右侧边框
    return (
      <>
        <div className="flex flex-col h-dvh bg-neutral-50 overflow-hidden text-sm">
          {/* 顶部栏 */}
          <header className="h-12 bg-white border-b border-neutral-200 flex items-center px-4 justify-between shrink-0 z-10">
            <div className="flex items-center gap-2">
              {LOGO_ICON}
              {HEADER_TITLE}
            </div>
            <div className="flex items-center gap-1">
              <TunnelButton />
              <Link to="/settings" className="p-1.5 text-neutral-400 active:text-neutral-900 rounded-md">
                <Settings size={16} />
              </Link>
            </div>
          </header>

          {isLoading && uiTasks.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-sm text-neutral-400">Loading...</div>
          ) : (
            <TaskList
              tasks={uiTasks}
              projects={uiProjects}
              selectedTaskId={null}
              onSelectTask={setSelectedTaskId}
              filterProjectId={filterProjectId}
              setFilterProjectId={setFilterProjectId}
              width="100%"
              onCreateProject={handleCreateProject}
              onCreateTask={handleCreateTask}
              activeTaskIds={activeTaskIds}
              onTaskStatusChange={handleTaskStatusChange}
            />
          )}
        </div>
        <Suspense fallback={null}>
          <Modal isOpen={isCreateProjectOpen} onClose={handleCloseProjectModal} title="Create New Project"
            action={<>
              <button onClick={handleCloseProjectModal} className="px-4 py-2 text-sm text-neutral-600">Cancel</button>
              <button onClick={handleSubmitProject} disabled={!newProjectName.trim() || !newProjectRepoPath.trim() || createProject.isPending}
                className={`px-4 py-2 text-sm font-medium rounded-lg ${newProjectName.trim() && newProjectRepoPath.trim() && !createProject.isPending ? 'bg-neutral-900 text-white' : 'bg-neutral-100 text-neutral-400 cursor-not-allowed'}`}>
                {createProject.isPending ? 'Creating...' : 'Create'}
              </button>
            </>}>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1.5">Project Name</label>
                <input type="text" value={newProjectName} onChange={e => setNewProjectName(e.target.value)} placeholder="e.g., Agent Tower"
                  className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:border-neutral-400" autoFocus />
              </div>
              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1.5">Repository Path</label>
                <FolderPicker value={newProjectRepoPath} onChange={setNewProjectRepoPath} />
              </div>
            </div>
          </Modal>
          <Modal isOpen={isCreateTaskOpen} onClose={handleCloseTaskModal} title="Create New Task"
            action={<>
              <button onClick={handleCloseTaskModal} disabled={createStep !== 'idle'} className="px-4 py-2 text-sm text-neutral-600 disabled:opacity-50">Cancel</button>
              <button onClick={handleSubmitTask} disabled={!newTaskTitle.trim() || !newTaskProjectId || createStep !== 'idle'}
                className={`px-4 py-2 text-sm font-medium rounded-lg ${newTaskTitle.trim() && newTaskProjectId && createStep === 'idle' ? 'bg-neutral-900 text-white' : 'bg-neutral-100 text-neutral-400 cursor-not-allowed'}`}>
                {CREATE_STEP_LABEL[createStep]}
              </button>
            </>}>
            <div className="space-y-4">
              <div className="flex gap-3">
                <div className="flex-1 min-w-0">
                  <label className="block text-sm font-medium text-neutral-700 mb-1.5">Project</label>
                  <Select value={newTaskProjectId} onChange={setNewTaskProjectId}
                    options={sortedProjects.map(p => ({ value: p.id, label: p.name }))}
                    placeholder="Select project..." disabled={createStep !== 'idle'} />
                </div>
                <div className="flex-1 min-w-0">
                  <label className="block text-sm font-medium text-neutral-700 mb-1.5">Provider</label>
                  <Select value={newTaskProviderId} onChange={setNewTaskProviderId}
                    options={sortedProviders.map(({ provider, availability }) => ({ value: provider.id, label: provider.name + (availability.type === 'NOT_FOUND' ? ' (不可用)' : ''), disabled: availability.type === 'NOT_FOUND' }))}
                    placeholder={isProvidersLoading ? 'Loading...' : 'Select provider...'} disabled={createStep !== 'idle'} />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1.5">Task Title</label>
                <input type="text" value={newTaskTitle} onChange={e => setNewTaskTitle(e.target.value)} placeholder="e.g., Implement login flow"
                  className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm focus:outline-none focus:border-neutral-400" disabled={createStep !== 'idle'}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) handleSubmitTask() }} />
              </div>
              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1.5">Description</label>
                <div
                  className={`relative border rounded-lg transition-colors ${
                    isDragOver ? 'border-neutral-400 bg-neutral-50' : 'border-neutral-200'
                  }`}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                >
                  <textarea
                    rows={3}
                    value={newTaskDescription}
                    onChange={e => setNewTaskDescription(e.target.value)}
                    onPaste={handlePaste}
                    placeholder="Optional..."
                    className="w-full px-3 py-2 text-sm focus:outline-none bg-transparent resize-none"
                    disabled={createStep !== 'idle'}
                    onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) handleSubmitTask() }}
                  />
                  {isDragOver && (
                    <div className="absolute inset-0 flex items-center justify-center bg-neutral-50/90 pointer-events-none">
                      <p className="text-sm text-neutral-600">Drop files here</p>
                    </div>
                  )}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={createStep !== 'idle' || isUploading}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-neutral-600 active:text-neutral-900 active:bg-neutral-100 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Paperclip size={14} />
                    Attach files
                  </button>
                  <span className="text-xs text-neutral-400">
                    or paste files
                  </span>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  onChange={handleFileInputChange}
                  className="hidden"
                />
                <AttachmentPreview files={attachmentFiles} onRemove={removeFile} />
              </div>
            </div>
          </Modal>
        </Suspense>
      </>
    )
  }

  // === Desktop: 原有三栏布局 ===
  return (
    <div ref={containerRef} className="flex flex-col h-screen bg-neutral-50 overflow-hidden text-sm">
      {/* === 顶部栏 === */}
      <header className="h-12 bg-white border-b border-neutral-200 flex items-center px-4 justify-between flex-shrink-0 z-10 relative">
        <div className="flex items-center gap-2">
          {LOGO_ICON}
          {HEADER_TITLE}
        </div>
        <div className="flex items-center gap-1">
          <TunnelButton />
          <Link to="/settings" className="p-1.5 text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100 rounded-md transition-colors">
            <Settings size={16} />
          </Link>
        </div>
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
            onTaskStatusChange={handleTaskStatusChange}
            onDeleteTask={handleDeleteTask}
          />
        )}

        {/* 拖拽分隔线 */}
        <div
          onMouseDown={handleMouseDown}
          className="w-1 cursor-col-resize hover:bg-neutral-300 active:bg-neutral-400 transition-colors z-50 -ml-[2px] flex-shrink-0 h-full"
          title="Drag to resize"
        />

        {/* 右侧: TaskDetail */}
        <TaskDetail
          task={taskDetailData}
          onDeleteTask={handleDeleteTask}
          isDeleting={deleteTask.isPending}
          onTaskStatusChange={handleTaskStatusChange}
        />
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
              <FolderPicker
                value={newProjectRepoPath}
                onChange={setNewProjectRepoPath}
              />
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
                disabled={createStep !== 'idle'}
                className="px-4 py-2 text-sm text-neutral-600 hover:text-neutral-900 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmitTask}
                disabled={!newTaskTitle.trim() || !newTaskProjectId || createStep !== 'idle'}
                className={`px-4 py-2 text-sm font-medium rounded-lg transition-all ${
                  newTaskTitle.trim() && newTaskProjectId && createStep === 'idle'
                    ? 'bg-neutral-900 text-white hover:bg-black'
                    : 'bg-neutral-100 text-neutral-400 cursor-not-allowed'
                }`}
              >
                {CREATE_STEP_LABEL[createStep]}
              </button>
            </>
          }
        >
          <div className="space-y-4">
            <div className="flex gap-3">
              <div className="flex-1 min-w-0">
                <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                  Project
                </label>
                <Select
                  value={newTaskProjectId}
                  onChange={setNewTaskProjectId}
                  options={sortedProjects.map(p => ({ value: p.id, label: p.name }))}
                  placeholder="Select project..."
                  disabled={createStep !== 'idle'}
                />
              </div>
              <div className="flex-1 min-w-0">
                <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                  Agent
                </label>
                <Select
                  value={newTaskProviderId}
                  onChange={setNewTaskProviderId}
                  options={sortedProviders.map(({ provider, availability }) => ({
                    value: provider.id,
                    label: provider.name + (availability.type === 'NOT_FOUND' ? ' (不可用)' : ''),
                    disabled: availability.type === 'NOT_FOUND',
                  }))}
                  placeholder={isProvidersLoading ? 'Loading...' : 'Select provider...'}
                  disabled={createStep !== 'idle'}
                />
              </div>
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
                disabled={createStep !== 'idle'}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) handleSubmitTask()
                }}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1.5">
                Description
              </label>
              <div
                className={`relative border rounded-lg transition-colors ${
                  isDragOver ? 'border-neutral-400 bg-neutral-50' : 'border-neutral-200'
                }`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
              >
                <textarea
                  rows={3}
                  value={newTaskDescription}
                  onChange={e => setNewTaskDescription(e.target.value)}
                  onPaste={handlePaste}
                  placeholder="Optional description..."
                  className="w-full px-3 py-2 text-sm focus:outline-none bg-transparent resize-none"
                  disabled={createStep !== 'idle'}
                  onKeyDown={e => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) handleSubmitTask()
                  }}
                />
                {isDragOver && (
                  <div className="absolute inset-0 flex items-center justify-center bg-neutral-50/90 pointer-events-none">
                    <p className="text-sm text-neutral-600">Drop files here</p>
                  </div>
                )}
              </div>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={createStep !== 'idle' || isUploading}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Paperclip size={14} />
                  Attach files
                </button>
                <span className="text-xs text-neutral-400">
                  or paste/drag files
                </span>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={handleFileInputChange}
                className="hidden"
              />
              <AttachmentPreview files={attachmentFiles} onRemove={removeFile} />
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
