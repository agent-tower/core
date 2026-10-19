import type { ReactNode } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatNumber } from '../lib/format'
import { TONE_INK, type Tone } from '../tokens'

export interface DeltaProps {
  /** 变化量：percent 模式下为比例（0.12 = 12%） */
  value: number
  format?: 'percent' | 'number'
  /** 哪个方向是好事；none 表示涨跌无好坏，只显示方向不上色 */
  goodWhen?: 'up' | 'down' | 'none'
  /** 对比口径，如「比上周」 */
  period?: ReactNode
  size?: 'sm' | 'md'
  className?: string
}

/**
 * 变化量：↑12% 比上周。颜色 = 方向 × 好坏（耗时上涨是坏事），而不是简单的涨绿跌红。
 * 箭头已经表达方向，数字不再重复正负号；读屏读完整的「上升 12%」。
 */
export function Delta({ value, format = 'percent', goodWhen = 'up', period, size = 'sm', className }: DeltaProps) {
  const direction = value > 0 ? 'up' : value < 0 ? 'down' : 'flat'
  const tone: Tone = direction === 'flat' || goodWhen === 'none' ? 'neutral' : direction === goodWhen ? 'success' : 'danger'
  const magnitude = Math.abs(value)
  const text = format === 'percent'
    ? `${Number.isInteger(magnitude * 100) ? (magnitude * 100).toFixed(0) : (magnitude * 100).toFixed(1)}%`
    : formatNumber(magnitude)
  const Arrow = direction === 'down' ? ArrowDown : ArrowUp

  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap', size === 'sm' ? 'text-xs' : 'text-[13px]', className)}>
      <span className={cn('inline-flex items-center gap-0.5 font-medium tabular-nums', goodWhen === 'none' && direction !== 'flat' ? 'text-foreground/80' : TONE_INK[tone])}>
        {direction !== 'flat' && <Arrow aria-hidden="true" className={size === 'sm' ? 'size-3' : 'size-3.5'} strokeWidth={2.5} />}
        <span className="sr-only">{direction === 'up' ? '+' : direction === 'down' ? '−' : ''}</span>
        {text}
      </span>
      {period && <span className="text-muted-foreground">{period}</span>}
    </span>
  )
}
