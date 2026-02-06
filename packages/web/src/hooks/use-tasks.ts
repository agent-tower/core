import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Task, TaskStatus } from '@agent-tower/shared'
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

// ============ 请求参数类型 ============

interface ListTasksParams {
  status?: TaskStatus
  page?: number
  limit?: number
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all })
    },
  })
}
