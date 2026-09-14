import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  SessionStatus,
  type AgentType,
  type RuntimeStateDto,
  type RuntimeTurnState,
  type Session,
} from '@agent-tower/shared'
import {
  ServerEvents,
  type SessionPermissionInvalidatedPayload,
  type SessionPermissionRequestedPayload,
  type SessionRuntimeStateChangedPayload,
} from '@agent-tower/shared/socket'
import { apiClient } from '../lib/api-client'
import { translate } from '../lib/i18n'
import { queryKeys } from './query-keys'
import { socketManager } from '@/lib/socket/manager'
import { useEffect } from 'react'
import { toast } from 'sonner'

// ============ Queries ============

/** 获取单个 session 详情 */
export function useSession(id: string) {
  return useQuery({
    queryKey: queryKeys.sessions.detail(id),
    queryFn: () => apiClient.get<Session>(`/sessions/${id}`),
    enabled: !!id,
  })
}

export function useRuntimeState(id: string) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: queryKeys.sessions.runtime(id),
    queryFn: () => apiClient.get<RuntimeStateDto>(`/sessions/${id}/runtime`),
    enabled: !!id,
  })

  useEffect(() => {
    if (!id) return
    const socket = socketManager.connect()
    const refresh = (payload: SessionPermissionRequestedPayload | SessionPermissionInvalidatedPayload) => {
      if (payload.sessionId !== id) return
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions.runtime(id) })
    }
    const onState = (payload: SessionRuntimeStateChangedPayload) => {
      if (payload.sessionId !== id) return
      queryClient.setQueryData(queryKeys.sessions.runtime(id), payload.state)
    }
    const onConnect = () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions.runtime(id) })
    }
    socket.on(ServerEvents.SESSION_PERMISSION_REQUESTED, refresh)
    socket.on(ServerEvents.SESSION_PERMISSION_INVALIDATED, refresh)
    socket.on(ServerEvents.SESSION_RUNTIME_STATE_CHANGED, onState)
    socket.on('connect', onConnect)
    return () => {
      socket.off(ServerEvents.SESSION_PERMISSION_REQUESTED, refresh)
      socket.off(ServerEvents.SESSION_PERMISSION_INVALIDATED, refresh)
      socket.off(ServerEvents.SESSION_RUNTIME_STATE_CHANGED, onState)
      socket.off('connect', onConnect)
    }
  }, [id, queryClient])

  return query
}

export function isRuntimeTurnActive(turnState?: RuntimeTurnState): boolean {
  return turnState === 'RUNNING'
    || turnState === 'AWAITING_PERMISSION'
    || turnState === 'CANCELLING'
}

export function isSessionStatusActive(status?: SessionStatus | string): boolean {
  return status === SessionStatus.RUNNING || status === SessionStatus.PENDING
}

export function useSessionActivity(id: string, status?: SessionStatus | string) {
  const { data: runtimeState } = useRuntimeState(id)
  return {
    runtimeState,
    isActive: isSessionStatusActive(status) || isRuntimeTurnActive(runtimeState?.turnState),
    isCancelling: runtimeState?.turnState === 'CANCELLING',
  }
}

export function useResolveRuntimePermission() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ sessionId, requestId, optionId }: {
      sessionId: string
      requestId: string
      optionId: string
    }) => apiClient.post<void>(`/sessions/${sessionId}/permissions/${requestId}/resolve`, { optionId }),
    onSettled: (_data, _error, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sessions.runtime(variables.sessionId) })
    },
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
const STOP_SESSION_REQUEST_TIMEOUT_MS = 45_000

export function useStopSession() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (id: string) => {
      // The server bounds its member-admission wait and answers 409 beyond it,
      // but once inside the critical section it waits for process-tree cleanup
      // (`SessionManager.stop` → `pendingFinalization`) which is deliberately
      // unbounded. This client-side ceiling keeps the stop button from staying
      // disabled/"Stopping…" forever when the server never answers.
      try {
        return await apiClient.post<Session>(
          `/sessions/${id}/stop`,
          undefined,
          { signal: AbortSignal.timeout(STOP_SESSION_REQUEST_TIMEOUT_MS) },
        )
      } catch (error) {
        if (error instanceof DOMException && error.name === 'TimeoutError') {
          throw new Error('Stop request timed out before the server answered. The session may still be stopping; refresh the status and retry.')
        }
        throw error
      }
    },
    onError: (error) => {
      toast.error(
        translate('Failed to stop session. Refreshing status; check it and try again.'),
        { description: error instanceof Error ? error.message : undefined },
      )
    },
    onSettled: (_data, _error, id) => {
      queryClient.setQueryData<RuntimeStateDto>(queryKeys.sessions.runtime(id), (state) => (
        state?.turnState === 'CANCELLING' ? { ...state, turnState: 'IDLE' } : state
      ))
      void Promise.allSettled([
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions.detail(id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions.runtime(id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all }),
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all }),
      ])
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
