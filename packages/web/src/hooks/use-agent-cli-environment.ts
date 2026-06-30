import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { queryKeys } from './query-keys'
import type {
  AgentCliCreateInstallTaskResponse,
  AgentCliEnvironmentStatus,
  AgentCliInstallLogResponse,
  AgentCliInstallPreview,
  AgentCliInstallTask,
  AgentCliPublicInstallManifestItem,
  AgentCliToolId,
} from '@agent-tower/shared'

export function useAgentCliManifest() {
  return useQuery({
    queryKey: queryKeys.agentCli.manifest,
    queryFn: () => apiClient.get<AgentCliPublicInstallManifestItem[]>('/agent-cli/manifest'),
  })
}

export function useAgentCliStatus() {
  return useQuery({
    queryKey: queryKeys.agentCli.status,
    queryFn: () => apiClient.get<AgentCliEnvironmentStatus>('/agent-cli/status'),
  })
}

export function useRefreshAgentCliStatus() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => apiClient.post<AgentCliEnvironmentStatus>('/agent-cli/status/refresh'),
    onSuccess: (status) => {
      queryClient.setQueryData(queryKeys.agentCli.status, status)
    },
  })
}

export function useCreateAgentCliInstallPreview() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (toolId: AgentCliToolId) =>
      apiClient.post<AgentCliInstallPreview>('/agent-cli/install-previews', { toolId }),
    onSuccess: (preview) => {
      queryClient.setQueryData(queryKeys.agentCli.preview(preview.id), preview)
    },
  })
}

export function useAgentCliInstallTask(taskId: string | null, enabled = true) {
  return useQuery({
    queryKey: taskId ? queryKeys.agentCli.task(taskId) : ['agent-cli', 'task', null],
    queryFn: () => apiClient.get<AgentCliInstallTask>(`/agent-cli/install-tasks/${taskId}`),
    enabled: !!taskId && enabled,
    refetchInterval: (query) => {
      const status = query.state.data?.status
      return status === 'running' || status === 'verifying' || status === 'cancelling'
        ? 1000
        : false
    },
  })
}

export function useAgentCliInstallLogs(taskId: string | null, enabled = true) {
  return useQuery({
    queryKey: taskId ? queryKeys.agentCli.logs(taskId) : ['agent-cli', 'logs', null],
    queryFn: () => apiClient.get<AgentCliInstallLogResponse>(`/agent-cli/install-tasks/${taskId}/logs`),
    enabled: !!taskId && enabled,
    refetchInterval: enabled && taskId ? 1000 : false,
  })
}

export function useCreateAgentCliInstallTask() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (previewId: string) =>
      apiClient.post<AgentCliCreateInstallTaskResponse>('/agent-cli/install-tasks', { previewId }),
    onSuccess: ({ task }) => {
      queryClient.setQueryData(queryKeys.agentCli.task(task.id), task)
      queryClient.invalidateQueries({ queryKey: queryKeys.agentCli.status })
    },
  })
}

export function useCancelAgentCliInstallTask() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (taskId: string) =>
      apiClient.post<AgentCliInstallTask>(`/agent-cli/install-tasks/${taskId}/cancel`),
    onSuccess: (task) => {
      queryClient.setQueryData(queryKeys.agentCli.task(task.id), task)
    },
  })
}
