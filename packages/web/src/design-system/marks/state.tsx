import { Check } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Badge, type BadgeVariant } from '../feedback/badge'
import type { Tone } from '../tokens'

/* ── 状态方块 ─────────────────────────────────────────────── */

export type SquareState = 'todo' | 'doing' | 'done' | 'late' | 'cancelled'

const SQUARE: Record<SquareState, string> = {
  // 未开始：空心
  todo: 'bg-background ring-1 ring-inset ring-foreground/30',
  // 进行中：对角半实心
  doing: 'ring-1 ring-inset ring-viz-6 bg-[linear-gradient(135deg,transparent_50%,var(--viz-6)_50%)]',
  // 已完成：实心
  done: 'bg-viz-6',
  // 逾期：红色斜纹——唯一带颜色的状态，因为需要处理
  late: 'hatch bg-destructive/10 text-destructive/70 ring-1 ring-inset ring-destructive/60',
  // 已取消：空心 + 斜杠
  cancelled: 'ring-1 ring-inset ring-foreground/20 bg-[linear-gradient(to_top_right,transparent_calc(50%-0.5px),var(--muted-foreground)_calc(50%-0.5px),var(--muted-foreground)_calc(50%+0.5px),transparent_calc(50%+0.5px))]',
}

export interface StateSquareProps {
  state: SquareState
  size?: 'sm' | 'md'
  /** 读屏名称 */
  label?: string
  className?: string
}

/**
 * 状态方块：空心 → 半实心 → 实心，按「完成程度」递进，黑白打印也能分辨。
 * 它是图表里的数据标记（连续记录、排期格），比彩色圆点更安静；界面里的状态图标
 * （任务、待办、按钮）一律用 lucide 线性图标，不用这种块面。
 */
export function StateSquare({ state, size = 'md', label, className }: StateSquareProps) {
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn('inline-block shrink-0 rounded-[3px]', size === 'md' ? 'size-3' : 'size-2.5', SQUARE[state], className)}
    />
  )
}

/* ── 目标状态 ─────────────────────────────────────────────── */

export type Health = 'not-started' | 'on-track' | 'ahead' | 'at-risk' | 'off-track' | 'done'

const HEALTH: Record<Health, { label: string; tone: Tone; variant: BadgeVariant }> = {
  'not-started': { label: 'Not started', tone: 'neutral', variant: 'soft' },
  'on-track': { label: 'On track', tone: 'neutral', variant: 'outline' },
  ahead: { label: 'Ahead', tone: 'success', variant: 'dot' },
  'at-risk': { label: 'At risk', tone: 'warning', variant: 'dot' },
  'off-track': { label: 'Off track', tone: 'danger', variant: 'soft' },
  done: { label: 'Done', tone: 'success', variant: 'soft' },
}

/**
 * 目标状态：正常不上色（不需要注意），领先 / 有风险用圆点，已延期用浅红底——
 * 越需要处理越醒目。里程碑、TeamRun、目标卡共用这一套。
 */
export function HealthBadge({ health, label, className }: { health: Health; label?: string; className?: string }) {
  const { t } = useI18n()
  const config = HEALTH[health]
  return (
    <Badge
      tone={config.tone}
      variant={config.variant}
      icon={health === 'done' ? <Check strokeWidth={3} /> : undefined}
      className={className}
    >
      {label ?? t(config.label)}
    </Badge>
  )
}
