import { useMutation, useQuery, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query'
import type { Task, TaskBoardResponse, TaskBody, TaskStatus } from '@agent-tower/shared'
import { apiClient } from '@/lib/api-client'
import { queryKeys } from './query-keys'

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

interface CreateTaskInput {
  title: string
  description?: string
  priority?: number
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
    const nextData = current.data.filter((task) => task.id !== taskId)
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
    const nextData = current.data.filter((task) => task.id !== taskId)
    if (nextData.length === current.data.length) return current
    return {
      ...current,
      data: nextData,
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

  return useMutation({
    mutationFn: (id: string) => apiClient.delete<void>(`/tasks/${id}`),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.tasks.all })
      const snapshots = removeTaskFromListCaches(queryClient, id)
      const boardSnapshots = removeTaskFromBoardCaches(queryClient, id)
      return { snapshots, boardSnapshots }
    },
    onError: (_error, _id, context) => {
      if (context?.snapshots) {
        restoreTaskListCaches(queryClient, context.snapshots)
      }
      if (context?.boardSnapshots) {
        restoreTaskBoardCaches(queryClient, context.boardSnapshots)
      }
    },
    onSuccess: () => {
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
