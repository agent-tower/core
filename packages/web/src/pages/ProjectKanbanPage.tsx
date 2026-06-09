import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import type { Task } from '@agent-tower/shared'
import { TaskList } from '@/components/task'
import { TaskDetail } from '@/components/task/TaskDetail'
import type { UITaskDetailData } from '@/components/task/types'
import { UITaskStatus } from '@/components/task/types'
import { toast } from 'sonner'
import { adaptProject, adaptTaskForDetail, adaptTaskForList, mapTaskStatusToUI, mapUIStatusToTask } from '@/components/task/adapters'
import { useProjects } from '@/hooks/use-projects'
import { useTasks, useDeleteTask, useUpdateTaskStatus } from '@/hooks/use-tasks'
import { useStartSession } from '@/hooks/use-sessions'
import { apiClient } from '@/lib/api-client'
import { queryKeys } from '@/hooks/query-keys'
import { Settings } from 'lucide-react'
import { useIsMobile } from '@/hooks/use-mobile'
import { useUIStore } from '@/stores/ui-store'
import { MobileTaskDetail } from '@/components/mobile'
import { TunnelButton } from '@/components/TunnelButton'
import { useProviders } from '@/hooks/use-providers'
import { useI18n } from '@/lib/i18n'
import type { TeamRunMode } from '@agent-tower/shared'
import { useCreateTaskTeamRun } from '@/hooks/use-team-run'
import { CreateProjectModal } from '@/components/project/CreateProjectModal'
import { BrandLogo } from '@/components/BrandLogo'
import { CreateTaskInput } from '@/components/task/CreateTaskInput'

type CreateStep = 'idle' | 'creating-task' | 'creating-teamrun' | 'creating-workspace' | 'creating-session' | 'starting-session'
type CreateTaskMode = 'SOLO' | 'TEAM'

function TypewriterText({ text, className }: { text: string; className?: string }) {
  const [displayed, setDisplayed] = useState('')
  const [done, setDone] = useState(false)

  useEffect(() => {
    setDisplayed('')
    setDone(false)
    let i = 0
    const id = setInterval(() => {
      i++
      if (i >= text.length) {
        setDisplayed(text)
        setDone(true)
        clearInterval(id)
      } else {
        setDisplayed(text.slice(0, i))
      }
    }, 50)
    return () => clearInterval(id)
  }, [text])

  return (
    <p className={className}>
      {displayed}
      {!done && <span className="inline-block w-[2px] h-[1em] bg-neutral-400 ml-0.5 align-middle animate-pulse" />}
    </p>
  )
}

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
const PROJECT_LIST_LIMIT = 100
const TASK_LIST_LIMIT = 1000

/** 分页响应类型 */
interface PaginatedResponse<T> {
  data: T[]
  total: number
  page: number
  limit: number
}

