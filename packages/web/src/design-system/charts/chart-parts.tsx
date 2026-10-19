import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { clamp } from '../lib/scale'
import { LegendSwatchMark, type LegendSwatch } from '../marks/legend'
import { VIZ } from '../tokens'
import { crisp, visibleLabelIndices } from './chart-utils'

/* ── 提示浮层 ─────────────────────────────────────────────── */

export interface ChartTooltipRow {
  label: ReactNode
  value: ReactNode
  color?: string
  /** 线图用短线（默认），柱/面用方块，计划用斜纹 */
  swatch?: LegendSwatch
}

export interface ChartTooltipProps {
  /** 锚点坐标（相对图表容器） */
  x: number
  y: number
  containerWidth: number
  containerHeight?: number
  title?: ReactNode
  rows: ChartTooltipRow[]
  footer?: ReactNode
}

/**
 * 图表提示：数值在前（加粗墨色）、系列名在后（灰），一次列出该位置的全部系列。
 * 提示只是增强——同样的数值必须能在直接标签或表格视图里读到。
 */
export function ChartTooltip({ x, y, containerWidth, containerHeight, title, rows, footer }: ChartTooltipProps) {
  const flip = x > containerWidth * 0.62
  const estimatedHeight = 28 + rows.length * 20 + (footer ? 24 : 0)
  const top = containerHeight ? clamp(y - 16, 0, Math.max(0, containerHeight - estimatedHeight)) : y
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute z-10 min-w-[120px] max-w-[240px] rounded-lg border border-border bg-popover px-2.5 py-2 text-xs shadow-popover"
      style={{ top, ...(flip ? { right: containerWidth - x + 12 } : { left: x + 12 }) }}
    >
      {title && <div className="mb-1 text-xs text-muted-foreground">{title}</div>}
      <div className="space-y-1">
        {rows.map((row, index) => (
          <div key={index} className="flex items-center gap-2 whitespace-nowrap">
            <LegendSwatchMark swatch={row.swatch ?? 'line'} color={row.color ?? VIZ.ink} />
            <span className="font-semibold tabular-nums text-foreground">{row.value}</span>
            <span className="truncate text-muted-foreground">{row.label}</span>
          </div>
        ))}
      </div>
      {footer && <div className="mt-1.5 border-t border-border/60 pt-1.5 text-xs text-muted-foreground">{footer}</div>}
    </div>
  )
}

/* ── SVG 定义 ─────────────────────────────────────────────── */

/** 计划 / 剩余的斜纹填充：45° 细线，浅墨底 */
export function HatchPattern({ id, color = VIZ.plan, background = VIZ.empty }: { id: string; color?: string; background?: string }) {
  return (
    <pattern id={id} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="5" height="5" fill={background} />
      <line x1="0" y1="0" x2="0" y2="5" stroke={color} strokeWidth="1.2" />
    </pattern>
  )
}

/* ── 坐标轴 ───────────────────────────────────────────────── */

/** 横向网格 + Y 刻度：网格是实线细线（不用虚线），0 基线稍深 */
export function YGrid({ ticks, y, left, right, format }: { ticks: number[]; y: (value: number) => number; left: number; right: number; format: (value: number) => string }) {
  return (
    <g>
      {ticks.map(tick => (
        <g key={tick}>
          <line x1={left} x2={right} y1={crisp(y(tick))} y2={crisp(y(tick))} stroke={tick === 0 ? VIZ.axis : VIZ.grid} strokeWidth={1} />
          <text x={left - 8} y={y(tick)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">
            {format(tick)}
          </text>
        </g>
      ))}
    </g>
  )
}

/** X 轴标签：按可用宽度抽稀，末尾总是保留；光标处标签加深 */
export function XLabels({ labels, x, y, width, minGap = 44, activeIndex }: { labels: string[]; x: (index: number) => number; y: number; width: number; minGap?: number; activeIndex?: number | null }) {
  const visible = visibleLabelIndices(labels.length, width, minGap, activeIndex)
  return (
    <g>
      {labels.map((label, index) => visible.has(index) && (
        <text
          key={index}
          x={x(index)}
          y={y}
          textAnchor="middle"
          className={cn('text-[11px] tabular-nums', activeIndex === index ? 'fill-foreground font-medium' : 'fill-muted-foreground')}
        >
          {label}
        </text>
      ))}
    </g>
  )
}

/** 读屏播报：键盘移动光标时朗读当前数据点 */
export function LiveReadout({ children }: { children: ReactNode }) {
  return <div className="sr-only" aria-live="polite">{children}</div>
}

/** 图表宽度未测量前的占位：保持高度，避免布局跳动 */
export function ChartPlaceholder({ height }: { height: number }) {
  return <div aria-hidden="true" style={{ height }} />
}
