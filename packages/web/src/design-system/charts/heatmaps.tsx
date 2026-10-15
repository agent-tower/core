import { useState, type ReactNode } from 'react'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { addDays } from '../lib/date'
import { useElementWidth } from '../lib/hooks'
import { clamp, quantize } from '../lib/scale'
import { VIZ, VIZ_RAMP } from '../tokens'
import { ChartPlaceholder, ChartTooltip } from './chart-parts'
import { defaultFormat } from './chart-utils'

/** 深色格子上用白字，浅色格子上用墨字——按填充明度选，保证格内数字可读 */
function inkOn(level: number) {
  return level >= 4 ? 'text-white' : 'text-foreground/80'
}

/** 序列色阶图例：少 □□□□□ 多 */
export function ScaleLegend({ steps = [0, 1, 3, 4, 6], className }: { steps?: number[]; className?: string }) {
  const { t } = useI18n()
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[11px] text-muted-foreground', className)}>
      {t('Less')}
      <span className="flex gap-[2px]" aria-hidden="true">
        {steps.map(step => <span key={step} className="size-2.5 rounded-[2px]" style={{ background: VIZ_RAMP[step] }} />)}
      </span>
      {t('More')}
    </span>
  )
}

/* ── 热力表 ───────────────────────────────────────────────── */

export interface HeatTableRow {
  /** 纯文本名称：悬停提示用 */
  name: string
  /** 行头内容，如项目圆点 + 名称；缺省显示 name */
  label?: ReactNode
}

export interface HeatTableProps {
  rows: (string | HeatTableRow)[]
  columns: string[]
  /** data[行][列] */
  data: number[][]
  /** 左上角表头 */
  corner?: ReactNode
  formatValue?: (value: number) => string
  /** 色阶上限，默认取最大值 */
  max?: number
  /** 格内显示数值（默认显示） */
  showValues?: boolean
  'aria-label': string
  className?: string
}

/**
 * 热力表：两个维度交叉的强弱（Agent × 星期）。同一色相由浅到深表示大小，
 * 格内仍写数字——颜色帮助扫视，数字负责精确，色盲与打印同样可读。
 */
