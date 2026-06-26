import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { WorkspaceKind, type Task } from '@agent-tower/shared'
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
import { Settings, ChevronDown, Check, Layers as LayersIcon, Plus as PlusIcon } from 'lucide-react'
import { useIsMobile } from '@/hooks/use-mobile'
import { useUIStore } from '@/stores/ui-store'
import { MobileTaskDetail } from '@/components/mobile'
import { TunnelButton } from '@/components/TunnelButton'
import { useProviders } from '@/hooks/use-providers'
import { useI18n } from '@/lib/i18n'
import type { TeamRunMode } from '@agent-tower/shared'
import { useCreateTaskTeamRun } from '@/hooks/use-team-run'
import { CreateProjectModal } from '@/components/project/CreateProjectModal'
import { BrandLogo, BrandLogoTitle } from '@/components/BrandLogo'
import { CreateTaskInput } from '@/components/task/CreateTaskInput'
import { getWorkspaceBranchLabel } from '@/components/workspace/team-workspace-view'
import { cn } from '@/lib/utils'
import { useDesktopTitlebar } from '@/lib/desktop-titlebar'

type CreateStep = 'idle' | 'creating-task' | 'creating-teamrun' | 'creating-workspace' | 'creating-session' | 'starting-session'
type CreateTaskMode = 'SOLO' | 'TEAM'
type WorkspaceMode = WorkspaceKind.WORKTREE | WorkspaceKind.MAIN_DIRECTORY
type BackgroundStartStatus = 'creating-workspace' | 'creating-session' | 'starting-session' | 'failed'

interface BackgroundStartState {
  status: BackgroundStartStatus
  error?: string
}

