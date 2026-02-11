import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiClient } from '../lib/api-client'
import { queryKeys } from './query-keys'

// ─── Types ───────────────────────────────────────────────────────

export type VariantConfig = Record<string, unknown>
export type AgentVariants = Record<string, VariantConfig>
export interface ExecutorProfiles {
  executors: Record<string, AgentVariants>
}

// ─── Queries ─────────────────────────────────────────────────────

/** 获取完整 profiles（合并后） */
export function useProfiles() {
  return useQuery({
    queryKey: queryKeys.profiles.all,
    queryFn: () => apiClient.get<ExecutorProfiles>('/profiles'),
  })
}

/** 获取默认 profiles */
export function useDefaultProfiles() {
  return useQuery({
    queryKey: queryKeys.profiles.defaults,
    queryFn: () => apiClient.get<ExecutorProfiles>('/profiles/defaults'),
  })
}

/** 获取某个 agent 的所有 variant */
export function useAgentVariants(agentType: string) {
  return useQuery({
    queryKey: queryKeys.profiles.agent(agentType),
    queryFn: () => apiClient.get<AgentVariants>(`/profiles/${agentType}`),
    enabled: !!agentType,
  })
}

// ─── Mutations ───────────────────────────────────────────────────

/** 更新 variant 配置 */
export function useUpdateVariant() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ agentType, variant, config }: {
      agentType: string; variant: string; config: VariantConfig
    }) => apiClient.put(`/profiles/${agentType}/${variant}`, config),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.profiles.all })
    },
  })
}

/** 删除 variant */
export function useDeleteVariant() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ agentType, variant }: { agentType: string; variant: string }) =>
      apiClient.delete(`/profiles/${agentType}/${variant}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.profiles.all })
    },
  })
}

/** 重新加载配置 */
export function useReloadProfiles() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => apiClient.post('/profiles/reload'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.profiles.all })
    },
  })
}
