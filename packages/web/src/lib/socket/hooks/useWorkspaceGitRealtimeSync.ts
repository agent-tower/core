import { useEffect } from 'react'
import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { ServerEvents, type WorkspaceGitChangedPayload } from '@agent-tower/shared/socket'
import { queryKeys } from '@/hooks/query-keys'
import { useGitVisibilityStore, type VisibleGitContext } from '@/stores/git-visibility-store'
import { socketManager } from '../manager.js'

export function invalidateAllGitRealtimeQueries(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: queryKeys.git.all })
  queryClient.invalidateQueries({ queryKey: ['workspaces', 'gitStatus'] })
  queryClient.invalidateQueries({ queryKey: ['workspaces', 'diff'] })
}

export function syncVisibleWorkspaceGitQueries(
  queryClient: QueryClient,
  payload?: Partial<WorkspaceGitChangedPayload> | null,
  visibleContext?: VisibleGitContext | null,
) {
  if (!payload?.workspaceId || !payload?.workingDir || !visibleContext) {
    return
  }

  if (
    visibleContext.workspaceId !== payload.workspaceId
    || visibleContext.workingDir !== payload.workingDir
  ) {
    return
  }

  if (visibleContext.tab === 'changes') {
    queryClient.invalidateQueries({ queryKey: queryKeys.git.changes(payload.workingDir) })
    queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.gitStatus(payload.workspaceId) })
    return
  }

  queryClient.invalidateQueries({ queryKey: queryKeys.git.log(payload.workingDir) })
}

export function useWorkspaceGitRealtimeSync() {
  const queryClient = useQueryClient()
  const visibleContext = useGitVisibilityStore((state) => state.visibleContext)

  useEffect(() => {
    const socket = socketManager.connect()

    const handleConnect = () => {
      invalidateAllGitRealtimeQueries(queryClient)
    }

    const handleWorkspaceGitChanged = (payload: WorkspaceGitChangedPayload) => {
      syncVisibleWorkspaceGitQueries(queryClient, payload, visibleContext)
    }

    socket.on('connect', handleConnect)
    socket.on(ServerEvents.WORKSPACE_GIT_CHANGED, handleWorkspaceGitChanged)

    return () => {
      socket.off('connect', handleConnect)
      socket.off(ServerEvents.WORKSPACE_GIT_CHANGED, handleWorkspaceGitChanged)
    }
  }, [queryClient, visibleContext])
}
