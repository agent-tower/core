import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { RoomMessage, StructuredMention, TeamRun, RoomMessageSenderType, RoomMessageKind } from '@agent-tower/shared'
import { apiClient, ApiError } from '@/lib/api-client'
import { queryKeys } from './query-keys'

export const teamRunQueryKeys = {
  all: ['team-runs'] as const,
  task: (taskId: string) => ['team-runs', 'task', taskId] as const,
  detail: (teamRunId: string) => ['team-runs', 'detail', teamRunId] as const,
  messages: (teamRunId: string) => ['team-runs', 'messages', teamRunId] as const,
  workRequests: (teamRunId: string) => ['team-runs', 'work-requests', teamRunId] as const,
  invocations: (teamRunId: string) => ['team-runs', 'invocations', teamRunId] as const,
}

const TEAM_RUN_REFRESH_INTERVAL_MS = 5000

export type PostRoomMessageInput = {
  content: string
  mentions?: StructuredMention[]
  attachmentIds?: string[]
  artifactRefs?: string[]
  senderType?: RoomMessageSenderType
  senderId?: string | null
  senderInvocationId?: string | null
  kind?: RoomMessageKind
}

/** 获取 task 对应的 TeamRun；不存在时返回 null，不把 404 当成错误噪声。 */
export function useTaskTeamRun(taskId: string) {
  return useQuery({
    queryKey: teamRunQueryKeys.task(taskId),
    queryFn: async () => {
      try {
        return await apiClient.get<TeamRun>(`/tasks/${taskId}/team-run`)
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          return null
        }
        throw error
      }
    },
    enabled: !!taskId,
    retry: false,
    refetchInterval: (query) => query.state.data ? TEAM_RUN_REFRESH_INTERVAL_MS : false,
  })
}

/** 获取 TeamRun 详情。 */
export function useTeamRun(teamRunId: string) {
  return useQuery({
    queryKey: teamRunQueryKeys.detail(teamRunId),
    queryFn: async () => {
      try {
        return await apiClient.get<TeamRun>(`/team-runs/${teamRunId}`)
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          return null
        }
        throw error
      }
    },
    enabled: !!teamRunId,
    retry: false,
    refetchInterval: TEAM_RUN_REFRESH_INTERVAL_MS,
  })
}

/** 获取 TeamRun 的 RoomMessage 列表。 */
export function useRoomMessages(teamRunId: string) {
  return useQuery({
    queryKey: teamRunQueryKeys.messages(teamRunId),
    queryFn: async () => {
      try {
        return await apiClient.get<RoomMessage[]>(`/team-runs/${teamRunId}/messages`)
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          return []
        }
        throw error
      }
    },
    enabled: !!teamRunId,
    retry: false,
    refetchInterval: TEAM_RUN_REFRESH_INTERVAL_MS,
  })
}

/** 发送 Team Room 消息。 */
export function usePostRoomMessage(teamRunId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: PostRoomMessageInput) =>
      apiClient.post<RoomMessage>(`/team-runs/${teamRunId}/messages`, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: teamRunQueryKeys.all })
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all })
    },
  })
}
