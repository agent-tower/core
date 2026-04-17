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

interface UpdateAppSettingsInput {
  locale?: AppLocale | null
  commitMessageProviderId?: string | null
  commitMessagePrompt?: string | null
}

export function useUpdateAppSettings() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data: UpdateAppSettingsInput) =>
      apiClient.put<AppSettings>('/app-settings', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.appSettings.detail })
    },
  })
}

export function useCommitMessageDefaults() {
  return useQuery({
    queryKey: [...queryKeys.appSettings.detail, 'commit-message-defaults'] as const,
    queryFn: () => apiClient.get<{ prompt: string }>('/app-settings/commit-message-defaults'),
  })
}
