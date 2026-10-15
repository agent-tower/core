import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { formatPercent } from '../lib/format'
import { hasNode } from '../lib/node'
import { arcPath } from '../lib/scale'
import { LegendSwatchMark } from '../marks/legend'
import { VIZ } from '../tokens'
import { defaultFormat, stackColors } from './chart-utils'

/* ── 环图 ─────────────────────────────────────────────────── */

export interface DonutSegment {
  id: string
  label: string
  value: number
  /** 分段颜色；数据本身是状态时传状态色（STATUS_MARK），否则默认序数墨阶 */
  color?: string
}

export interface DonutChartProps {
  segments: DonutSegment[]
  size?: number
  thickness?: number
  /** 中心大数字，默认合计 */
  centerValue?: ReactNode
  centerLabel?: ReactNode
  formatValue?: (value: number) => string
  'aria-label': string
  className?: string
}

/**
 * 环图：一眼看出「整体由哪几块构成」。最多 4–6 段，分段之间 2px 白缝；
 * 旁边的图例表给出精确数值与占比——比较相近的数值请用条形图，角度不好比。
 */
export function DonutChart({ segments, size = 136, thickness = 14, centerValue, centerLabel, formatValue = defaultFormat, className, ...props }: DonutChartProps) {
  const [active, setActive] = useState<number | null>(null)
  const total = segments.reduce((sum, segment) => sum + segment.value, 0)
  const palette = stackColors(segments.length)
  const colorOf = (index: number) => segments[index].color ?? palette[index]
  const center = size / 2
  const outer = size / 2
  const inner = outer - thickness
  const padAngle = segments.length > 1 ? 2 / (outer - thickness / 2) : 0

  const arcs: { index: number; d: string }[] = []
  let cursor = 0
  for (let index = 0; index < segments.length; index++) {
    const sweep = total > 0 ? (segments[index].value / total) * Math.PI * 2 : 0
    const start = cursor + padAngle / 2
    const end = cursor + sweep - padAngle / 2
    cursor += sweep
    arcs.push({ index, d: end > start ? arcPath(center, center, outer, inner, start, end) : '' })
  }

  const shown = active !== null ? segments[active] : null

  return (
    <div className={cn('flex flex-wrap items-center gap-x-6 gap-y-4', className)}>
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={props['aria-label']} onPointerLeave={() => setActive(null)}>
          <circle cx={center} cy={center} r={outer - thickness / 2} fill="none" stroke={VIZ.empty} strokeWidth={thickness} opacity={total > 0 ? 0 : 1} />
          {arcs.map(arc => arc.d && (
            <path
              key={segments[arc.index].id}
              d={arc.d}
              fill={colorOf(arc.index)}
              opacity={active !== null && active !== arc.index ? 0.3 : 1}
              className="transition-opacity duration-150"
              onPointerEnter={() => setActive(arc.index)}
            />
          ))}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-[22px] font-semibold leading-7 tracking-tight text-foreground">
            {shown ? formatValue(shown.value) : centerValue ?? formatValue(total)}
          </span>
          <span className="max-w-[80%] truncate text-[11px] leading-4 text-muted-foreground">
            {shown ? `${shown.label} · ${formatPercent(total ? shown.value / total : 0)}` : centerLabel}
          </span>
        </div>
      </div>

      <table className="min-w-[160px] flex-1 border-collapse text-xs">
        <tbody>
          {segments.map((segment, index) => (
            <tr
              key={segment.id}
              onPointerEnter={() => setActive(index)}
              onPointerLeave={() => setActive(null)}
              className={cn('transition-opacity duration-150', active !== null && active !== index && 'opacity-40')}
            >
              <td className="h-7 w-4 pr-2">
                <LegendSwatchMark color={colorOf(index)} />
              </td>
              <td className="h-7 truncate pr-3 text-foreground/85">{segment.label}</td>
              <td className="h-7 pr-3 text-right font-medium tabular-nums text-foreground">{formatValue(segment.value)}</td>
              <td className="h-7 w-10 text-right tabular-nums text-muted-foreground">{formatPercent(total ? segment.value / total : 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ── 百格图 ───────────────────────────────────────────────── */

export interface WaffleChartProps {
  /** 主体占比 0–1（实心墨色） */
  value: number
  /** 紧随其后的第二部分 0–1（斜纹，如「进行中」） */
  secondary?: number
  cellSize?: number
  'aria-label': string
  className?: string
}

/**
 * 百格图：把一个比例画成 100 个格子，「每 100 个里有 83 个」比百分比更有体感。
 * 实心 = 已达成，斜纹 = 进行中，浅格 = 剩余。
 */
export function WaffleChart({ value, secondary = 0, cellSize = 10, className, ...props }: WaffleChartProps) {
  const filled = Math.round(Math.min(1, Math.max(0, value)) * 100)
  const partial = Math.min(100 - filled, Math.round(Math.max(0, secondary) * 100))
  return (
    <div
      role="img"
      aria-label={props['aria-label']}
      className={cn('grid w-max grid-cols-10 gap-[2px]', className)}
    >
      {Array.from({ length: 100 }).map((_, index) => (
        <span
          key={index}
          aria-hidden="true"
          className={cn(
            'rounded-[2px]',
            index < filled ? 'bg-viz-6' : index < filled + partial ? 'hatch bg-viz-0 text-viz-3' : 'bg-viz-0',
          )}
          style={{ width: cellSize, height: cellSize }}
        />
      ))}
    </div>
  )
}

/* ── 排行条 ───────────────────────────────────────────────── */

export interface RankedItem {
  id: string
  label: ReactNode
  value: number
  meta?: ReactNode
  icon?: ReactNode
}

export interface RankedBarsProps {
  items: RankedItem[]
  formatValue?: (value: number) => string
  /** 条长基准，默认取最大值 */
  max?: number
  showRank?: boolean
  className?: string
  'aria-label': string
}

/**
 * 排行条：同一指标下各对象的排名。一个系列只用一种颜色（墨色），长度表达大小；
 * 不要按数值深浅上色——那是在重复条长已经表达的信息。数值右对齐成一列。
 */
export function RankedBars({ items, formatValue = defaultFormat, max, showRank = true, className, ...props }: RankedBarsProps) {
  const [active, setActive] = useState<string | null>(null)
  const ceiling = max ?? Math.max(1, ...items.map(item => item.value))
  return (
    <ol aria-label={props['aria-label']} className={cn('flex flex-col', className)} onPointerLeave={() => setActive(null)}>
      {items.map((item, index) => (
        <li
          key={item.id}
          onPointerEnter={() => setActive(item.id)}
          className={cn(
            'grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 py-1.5 transition-opacity duration-150',
            !showRank && 'grid-cols-[minmax(0,1fr)_auto]',
            active !== null && active !== item.id && 'opacity-45',
          )}
        >
          {showRank && (
            <span className={cn('w-5 text-[11px] font-semibold tabular-nums', index < 3 ? 'text-foreground' : 'text-muted-foreground')}>
              {String(index + 1).padStart(2, '0')}
            </span>
          )}
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5">
              {item.icon && <span className="flex shrink-0 [&_svg]:size-3.5">{item.icon}</span>}
              <span className="truncate text-[13px] text-foreground/90">{item.label}</span>
              {hasNode(item.meta) && <span className="shrink-0 truncate text-[11px] text-muted-foreground">{item.meta}</span>}
            </div>
            <div className="mt-1 h-1.5 w-full">
              <div
                className="h-full rounded-r-[3px] bg-viz-6 transition-[width] duration-500 ease-enter motion-reduce:transition-none"
                style={{ width: `max(2px, ${(item.value / ceiling) * 100}%)` }}
              />
            </div>
          </div>
          <span className="text-right text-[13px] font-semibold tabular-nums text-foreground">{formatValue(item.value)}</span>
        </li>
      ))}
    </ol>
  )
}

/* ── 漏斗 ─────────────────────────────────────────────────── */

export interface FunnelStage {
  id: string
  label: string
  value: number
}

export interface FunnelChartProps {
  stages: FunnelStage[]
  formatValue?: (value: number) => string
  'aria-label': string
  className?: string
}

/**
 * 漏斗：有序阶段的逐级留存（创建 → 执行 → 审查 → 合并）。阶段是有序类别，
 * 用序数墨阶由浅到深；阶段之间标出转化率，最大流失处一眼可见。
 */
export function FunnelChart({ stages, formatValue = defaultFormat, className, ...props }: FunnelChartProps) {
  const first = stages[0]?.value || 1
  const max = Math.max(1, ...stages.map(stage => stage.value))
  const colors = stackColors(stages.length).slice().reverse()
  const conversions = stages.map((stage, index) => (index === 0 ? 1 : stages[index - 1].value ? stage.value / stages[index - 1].value : 0))
  const worst = conversions.slice(1).reduce((low, value, index) => (value < conversions[low + 1] ? index : low), 0) + 1

  return (
    <div role="img" aria-label={props['aria-label']} className={cn('flex flex-col', className)}>
      {stages.map((stage, index) => {
        const ratio = stage.value / max
        const nextRatio = index < stages.length - 1 ? stages[index + 1].value / max : ratio
        return (
          <div key={stage.id}>
            <div className="grid grid-cols-[5.5rem_minmax(0,1fr)_4.5rem] items-center gap-3">
              <span className="truncate text-xs text-foreground/85">{stage.label}</span>
              <div className="flex h-6 justify-center">
                <div className="h-full rounded-[4px]" style={{ width: `${ratio * 100}%`, background: colors[index] }} />
              </div>
              <span className="text-right">
                <span className="block text-[13px] font-semibold leading-4 tabular-nums text-foreground">{formatValue(stage.value)}</span>
                <span className="block text-[10px] leading-3 tabular-nums text-muted-foreground">{formatPercent(stage.value / first)}</span>
              </span>
            </div>
            {index < stages.length - 1 && (
              <div className="grid grid-cols-[5.5rem_minmax(0,1fr)_4.5rem] items-center gap-3">
                <span />
                {/* 级间转化率写在连接带中间，右列只留本级数值，读起来不串行 */}
                <div className="relative flex h-5 items-center justify-center">
                  <svg viewBox="0 0 100 10" preserveAspectRatio="none" className="absolute inset-0 size-full" aria-hidden="true">
                    <polygon
                      points={`${50 - ratio * 50},0 ${50 + ratio * 50},0 ${50 + nextRatio * 50},10 ${50 - nextRatio * 50},10`}
                      fill={VIZ.empty}
                    />
                  </svg>
                  <span className={cn('relative text-[10px] leading-none tabular-nums', index + 1 === worst ? 'font-medium text-warning-ink' : 'text-foreground/70')}>
                    ↓ {formatPercent(conversions[index + 1])}
                  </span>
                </div>
                <span />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
