import { ClientEvents } from '@agent-tower/shared/socket'
import { socketManager } from './manager'

const taskSubscriptions = new Map<string, { count: number; release: () => void }>()
export function retainTaskSubscription(taskId: string) {
  const existing = taskSubscriptions.get(taskId)
  if (existing) existing.count++
  else {
    const socket = socketManager.connect()
    const subscribe = () => socket.emit(ClientEvents.SUBSCRIBE, { topic: 'task', id: taskId })
    socket.on('connect', subscribe)
    if (socket.connected) subscribe()
    taskSubscriptions.set(taskId, { count: 1, release: () => { socket.off('connect', subscribe); socket.emit(ClientEvents.UNSUBSCRIBE, { topic: 'task', id: taskId }) } })
  }
  return () => {
    const current = taskSubscriptions.get(taskId)
    if (current && --current.count === 0) { current.release(); taskSubscriptions.delete(taskId) }
  }
}
