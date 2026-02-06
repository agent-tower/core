import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Project } from '@agent-tower/shared'
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

/** 项目详情响应（含任务统计） */
interface ProjectDetail extends Project {
  _count?: {
    tasks: number
  }
}

// ============ 请求参数类型 ============

interface ListProjectsParams {
  page?: number
  limit?: number
}

interface CreateProjectInput {
  name: string
  repoPath: string
  mainBranch?: string
  description?: string
}

interface UpdateProjectInput {
  id: string
  name?: string
  description?: string
  mainBranch?: string
}

// ============ Query Hooks ============

/**
 * 获取项目列表（支持分页）
 * GET /api/projects
 */
export function useProjects(options?: ListProjectsParams) {
  const params: Record<string, string> = {}
  if (options?.page != null) params.page = String(options.page)
  if (options?.limit != null) params.limit = String(options.limit)

  return useQuery({
    queryKey: queryKeys.projects.list(options),
    queryFn: () =>
      apiClient.get<PaginatedResponse<Project>>('/projects', { params }),
  })
}

/**
 * 获取项目详情（含任务统计）
 * GET /api/projects/:id
 */
export function useProject(id: string) {
  return useQuery({
    queryKey: queryKeys.projects.detail(id),
    queryFn: () => apiClient.get<ProjectDetail>(`/projects/${id}`),
    enabled: !!id,
  })
}

// ============ Mutation Hooks ============

/**
 * 创建项目
 * POST /api/projects
 */
export function useCreateProject() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: CreateProjectInput) =>
      apiClient.post<Project>('/projects', input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all })
    },
  })
}

/**
 * 更新项目
 * PUT /api/projects/:id
 */
export function useUpdateProject() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, ...data }: UpdateProjectInput) =>
      apiClient.put<Project>(`/projects/${id}`, data),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all })
      queryClient.invalidateQueries({
        queryKey: queryKeys.projects.detail(variables.id),
      })
    },
  })
}

/**
 * 删除项目
 * DELETE /api/projects/:id
 */
export function useDeleteProject() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) => apiClient.delete<void>(`/projects/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all })
    },
  })
}
