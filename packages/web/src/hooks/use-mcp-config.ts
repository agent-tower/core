import { useQuery } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { queryKeys } from './query-keys'
import type { McpConfigResponse } from '@agent-tower/shared'

export type { McpConfigResponse }

export function useMcpConfig() {
  return useQuery({
    queryKey: queryKeys.system.mcpConfig,
    queryFn: () => apiClient.get<McpConfigResponse>('/system/mcp-config'),
  })
}
