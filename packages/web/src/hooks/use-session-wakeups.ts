import { useEffect, useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { SessionWakeupDto } from '@agent-tower/shared'
import { ServerEvents, type SessionWakeupsChangedPayload } from '@agent-tower/shared/socket'
import { apiClient } from '@/lib/api-client'
import { socketManager } from '@/lib/socket/manager'
import { queryKeys } from './query-keys'

const NO_WAKEUPS: SessionWakeupDto[] = []

/**
 * Wake-ups the agent asked Agent Tower for that will still start a turn
 * (PENDING: waiting for a timer or a service exit; READY: waiting for the
 * current turn to end). While any exist the task stays in progress.
 */
export function usePendingSessionWakeups(sessionId: string) {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: queryKeys.sessions.wakeups(sessionId),
    queryFn: () => apiClient.get<SessionWakeupDto[]>(`/sessions/${encodeURIComponent(sessionId)}/wakeups`),
    enabled: !!sessionId,
  })

  useEffect(() => {
    if (!sessionId) return
    const socket = socketManager.connect()
    const refresh = () => { void queryClient.invalidateQueries({ queryKey: queryKeys.sessions.wakeups(sessionId) }) }
    const onChanged = (payload: SessionWakeupsChangedPayload) => {
      if (payload.sessionId === sessionId) refresh()
    }
    socket.on(ServerEvents.SESSION_WAKEUPS_CHANGED, onChanged)
    socket.on('connect', refresh)
    return () => {
      socket.off(ServerEvents.SESSION_WAKEUPS_CHANGED, onChanged)
      socket.off('connect', refresh)
    }
  }, [sessionId, queryClient])

  const pending = useMemo(() => {
    // This renders inside every session log; never let an unexpected payload break it.
    const rows = Array.isArray(query.data)
      ? query.data.filter((wakeup) => wakeup.state === 'PENDING' || wakeup.state === 'READY')
      : NO_WAKEUPS
    return rows.length > 0 ? [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : NO_WAKEUPS
  }, [query.data])
  return { ...query, pending }
}

export function useCancelSessionWakeup(sessionId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (wakeupId: string) => apiClient.delete<SessionWakeupDto>(
      `/sessions/${encodeURIComponent(sessionId)}/wakeups/${encodeURIComponent(wakeupId)}`,
    ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.sessions.wakeups(sessionId) }),
  })
}
