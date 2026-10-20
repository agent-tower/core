import type { MessageDelivery } from '@agent-tower/shared'
import { type LogEntry, LogType } from '@agent-tower/shared/log-adapter'

/** Delivery identity wins over timing/content; only missing user rows are projected. */
export function mergeDeliveryLogs(logs: LogEntry[], deliveries: MessageDelivery[]): LogEntry[] {
  const known = new Set(logs.flatMap(log => log.deliveryId ? [log.deliveryId] : []))
  const missing = deliveries.filter(item => item.state !== 'CANCELLED' && !known.has(item.id))
    .map((item): LogEntry => ({ id: `user:${item.id}`, deliveryId: item.id, timestamp: Date.parse(item.createdAt), type: LogType.User, content: item.originalText }))
  if (!missing.length) return logs
  return [...logs, ...missing].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))
}
