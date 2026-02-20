import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Workspace, GitOperationStatus } from '@agent-tower/shared'
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
    mutationFn: ({ id, commitMessage }: { id: string; commitMessage?: string }) =>
      apiClient.post<{ success: boolean; sha: string }>(`/workspaces/${id}/merge`, { commitMessage }),
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

/** 在 IDE 中打开 workspace */
export function useOpenInEditor() {
  return useMutation({
    mutationFn: ({ workspaceId, editorType }: { workspaceId: string; editorType?: string }) =>
      apiClient.post<{ success: boolean }>(`/workspaces/${workspaceId}/open-editor`, { editorType }),
  })
}

// ============ Git Operations ============

/** 获取 workspace 的 Git 操作状态 */
export function useGitStatus(workspaceId: string) {
  return useQuery({
    queryKey: queryKeys.workspaces.gitStatus(workspaceId),
    queryFn: () => apiClient.get<GitOperationStatus>(`/workspaces/${workspaceId}/git-status`),
    enabled: !!workspaceId,
  })
}

/** Rebase workspace 分支到最新基础分支 */
export function useRebaseWorkspace() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.post<{ success: boolean }>(`/workspaces/${id}/rebase`),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.gitStatus(id) })
    },
    onError: (_error, id) => {
      // 冲突时也刷新 git status 以更新 ConflictBanner
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.gitStatus(id) })
    },
  })
}

/** 中止当前 Git 操作 */
export function useAbortOperation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.post<{ success: boolean }>(`/workspaces/${id}/abort-operation`),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.gitStatus(id) })
    },
  })
}
