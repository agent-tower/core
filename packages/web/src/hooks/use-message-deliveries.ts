import { retainTaskSubscription } from '@/lib/socket/task-subscription'
import { useEffect } from 'react'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { isSessionMessageDelivery, type MessageDelivery, type MessageDeliveryAction, type MessageDeliveryPage, type MessageDeliverySubmission } from '@agent-tower/shared'
import { ServerEvents } from '@agent-tower/shared/socket'
import { apiClient } from '@/lib/api-client'
import { socketManager } from '@/lib/socket/manager'
import { cacheDelivery, mergeDeliveryPages, type DeliveryData } from './delivery-cache'
import { userSubmission } from './user-submission'
import { queryKeys } from './query-keys'

const STOP_AND_SEND_REQUEST_TIMEOUT_MS = 45_000

export const deliveryKey = (sessionId: string) => ['message-deliveries', sessionId] as const
export function useMessageDeliveries(sessionId: string, filter: 'pending' | 'sent' = 'pending', scopeType: 'SESSION' | 'TEAM_TASK' = 'SESSION') {
  const client = useQueryClient()
  const query = useInfiniteQuery({
    queryKey: [...deliveryKey(sessionId), filter],
    structuralSharing: (oldData, newData) => mergeDeliveryPages(oldData as DeliveryData | undefined, newData as DeliveryData),
    initialPageParam: '',
    queryFn: async ({ pageParam }) => {
      const page = await apiClient.get<MessageDeliveryPage>('/message-deliveries', { params: { scopeType, scopeId: scopeType === 'TEAM_TASK' ? sessionId.replace(/^task:/, '') : sessionId, filter, ...(pageParam ? { cursor: pageParam } : {}) } })
      if (filter !== 'pending' || pageParam) return page
      // A pending operation can disappear before the independently polled sent page arrives.
      // Resolve that transition through its authoritative detail before dropping the bubble.
      const previous = client.getQueryData<DeliveryData>([...deliveryKey(sessionId), 'pending'])
      const visible = new Set(page.items.map(item => item.id))
      const disappeared = previous?.pages.flatMap(p => p.items).filter(item => !['SENT', 'CANCELLED'].includes(item.state) && !visible.has(item.id)) ?? []
      const resolved = await Promise.all(disappeared.map(item => apiClient.get<MessageDelivery>(`/message-deliveries/${encodeURIComponent(item.id)}`)))
      for (const delivery of resolved) cacheDelivery(client, delivery)
      return { ...page, items: [...page.items, ...resolved] }
    },
    getNextPageParam: page => page.nextCursor ?? undefined,
    enabled: !!sessionId,
    refetchInterval: query => query.state.data?.pages.some(page => page.items.some(item => !['SENT', 'CANCELLED'].includes(item.state))) ? 1000 : 5000,
  })
  useEffect(() => {
    if (scopeType === 'TEAM_TASK' && query.dataUpdatedAt) void client.invalidateQueries({ queryKey: ['team-runs', 'task', sessionId.replace(/^task:/, '')] })
  }, [client, scopeType, sessionId, query.dataUpdatedAt])
  useEffect(() => {
    if (!sessionId) return
    const release = scopeType === 'TEAM_TASK' ? retainTaskSubscription(sessionId.replace(/^task:/, '')) : undefined
    const socket = socketManager.connect()
    const refresh = () => { void client.invalidateQueries({ queryKey: deliveryKey(sessionId) }) }
    const onDelivery = (payload: { sessionId?: string; taskId?: string }) => { if (payload.sessionId === sessionId || payload.taskId && `task:${payload.taskId}` === sessionId) refresh() }
    socket.on(ServerEvents.MESSAGE_DELIVERY_INVALIDATED, onDelivery)
    socket.on('connect', refresh)
    return () => { release?.(); socket.off(ServerEvents.MESSAGE_DELIVERY_INVALIDATED, onDelivery); socket.off('connect', refresh) }
  }, [sessionId, scopeType, client])
  return query
}
export function useDeliveryAction(sessionId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ delivery, action }: { delivery: MessageDelivery; action: MessageDeliveryAction }) => {
      const input = { action, expectedRevision: delivery.revision }
      return userSubmission(`action:${delivery.id}`, input, body => {
        const { clientSubmissionId, ...rest } = body as typeof input & { clientSubmissionId: string }
        return apiClient.post<MessageDeliverySubmission>(`/message-deliveries/${delivery.id}/actions`, { ...rest, actionId: clientSubmissionId }, action === 'stop_and_send'
          ? { signal: AbortSignal.timeout(STOP_AND_SEND_REQUEST_TIMEOUT_MS) }
          : undefined)
      })
    },
    onSuccess: result => cacheDelivery(client, result.delivery),
    onSettled: (_result, _error, { delivery, action }) => {
      const refreshes = [client.invalidateQueries({ queryKey: deliveryKey(sessionId) })]
      if (action === 'stop_and_send' && isSessionMessageDelivery(delivery)) {
        refreshes.push(
          client.invalidateQueries({ queryKey: queryKeys.sessions.detail(delivery.sessionId) }),
          client.invalidateQueries({ queryKey: queryKeys.sessions.runtime(delivery.sessionId) }),
          client.invalidateQueries({ queryKey: queryKeys.sessions.wakeups(delivery.sessionId) }),
        )
        if (delivery.origin === 'CONVERSATION') refreshes.push(client.invalidateQueries({ queryKey: queryKeys.conversations.all }))
        else refreshes.push(
          client.invalidateQueries({ queryKey: queryKeys.workspaces.all }),
          client.invalidateQueries({ queryKey: queryKeys.tasks.all }),
        )
      }
      // A failed stop must release its button even if a recovery GET is slow.
      // The queries keep refreshing independently and REST remains authoritative.
      if (action === 'stop_and_send') void Promise.allSettled(refreshes)
      else return Promise.allSettled(refreshes)
    },
  })
}
