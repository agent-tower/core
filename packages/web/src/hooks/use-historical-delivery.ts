import { useQuery } from '@tanstack/react-query'
import type { MessageDelivery } from '@agent-tower/shared'
import { apiClient } from '@/lib/api-client'

/**
 * Deliveries that a log's user messages refer to but the session's delivery
 * lists do not carry: team inputs, cancelled operations and sent ones older
 * than the latest page. Rows that mount in the same tick share one
 * `GET /message-deliveries/by-ids` request instead of sending one each.
 */

/** Server limit for one `GET /message-deliveries/by-ids` request. */
const MAX_IDS_PER_REQUEST = 100

interface PendingDelivery {
  id: string
  resolve: (delivery: MessageDelivery | null) => void
  reject: (error: unknown) => void
}

let queue: PendingDelivery[] = []

function flush(): void {
  const pending = queue
  queue = []
  const ids = [...new Set(pending.map((item) => item.id))]
  for (let start = 0; start < ids.length; start += MAX_IDS_PER_REQUEST) {
    const batch = new Set(ids.slice(start, start + MAX_IDS_PER_REQUEST))
    const waiting = pending.filter((item) => batch.has(item.id))
    apiClient.get<{ items: MessageDelivery[] }>('/message-deliveries/by-ids', { params: { ids: [...batch].join(',') } })
      .then(({ items }) => {
        const byId = new Map(items.map((item) => [item.id, item]))
        // The server leaves out an ID it would refuse to show; that message gets no feedback.
        for (const item of waiting) item.resolve(byId.get(item.id) ?? null)
      })
      // Also catches a malformed answer, so no row waits forever.
      .catch((error: unknown) => {
        for (const item of waiting) item.reject(error)
      })
  }
}

export function loadHistoricalDelivery(id: string): Promise<MessageDelivery | null> {
  return new Promise((resolve, reject) => {
    if (!queue.length) setTimeout(flush, 0)
    queue.push({ id, resolve, reject })
  })
}

export function useHistoricalDelivery(id: string) {
  return useQuery({
    queryKey: ['message-delivery', id],
    queryFn: () => loadHistoricalDelivery(id),
    staleTime: Infinity,
  })
}
