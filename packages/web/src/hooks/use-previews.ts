import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { resolvePreviewViewUrl } from '@/lib/preview-url'
import { queryKeys } from './query-keys'

export interface PreviewStatus {
  configured: boolean
  ready: boolean
  target: string | null
  viewUrl: string | null
  error: string | null
}

export function usePreviewStatus(workspaceId?: string) {
  return useQuery({
    queryKey: queryKeys.previews.status(workspaceId ?? ''),
    queryFn: async () => {
      const status = await apiClient.get<PreviewStatus>(`/previews/${workspaceId}/status`)
      return {
        ...status,
        viewUrl: status.viewUrl ? resolvePreviewViewUrl(status.viewUrl) : null,
      }
    },
    enabled: Boolean(workspaceId),
    refetchOnWindowFocus: false,
  })
}

export function useUpdatePreviewConfig(workspaceId?: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (target: string | null) =>
      apiClient.put<PreviewStatus>(`/previews/${workspaceId}/config`, { target }),
    onSuccess: () => {
      if (!workspaceId) return
      queryClient.invalidateQueries({ queryKey: queryKeys.previews.status(workspaceId) })
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all })
    },
  })
}