export function HeatTable({ rows, columns, data, corner, formatValue = defaultFormat, max, showValues = true, className, ...props }: HeatTableProps) {
  const ceiling = max ?? Math.max(1, ...data.flat())
  return (
    <div className={cn('overflow-x-auto scrollbar-app-thin', className)}>
      <table aria-label={props['aria-label']} className="border-separate border-spacing-[2px] text-[11px]">
        <thead>
          <tr>
            <th scope="col" className="pr-2 text-left font-normal text-muted-foreground">{corner}</th>
            {columns.map(column => (
              <th key={column} scope="col" className="h-6 min-w-9 px-1 text-center font-normal text-muted-foreground">{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => {
            const { name, label } = typeof row === 'string' ? { name: row, label: row } : row
            return (
              <tr key={rowIndex}>
                <th scope="row" className="whitespace-nowrap pr-2 text-left font-normal text-foreground/85">
                  <span className="block max-w-40 truncate">{label ?? name}</span>
                </th>
                {columns.map((column, columnIndex) => {
                  const value = data[rowIndex]?.[columnIndex] ?? 0
                  const level = quantize(value, ceiling, 7)
                  return (
                    <td
                      key={column}
                      title={`${name} · ${column}：${formatValue(value)}`}
                      className={cn('h-7 min-w-9 rounded-[3px] px-1 text-center tabular-nums transition-shadow hover:ring-2 hover:ring-foreground/70', inkOn(level))}
                      style={{ background: VIZ_RAMP[level] }}
                    >
                      {showValues ? formatValue(value) : <span className="sr-only">{formatValue(value)}</span>}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/* ── 日历热力 ─────────────────────────────────────────────── */

export interface CalendarHeatmapProps {
  /** 第一天（会自动对齐到所在周的周一） */
  start: Date
  /** 从 start 开始逐日的数值 */
  values: number[]
  /** 提示文案，如 (日期, 值) => '10月14日 · 12 次会话' */
  describe?: (date: Date, value: number) => string
  locale?: string
  'aria-label': string
  className?: string
}

const LEVELS = [0, 1, 3, 4, 6]

/**
 * 日历热力：一年里每天的活跃度。周为列、星期为行，5 档墨阶；
 * 只标月份与一、三、五，悬停看具体日期和数值。窄容器里格子自动缩小。
 */
export function CalendarHeatmap({ start, values, describe, locale, className, ...props }: CalendarHeatmapProps) {
  const [measureRef, width] = useElementWidth<HTMLDivElement>()
  const [hover, setHover] = useState<{ x: number; y: number; index: number } | null>(null)

  const offset = (start.getDay() + 6) % 7 // 周一为 0
  const weeks = Math.ceil((values.length + offset) / 7)
  const labelWidth = 22
  const gap = 2
  const cell = clamp(Math.floor((width - labelWidth) / weeks) - gap, 6, 13)
  const pitch = cell + gap
  const top = 16
  const height = top + pitch * 7
  const ceiling = Math.max(1, ...values)
  const monthFormat = new Intl.DateTimeFormat(locale, { month: 'short' })
  const weekdayFormat = new Intl.DateTimeFormat(locale, { weekday: 'narrow' })
  const dateAt = (index: number) => addDays(start, index)

  // 月份标签：每月 1 号所在的那一周
  const months: { week: number; label: string }[] = []
  for (let index = 0; index < values.length; index++) {
    const date = dateAt(index)
    if (date.getDate() === 1) {
      const week = Math.floor((index + offset) / 7)
      if (!months.length || week - months[months.length - 1].week >= 3) months.push({ week, label: monthFormat.format(date) })
    }
  }
  const monday = addDays(start, -offset)

  return (
    <div ref={measureRef} className={cn('relative w-full', className)} onPointerLeave={() => setHover(null)}>
      {width === 0 ? (
        <ChartPlaceholder height={height} />
      ) : (
        <svg width={labelWidth + weeks * pitch} height={height} role="img" aria-label={props['aria-label']} className="block">
          {months.map(month => (
            <text key={month.week} x={labelWidth + month.week * pitch} y={10} className="fill-muted-foreground text-[10px]">{month.label}</text>
          ))}
          {[0, 2, 4].map(day => (
            <text key={day} x={0} y={top + day * pitch + cell / 2} dy="0.32em" className="fill-muted-foreground text-[10px]">
              {weekdayFormat.format(addDays(monday, day))}
            </text>
          ))}
          {values.map((value, index) => {
            const position = index + offset
            const week = Math.floor(position / 7)
            const day = position % 7
            const level = LEVELS[quantize(value, ceiling, LEVELS.length)]
            const x = labelWidth + week * pitch
            const y = top + day * pitch
            return (
              <rect
                key={index}
                x={x}
                y={y}
                width={cell}
                height={cell}
                rx={2}
                fill={VIZ_RAMP[level]}
                stroke={hover?.index === index ? VIZ.text : 'none'}
                strokeWidth={1.5}
                onPointerEnter={() => setHover({ x: x + cell, y, index })}
              />
            )
          })}
        </svg>
      )}
      {hover && width > 0 && (
        <ChartTooltip
          x={hover.x}
          y={hover.y}
          containerWidth={width}
          containerHeight={height}
          rows={[{
            label: describe ? describe(dateAt(hover.index), values[hover.index]) : dateAt(hover.index).toLocaleDateString(locale),
            value: values[hover.index],
            swatch: 'solid',
            color: VIZ_RAMP[LEVELS[quantize(values[hover.index], ceiling, LEVELS.length)]],
          }]}
        />
      )}
    </div>
  )
}
