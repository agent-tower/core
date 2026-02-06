import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Workspace } from '@agent-tower/shared'
import { apiClient } from '../lib/api-client'
import { queryKeys } from './query-keys'

// ============ Queries ============

/** 获取某个 task 下的所有 workspaces */
export function useWorkspaces(taskId: string) {
  return useQuery({
    queryKey: queryKeys.workspaces.list(taskId),
    queryFn: () => apiClient.get<Workspace[]>(`/tasks/${taskId}/workspaces`),
    enabled: !!taskId,
  })
}

/** 获取单个 workspace 详情（含 sessions） */
export function useWorkspace(id: string) {
  return useQuery({
    queryKey: queryKeys.workspaces.detail(id),
    queryFn: () => apiClient.get<Workspace>(`/workspaces/${id}`),
    enabled: !!id,
  })
}

/** 获取 workspace 的 diff */
export function useWorkspaceDiff(id: string) {
  return useQuery({
    queryKey: queryKeys.workspaces.diff(id),
    queryFn: () => apiClient.get<{ diff: string }>(`/workspaces/${id}/diff`),
    enabled: !!id,
  })
}

// ============ Mutations ============

/** 创建 workspace */
export function useCreateWorkspace(taskId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data: { branchName?: string }) =>
      apiClient.post<Workspace>(`/tasks/${taskId}/workspaces`, data),
    onSuccess: () => {
      // 创建 workspace 会同时影响 task 状态，所以两者都需要 invalidate
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.list(taskId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all })
    },
  })
}

/** 合并 workspace */
export function useMergeWorkspace() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.post<{ success: boolean; sha: string }>(`/workspaces/${id}/merge`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all })
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all })
    },
  })
}

/** 归档 workspace */
export function useArchiveWorkspace() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.post<void>(`/workspaces/${id}/archive`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all })
    },
  })
}

/** 删除 workspace */
export function useDeleteWorkspace() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete<void>(`/workspaces/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all })
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all })
    },
  })
}
