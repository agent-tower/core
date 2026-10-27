import { isTaskInSubtree, type TaskDeletionScope } from '@agent-tower/shared'
import { useMutation, useQuery, useInfiniteQuery, useQueryClient, type QueryClient, type QueryKey, type InfiniteData } from '@tanstack/react-query'
import type { CreateTaskInput, Task, TaskBoardResponse, TaskBody, TaskStatus } from '@agent-tower/shared'
import { apiClient } from '@/lib/api-client'
import { queryKeys } from './query-keys'
import { useTaskCleanupMonitor } from './use-task-cleanup-monitor'

// ============ API 响应类型 ============

/** 分页列表响应 */
interface PaginatedResponse<T> {
  data: T[]
  total: number
  page: number
  limit: number
}

type TasksListSnapshot = Array<[
  readonly unknown[],
  PaginatedResponse<Task> | undefined,
]>

type TaskBoardSnapshot = Array<[
  readonly unknown[],
  TaskBoardResponse | undefined,
]>

// ============ 请求参数类型 ============

interface ListTasksParams {
  status?: TaskStatus
  page?: number
  limit?: number
}

interface TaskBoardParams extends ListTasksParams {
  projectId?: string
}

interface UpdateTaskInput {
  id: string
  title?: string
  description?: string
  priority?: number
}

interface UpdateTaskStatusInput {
  id: string
  status: TaskStatus
}

export function removeTaskFromListCaches(
  queryClient: QueryClient,
  taskId: string,
  projectId?: string,
): TasksListSnapshot {
  const predicate = (query: { queryKey: QueryKey }) => isTaskListQueryKey(query.queryKey, projectId)
  const snapshots = queryClient.getQueriesData<PaginatedResponse<Task>>({ predicate })

  queryClient.setQueriesData<PaginatedResponse<Task>>({ predicate }, (current) => {
    if (!current || !Array.isArray(current.data)) return current
    const nextData = current.data.filter((task) => !isTaskInSubtree(task, taskId))
    if (nextData.length === current.data.length) return current
    return {
      ...current,
      data: nextData,
      total: Math.max(0, current.total - (current.data.length - nextData.length)),
    }
  })

  queryClient.removeQueries({
    queryKey: queryKeys.tasks.detail(taskId),
    exact: true,
  })
  queryClient.removeQueries({
    queryKey: queryKeys.tasks.body(taskId),
    exact: true,
  })

  return snapshots
}

export function isTaskListQueryKey(queryKey: QueryKey, projectId?: string): boolean {
  if (!Array.isArray(queryKey)) return false
  if (queryKey[0] !== 'tasks' || queryKey[1] !== 'list') return false
  return projectId ? queryKey[2] === projectId : true
}

/** The changed descendant need not be cached; refresh cached ancestors in its project. */
export function isTaskDetailQueryForProject(query: { queryKey: QueryKey; state: { data: unknown } }, projectId: string): boolean {
  if (query.queryKey[0] !== 'tasks' || query.queryKey[1] !== 'detail') return false
  const task = query.state.data as Task | undefined
  return !task || task.projectId === projectId
}

export function isTaskBoardQueryKey(queryKey: QueryKey, projectId?: string): boolean {
  if (!Array.isArray(queryKey)) return false
  if (queryKey[0] !== 'tasks' || queryKey[1] !== 'board') return false
  if (!projectId) return true
  const params = queryKey[2]
  if (!params || typeof params !== 'object') return true
  const boardProjectId = (params as { projectId?: unknown }).projectId
  return boardProjectId == null || boardProjectId === projectId
}

export function removeTaskFromBoardCaches(
  queryClient: QueryClient,
  taskId: string,
  projectId?: string,
): TaskBoardSnapshot {
  const predicate = (query: { queryKey: QueryKey }) => isTaskBoardQueryKey(query.queryKey, projectId)
  const snapshots = queryClient.getQueriesData<TaskBoardResponse>({ predicate })

  queryClient.setQueriesData<TaskBoardResponse>({ predicate }, (current) => {
    if (!current || !Array.isArray(current.data)) return current
    const nextData = current.data.filter((task) => !isTaskInSubtree(task, taskId))
    const parents = current.parents?.filter(task => !isTaskInSubtree(task, taskId))
    if (nextData.length === current.data.length && parents?.length === current.parents?.length) return current
    return {
      ...current,
      data: nextData,
      ...(parents ? { parents } : {}),
      total: Math.max(0, current.total - (current.data.length - nextData.length)),
    }
  })

  return snapshots
}

function restoreTaskListCaches(
  queryClient: QueryClient,
  snapshots: TasksListSnapshot,
) {
  for (const [queryKey, data] of snapshots) {
    queryClient.setQueryData(queryKey, data)
  }
}

function restoreTaskBoardCaches(
  queryClient: QueryClient,
  snapshots: TaskBoardSnapshot,
) {
  for (const [queryKey, data] of snapshots) {
    queryClient.setQueryData(queryKey, data)
  }
}

// ============ Query Hooks ============

/**
 * 获取项目的任务列表（支持分页和状态过滤）
 * GET /api/projects/:projectId/tasks
 */
export function useTasks(projectId: string, options?: ListTasksParams) {
  const params: Record<string, string> = {}
  if (options?.status != null) params.status = options.status
  if (options?.page != null) params.page = String(options.page)
  if (options?.limit != null) params.limit = String(options.limit)

  return useQuery({
    queryKey: queryKeys.tasks.list(projectId, options as Record<string, unknown> | undefined),
    queryFn: () =>
      apiClient.get<PaginatedResponse<Task>>(
        `/projects/${projectId}/tasks`,
        { params },
      ),
    enabled: !!projectId,
  })
}

