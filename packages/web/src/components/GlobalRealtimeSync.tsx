import { useTaskRealtimeSync } from '@/lib/socket/hooks/useTaskRealtimeSync'
import { useTeamRunRealtimeSync } from '@/lib/socket/hooks/useTeamRunRealtimeSync'
import { useWorkspaceGitRealtimeSync } from '@/lib/socket/hooks/useWorkspaceGitRealtimeSync'

export function GlobalRealtimeSync() {
  useTaskRealtimeSync()
  useTeamRunRealtimeSync()
  useWorkspaceGitRealtimeSync()
  return null
}
