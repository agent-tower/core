import { cn } from '@/lib/utils'
import { clamp } from '../lib/scale'
import type { Tone } from '../tokens'

export type TrackTone = 'ink' | Tone

const FILL: Record<TrackTone, string> = {
  ink: 'bg-viz-6',
  neutral: 'bg-viz-3',
  info: 'bg-info',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-destructive',
}

/** 未填充的轨道是同色相的浅一档，整条进度条都在传达状态 */
const TRACK: Record<TrackTone, string> = {
  ink: 'bg-viz-0',
  neutral: 'bg-viz-0',
  info: 'bg-info/15',
  success: 'bg-success/15',
  warning: 'bg-warning/15',
  danger: 'bg-destructive/15',
}

const HEIGHT = { xs: 'h-1', sm: 'h-1.5', md: 'h-2' }

export interface TrackProps {
  value: number
  max?: number
  /** 预期位置：一根竖线标出「此刻应该到哪」 */
  expected?: number
  tone?: TrackTone
  size?: keyof typeof HEIGHT
  'aria-label'?: string
  className?: string
}

/**
 * 进度条：实际进度实心墨色，预期位置用竖线标出——落后多少一眼可见。
 * 只有进度本身代表风险时才换状态色（如上下文窗口将满）。
 */
export function Track({ value, max = 1, expected, tone = 'ink', size = 'sm', className, ...props }: TrackProps) {
  const ratio = max > 0 ? clamp(value / max, 0, 1) : 0
  const expectedRatio = expected !== undefined && max > 0 ? clamp(expected / max, 0, 1) : null

  return (
    <div
      role="progressbar"
      aria-label={props['aria-label']}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className={cn('relative w-full rounded-full', HEIGHT[size], TRACK[tone], className)}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-500 ease-enter motion-reduce:transition-none', FILL[tone])}
        style={{ width: ratio > 0 ? `max(2px, ${ratio * 100}%)` : 0 }}
      />
      {expectedRatio !== null && (
        <span
          aria-hidden="true"
          className="absolute -top-[3px] -bottom-[3px] w-0.5 -translate-x-1/2 rounded-full bg-foreground/60 ring-2 ring-background"
          style={{ left: `${expectedRatio * 100}%` }}
        />
      )}
    </div>
  )
}