export function ProjectKanbanPage() {
  const { t } = useI18n()
  // === 状态 ===
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [filterProjectId, setFilterProjectId] = useState<string | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH)

  // Modal 状态
  const [isCreateProjectOpen, setIsCreateProjectOpen] = useState(false)
  const [createStep, setCreateStep] = useState<CreateStep>('idle')

  // === rerender-use-ref-transient-values: resize 过程中的 mouse position 使用 ref ===
  const isDraggingRef = useRef(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(DEFAULT_SIDEBAR_WIDTH)
  const containerRef = useRef<HTMLDivElement>(null)

  const queryClient = useQueryClient()
  const { data: providersData, isLoading: isProvidersLoading } = useProviders()

  // === API 数据 ===
  const { data: projectsData, isLoading: isProjectsLoading } = useProjects({ limit: PROJECT_LIST_LIMIT })
  const projects = useMemo(() => projectsData?.data ?? [], [projectsData?.data])
  const uiProjects = useMemo(() => projects.map(adaptProject), [projects])
  const effectiveFilterProjectId = filterProjectId && projects.some(project => project.id === filterProjectId)
    ? filterProjectId
    : null

  // 当选中了某个项目时，直接用 useTasks 获取该项目的任务
  const { data: filteredTasksData, isLoading: isFilteredTasksLoading } = useTasks(
    effectiveFilterProjectId ?? '',
    { limit: TASK_LIST_LIMIT },
  )

  // 当未选中项目时（All Projects），为每个项目获取任务
  const allProjectTaskQueries = useQueries({
    queries: effectiveFilterProjectId
      ? [] // 已选中项目时不需要这些查询
      : projects.map(p => ({
          queryKey: queryKeys.tasks.list(p.id, { limit: TASK_LIST_LIMIT }),
          queryFn: () =>
            apiClient.get<PaginatedResponse<Task>>(
              `/projects/${p.id}/tasks`,
              { params: { limit: String(TASK_LIST_LIMIT) } },
            ),
        })),
  })

  const isAllTasksLoading = !effectiveFilterProjectId && allProjectTaskQueries.some(q => q.isLoading)

  // 合并任务数据（同时保留原始 Task 用于 session 匹配）
  const rawTasks = useMemo<Task[]>(() => {
    if (effectiveFilterProjectId) {
      return filteredTasksData?.data ?? []
    }
    const allTasks: Task[] = []
    for (const q of allProjectTaskQueries) {
      if (q.data?.data) {
        allTasks.push(...q.data.data)
      }
    }
    return allTasks
  }, [effectiveFilterProjectId, filteredTasksData, allProjectTaskQueries])
  const [pendingCreatedTaskId, setPendingCreatedTaskId] = useState<string | null>(null)
  const effectiveSelectedTaskId = useMemo(() => {
    if (selectedTaskId && rawTasks.some(task => task.id === selectedTaskId)) return selectedTaskId
    if (pendingCreatedTaskId && selectedTaskId === pendingCreatedTaskId) return pendingCreatedTaskId
    return null
  }, [selectedTaskId, rawTasks, pendingCreatedTaskId])

  useEffect(() => {
    if (pendingCreatedTaskId && rawTasks.some(task => task.id === pendingCreatedTaskId)) {
      setPendingCreatedTaskId(null)
    }
  }, [pendingCreatedTaskId, rawTasks])

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
  const activeProjects = useMemo(
    () => sortedProjects.filter(project => !project.archivedAt),
    [sortedProjects],
  )

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
    if (!effectiveSelectedTaskId) return null
    const task = rawTasks.find(t => t.id === effectiveSelectedTaskId)
    if (!task) return null

    const project = projects.find(p => p.id === task.projectId)
    if (!project) {
      const branch = task.workspaces?.find(w => w.status === 'ACTIVE')?.branchName
        ?? task.workspaces?.[0]?.branchName
        ?? '—'

      return {
        id: task.id,
        projectId: task.projectId,
        projectName: 'Unknown',
        projectColor: 'text-neutral-500',
        title: task.title,
        status: mapTaskStatusToUI(task.status),
        branch,
        mainBranch: 'main',
        description: task.description ?? '',
        projectArchivedAt: null,
        projectRepoDeletedAt: null,
      }
    }

    return adaptTaskForDetail(task, project)
  }, [effectiveSelectedTaskId, rawTasks, projects])

  // === Mutations ===
  const createTaskTeamRun = useCreateTaskTeamRun()
  const deleteTask = useDeleteTask()
  const updateTaskStatus = useUpdateTaskStatus()

  const handleDeleteTask = useCallback((taskId: string) => {
    deleteTask.mutate(taskId, {
      onSuccess: () => {
        // 删除后清除选中状态
        if (effectiveSelectedTaskId === taskId) {
          setSelectedTaskId(null)
        }
        // 刷新所有任务列表
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all })
      },
      onError: () => {
        toast.error(t('删除任务失败'))
      },
    })
  }, [deleteTask, effectiveSelectedTaskId, queryClient, t])

  const handleTaskStatusChange = useCallback((taskId: string, newStatus: UITaskStatus) => {
    updateTaskStatus.mutate(
      { id: taskId, status: mapUIStatusToTask(newStatus) },
      {
        onError: () => {
          toast.error(t('状态变更失败，该操作不被允许'))
        },
      },
    )
  }, [updateTaskStatus, t])

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
    if (activeProjects.length === 0) {
      toast.error(t('没有可用项目，请先创建或恢复项目'))
      return
    }
    setSelectedTaskId(null)
  }, [activeProjects, t])

  const handleCloseProjectModal = useCallback(() => {
    setIsCreateProjectOpen(false)
  }, [])

  const startSession = useStartSession()

  const handleSubmitTask = useCallback(async (data: {
    title: string
    description: string
    projectId: string
    providerId: string
    mode: CreateTaskMode
    teamRunMode: TeamRunMode
    teamTemplateId: string | null
    memberPresetIds: string[]
    attachmentLinks: string
  }) => {
    const { title, description, projectId, providerId, mode, teamRunMode, teamTemplateId, memberPresetIds, attachmentLinks } = data
    const fullDescription = [description, attachmentLinks].filter(Boolean).join('\n\n')

    let createdTask: Task | null = null

    try {
      setCreateStep('creating-task')
      createdTask = await apiClient.post<Task>(`/projects/${projectId}/tasks`, {
        title,
        description: fullDescription || undefined,
      })

      localStorage.setItem('lastSelectedProjectId', projectId)
      if (mode === 'SOLO' && providerId) {
        localStorage.setItem('lastSelectedProviderId', providerId)
        const usageCountStr = localStorage.getItem('providerUsageCount')
        const usageCount: Record<string, number> = usageCountStr ? JSON.parse(usageCountStr) : {}
        usageCount[providerId] = (usageCount[providerId] ?? 0) + 1
        localStorage.setItem('providerUsageCount', JSON.stringify(usageCount))
      }

      if (mode === 'TEAM') {
        setCreateStep('creating-teamrun')
        await createTaskTeamRun.mutateAsync({
          taskId: createdTask.id,
          mode: teamRunMode,
          ...(teamTemplateId ? { teamTemplateId } : {}),
          ...(memberPresetIds.length > 0 ? { memberPresetIds } : {}),
        })
      } else if (providerId) {
        const prompt = [title, fullDescription].filter(Boolean).join('\n\n')

        setCreateStep('creating-workspace')
        const workspace = await apiClient.post<{ id: string }>(`/tasks/${createdTask.id}/workspaces`, {})

        setCreateStep('creating-session')
        const session = await apiClient.post<{ id: string }>(
          `/workspaces/${workspace.id}/sessions`,
          { providerId, prompt },
        )

        setCreateStep('starting-session')
        await startSession.mutateAsync(session.id)

        await queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.list(createdTask.id) })
      }

      if (effectiveFilterProjectId && projectId !== effectiveFilterProjectId) {
        setFilterProjectId(null)
      }
      setPendingCreatedTaskId(createdTask.id)
      setSelectedTaskId(createdTask.id)
      setCreateStep('idle')

      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all })
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all })
    } catch (error) {
      setCreateStep('idle')
      if (createdTask && mode === 'TEAM') {
        // TeamRun creation failed — clean up orphan task and treat as complete failure
        try { await deleteTask.mutateAsync(createdTask.id) } catch { /* best-effort cleanup */ }
        toast.error(t('TeamRun 创建失败，请检查团队配置后重试'))
        throw error
      } else if (createdTask) {
        // SOLO partial success: task exists but agent start failed — navigate to detail
        if (effectiveFilterProjectId && projectId !== effectiveFilterProjectId) {
          setFilterProjectId(null)
        }
        setPendingCreatedTaskId(createdTask.id)
        setSelectedTaskId(createdTask.id)
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all })
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.all })
        toast.error(t('任务已创建，但启动 Agent 失败，可在详情中重试'))
      } else {
        toast.error(error instanceof Error ? error.message : t('Failed to create task'))
        throw error
      }
    }
  }, [createTaskTeamRun, startSession, deleteTask, queryClient, t, effectiveFilterProjectId])


  const isLoading = isProjectsLoading || isFilteredTasksLoading || isAllTasksLoading

  const createTaskProjectOptions = useMemo(() =>
    activeProjects.map(p => ({ id: p.id, name: p.name })),
    [activeProjects],
  )

  const createTaskProviderOptions = useMemo(() =>
    sortedProviders.map(({ provider, availability }) => ({
      id: provider.id,
      name: provider.name,
      available: availability.type !== 'NOT_FOUND',
    })),
    [sortedProviders],
  )

  const defaultProjectId = useMemo(() => {
    if (effectiveFilterProjectId && activeProjects.find(p => p.id === effectiveFilterProjectId)) return effectiveFilterProjectId
    const lastProjectId = localStorage.getItem('lastSelectedProjectId')
    if (lastProjectId && activeProjects.find(p => p.id === lastProjectId)) return lastProjectId
    return activeProjects[0]?.id ?? ''
  }, [activeProjects, effectiveFilterProjectId])

  const defaultProviderId = useMemo(() => {
    const lastProviderId = localStorage.getItem('lastSelectedProviderId')
    if (lastProviderId && sortedProviders.find(p => p.provider.id === lastProviderId && p.availability.type !== 'NOT_FOUND')) return lastProviderId
    const available = sortedProviders.find(p => p.availability.type !== 'NOT_FOUND')
    return available?.provider.id ?? ''
  }, [sortedProviders])

  const isMobile = useIsMobile()
  const [mobileCreateOpen, setMobileCreateOpen] = useState(false)

  const handleMobileCreateTask = useCallback(() => {
    if (activeProjects.length === 0) {
      toast.error(t('没有可用项目，请先创建或恢复项目'))
      return
    }
    setMobileCreateOpen(true)
  }, [activeProjects, t])

  const handleMobileSubmitTask = useCallback(async (data: Parameters<typeof handleSubmitTask>[0]) => {
    await handleSubmitTask(data)
    setMobileCreateOpen(false)
  }, [handleSubmitTask])

  // === Mobile: 任务列表 → 点击任务 → 全屏详情页 ===
  if (isMobile) {
    // Mobile create view — fullscreen create input
    if (mobileCreateOpen) {
      return (
        <div className="flex flex-col h-dvh bg-white overflow-hidden text-sm">
          <header className="h-12 border-b border-neutral-200 flex items-center px-4 shrink-0">
            <button
              onClick={() => setMobileCreateOpen(false)}
              className="text-sm text-neutral-600 active:text-neutral-900"
            >
              {t('Cancel')}
            </button>
          </header>
          <div className="flex-1 flex flex-col items-center justify-center px-4">
            <h1 className="text-xl text-neutral-900 mb-1.5 tracking-tight">{t('欢迎使用 Agent Tower')}</h1>
            <TypewriterText text={t('描述任务，选择 Agent 或团队，即刻开始')} className="text-[13px] text-neutral-400 mb-6" />
            <CreateTaskInput
              projects={createTaskProjectOptions}
              providers={createTaskProviderOptions}
              isProvidersLoading={isProvidersLoading}
              onSubmit={handleMobileSubmitTask}
              defaultProjectId={defaultProjectId}
              defaultProviderId={defaultProviderId}
              createStep={createStep}
            />
          </div>
        </div>
      )
    }

    // Mobile task detail — 选中任务时全屏展示
    if (effectiveSelectedTaskId && taskDetailData) {
      return (
        <>
          <MobileTaskDetail
            task={taskDetailData}
            onBack={() => setSelectedTaskId(null)}
            onDeleteTask={taskDetailData.projectArchivedAt ? undefined : handleDeleteTask}
            isDeleting={deleteTask.isPending}
          />
          {/* Modals 在移动端也需要 */}
          <CreateProjectModal
            isOpen={isCreateProjectOpen}
            onClose={handleCloseProjectModal}
          />
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
              <BrandLogo />
              {HEADER_TITLE}
            </div>
            <div className="flex items-center gap-1">
              <TunnelButton />
              <button onClick={() => useUIStore.getState().openSettings()} className="p-1.5 text-neutral-400 active:text-neutral-900 rounded-md">
                <Settings size={16} />
              </button>
            </div>
          </header>

          {isLoading && uiTasks.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-sm text-neutral-400">{t('Loading...')}</div>
          ) : (
            <TaskList
              tasks={uiTasks}
              projects={uiProjects}
              selectedTaskId={null}
              onSelectTask={setSelectedTaskId}
              filterProjectId={effectiveFilterProjectId}
              setFilterProjectId={setFilterProjectId}
              width="100%"
              onCreateProject={handleCreateProject}
              onCreateTask={handleMobileCreateTask}
              activeTaskIds={activeTaskIds}
              onTaskStatusChange={handleTaskStatusChange}
            />
          )}
        </div>
        <CreateProjectModal
          isOpen={isCreateProjectOpen}
          onClose={handleCloseProjectModal}
        />
      </>
    )
  }

  // === Desktop: 原有三栏布局 ===
  return (
    <div ref={containerRef} className="flex flex-col h-screen bg-neutral-50 overflow-hidden text-sm">
      {/* === 顶部栏 === */}
      <header className="h-12 bg-white border-b border-neutral-200 flex items-center px-4 justify-between flex-shrink-0 z-10 relative">
        <div className="flex items-center gap-2">
          <BrandLogo />
          {HEADER_TITLE}
        </div>
        <div className="flex items-center gap-1">
          <TunnelButton />
          <button onClick={() => useUIStore.getState().openSettings()} className="p-1.5 text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100 rounded-md transition-colors">
            <Settings size={16} />
          </button>
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
            {t('Loading...')}
          </div>
        ) : (
          <TaskList
            tasks={uiTasks}
            projects={uiProjects}
            selectedTaskId={effectiveSelectedTaskId}
            onSelectTask={setSelectedTaskId}
            filterProjectId={effectiveFilterProjectId}
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
          title={t('Drag to resize')}
        />

        {/* 右侧: TaskDetail or Create Panel */}
        {effectiveSelectedTaskId && taskDetailData ? (
          <TaskDetail
            task={taskDetailData}
            onDeleteTask={taskDetailData.projectArchivedAt ? undefined : handleDeleteTask}
            isDeleting={deleteTask.isPending}
            onTaskStatusChange={taskDetailData.projectArchivedAt ? undefined : handleTaskStatusChange}
          />
        ) : effectiveSelectedTaskId && !taskDetailData ? (
          <div className="flex-1 flex items-center justify-center bg-white min-w-0">
            <span className="text-sm text-neutral-400">{t('Loading...')}</span>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center bg-white min-w-0 px-8">
            <div className="w-full max-w-3xl flex flex-col items-center animate-[fadeInUp_0.5s_cubic-bezier(0.16,1,0.3,1)]">
              <h1 className="text-2xl text-neutral-900 mb-1.5 tracking-tight">{t('欢迎使用 Agent Tower')}</h1>
              <TypewriterText text={t('描述任务，选择 Agent 或团队，即刻开始')} className="text-[13px] text-neutral-400 mb-8" />
              <CreateTaskInput
                projects={createTaskProjectOptions}
                providers={createTaskProviderOptions}
                isProvidersLoading={isProvidersLoading}
                onSubmit={handleSubmitTask}
                defaultProjectId={defaultProjectId}
                defaultProviderId={defaultProviderId}
                createStep={createStep}
              />
            </div>
          </div>
        )}
      </div>

      {/* === Modals === */}
      <CreateProjectModal
        isOpen={isCreateProjectOpen}
        onClose={handleCloseProjectModal}
      />
    </div>
  )
}
