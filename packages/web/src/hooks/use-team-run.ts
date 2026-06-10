import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AgentInvocation,
  MemberPreset,
  RoomMessage,
  StructuredMention,
  TeamRun,
  TeamRunMode,
  TeamMember,
  RoomMessageSenderType,
  RoomMessageKind,
  TeamTemplate,
  TeamMemberCapabilities,
  TeamMemberQueueManagementPolicy,
  WorkspacePolicy,
  TeamMemberSessionPolicy,
  TeamMemberTriggerPolicy,
  WorkRequest,
} from '@agent-tower/shared'
import { apiClient, ApiError } from '@/lib/api-client'
import { queryKeys } from './query-keys'

export const teamRunQueryKeys = {
  all: ['team-runs'] as const,
  memberPresets: ['member-presets'] as const,
  memberPresetDetail: (id: string) => ['member-presets', 'detail', id] as const,
  teamTemplates: ['team-templates'] as const,
  teamTemplateDetail: (id: string) => ['team-templates', 'detail', id] as const,
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

export function upsertRoomMessage(messages: RoomMessage[] | undefined, message: RoomMessage): RoomMessage[] {
  const currentMessages = messages ?? []
  const existingIndex = currentMessages.findIndex((item) => item.id === message.id)
  if (existingIndex >= 0) {
    return currentMessages.map((item, index) => index === existingIndex ? message : item)
  }
  return [...currentMessages, message]
}

function upsertTeamRunRoomMessage(teamRun: TeamRun | null | undefined, message: RoomMessage) {
  if (!teamRun || teamRun.id !== message.teamRunId) return teamRun
  return {
    ...teamRun,
    messages: upsertRoomMessage(teamRun.messages, message),
  }
}

export type CreateMemberPresetInput = {
  name: string
  aliases: string[]
  providerId: string
  rolePrompt: string
  capabilities: TeamMemberCapabilities
  workspacePolicy: WorkspacePolicy
  triggerPolicy: TeamMemberTriggerPolicy
  sessionPolicy: TeamMemberSessionPolicy
  queueManagementPolicy: TeamMemberQueueManagementPolicy
  avatar?: string | null
}

export type UpdateMemberPresetInput = Partial<CreateMemberPresetInput>

export type CreateTeamTemplateInput = {
  name: string
  memberPresetIds?: string[]
  members?: Array<{
    memberPresetId: string
    position?: number
  }>
}

export type UpdateTeamTemplateInput = Partial<CreateTeamTemplateInput>

export type CreateTaskTeamRunInput = {
  mode: TeamRunMode
  teamTemplateId?: string
  memberPresetIds?: string[]
}

export type TeamRunMemberSnapshotInput = {
  name: string
  aliases: string[]
  providerId: string
  rolePrompt: string
  capabilities: TeamMemberCapabilities
  workspacePolicy: WorkspacePolicy
  triggerPolicy: TeamMemberTriggerPolicy
  sessionPolicy: TeamMemberSessionPolicy
  queueManagementPolicy: TeamMemberQueueManagementPolicy
  avatar?: string | null
}

export type AddTeamRunMemberInput = {
  memberPresetId?: string
  member?: TeamRunMemberSnapshotInput
}

export type PatchTeamRunMemberInput = Partial<TeamRunMemberSnapshotInput>

export type RemoveTeamRunMemberInput = {
  memberId: string
  stopActive?: boolean
  cancelQueued?: boolean
}

export type StopMemberWorkInput = {
  memberId: string
  cancelQueued?: boolean
}

export type CancelWorkRequestInput = {
  workRequestId: string
  requesterMemberId: string
}

type ApproveWorkRequestResponse = {
  workRequest: WorkRequest
  startedInvocations: AgentInvocation[]
}

type StopMemberWorkResponse = {
  stoppedSessionIds: string[]
  cancelledInvocationIds: string[]
  cancelledWorkRequestIds: string[]
  startedInvocations: AgentInvocation[]
}

type RemoveTeamRunMemberResponse = {
  member: TeamMember
  stoppedSessionIds: string[]
  cancelledInvocationIds: string[]
  cancelledWorkRequestIds: string[]
  startedInvocations: AgentInvocation[]
}

function getCachedTeamRunTaskId(queryClient: ReturnType<typeof useQueryClient>, teamRunId: string) {
  const detail = queryClient.getQueryData<TeamRun | null>(teamRunQueryKeys.detail(teamRunId))
  if (detail?.taskId) return detail.taskId

  const cachedTeamRuns = queryClient.getQueriesData<TeamRun | null>({ queryKey: teamRunQueryKeys.all })
  for (const [, teamRun] of cachedTeamRuns) {
    if (teamRun?.id === teamRunId && teamRun.taskId) {
      return teamRun.taskId
    }
  }

  return undefined
}

function invalidateTeamRunActionQueries(queryClient: ReturnType<typeof useQueryClient>, teamRunId: string) {
  const taskId = getCachedTeamRunTaskId(queryClient, teamRunId)

  void queryClient.invalidateQueries({ queryKey: teamRunQueryKeys.all })
  void queryClient.invalidateQueries({ queryKey: teamRunQueryKeys.detail(teamRunId) })
  void queryClient.invalidateQueries({ queryKey: teamRunQueryKeys.workRequests(teamRunId) })
  void queryClient.invalidateQueries({ queryKey: teamRunQueryKeys.invocations(teamRunId) })
  void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all })
  void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all })

  if (taskId) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) })
    void queryClient.invalidateQueries({ queryKey: teamRunQueryKeys.task(taskId) })
    void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.list(taskId) })
  }
}