/** 顶栏项目切换器：面包屑式「Agent Tower / 项目 ▾」，侧栏空间全部留给任务 */
function ProjectSwitcher({
  projects,
  filterProjectId,
  setFilterProjectId,
  onCreateProject,
  className,
}: {
  projects: ReturnType<typeof adaptProject>[]
  filterProjectId: string | null
  setFilterProjectId: (id: string | null) => void
  onCreateProject: () => void
  className?: string
}) {
  const { t } = useI18n()
  const [isOpen, setIsOpen] = useState(false)
  const activeProjects = projects.filter(p => !p.archivedAt)
  const current = filterProjectId ? projects.find(p => p.id === filterProjectId) ?? null : null

  return (
    <div className={cn('relative flex items-center min-w-0', className)}>
      <span className="mx-1.5 text-muted-foreground/40 select-none">/</span>
      <button
        onClick={() => setIsOpen(prev => !prev)}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-sm text-foreground/90 hover:bg-accent transition-colors min-w-0"
      >
        {current ? (
          <span className={`w-2 h-2 rounded-full shrink-0 ${current.color.replace('text-', 'bg-')}`} />
        ) : (
          <LayersIcon size={13} className="text-muted-foreground shrink-0" />
        )}
        <span className="truncate max-w-[200px] font-medium">{current ? current.name : t('All Projects')}</span>
        <ChevronDown size={13} className={`text-muted-foreground/70 shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen ? (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setIsOpen(false)} />
          <div className="absolute left-4 top-full mt-1.5 w-60 bg-popover border border-border rounded-lg shadow-lg shadow-black/5 z-40 py-1 animate-in fade-in zoom-in-95 duration-100 origin-top-left">
            <button
              onClick={() => { setFilterProjectId(null); setIsOpen(false) }}
              className="w-full text-left px-3 py-1.5 text-[13px] flex items-center gap-2 hover:bg-accent/50 transition-colors"
            >
              <LayersIcon size={13} className="text-muted-foreground shrink-0" />
              <span className={`flex-1 truncate ${filterProjectId === null ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
                {t('All Projects')}
              </span>
              {filterProjectId === null ? <Check size={14} className="text-foreground shrink-0" /> : null}
            </button>

            <div className="h-px bg-border/60 my-1 mx-2" />

            <div className="max-h-[40vh] overflow-y-auto scrollbar-app-thin">
              {activeProjects.map(p => {
                const isActive = filterProjectId === p.id
                return (
                  <button
                    key={p.id}
                    onClick={() => { setFilterProjectId(p.id); setIsOpen(false) }}
                    className="w-full text-left px-3 py-1.5 text-[13px] flex items-center gap-2 hover:bg-accent/50 transition-colors"
                  >
                    <span className={`w-2 h-2 rounded-full shrink-0 ${p.color.replace('text-', 'bg-')}`} />
                    <span className={`flex-1 truncate ${isActive ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
                      {p.name}
                    </span>
                    {isActive ? <Check size={14} className="text-foreground shrink-0" /> : null}
                  </button>
                )
              })}
            </div>

            <div className="h-px bg-border/60 my-1 mx-2" />

            <button
              onClick={() => { setIsOpen(false); onCreateProject() }}
              className="w-full text-left px-3 py-1.5 text-[13px] flex items-center gap-2 text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
            >
              <PlusIcon size={13} />
              <span>{t('Create New Project...')}</span>
            </button>
          </div>
        </>
      ) : null}
    </div>
  )
}

/** 任务列表加载骨架：结构与真实列表行一致，避免加载完成后跳动 */
function TaskListSkeleton() {
  return (
    <div className="px-4 pt-6 space-y-5 animate-pulse" aria-hidden>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-start gap-3">
          <div className="w-4 h-4 rounded-full bg-muted shrink-0 mt-0.5" />
          <div className="flex-1 space-y-2">
            <div className="h-3 rounded bg-muted" style={{ width: `${70 - (i % 3) * 12}%` }} />
            <div className="h-2.5 rounded bg-muted/70" style={{ width: `${45 + (i % 2) * 18}%` }} />
          </div>
        </div>
      ))}
    </div>
  )
}

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

function upsertTaskIntoPage(page: PaginatedResponse<Task> | undefined, task: Task): PaginatedResponse<Task> | undefined {
  if (!page) return page
  const existingIndex = page.data.findIndex(item => item.id === task.id)
  if (existingIndex >= 0) {
    return {
      ...page,
      data: page.data.map(item => item.id === task.id ? { ...item, ...task } : item),
    }
  }
  return {
    ...page,
    data: [task, ...page.data],
    total: page.total + 1,
  }
}

function attachTaskProjectMetadata(task: Task, projects: Task['project'][]): Task {
  const project = projects.find(item => item?.id === task.projectId)
  return project ? { ...task, project } : task
}

export function ProjectKanbanPage() {
  const { t, locale } = useI18n()
  // === 状态 ===
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [filterProjectId, setFilterProjectId] = useState<string | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH)

  // Modal 状态
  const [isCreateProjectOpen, setIsCreateProjectOpen] = useState(false)
  const [createStep, setCreateStep] = useState<CreateStep>('idle')
  const [backgroundStarts, setBackgroundStarts] = useState<Record<string, BackgroundStartState>>({})

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
  const fetchedTasks = useMemo<Task[]>(() => {
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
  const [optimisticCreatedTasks, setOptimisticCreatedTasks] = useState<Task[]>([])
  const rawTasks = useMemo<Task[]>(() => {
    if (optimisticCreatedTasks.length === 0) return fetchedTasks

    const fetchedIds = new Set(fetchedTasks.map(task => task.id))
    return [
      ...optimisticCreatedTasks.filter(task => !fetchedIds.has(task.id)),
      ...fetchedTasks,
    ]
  }, [fetchedTasks, optimisticCreatedTasks])
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

  useEffect(() => {
    if (optimisticCreatedTasks.length === 0) return
    const fetchedIds = new Set(fetchedTasks.map(task => task.id))
    if (optimisticCreatedTasks.some(task => fetchedIds.has(task.id))) {
      setOptimisticCreatedTasks(current => current.filter(task => !fetchedIds.has(task.id)))
    }
  }, [fetchedTasks, optimisticCreatedTasks])

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
      const branch = getWorkspaceBranchLabel(
        task.workspaces?.find(w => w.status === 'ACTIVE') ?? task.workspaces?.[0],
      )

      return {
        id: task.id,
        projectId: task.projectId,
        projectName: 'Unknown',
        projectColor: 'text-muted-foreground',
        title: task.title,
        status: mapTaskStatusToUI(task.status),
        branch,
        mainBranch: 'main',
        description: task.description ?? '',
        isGitRepo: false,
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
  const startSession = useStartSession()

  const revealCreatedTask = useCallback((task: Task) => {
    setOptimisticCreatedTasks(current => {
      if (current.some(item => item.id === task.id)) {
        return current.map(item => item.id === task.id ? { ...item, ...task } : item)
      }
      return [task, ...current]
    })
    queryClient.setQueryData<PaginatedResponse<Task>>(
      queryKeys.tasks.list(task.projectId, { limit: TASK_LIST_LIMIT }),
      current => upsertTaskIntoPage(current, task),
    )
    queryClient.setQueryData(queryKeys.tasks.detail(task.id), task)
    setPendingCreatedTaskId(task.id)
    setSelectedTaskId(task.id)
  }, [queryClient])

  const startTaskInBackground = useCallback((task: Task, providerId: string, workspaceMode: WorkspaceMode) => {
    const taskId = task.id
    const prompt = [task.title, task.description].filter(Boolean).join('\n\n')

    setBackgroundStarts(current => ({
      ...current,
      [taskId]: { status: 'creating-workspace' },
    }))

    void (async () => {
      try {
        const workspace = await apiClient.post<{ id: string }>(
          `/tasks/${taskId}/workspaces`,
          { workspaceKind: workspaceMode },
        )
        setBackgroundStarts(current => ({
          ...current,
          [taskId]: { status: 'creating-session' },
        }))

        const session = await apiClient.post<{ id: string }>(
          `/workspaces/${workspace.id}/sessions`,
          { providerId, prompt },
        )
        setBackgroundStarts(current => ({
          ...current,
          [taskId]: { status: 'starting-session' },
        }))

        await startSession.mutateAsync(session.id)
        await queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.list(taskId) })
        await queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all })

        setBackgroundStarts(current => {
          const { [taskId]: _done, ...rest } = current
          return rest
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : t('启动 Agent 失败')
        setBackgroundStarts(current => ({
          ...current,
          [taskId]: { status: 'failed', error: message },
        }))
        toast.error(t('任务已创建，但启动 Agent 失败，可在详情中重试'))
        queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.list(taskId) })
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all })
      }
    })()
  }, [queryClient, startSession, t])

  const handleAutoStartRecovered = useCallback((taskId: string) => {
    setBackgroundStarts(current => {
      const { [taskId]: _recovered, ...rest } = current
      return rest
    })
    queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.list(taskId) })
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all })
  }, [queryClient])

  const handleDeleteTask = useCallback((taskId: string) => {
    deleteTask.mutate(taskId, {
      onSuccess: () => {
        // 删除后清除选中状态
        if (effectiveSelectedTaskId === taskId) {
          setSelectedTaskId(null)
        }
        setBackgroundStarts(current => {
          const { [taskId]: _removed, ...rest } = current
          return rest
        })
        setOptimisticCreatedTasks(current => current.filter(task => task.id !== taskId))
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

  const handleSubmitTask = useCallback(async (data: {
    title: string
    description: string
    projectId: string
    providerId: string
    mode: CreateTaskMode
    workspaceMode: WorkspaceMode
    teamRunMode: TeamRunMode
    teamTemplateId: string | null
    memberPresetIds: string[]
    attachmentLinks: string
  }) => {
    const { title, description, projectId, providerId, mode, workspaceMode, teamRunMode, teamTemplateId, memberPresetIds, attachmentLinks } = data
    const fullDescription = [description, attachmentLinks].filter(Boolean).join('\n\n')
    const selectedProject = activeProjects.find(project => project.id === projectId)
    const isGitProject = selectedProject?.isGitRepo !== false
    const effectiveMode: CreateTaskMode = isGitProject ? mode : 'SOLO'
    const effectiveWorkspaceMode: WorkspaceMode = isGitProject ? workspaceMode : WorkspaceKind.MAIN_DIRECTORY

    let createdTask: Task | null = null

    try {
      setCreateStep('creating-task')
      const created = await apiClient.post<Task>(`/projects/${projectId}/tasks`, {
        title,
        description: fullDescription || undefined,
      })
      createdTask = attachTaskProjectMetadata(created, activeProjects)

      localStorage.setItem('lastSelectedProjectId', projectId)
      if (effectiveMode === 'SOLO' && providerId) {
        localStorage.setItem('lastSelectedProviderId', providerId)
        const usageCountStr = localStorage.getItem('providerUsageCount')
        const usageCount: Record<string, number> = usageCountStr ? JSON.parse(usageCountStr) : {}
        usageCount[providerId] = (usageCount[providerId] ?? 0) + 1
        localStorage.setItem('providerUsageCount', JSON.stringify(usageCount))
      }

      if (effectiveMode === 'TEAM') {
        setCreateStep('creating-teamrun')
        await createTaskTeamRun.mutateAsync({
          taskId: createdTask.id,
          mode: teamRunMode,
          ...(teamTemplateId ? { teamTemplateId } : {}),
          ...(memberPresetIds.length > 0 ? { memberPresetIds } : {}),
        })
      } else if (providerId) {
        startTaskInBackground(createdTask, providerId, effectiveWorkspaceMode)
      }

      if (effectiveFilterProjectId && projectId !== effectiveFilterProjectId) {
        setFilterProjectId(null)
      }
      revealCreatedTask(createdTask)
      setCreateStep('idle')

      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all })
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all })
    } catch (error) {
      setCreateStep('idle')
      if (createdTask && effectiveMode === 'TEAM') {
        // TeamRun creation failed — clean up orphan task and treat as complete failure
        try { await deleteTask.mutateAsync(createdTask.id) } catch { /* best-effort cleanup */ }
        toast.error(t('TeamRun 创建失败，请检查团队配置后重试'))
        throw error
      } else if (createdTask) {
        if (effectiveFilterProjectId && projectId !== effectiveFilterProjectId) {
          setFilterProjectId(null)
        }
        revealCreatedTask(createdTask)
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all })
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.all })
      } else {
        toast.error(error instanceof Error ? error.message : t('Failed to create task'))
        throw error
      }
    }
  }, [activeProjects, createTaskTeamRun, startTaskInBackground, deleteTask, queryClient, t, effectiveFilterProjectId, revealCreatedTask])


  const isLoading = isProjectsLoading || isFilteredTasksLoading || isAllTasksLoading

  const createTaskProjectOptions = useMemo(() =>
    activeProjects.map(p => ({
      id: p.id,
      name: p.name,
      color: uiProjects.find(u => u.id === p.id)?.color,
      isGitRepo: p.isGitRepo,
    })),
    [activeProjects, uiProjects],
  )

  const createTaskProviderOptions = useMemo(() =>
    sortedProviders.map(({ provider, availability }) => ({
      id: provider.id,
      name: provider.name,
      agentType: provider.agentType,
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

  const [createTaskProjectId, setCreateTaskProjectId] = useState(defaultProjectId)

  useEffect(() => {
    setCreateTaskProjectId(defaultProjectId)
  }, [defaultProjectId])

  const createTaskProjectName = useMemo(() => {
    return activeProjects.find(p => p.id === createTaskProjectId)?.name
      ?? activeProjects.find(p => p.id === defaultProjectId)?.name
      ?? t('Project')
  }, [activeProjects, createTaskProjectId, defaultProjectId, t])

  const createTaskTitle = locale === 'zh-CN'
    ? `你需要在 ${createTaskProjectName} 中做点什么？`
    : `What do you need to do in ${createTaskProjectName}?`

  const defaultProviderId = useMemo(() => {
    const lastProviderId = localStorage.getItem('lastSelectedProviderId')
    if (lastProviderId && sortedProviders.find(p => p.provider.id === lastProviderId && p.availability.type !== 'NOT_FOUND')) return lastProviderId
    const available = sortedProviders.find(p => p.availability.type !== 'NOT_FOUND')
    return available?.provider.id ?? ''
  }, [sortedProviders])

  const isMobile = useIsMobile()
  const [mobileCreateOpen, setMobileCreateOpen] = useState(false)
  const { usesIntegratedTitlebar, desktopPlatform, hasMacTrafficLights } = useDesktopTitlebar()
  const hasWindowsWindowControls = usesIntegratedTitlebar && desktopPlatform === 'win32'

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
        <div className="flex flex-col h-dvh bg-background overflow-hidden text-sm">
          <header className="h-12 border-b border-border/60 flex items-center px-4 shrink-0">
            <button
              onClick={() => setMobileCreateOpen(false)}
              className="text-sm text-muted-foreground active:text-foreground"
            >
              {t('Cancel')}
            </button>
          </header>
          <div className="flex-1 flex flex-col items-center justify-center px-4 pb-[8vh]">
            <h1 className="max-w-full text-center text-[20px] font-medium tracking-tight leading-snug text-foreground mb-5 break-words">{createTaskTitle}</h1>
            <CreateTaskInput
              projects={createTaskProjectOptions}
              providers={createTaskProviderOptions}
              isProvidersLoading={isProvidersLoading}
              onSubmit={handleMobileSubmitTask}
              defaultProjectId={defaultProjectId}
              defaultProviderId={defaultProviderId}
              onProjectChange={setCreateTaskProjectId}
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
            autoStartState={backgroundStarts[taskDetailData.id] ?? null}
            onAutoStartRecovered={handleAutoStartRecovered}
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
        <div className="flex flex-col h-dvh bg-sidebar overflow-hidden text-sm">
          {/* 顶部栏 */}
          <header className="h-12 bg-sidebar flex items-center px-4 justify-between shrink-0 z-20">
            <div className="flex items-center gap-2 min-w-0">
              <BrandLogo />
              <BrandLogoTitle />
              <ProjectSwitcher
                projects={uiProjects}
                filterProjectId={effectiveFilterProjectId}
                setFilterProjectId={setFilterProjectId}
                onCreateProject={handleCreateProject}
              />
            </div>
            <div className="flex items-center gap-1">
              <TunnelButton />
              <button onClick={() => useUIStore.getState().openSettings()} className="p-1.5 text-muted-foreground/70 active:text-foreground rounded-md">
                <Settings size={16} />
              </button>
            </div>
          </header>

          {isLoading && uiTasks.length === 0 ? (
            <div className="flex-1 overflow-hidden"><TaskListSkeleton /></div>
          ) : (
            <TaskList
              tasks={uiTasks}
              projects={uiProjects}
              selectedTaskId={null}
              onSelectTask={setSelectedTaskId}
              filterProjectId={effectiveFilterProjectId}
              setFilterProjectId={setFilterProjectId}
              width="100%"
              onCreateTask={handleMobileCreateTask}
              onCreateProject={handleCreateProject}
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
    <div ref={containerRef} className="flex flex-col h-screen bg-sidebar overflow-hidden text-sm">
      {/* === 顶部栏 === */}
      <header
        className={cn(
          'h-12 bg-sidebar flex items-center px-4 justify-between flex-shrink-0 z-20 relative',
          usesIntegratedTitlebar && 'app-region-drag',
          hasWindowsWindowControls && 'pr-[150px]',
        )}
      >
        <div className={cn(
          'flex items-center gap-2 min-w-0',
          hasMacTrafficLights && 'pl-[72px]',
        )}>
          <BrandLogo />
          <BrandLogoTitle />
          <ProjectSwitcher
            projects={uiProjects}
            filterProjectId={effectiveFilterProjectId}
            setFilterProjectId={setFilterProjectId}
            onCreateProject={handleCreateProject}
            className={usesIntegratedTitlebar ? 'app-region-no-drag' : undefined}
          />
        </div>
        <div className={cn(
          'flex items-center gap-1',
          usesIntegratedTitlebar && 'app-region-no-drag',
        )}>
          <div className={usesIntegratedTitlebar ? 'app-region-no-drag' : undefined}>
            <TunnelButton />
          </div>
          <button
            onClick={() => useUIStore.getState().openSettings()}
            className={cn(
              'p-1.5 text-muted-foreground/70 hover:text-foreground hover:bg-accent rounded-md transition-colors',
              usesIntegratedTitlebar && 'app-region-no-drag',
            )}
          >
            <Settings size={16} />
          </button>
        </div>
      </header>

      {/* === 主体双栏区域 === */}
      <div className="flex-1 flex overflow-hidden">
        {/* 左侧: TaskList */}
        {isLoading && uiTasks.length === 0 ? (
          <div
            className="h-full overflow-hidden flex-shrink-0"
            style={{ width: sidebarWidth }}
          >
            <TaskListSkeleton />
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
            onCreateTask={handleCreateTask}
            onCreateProject={handleCreateProject}
            isCreateActive={!effectiveSelectedTaskId}
            activeTaskIds={activeTaskIds}
            onTaskStatusChange={handleTaskStatusChange}
            onDeleteTask={handleDeleteTask}
          />
        )}

        {/* 拖拽分隔线 */}
        <div
          onMouseDown={handleMouseDown}
          className="w-1 cursor-col-resize hover:bg-border active:bg-ring/40 transition-colors z-50 -ml-[2px] flex-shrink-0 h-full"
          title={t('Drag to resize')}
        />

        {/* 右侧: 内容岛屿（圆角面板，四周边框一致） */}
        <div className="flex-1 flex min-w-0 mb-2 mr-2 rounded-xl border border-border/50 bg-background overflow-hidden">
          {effectiveSelectedTaskId && taskDetailData ? (
            <TaskDetail
              task={taskDetailData}
              onDeleteTask={taskDetailData.projectArchivedAt ? undefined : handleDeleteTask}
              isDeleting={deleteTask.isPending}
              onTaskStatusChange={taskDetailData.projectArchivedAt ? undefined : handleTaskStatusChange}
              autoStartState={backgroundStarts[taskDetailData.id] ?? null}
              onAutoStartRecovered={handleAutoStartRecovered}
            />
          ) : effectiveSelectedTaskId && !taskDetailData ? (
            <div className="flex-1 flex items-center justify-center bg-background min-w-0">
              <span className="text-sm text-muted-foreground/70">{t('Loading...')}</span>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center bg-background min-w-0 px-8 pb-[10vh]">
              <div className="w-full max-w-2xl flex flex-col items-center animate-[fadeInUp_0.5s_cubic-bezier(0.16,1,0.3,1)]">
                <h1 className="max-w-full text-center text-[26px] font-medium tracking-tight leading-snug text-foreground mb-6 break-words">{createTaskTitle}</h1>
                <CreateTaskInput
                  projects={createTaskProjectOptions}
                  providers={createTaskProviderOptions}
                  isProvidersLoading={isProvidersLoading}
                  onSubmit={handleSubmitTask}
                  defaultProjectId={defaultProjectId}
                  defaultProviderId={defaultProviderId}
                  onProjectChange={setCreateTaskProjectId}
                  createStep={createStep}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* === Modals === */}
      <CreateProjectModal
        isOpen={isCreateProjectOpen}
        onClose={handleCloseProjectModal}
      />
    </div>
  )
}
