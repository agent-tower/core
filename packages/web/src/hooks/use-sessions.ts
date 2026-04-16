import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { Session, AgentType } from '@agent-tower/shared'
import { apiClient } from '../lib/api-client'
import { queryKeys } from './query-keys'

// ============ Queries ============

/** 获取单个 session 详情 */
export function useSession(id: string) {
  return useQuery({
    queryKey: queryKeys.sessions.detail(id),
    queryFn: () => apiClient.get<Session>(`/sessions/${id}`),
    enabled: !!id,
  })
}

// ============ Mutations ============

/** 创建 session */
export function useCreateSession(workspaceId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data: { agentType: AgentType; prompt: string }) =>
      apiClient.post<Session>(`/workspaces/${workspaceId}/sessions`, data),
    onSuccess: () => {
      // 新建 session 后 invalidate workspace 详情（含 sessions 列表）
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.detail(workspaceId) })
    },
  })
}

/** 启动 session */
export function useStartSession() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.post<Session>(`/sessions/${id}/start`),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions.detail(id) })
      // Starting a session transitions the task from TODO → IN_PROGRESS (server-side).
      // Invalidate all task queries so the kanban board reflects this immediately,
      // without relying solely on the WebSocket event which can race with in-flight fetches.
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all })
    },
  })
}

/** 停止 session */
export function useStopSession() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (id: string) =>
      apiClient.post<Session>(`/sessions/${id}/stop`),
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions.detail(id) })
    },
  })
}

/** 向 session 发送消息（统一入口 — 无论 RUNNING 还是 COMPLETED/CANCELLED） */
export function useSendMessage() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, message, providerId }: { id: string; message: string; providerId?: string }) =>
      apiClient.post<void>(`/sessions/${id}/message`, { message, providerId }),
    onSuccess: () => {
      // sendMessage 现在可能 spawn 新 PTY（从 COMPLETED → RUNNING），
      // 需要 invalidate workspaces 让前端 session 状态刷新
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all })
      // Sending a message may restart a session (COMPLETED → RUNNING),
      // which also reverts the task status (e.g. IN_REVIEW → IN_PROGRESS).
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all })
    },
  })
}
