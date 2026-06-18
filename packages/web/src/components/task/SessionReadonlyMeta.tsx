import type { Session } from '@agent-tower/shared'
import { AgentLogo, TokenUsageIndicator } from '@/components/agent'
import type { TooltipSide } from '@/components/ui/tooltip'
import type { TokenUsageInfo } from '@/hooks/useTokenUsage'
import type { ProviderWithAvailability } from '@/hooks/use-providers'
import { useI18n } from '@/lib/i18n'
import { truncateMiddle } from '@/lib/utils'

type SessionTokenUsage = { totalTokens: number; modelContextWindow?: number }
type SessionProviderFallback = { providerId?: string | null; agentType?: string | null }

export function getSessionTokenUsage(session: Session | null | undefined): SessionTokenUsage | undefined {
  const tokenUsage = session?.tokenUsage
  if (!tokenUsage || typeof tokenUsage.totalTokens !== 'number') return undefined
  return tokenUsage
}

export function resolveSessionProviderDisplay(
  session: Session | null | undefined,
  providers?: ProviderWithAvailability[],
  fallback?: SessionProviderFallback,
) {
  const providerId = session?.providerId ?? fallback?.providerId ?? null
  const provider = providerId
    ? providers?.find((item) => item.provider.id === providerId)?.provider
    : null
  const label = provider?.name ?? providerId ?? session?.agentType ?? fallback?.agentType ?? null
  if (!label) return null
  const agentType = session?.agentType ?? provider?.agentType ?? fallback?.agentType ?? null

  const title = providerId && provider?.name && providerId !== provider.name
    ? `${provider.name} (${providerId})`
    : label

  return { label, title, agentType }
}

interface SessionReadonlyMetaProps {
  session: Session | null | undefined
  providers?: ProviderWithAvailability[]
  usage: TokenUsageInfo | null
  compact?: boolean
  providerIdFallback?: string | null
  agentTypeFallback?: string | null
  tokenTooltipSide?: TooltipSide
}

export function SessionReadonlyMeta({
  session,
  providers,
  usage,
  compact = false,
  providerIdFallback,
  agentTypeFallback,
  tokenTooltipSide = 'top',
}: SessionReadonlyMetaProps) {
  const { t } = useI18n()
  const provider = resolveSessionProviderDisplay(session, providers, {
    providerId: providerIdFallback,
    agentType: agentTypeFallback,
  })
  if (!provider && !usage) return null

  return (
    <div className={`flex shrink-0 items-center ${compact ? 'gap-1' : 'gap-2'}`}>
      {provider && (
        <div
          className={`flex shrink-0 items-center rounded-lg text-neutral-500 ${
            compact
              ? 'max-w-[130px] min-w-[82px] gap-1 px-1.5 py-1 text-[11px]'
              : 'max-w-[220px] min-w-[110px] gap-1.5 px-2 py-1.5 text-xs'
          }`}
          title={`${t('Provider')}: ${provider.title}`}
        >
          <AgentLogo agentType={provider.agentType} className={compact ? 'size-3' : 'size-3.5'} />
          <span className="min-w-0 truncate">{truncateMiddle(provider.label, compact ? 12 : 18)}</span>
        </div>
      )}
      <TokenUsageIndicator usage={usage} tooltipSide={tokenTooltipSide} />
    </div>
  )
}
