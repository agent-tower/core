import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { queryKeys } from './query-keys'

interface TunnelStatus {
  running: boolean
  url: string | null
  startedAt: string | null
}

export function useTunnelStatus() {
  return useQuery({
    queryKey: queryKeys.tunnel.status,
    queryFn: () => apiClient.get<TunnelStatus>('/tunnel/status'),
    refetchInterval: (query) => (query.state.data?.running ? 10000 : false),
  })
}

export function useStartTunnel() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => {
      const port = parseInt(window.location.port || (window.location.protocol === 'https:' ? '443' : '80'), 10)
      return apiClient.post<{ url: string }>('/tunnel/start', { port })
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