export function useTaskBoard(options?: TaskBoardParams) {
  const params: Record<string, string> = {}
  if (options?.projectId) params.projectId = options.projectId
  if (options?.status != null) params.status = options.status
  if (options?.page != null) params.page = String(options.page)
  if (options?.limit != null) params.limit = String(options.limit)

  return useQuery({
    queryKey: queryKeys.tasks.board(options as Record<string, unknown> | undefined),
    queryFn: () => apiClient.get<TaskBoardResponse>('/task-board', { params }),
  })
}

export function useTaskDeletionScope(taskId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.tasks.deletionScope(taskId),
    queryFn: () => apiClient.get<TaskDeletionScope>(`/tasks/${taskId}/deletion-scope`),
    enabled: Boolean(taskId) && enabled,
  })
}

/** Remove visible descendants from every loaded child page; REST restores authoritative totals. */
export function removeTaskFromSubtaskCaches(queryClient: QueryClient, taskId: string) {
  const filter = { queryKey: ['tasks', 'subtasks'] }
  const snapshots = queryClient.getQueriesData<InfiniteData<TaskBoardResponse>>(filter)
  queryClient.setQueriesData<InfiniteData<TaskBoardResponse>>(filter, current => {
    if (!current) return current
    const removedIds = new Set(current.pages.flatMap(page => page.data.filter(task => isTaskInSubtree(task, taskId)).map(task => task.id)))
    if (!removedIds.size) return current
    return { ...current, pages: current.pages.map(page => ({
      ...page, data: page.data.filter(task => !removedIds.has(task.id)), total: Math.max(0, page.total - removedIds.size),
    })) }
  })
  return snapshots
}

/** Child pages load only when the sidebar group or detail panel is opened. */
export function useSubtasks(taskId: string, enabled = true) {
  return useInfiniteQuery({
    queryKey: queryKeys.tasks.subtasks(taskId),
    initialPageParam: 1,
    queryFn: ({ pageParam }) => apiClient.get<TaskBoardResponse>(`/tasks/${taskId}/subtasks`, {
      params: { page: String(pageParam), limit: '100' },
    }),
    getNextPageParam: page => page.page < page.totalPages ? page.page + 1 : undefined,
    enabled: Boolean(taskId) && enabled,
  })
}

/**
 * 获取任务详情
 * GET /api/tasks/:id
 */
export function useTask(id: string) {
  return useQuery({
    queryKey: queryKeys.tasks.detail(id),
    queryFn: () => apiClient.get<Task>(`/tasks/${id}`),
    enabled: !!id,
  })
}

/**
 * 按需获取任务完整正文。点击任务/TeamRun 热路径不要默认调用。
 * GET /api/tasks/:id/body
 */
export function useTaskBody(id: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.tasks.body(id),
    queryFn: () => apiClient.get<TaskBody>(`/tasks/${id}/body`),
    enabled: !!id && enabled,
  })
}

// ============ Mutation Hooks ============

/**
 * 创建任务
 * POST /api/projects/:projectId/tasks
 */
export function useCreateTask(projectId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: CreateTaskInput) =>
      apiClient.post<Task>(`/projects/${projectId}/tasks`, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.boardAll })
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.list(projectId),
      })
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.stats(projectId),
      })
    },
  })
}

/**
 * 更新任务
 * PUT /api/tasks/:id
 */
export function useUpdateTask() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, ...data }: UpdateTaskInput) =>
      apiClient.put<Task>(`/tasks/${id}`, data),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all })
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.detail(data.id),
      })
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.body(data.id),
      })
    },
  })
}

/**
 * 更新任务状态
 * PATCH /api/tasks/:id/status
 */
export function useUpdateTaskStatus() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, status }: UpdateTaskStatusInput) =>
      apiClient.patch<Task>(`/tasks/${id}/status`, { status }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all })
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.detail(data.id),
      })
    },
  })
}

/**
 * 删除任务
 * DELETE /api/tasks/:id
 */
export function useDeleteTask() {
  const queryClient = useQueryClient()
  const trackCleanup = useTaskCleanupMonitor()

  return useMutation({
    mutationFn: (input: string | { id: string; expectedSubtaskCount?: number }) => {
      const { id, expectedSubtaskCount } = typeof input === 'string' ? { id: input } : input
      return apiClient.delete<void>(`/tasks/${id}`, expectedSubtaskCount === undefined ? undefined : {
        params: { expectedSubtaskCount: String(expectedSubtaskCount) },
      })
    },
    onMutate: async (input) => {
      const id = typeof input === 'string' ? input : input.id
      await queryClient.cancelQueries({ queryKey: queryKeys.tasks.all })
      const snapshots = removeTaskFromListCaches(queryClient, id)
      const boardSnapshots = removeTaskFromBoardCaches(queryClient, id)
      const subtaskSnapshots = removeTaskFromSubtaskCaches(queryClient, id)
      return { snapshots, boardSnapshots, subtaskSnapshots }
    },
    onError: (_error, _id, context) => {
      if (context?.snapshots) {
        restoreTaskListCaches(queryClient, context.snapshots)
      }
      for (const [key, data] of context?.subtaskSnapshots ?? []) queryClient.setQueryData(key, data)
      if (context?.boardSnapshots) {
        restoreTaskBoardCaches(queryClient, context.boardSnapshots)
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all })
    },
    onSuccess: (_data, input) => {
      trackCleanup(typeof input === 'string' ? input : input.id)
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all })
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all })
    },
  })
}

/**
 * 重试任务（归档当前 Workspace，重置状态为 TODO）
 * POST /api/tasks/:id/retry
 */
export function useRetryTask() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.post<Task>(`/tasks/${id}/retry`, {}),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all })
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all })
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.detail(data.id),
      })
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.body(data.id),
      })
    },
  })
}
