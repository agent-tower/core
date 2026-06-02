import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { queryKeys } from './query-keys'

export type TunnelHealthStatus =
  | 'stopped'
  | 'starting'
  | 'checking'
  | 'healthy'
  | 'degraded'
  | 'localUnhealthy'
  | 'exited'
  | 'error'
  | 'linkReplaced'

export interface TunnelStatus {
  running: boolean
  status: TunnelHealthStatus
  url: string | null
  startedAt: string | null
  targetPort: number | null
  generation: number
  lastCheckedAt: string | null
  lastHealthyAt: string | null
  lastRemoteError: string | null
  lastLocalError: string | null
  lastExitAt: string | null
  lastExitCode: number | null
  lastExitSignal: string | null
  lastError: string | null
  lastProcessOutput: string | null
  consecutiveRemoteFailures: number
  consecutiveLocalFailures: number
  canRegenerate: boolean
  token?: string
  shareableUrl?: string
}

interface TunnelStartResponse {
  url: string
  token: string
  shareableUrl: string
}

function currentPort() {
  return parseInt(window.location.port || (window.location.protocol === 'https:' ? '443' : '80'), 10)
}

export function useTunnelStatus() {
  return useQuery({
    queryKey: queryKeys.tunnel.status,
    queryFn: () => apiClient.get<TunnelStatus>('/tunnel/status'),
    refetchInterval: (query) => (query.state.data?.running ? 5000 : false),
  })
}

export function useStartTunnel() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => {
      return apiClient.post<TunnelStartResponse>('/tunnel/start', { port: currentPort() })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tunnel.status })
    },
  })
}

export function useRegenerateTunnel() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => {
      return apiClient.post<TunnelStartResponse>('/tunnel/regenerate', { port: currentPort() })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tunnel.status })
    },
  })
}

export function useStopTunnel() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => apiClient.post<{ ok: boolean }>('/tunnel/stop'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tunnel.status })
    },
  })
}
