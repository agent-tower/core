import { useMemo } from 'react'
import type { Session } from '@agent-tower/shared'
import { useProviders } from './use-providers'

/**
 * 根据 session 的 providerId 获取 provider 名称
 */
export function useActiveProviderName(activeSession: Session | null | undefined) {
  const { data: providers } = useProviders()

  return useMemo(() => {
    const pid = activeSession?.providerId
    if (!pid || !providers) return null
    const match = providers.find((p) => p.provider.id === pid)
    return match?.provider.name ?? null
  }, [activeSession?.providerId, providers])
}
