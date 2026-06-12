import { useEffect } from 'react'
import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { ServerEvents, type WorkspaceGitChangedPayload } from '@agent-tower/shared/socket'
import { queryKeys } from '@/hooks/query-keys'
import { socketManager } from '../manager.js'

function isGitQueryForWorkingDir(queryKey: readonly unknown[], workingDir: string) {
  return queryKey[0] === 'git' && queryKey[2] === workingDir
}

export function invalidateAllGitRealtimeQueries(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: queryKeys.git.all })
  queryClient.invalidateQueries({ queryKey: ['workspaces', 'gitStatus'] })
  queryClient.invalidateQueries({ queryKey: ['workspaces', 'diff'] })
}

export function invalidateWorkspaceGitQueries(
  queryClient: QueryClient,
  payload?: Partial<WorkspaceGitChangedPayload> | null,
) {
  if (!payload?.workspaceId || !payload?.workingDir) {
    invalidateAllGitRealtimeQueries(queryClient)
    return
  }

  queryClient.invalidateQueries({
    predicate: (query) => isGitQueryForWorkingDir(query.queryKey, payload.workingDir!),
  })
  queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.gitStatus(payload.workspaceId) })
  queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.diff(payload.workspaceId) })
}

export function useWorkspaceGitRealtimeSync() {
  const queryClient = useQueryClient()

  useEffect(() => {
    const socket = socketManager.connect()

    const handleConnect = () => {
      invalidateAllGitRealtimeQueries(queryClient)
    }

    const handleWorkspaceGitChanged = (payload: WorkspaceGitChangedPayload) => {
      invalidateWorkspaceGitQueries(queryClient, payload)
    }

    socket.on('connect', handleConnect)
    socket.on(ServerEvents.WORKSPACE_GIT_CHANGED, handleWorkspaceGitChanged)

    return () => {
      socket.off('connect', handleConnect)
      socket.off(ServerEvents.WORKSPACE_GIT_CHANGED, handleWorkspaceGitChanged)
    }
  }, [queryClient])
}
