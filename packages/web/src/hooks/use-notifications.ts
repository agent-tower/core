import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { queryKeys } from './query-keys'
import type { NotificationSettings } from '@agent-tower/shared'

export type { NotificationSettings }

export function useNotificationSettings() {
  return useQuery({
    queryKey: queryKeys.notifications.settings,
    queryFn: () => apiClient.get<NotificationSettings>('/notifications/settings'),
  })
}

export function useUpdateNotificationSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: Partial<Omit<NotificationSettings, 'id'>>) =>
      apiClient.put<NotificationSettings>('/notifications/settings', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.notifications.settings })
    },
  })
}

export function useTestNotificationChannel() {
  return useMutation({
    mutationFn: (data: { channel: string; webhookUrl: string; baseUrl?: string }) =>
      apiClient.post<{ success: boolean }>('/notifications/test', data),
  })
}
