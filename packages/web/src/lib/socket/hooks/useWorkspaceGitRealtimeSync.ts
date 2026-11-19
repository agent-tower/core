import { useEffect } from 'react'
import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { ServerEvents, type WorkspaceGitChangedPayload } from '@agent-tower/shared/socket'
import { queryKeys } from '@/hooks/query-keys'
import { socketManager } from '../manager.js'
import { getWorkspaceGitSubscriptions } from '../workspace-git-subscriptions'

export function invalidateAllGitRealtimeQueries(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: queryKeys.git.all, refetchType: 'none' })
  queryClient.invalidateQueries({ queryKey: ['workspaces', 'gitStatus'], refetchType: 'none' })
  queryClient.invalidateQueries({ queryKey: ['workspaces', 'diff'], refetchType: 'none' })
}

/**
 * Applies a `workspace:git_changed` hint. A base-branch change refreshes workspace metadata and the
 * workspace diff; file diffs follow the version tokens of the new change list. Git queries of a
 * workspace with a live subscription are left to the pushed state; others refetch where they are
 * shown and are marked stale elsewhere.
 */
export function syncWorkspaceGitChangedQueries(
  queryClient: QueryClient,
  payload: Partial<WorkspaceGitChangedPayload> | null | undefined,
  isLive: (workspaceId: string) => boolean,
) {
  if (!payload?.workspaceId || !payload?.workingDir) {
    return
  }

  if (payload.reason === 'base-branch') {
    queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.detail(payload.workspaceId) })
    if (payload.taskId) queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.list(payload.taskId) })
    if (payload.projectId) queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.projectBranches(payload.projectId) })
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all })
    queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.diff(payload.workspaceId) })
  }

  if (isLive(payload.workspaceId)) {
    return
  }

  queryClient.invalidateQueries({ queryKey: queryKeys.git.changes(payload.workingDir) })
  queryClient.invalidateQueries({ queryKey: queryKeys.git.log(payload.workingDir) })
  queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.gitStatus(payload.workspaceId) })
}

export function useWorkspaceGitRealtimeSync() {
  const queryClient = useQueryClient()

  useEffect(() => {
    const socket = socketManager.connect()
    const subscriptions = getWorkspaceGitSubscriptions(queryClient)

    // Reconnect fallback: workspaces with a live subscription get their current state from the
    // subscription manager's new acknowledgement; everything else reloads when next shown.
    const handleConnect = () => {
      invalidateAllGitRealtimeQueries(queryClient)
      for (const key of ['list', 'detail', 'project-branches']) {
        queryClient.invalidateQueries({ queryKey: ['workspaces', key] })
      }
    }

    const handleWorkspaceGitChanged = (payload: WorkspaceGitChangedPayload) => {
      syncWorkspaceGitChangedQueries(queryClient, payload, (workspaceId) => subscriptions.coversWorkspace(workspaceId))
    }

    socket.on('connect', handleConnect)
    socket.on(ServerEvents.WORKSPACE_GIT_CHANGED, handleWorkspaceGitChanged)

    return () => {
      socket.off('connect', handleConnect)
      socket.off(ServerEvents.WORKSPACE_GIT_CHANGED, handleWorkspaceGitChanged)
    }
  }, [queryClient])
}
