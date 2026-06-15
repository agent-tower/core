import { useEffect } from 'react'
import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { ServerEvents, type WorkspaceGitChangedPayload } from '@agent-tower/shared/socket'
import { queryKeys } from '@/hooks/query-keys'
import { useGitVisibilityStore, type VisibleGitContext } from '@/stores/git-visibility-store'
import { socketManager } from '../manager.js'

export function invalidateAllGitRealtimeQueries(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: queryKeys.git.all, refetchType: 'none' })
  queryClient.invalidateQueries({ queryKey: ['workspaces', 'gitStatus'], refetchType: 'none' })
  queryClient.invalidateQueries({ queryKey: ['workspaces', 'diff'], refetchType: 'none' })
}

function markWorkspaceGitQueriesStale(
  queryClient: QueryClient,
  payload: Partial<WorkspaceGitChangedPayload>,
) {
  if (payload.workingDir) {
    queryClient.invalidateQueries({
      queryKey: queryKeys.git.changes(payload.workingDir),
      refetchType: 'none',
    })
    queryClient.invalidateQueries({
      queryKey: queryKeys.git.log(payload.workingDir),
      refetchType: 'none',
    })
  }
  if (payload.workspaceId) {
    queryClient.invalidateQueries({
      queryKey: queryKeys.workspaces.gitStatus(payload.workspaceId),
      refetchType: 'none',
    })
  }
}

export function syncVisibleWorkspaceGitQueries(
  queryClient: QueryClient,
  payload?: Partial<WorkspaceGitChangedPayload> | null,
  visibleContext?: VisibleGitContext | null,
) {
  if (!payload?.workspaceId || !payload?.workingDir) {
    return
  }

  if (
    !visibleContext
    || visibleContext.workspaceId !== payload.workspaceId
    || visibleContext.workingDir !== payload.workingDir
  ) {
    markWorkspaceGitQueriesStale(queryClient, payload)
    return
  }

  if (visibleContext.tab === 'changes') {
    queryClient.invalidateQueries({ queryKey: queryKeys.git.changes(payload.workingDir) })
    queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.gitStatus(payload.workspaceId) })
    queryClient.invalidateQueries({
      queryKey: queryKeys.git.log(payload.workingDir),
      refetchType: 'none',
    })
    return
  }

  queryClient.invalidateQueries({ queryKey: queryKeys.git.log(payload.workingDir) })
  queryClient.invalidateQueries({
    queryKey: queryKeys.git.changes(payload.workingDir),
    refetchType: 'none',
  })
  queryClient.invalidateQueries({
    queryKey: queryKeys.workspaces.gitStatus(payload.workspaceId),
    refetchType: 'none',
  })
}

export function useWorkspaceGitRealtimeSync() {
  const queryClient = useQueryClient()
  const visibleContext = useGitVisibilityStore((state) => state.visibleContext)

  useEffect(() => {
    const socket = socketManager.connect()

    const handleConnect = () => {
      invalidateAllGitRealtimeQueries(queryClient)
      if (visibleContext) {
        syncVisibleWorkspaceGitQueries(queryClient, {
          workspaceId: visibleContext.workspaceId,
          workingDir: visibleContext.workingDir,
        }, visibleContext)
      }
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
