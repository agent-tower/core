import { useTaskRealtimeSync } from '@/lib/socket/hooks/useTaskRealtimeSync'

export function GlobalRealtimeSync() {
  useTaskRealtimeSync()
  return null
}
