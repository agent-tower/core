import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '../lib/api-client'
import { queryKeys } from './query-keys'
import type {
  AgentType,
  ProviderCapabilityMatrix,
  ProviderBackupFile,
  ProviderDraftInput,
  ProviderDraftTestResult,
  ProviderImportPreview,
  ProviderImportResult,
  RedactedProvider,
} from '@agent-tower/shared'

// ─── Types ───────────────────────────────────────────────────────

export interface ProviderWithAvailability {
  provider: RedactedProvider
  availability: {
    type: 'LOGIN_DETECTED' | 'INSTALLATION_FOUND' | 'NOT_FOUND'
    lastAuthTimestamp?: number
    error?: string
  }
}

export type CreateProviderInput = Omit<ProviderDraftInput, 'providerId'>
export type UpdateProviderInput = Partial<Omit<ProviderDraftInput, 'providerId' | 'agentType'>>

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
    queryFn: () => apiClient.get<RedactedProvider>(`/providers/${id}`),
    enabled: !!id,
  })
}

export function useProviderCapabilities(agentType?: AgentType | string, model?: string) {
  const normalizedModel = model?.trim() || undefined
  return useQuery({
    queryKey: queryKeys.providers.capabilities(agentType, normalizedModel),
    queryFn: () => {
      const params = new URLSearchParams()
      if (agentType) params.set('agentType', agentType)
      if (normalizedModel) params.set('model', normalizedModel)
      const suffix = params.toString()
      return apiClient.get<Partial<ProviderCapabilityMatrix>>(`/providers/capabilities${suffix ? `?${suffix}` : ''}`)
    },
    staleTime: 5 * 60 * 1000,
  })
}

// ─── Mutations ───────────────────────────────────────────────────

/** 创建 provider */
export function useCreateProvider() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateProviderInput) => apiClient.post<RedactedProvider>('/providers', input),
    onSuccess: provider => {
      qc.setQueryData(queryKeys.providers.detail(provider.id), provider)
      qc.invalidateQueries({ queryKey: queryKeys.providers.all })
    },
  })
}

/** 更新 provider */
export function useUpdateProvider() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateProviderInput }) =>
      apiClient.put<RedactedProvider>(`/providers/${id}`, data),
    onSuccess: provider => {
      qc.setQueryData(queryKeys.providers.detail(provider.id), provider)
      qc.invalidateQueries({ queryKey: queryKeys.providers.all })
      qc.invalidateQueries({ queryKey: queryKeys.providers.detail(provider.id) })
    },
  })
}

export function useTestProviderDraft() {
  return useMutation({
    mutationFn: (input: ProviderDraftInput) =>
      apiClient.post<ProviderDraftTestResult>('/providers/test', input),
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

/** 导出 Provider 备份 */
export function useExportProviderBackup() {
  return useMutation({
    mutationFn: () => apiClient.get<ProviderBackupFile>('/providers/backup'),
  })
}

/** 预览导入结果 */
export function usePreviewProviderImport() {
  return useMutation({
    mutationFn: (backup: ProviderBackupFile) =>
      apiClient.post<ProviderImportPreview>('/providers/import/preview', backup),
  })
}

/** 导入 Provider 备份 */
export function useImportProviderBackup() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (backup: ProviderBackupFile) =>
      apiClient.post<ProviderImportResult>('/providers/import', backup),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.providers.all })
    },
  })
}
