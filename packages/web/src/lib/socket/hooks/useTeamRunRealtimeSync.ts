import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  ServerEvents,
  type TeamRunInvalidatedPayload,
  type TeamRunInvalidationScope,
} from '@agent-tower/shared/socket'
import { queryKeys } from '@/hooks/query-keys'
import { teamRunQueryKeys } from '@/hooks/use-team-run'
import { socketManager } from '../manager.js'

function hasScope(payload: TeamRunInvalidatedPayload, scope: TeamRunInvalidationScope) {
  return payload.scopes.includes(scope)
}

export function useTeamRunRealtimeSync() {
  const queryClient = useQueryClient()

  useEffect(() => {
    const socket = socketManager.connect()

    const invalidateTeamRunQueries = (payload?: TeamRunInvalidatedPayload) => {
      if (!payload) {
        void queryClient.invalidateQueries({ queryKey: teamRunQueryKeys.all })
        return
      }

      void queryClient.invalidateQueries({ queryKey: teamRunQueryKeys.detail(payload.teamRunId) })

      if (hasScope(payload, 'team-run') || hasScope(payload, 'team-members')) {
        void queryClient.invalidateQueries({ queryKey: teamRunQueryKeys.all })
      }

      if (hasScope(payload, 'room-messages')) {
        void queryClient.invalidateQueries({ queryKey: teamRunQueryKeys.messages(payload.teamRunId) })
      }

      if (hasScope(payload, 'work-requests')) {
        void queryClient.invalidateQueries({ queryKey: teamRunQueryKeys.workRequests(payload.teamRunId) })
      }

      if (hasScope(payload, 'agent-invocations')) {
        void queryClient.invalidateQueries({ queryKey: teamRunQueryKeys.invocations(payload.teamRunId) })
      }

      if (payload.taskId) {
        void queryClient.invalidateQueries({ queryKey: teamRunQueryKeys.task(payload.taskId) })
      }

      if (payload.taskId && (hasScope(payload, 'task') || hasScope(payload, 'team-run'))) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(payload.taskId) })
      }

      if (payload.projectId && (hasScope(payload, 'task') || hasScope(payload, 'team-run'))) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.list(payload.projectId) })
        void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.boardAll })
      }

      if (hasScope(payload, 'workspaces')) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all })
        if (payload.taskId) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.list(payload.taskId) })
        }
      }
    }

    const handleReconnect = () => invalidateTeamRunQueries()
    const handleTeamRunInvalidated = (payload: TeamRunInvalidatedPayload) => invalidateTeamRunQueries(payload)

    socket.on('connect', handleReconnect)
    socket.on(ServerEvents.TEAM_RUN_INVALIDATED, handleTeamRunInvalidated)

    return () => {
      socket.off('connect', handleReconnect)
      socket.off(ServerEvents.TEAM_RUN_INVALIDATED, handleTeamRunInvalidated)
    }
  }, [queryClient])
}
