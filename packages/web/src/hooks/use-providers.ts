import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '../lib/api-client'
import { queryKeys } from './query-keys'
import type { Provider, AgentType } from '@agent-tower/shared'

// ─── Types ───────────────────────────────────────────────────────

export interface ProviderWithAvailability {
  provider: Provider
  availability: {
    type: 'LOGIN_DETECTED' | 'INSTALLATION_FOUND' | 'NOT_FOUND'
    lastAuthTimestamp?: number
    error?: string
  }
}

export interface CreateProviderInput {
  name: string
  agentType: AgentType
  env?: Record<string, string>
  config?: Record<string, unknown>
  settings?: Record<string, unknown>
  isDefault?: boolean
}

export interface UpdateProviderInput {
  name?: string
  env?: Record<string, string>
  config?: Record<string, unknown>
  settings?: Record<string, unknown>
  isDefault?: boolean
}

// ─── Queries ─────────────────────────────────────────────────────

/** 获取所有 providers（带可用性检查） */
export function useProviders() {
  return useQuery({
    queryKey: queryKeys.providers.all,
    queryFn: () => apiClient.get<ProviderWithAvailability[]>('/providers'),
  })
}

/** 获取单个 provider 详情 */
export function useProvider(id: string) {
  return useQuery({
    queryKey: queryKeys.providers.detail(id),
    queryFn: () => apiClient.get<Provider>(`/providers/${id}`),
    enabled: !!id,
  })
}

// ─── Mutations ───────────────────────────────────────────────────

/** 创建 provider */
export function useCreateProvider() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateProviderInput) => apiClient.post<Provider>('/providers', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.providers.all })
    },
  })
}

/** 更新 provider */
export function useUpdateProvider() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateProviderInput }) =>
      apiClient.put<Provider>(`/providers/${id}`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.providers.all })
    },
  })
}

/** 删除 provider */
export function useDeleteProvider() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => apiClient.delete(`/providers/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.providers.all })
    },
  })
}

/** 重新加载配置 */
export function useReloadProviders() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => apiClient.post('/providers/reload'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.providers.all })
    },
  })
}
