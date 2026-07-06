import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AccessAuthPublicStatus,
  AccessAuthSafeSettings,
  UpdateAccessAuthSettingsInput,
} from '@agent-tower/shared'
import { apiClient } from '@/lib/api-client'
import { queryKeys } from './query-keys'

export type {
  AccessAuthPublicStatus,
  AccessAuthSafeSettings,
  UpdateAccessAuthSettingsInput,
}

export function useAccessAuthStatus() {
  return useQuery({
    queryKey: queryKeys.accessAuth.status,
    queryFn: () => apiClient.get<AccessAuthPublicStatus>('/access-auth/status'),
    retry: false,
  })
}

export function useAccessAuthSettings(enabled = true) {
  return useQuery({
    queryKey: queryKeys.accessAuth.settings,
    queryFn: () => apiClient.get<AccessAuthSafeSettings>('/access-auth/settings'),
    enabled,
  })
}

export function useLoginAccessAuth() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (password: string) =>
      apiClient.post<AccessAuthPublicStatus>('/access-auth/login', { password }),
    onSuccess: (status) => {
      queryClient.setQueryData(queryKeys.accessAuth.status, status)
      queryClient.invalidateQueries()
    },
  })
}

export function useLogoutAccessAuth() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: () => apiClient.post<AccessAuthPublicStatus>('/access-auth/logout', {}),
    onSuccess: (status) => {
      queryClient.setQueryData(queryKeys.accessAuth.status, status)
      queryClient.invalidateQueries()
    },
  })
}

export function useUpdateAccessAuthSettings() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (data: UpdateAccessAuthSettingsInput) =>
      apiClient.put<AccessAuthSafeSettings>('/access-auth/settings', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.accessAuth.status })
      queryClient.invalidateQueries({ queryKey: queryKeys.accessAuth.settings })
    },
  })
}
