import type { ComponentProps, ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatNumber, formatPercent } from '../lib/format'
import { hasNode } from '../lib/node'
import { Delta, type DeltaProps } from '../marks/delta'
import { Sparkline } from '../marks/sparkline'
import { Track, type TrackTone } from '../marks/track'

/* ── 统计卡 ───────────────────────────────────────────────── */

export interface StatTileProps {
  /** 名词短语，句首大写，不加冒号 */
  label: ReactNode
  /** 已格式化的数值（紧凑写法：1,284 / 12.9K / 1.2万） */
  value: ReactNode
  unit?: ReactNode
  icon?: ReactNode
  delta?: DeltaProps
  /** 12 个点左右的走势 */
  trend?: number[]
  footnote?: ReactNode
  className?: string
}

/**
 * 统计卡：一个数字就是答案时不要画图。标签 · 数值 · 变化量（带对比口径）· 可选走势线。
 * 大数字用比例数字（不加 tabular），视觉更紧凑。
 */
export function StatTile({ label, value, unit, icon, delta, trend, footnote, className }: StatTileProps) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1 bg-background p-4', className)}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground [&_svg]:size-3.5">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-1">
          <span className="truncate text-[26px] font-semibold leading-8 tracking-tight text-foreground">{value}</span>
          {hasNode(unit) && <span className="shrink-0 text-[13px] text-muted-foreground">{unit}</span>}
        </div>
        {trend && <Sparkline values={trend} area width={76} height={28} className="mb-1" />}
      </div>
      {(delta || footnote) && (
        <div className="flex min-w-0 items-center gap-2">
          {delta && <Delta {...delta} />}
          {footnote && <span className="truncate text-xs text-muted-foreground">{footnote}</span>}
        </div>
      )}
    </div>
  )
}

/** 统计卡组（KPI 行）：同一行 2–4 个指标，用 1px 细线分隔，任意折行都对齐 */
export function StatGroup({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('grid gap-px overflow-hidden rounded-xl border border-border/70 bg-border/60 sm:grid-cols-2 xl:grid-cols-4', className)}
      {...props}
    />
  )
}

/* ── 主数字 ───────────────────────────────────────────────── */

export interface HeroFigureProps {
  value: ReactNode
  unit?: ReactNode
  label: ReactNode
  delta?: DeltaProps
  caption?: ReactNode
  className?: string
}

/** 主数字：一个视图只能有一个。≥ 48px，和正文同一款无衬线字体，不用装饰字 */
export function HeroFigure({ value, unit, label, delta, caption, className }: HeroFigureProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-baseline gap-1">
        <span className="text-[56px] font-semibold leading-none tracking-tight text-foreground">{value}</span>
        {hasNode(unit) && <span className="text-xl font-medium text-muted-foreground">{unit}</span>}
      </div>
      {(delta || caption) && (
        <div className="flex flex-wrap items-center gap-2">
          {delta && <Delta size="md" {...delta} />}
          {hasNode(caption) && <span className="text-xs text-muted-foreground">{caption}</span>}
        </div>
      )}
    </div>
  )
}

/* ── 用量表 ───────────────────────────────────────────────── */

export interface MeterProps {
  label: ReactNode
  value: number
  max: number
  formatValue?: (value: number) => string
  /** 进入警告 / 危险的占比阈值 */
  warningAt?: number
  dangerAt?: number
  className?: string
}

/**
 * 用量表：有上限的资源（上下文窗口、配额、磁盘）。平时墨色；
 * 超过阈值后整条（含轨道）换成警告 / 危险色，并加图标——颜色不单独承载含义。
 */
export function Meter({ label, value, max, formatValue = number => formatNumber(number, { compact: true }), warningAt = 0.7, dangerAt = 0.9, className }: MeterProps) {
  const ratio = max > 0 ? value / max : 0
  const tone: TrackTone = ratio >= dangerAt ? 'danger' : ratio >= warningAt ? 'warning' : 'ink'
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="flex min-w-0 items-center gap-1 text-foreground/85">
          {tone !== 'ink' && <TriangleAlert aria-hidden="true" className={cn('size-3 shrink-0', tone === 'danger' ? 'text-destructive' : 'text-warning')} />}
          <span className="truncate">{label}</span>
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {formatValue(value)} / {formatValue(max)}
          <span className={cn('ml-1.5 font-medium', tone === 'danger' ? 'text-destructive-ink' : tone === 'warning' ? 'text-warning-ink' : 'text-foreground/80')}>
            {formatPercent(ratio)}
          </span>
        </span>
      </div>
      <Track value={value} max={max} tone={tone} aria-label={typeof label === 'string' ? label : undefined} />
    </div>
  )
}
