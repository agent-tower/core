import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { clamp } from '../lib/scale'
import { STATUS_MARK, VIZ, type Tone } from '../tokens'

export interface RingProps {
  /** 0–1 */
  value: number
  /** 外径 px */
  size?: number
  thickness?: number
  /** 预期位置（0–1），在环上画一道短刻线 */
  expected?: number
  tone?: 'ink' | Tone
  /** 中心内容；不传则显示百分比 */
  children?: ReactNode
  'aria-label'?: string
  className?: string
}

/**
 * 进度环：单个比例的紧凑表达（目标完成度、上下文占用）。
 * 中心放数字，环只是辅助；多个比例并排比较时改用 Track，长度比角度更好比。
 */
export function Ring({ value, size = 64, thickness, expected, tone = 'ink', children, className, ...props }: RingProps) {
  const stroke = thickness ?? Math.max(3, Math.round(size / 14))
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const ratio = clamp(value, 0, 1)
  const color = tone === 'ink' ? VIZ.ink : STATUS_MARK[tone]
  const percent = Math.round(ratio * 100)
  const center = size / 2
  const expectedAngle = expected !== undefined ? clamp(expected, 0, 1) * Math.PI * 2 : null

  return (
    <div
      role="img"
      aria-label={props['aria-label'] ?? `${percent}%`}
      className={cn('relative inline-flex shrink-0 items-center justify-center', className)}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
        <circle cx={center} cy={center} r={radius} fill="none" stroke={tone === 'ink' ? VIZ.empty : `color-mix(in oklab, ${color} 15%, transparent)`} strokeWidth={stroke} />
        {ratio > 0 && (
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - ratio)}
            className="transition-[stroke-dashoffset] duration-700 ease-enter motion-reduce:transition-none"
          />
        )}
        {expectedAngle !== null && (
          <line
            x1={center + (radius - stroke) * Math.cos(expectedAngle)}
            y1={center + (radius - stroke) * Math.sin(expectedAngle)}
            x2={center + (radius + stroke) * Math.cos(expectedAngle)}
            y2={center + (radius + stroke) * Math.sin(expectedAngle)}
            stroke={VIZ.text}
            strokeOpacity={0.6}
            strokeWidth={2}
            strokeLinecap="round"
          />
        )}
      </svg>
      <span className="absolute inset-0 flex items-center justify-center">
        {children ?? (
          <span
            className={cn(
              'font-semibold tracking-tight text-foreground',
              size >= 88 ? 'text-2xl' : size >= 60 ? 'text-[15px]' : 'text-[11px]',
            )}
          >
            {percent}
            <span className={cn('font-medium text-muted-foreground', size >= 88 ? 'text-sm' : 'text-[0.7em]')}>%</span>
          </span>
        )}
      </span>
    </div>
  )
}
