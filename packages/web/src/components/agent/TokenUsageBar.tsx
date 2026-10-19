import { Gauge } from 'lucide-react'
import { Tooltip, type TooltipSide } from '@/components/ui/tooltip'
import { TONE_INK, TONE_MARK, type Tone } from '@/design-system'
import type { TokenUsageInfo } from '../../hooks/useTokenUsage'
import { useI18n } from '@/lib/i18n'

interface TokenUsageIndicatorProps {
  usage: TokenUsageInfo | null
  tooltipSide?: TooltipSide
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toString()
}

/** 上下文将满才上色：90% 起危险、70% 起警告，其余保持灰色 */
function getUsageTone(ratio: number): Tone {
  if (ratio >= 0.9) return 'danger'
  if (ratio >= 0.7) return 'warning'
  return 'neutral'
}

export function TokenUsageIndicator({ usage, tooltipSide = 'top' }: TokenUsageIndicatorProps) {
  const { t } = useI18n()
  if (!usage) return null

  const maxCtx = usage.modelContextWindow
  const ratio = maxCtx ? usage.totalTokens / maxCtx : 0
  const percentage = maxCtx ? Math.min(Math.round(ratio * 100), 100) : null
  const tone = maxCtx ? getUsageTone(ratio) : 'neutral'
  // 图标用基础状态色，数字用 *-ink 保证文字对比度
  const iconClass = TONE_MARK[tone]
  const textClass = tone === 'neutral' ? 'text-muted-foreground' : TONE_INK[tone]

  const tooltipContent = maxCtx
    ? <span>{t('上下文: {used} / {max} tokens', { used: formatNumber(usage.totalTokens), max: formatNumber(maxCtx) })}</span>
    : <span>{t('已使用: {used} tokens', { used: formatNumber(usage.totalTokens) })}</span>

  return (
    <Tooltip content={tooltipContent} side={tooltipSide}>
      <div className="flex items-center gap-1.5 px-2 py-1.5 text-xs rounded-lg hover:bg-accent transition-colors cursor-default select-none">
        <Gauge size={14} className={iconClass} />
        <span className={`tabular-nums ${textClass}`}>
          {formatNumber(usage.totalTokens)}
          {percentage !== null && (
            <span className="ml-0.5 text-muted-foreground">/ {percentage}%</span>
          )}
        </span>
      </div>
    </Tooltip>
  )
}

export { formatNumber }
