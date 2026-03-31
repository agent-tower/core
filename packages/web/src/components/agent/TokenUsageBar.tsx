import { Gauge } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import type { TokenUsageInfo } from '../../hooks/useTokenUsage'
import { useI18n } from '@/lib/i18n'

interface TokenUsageIndicatorProps {
  usage: TokenUsageInfo | null
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toString()
}

function getUsageColor(ratio: number): string {
  if (ratio >= 0.9) return 'text-red-500'
  if (ratio >= 0.7) return 'text-amber-500'
  return 'text-neutral-400'
}

export function TokenUsageIndicator({ usage }: TokenUsageIndicatorProps) {
  const { t } = useI18n()
  if (!usage) return null

  const maxCtx = usage.modelContextWindow
  const ratio = maxCtx ? usage.totalTokens / maxCtx : 0
  const percentage = maxCtx ? Math.min(Math.round(ratio * 100), 100) : null
  const colorClass = maxCtx ? getUsageColor(ratio) : 'text-neutral-400'

  const tooltipContent = maxCtx
    ? <span>{t('上下文: {used} / {max} tokens', { used: formatNumber(usage.totalTokens), max: formatNumber(maxCtx) })}</span>
    : <span>{t('已使用: {used} tokens', { used: formatNumber(usage.totalTokens) })}</span>

  return (
    <Tooltip content={tooltipContent}>
      <div className="flex items-center gap-1.5 px-2 py-1.5 text-xs rounded-lg hover:bg-neutral-100 transition-colors cursor-default select-none">
        <Gauge size={14} className={colorClass} />
        <span className={`tabular-nums ${colorClass}`}>
          {formatNumber(usage.totalTokens)}
          {percentage !== null && (
            <span className="text-neutral-300 ml-0.5">/ {percentage}%</span>
          )}
        </span>
      </div>
    </Tooltip>
  )
}

export { formatNumber }
