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

/** 向 session 发送消息 */
export function useSendMessage() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ id, message }: { id: string; message: string }) =>
      apiClient.post<void>(`/sessions/${id}/message`, { message }),
    onSuccess: (_data, { id }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions.detail(id) })
    },
  })
}