/** 获取所有 MemberPreset。 */
export function useMemberPresets() {
  return useQuery({
    queryKey: teamRunQueryKeys.memberPresets,
    queryFn: () => apiClient.get<MemberPreset[]>('/member-presets'),
  })
}

/** 获取单个 MemberPreset 详情。 */
export function useMemberPreset(id: string) {
  return useQuery({
    queryKey: teamRunQueryKeys.memberPresetDetail(id),
    queryFn: () => apiClient.get<MemberPreset>(`/member-presets/${id}`),
    enabled: !!id,
  })
}

/** 创建 MemberPreset。 */
export function useCreateMemberPreset() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateMemberPresetInput) =>
      apiClient.post<MemberPreset>('/member-presets', input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: teamRunQueryKeys.memberPresets })
      queryClient.invalidateQueries({ queryKey: teamRunQueryKeys.teamTemplates })
    },
  })
}

/** 更新 MemberPreset。 */
export function useUpdateMemberPreset() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateMemberPresetInput }) =>
      apiClient.patch<MemberPreset>(`/member-presets/${id}`, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: teamRunQueryKeys.memberPresets })
      queryClient.invalidateQueries({ queryKey: teamRunQueryKeys.memberPresetDetail(variables.id) })
      queryClient.invalidateQueries({ queryKey: teamRunQueryKeys.teamTemplates })
    },
  })
}

/** 删除 MemberPreset。 */
export function useDeleteMemberPreset() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apiClient.delete(`/member-presets/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: teamRunQueryKeys.memberPresets })
      queryClient.invalidateQueries({ queryKey: teamRunQueryKeys.teamTemplates })
    },
  })
}

/** 获取所有 TeamTemplate。 */
export function useTeamTemplates() {
  return useQuery({
    queryKey: teamRunQueryKeys.teamTemplates,
    queryFn: () => apiClient.get<TeamTemplate[]>('/team-templates'),
  })
}

/** 获取单个 TeamTemplate 详情。 */
export function useTeamTemplate(id: string) {
  return useQuery({
    queryKey: teamRunQueryKeys.teamTemplateDetail(id),
    queryFn: () => apiClient.get<TeamTemplate>(`/team-templates/${id}`),
    enabled: !!id,
  })
}

/** 创建 TeamTemplate。 */
export function useCreateTeamTemplate() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateTeamTemplateInput) =>
      apiClient.post<TeamTemplate>('/team-templates', input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: teamRunQueryKeys.teamTemplates })
    },
  })
}

/** 更新 TeamTemplate。 */
export function useUpdateTeamTemplate() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateTeamTemplateInput }) =>
      apiClient.patch<TeamTemplate>(`/team-templates/${id}`, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: teamRunQueryKeys.teamTemplates })
      queryClient.invalidateQueries({ queryKey: teamRunQueryKeys.teamTemplateDetail(variables.id) })
    },
  })
}

/** 删除 TeamTemplate。 */
export function useDeleteTeamTemplate() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apiClient.delete(`/team-templates/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: teamRunQueryKeys.teamTemplates })
    },
  })
}

