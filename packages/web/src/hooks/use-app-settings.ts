import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { queryKeys } from './query-keys'
import type { AppSettings, AppLocale } from '@agent-tower/shared'

export type { AppSettings, AppLocale }

export function useAppSettings() {
  return useQuery({
    queryKey: queryKeys.appSettings.detail,
    queryFn: () => apiClient.get<AppSettings>('/app-settings'),
  })
}

export function useUpdateAppSettings() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data: { locale?: AppLocale | null }) =>
      apiClient.put<AppSettings>('/app-settings', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.appSettings.detail })
    },
  })
}
