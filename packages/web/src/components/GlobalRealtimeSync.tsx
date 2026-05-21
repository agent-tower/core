import { useTaskRealtimeSync } from '@/lib/socket/hooks/useTaskRealtimeSync'
import { useTeamRunRealtimeSync } from '@/lib/socket/hooks/useTeamRunRealtimeSync'

export function GlobalRealtimeSync() {
  useTaskRealtimeSync()
  useTeamRunRealtimeSync()
  return null
}