/** 为 task 创建 TeamRun。 */
export function useCreateTaskTeamRun() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ taskId, ...input }: CreateTaskTeamRunInput & { taskId: string }) =>
      apiClient.post<TeamRun>(`/tasks/${taskId}/team-runs`, input),
    onSuccess: (teamRun, variables) => {
      queryClient.setQueryData(teamRunQueryKeys.task(variables.taskId), teamRun)
      queryClient.setQueryData(teamRunQueryKeys.detail(teamRun.id), teamRun)
      queryClient.setQueryData(teamRunQueryKeys.messages(teamRun.id), teamRun.messages ?? [])
      queryClient.setQueryData(teamRunQueryKeys.workRequests(teamRun.id), teamRun.workRequests ?? [])
      queryClient.setQueryData(teamRunQueryKeys.invocations(teamRun.id), teamRun.invocations ?? [])

      void queryClient.invalidateQueries({ queryKey: teamRunQueryKeys.task(variables.taskId) })
      void queryClient.invalidateQueries({ queryKey: teamRunQueryKeys.all })
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all })
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(variables.taskId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all })
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.list(variables.taskId) })
    },
    onError: (_error, variables) => {
      void queryClient.invalidateQueries({ queryKey: teamRunQueryKeys.task(variables.taskId) })
      void queryClient.invalidateQueries({ queryKey: teamRunQueryKeys.all })
    },
  })
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
    onSuccess: (message) => {
      queryClient.setQueryData<RoomMessage[]>(
        teamRunQueryKeys.messages(teamRunId),
        (current) => upsertRoomMessage(current, message),
      )
      queryClient.setQueryData<TeamRun | null>(
        teamRunQueryKeys.detail(teamRunId),
        (current) => upsertTeamRunRoomMessage(current, message),
      )

      const taskId = getCachedTeamRunTaskId(queryClient, teamRunId)
      if (taskId) {
        queryClient.setQueryData<TeamRun | null>(
          teamRunQueryKeys.task(taskId),
          (current) => upsertTeamRunRoomMessage(current, message),
        )
      }

      queryClient.invalidateQueries({ queryKey: teamRunQueryKeys.all })
      queryClient.invalidateQueries({ queryKey: ['tasks'] })
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all })
    },
  })
}

/** Add a member to a running TeamRun. */
export function useAddTeamRunMember(teamRunId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (input: AddTeamRunMemberInput) =>
      apiClient.post<TeamMember>(`/team-runs/${teamRunId}/members`, input),
    onSuccess: () => {
      invalidateTeamRunActionQueries(queryClient, teamRunId)
    },
  })
}

/** Patch a TeamRun member snapshot. */
export function usePatchTeamRunMember(teamRunId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ memberId, data }: { memberId: string; data: PatchTeamRunMemberInput }) =>
      apiClient.patch<TeamMember>(`/team-runs/${teamRunId}/members/${memberId}`, data),
    onSuccess: () => {
      invalidateTeamRunActionQueries(queryClient, teamRunId)
    },
  })
}

/** Soft-remove a TeamRun member and optionally stop active work/cancel queue. */
export function useRemoveTeamRunMember(teamRunId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ memberId, stopActive = true, cancelQueued = true }: RemoveTeamRunMemberInput) =>
      apiClient.post<RemoveTeamRunMemberResponse>(`/team-runs/${teamRunId}/members/${memberId}/remove`, {
        stopActive,
        cancelQueued,
      }),
    onSuccess: () => {
      invalidateTeamRunActionQueries(queryClient, teamRunId)
    },
  })
}

/** Approve a pending TeamRun WorkRequest. */
export function useApproveWorkRequest(teamRunId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (workRequestId: string) =>
      apiClient.post<ApproveWorkRequestResponse>(`/team-runs/work-requests/${workRequestId}/approve`),
    onSuccess: () => {
      invalidateTeamRunActionQueries(queryClient, teamRunId)
    },
  })
}

/** Reject a pending TeamRun WorkRequest. */
export function useRejectWorkRequest(teamRunId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (workRequestId: string) =>
      apiClient.post<WorkRequest>(`/team-runs/work-requests/${workRequestId}/reject`),
    onSuccess: () => {
      invalidateTeamRunActionQueries(queryClient, teamRunId)
    },
  })
}

/** Cancel a pending or queued TeamRun WorkRequest. */
export function useCancelWorkRequest(teamRunId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ workRequestId, requesterMemberId }: CancelWorkRequestInput) =>
      apiClient.post<WorkRequest>(`/team-runs/work-requests/${workRequestId}/cancel`, {
        teamRunId,
        requesterMemberId,
      }),
    onSuccess: () => {
      invalidateTeamRunActionQueries(queryClient, teamRunId)
    },
  })
}

/** Stop a running TeamRun member session. */
export function useStopMemberWork(teamRunId: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: ({ memberId, cancelQueued }: StopMemberWorkInput) =>
      apiClient.post<StopMemberWorkResponse>(`/team-runs/${teamRunId}/members/${memberId}/stop`, {
        cancelQueued,
      }),
    onSuccess: () => {
      invalidateTeamRunActionQueries(queryClient, teamRunId)
    },
  })
}
