import type { InfiniteData, QueryClient } from '@tanstack/react-query'
import { isSessionMessageDelivery, type MessageDelivery, type MessageDeliveryPage } from '@agent-tower/shared'

export type DeliveryData = InfiniteData<MessageDeliveryPage, string>
/** A late REST response may never roll an operation back across its CAS revision. */
export function mergeDeliveryPages(previous: DeliveryData | undefined, incoming: DeliveryData): DeliveryData {
  const known = new Map(previous?.pages.flatMap(page => page.items.map(item => [item.id, item] as const)))
  return { ...incoming, pages: incoming.pages.map(page => ({ ...page, items: page.items.map(item => {
    const old = known.get(item.id)
    return old && old.revision > item.revision ? old : item
  }) })) }
}
export function applyDelivery(previous: DeliveryData | undefined, delivery: MessageDelivery): DeliveryData | undefined {
  if (!previous) return previous
  return mergeDeliveryPages(previous, { ...previous, pages: previous.pages.map(page => ({ ...page, items: page.items.map(item => item.id === delivery.id ? delivery : item) })) })
}

export function cacheDelivery(client: QueryClient, delivery: MessageDelivery) {
  const key = ['message-deliveries', isSessionMessageDelivery(delivery) ? delivery.sessionId : `task:${delivery.destination.taskId}`]
  client.setQueriesData<DeliveryData>({ queryKey: key }, previous => applyDelivery(previous, delivery))
  if (delivery.state !== 'CANCELLED') {
    client.setQueryData<DeliveryData>([...key, delivery.state === 'SENT' ? 'sent' : 'pending'], previous => {
      if (!previous) return { pages: [{ items: [delivery], nextCursor: null }], pageParams: [''] }
      if (previous.pages.some(page => page.items.some(item => item.id === delivery.id))) return applyDelivery(previous, delivery)
      return { ...previous, pages: previous.pages.map((page, index) => index ? page : { ...page, items: [...page.items, delivery].sort((a, b) => a.sequence - b.sequence) }) }
    })
  }
}
