import { useState, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'
import { formatSignedPercent } from '../lib/format'
import { useElementWidth } from '../lib/hooks'
import { dodge, linearScale } from '../lib/scale'
import { VIZ } from '../tokens'
import { ChartPlaceholder, ChartTooltip, LiveReadout } from './chart-parts'
import { CHART_FOCUS, crisp, defaultFormat, estimateLabelWidth, nextIndexForKey } from './chart-utils'

export interface SlopeItem {
  id: string
  label: string
  start: number
  end: number
  /** 故事的主角：墨色加粗，其余为灰色背景线 */
  emphasis?: boolean
}

export interface SlopeChartProps {
  items: SlopeItem[]
  startLabel: string
  endLabel: string
  height?: number
  formatValue?: (value: number) => string
  /** 右侧变化量文案，默认相对变化百分比 */
  formatChange?: (item: SlopeItem) => string
  'aria-label': string
  className?: string
}

const LABEL_GAP = 15

function relativeChange(item: SlopeItem) {
  return item.start === 0 ? 0 : (item.end - item.start) / Math.abs(item.start)
}

/**
 * 斜坡图：两个时点之间「谁升谁降」。只强调一两条主角线，其余为灰色背景，
 * 两端直接标注名称与数值；标签相互避让，被挪动的标签用短引线连回端点。
 */
export function SlopeChart({ items, startLabel, endLabel, height = 240, formatValue = defaultFormat, formatChange, className, ...props }: SlopeChartProps) {
  const [measureRef, width] = useElementWidth<HTMLDivElement>()
  const [active, setActive] = useState<number | null>(null)

  const changeText = (item: SlopeItem) => (formatChange ? formatChange(item) : formatSignedPercent(relativeChange(item)))
  const leftTexts = items.map(item => `${item.label} ${formatValue(item.start)}`)
  const rightTexts = items.map(item => `${formatValue(item.end)} ${item.label} ${changeText(item)}`)
  const leftWidth = Math.min(estimateLabelWidth(leftTexts), width * 0.3)
  const rightWidth = Math.min(estimateLabelWidth(rightTexts), width * 0.4)
  const x1 = leftWidth + 6
  const x2 = Math.max(x1 + 40, width - rightWidth - 6)

  const top = 30
  const bottom = 12
  const values = items.flatMap(item => [item.start, item.end])
  const min = Math.min(...values)
  const max = Math.max(...values)
  const pad = (max - min || 1) * 0.06
  const y = linearScale([min - pad, max + pad], [height - bottom, top])

  const leftY = dodge(items.map(item => y(item.start)), LABEL_GAP, [top, height - bottom])
  const rightY = dodge(items.map(item => y(item.end)), LABEL_GAP, [top, height - bottom])
  const isEmphasized = (index: number) => (active !== null ? active === index : Boolean(items[index].emphasis))
  // 背景线先画，主角线后画，保证主角在最上层
  const order = items.map((_, index) => index).sort((a, b) => Number(isEmphasized(a)) - Number(isEmphasized(b)))

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = nextIndexForKey(event.key, active, items.length, 'y')
    if (next === undefined) return
    event.preventDefault()
    setActive(next)
  }

  return (
    <div ref={measureRef} className={cn('relative w-full', className)}>
      {width === 0 ? (
        <ChartPlaceholder height={height} />
      ) : (
        <div role="img" aria-label={props['aria-label']} tabIndex={0} onKeyDown={handleKeyDown} onBlur={() => setActive(null)} className={CHART_FOCUS}>
          <svg width={width} height={height} className="block overflow-visible" aria-hidden="true" onPointerLeave={() => setActive(null)}>
            <text x={x1} y={12} textAnchor="middle" className="fill-muted-foreground text-[11px]">{startLabel}</text>
            <text x={x2} y={12} textAnchor="middle" className="fill-muted-foreground text-[11px]">{endLabel}</text>
            <line x1={crisp(x1)} x2={crisp(x1)} y1={top - 8} y2={height - bottom + 4} stroke={VIZ.grid} />
            <line x1={crisp(x2)} x2={crisp(x2)} y1={top - 8} y2={height - bottom + 4} stroke={VIZ.grid} />

            {order.map(index => {
              const item = items[index]
              const strong = isEmphasized(index)
              const color = strong ? VIZ.ink : VIZ.context
              const startY = y(item.start)
              const endY = y(item.end)
              const change = relativeChange(item)
              return (
                <g key={item.id} onPointerEnter={() => setActive(index)}>
                  <line x1={x1} y1={startY} x2={x2} y2={endY} stroke="transparent" strokeWidth={14} />
                  <line x1={x1} y1={startY} x2={x2} y2={endY} stroke={color} strokeWidth={strong ? 2 : 1.5} strokeLinecap="round" />
                  <circle cx={x1} cy={startY} r={strong ? 4 : 3} fill={color} stroke={VIZ.surface} strokeWidth={2} />
                  <circle cx={x2} cy={endY} r={strong ? 4 : 3} fill={color} stroke={VIZ.surface} strokeWidth={2} />

                  {Math.abs(leftY[index] - startY) > 1.5 && (
                    <line x1={x1 - 5} y1={startY} x2={x1 - 9} y2={leftY[index]} stroke={VIZ.axis} />
                  )}
                  <text x={x1 - 11} y={leftY[index]} dy="0.32em" textAnchor="end" className="text-[11px] tabular-nums">
                    <tspan className={strong ? 'fill-foreground font-medium' : 'fill-muted-foreground'}>{item.label}</tspan>
                    <tspan dx={4} className={strong ? 'fill-foreground font-semibold' : 'fill-muted-foreground'}>{formatValue(item.start)}</tspan>
                  </text>

                  {Math.abs(rightY[index] - endY) > 1.5 && (
                    <line x1={x2 + 5} y1={endY} x2={x2 + 9} y2={rightY[index]} stroke={VIZ.axis} />
                  )}
                  <text x={x2 + 11} y={rightY[index]} dy="0.32em" className="text-[11px] tabular-nums">
                    <tspan className={strong ? 'fill-foreground font-semibold' : 'fill-muted-foreground'}>{formatValue(item.end)}</tspan>
                    <tspan dx={4} className={strong ? 'fill-foreground font-medium' : 'fill-muted-foreground'}>{item.label}</tspan>
                    <tspan
                      dx={4}
                      className={cn(
                        !strong ? 'fill-muted-foreground' : change > 0 ? 'fill-success-ink' : change < 0 ? 'fill-destructive-ink' : 'fill-muted-foreground',
                      )}
                    >
                      {changeText(item)}
                    </tspan>
                  </text>
                </g>
              )
            })}
          </svg>
        </div>
      )}
      {active !== null && width > 0 && (
        <ChartTooltip
          x={x2}
          y={y(items[active].end)}
          containerWidth={width}
          containerHeight={height}
          title={items[active].label}
          rows={[
            { label: startLabel, value: formatValue(items[active].start), color: VIZ.context },
            { label: endLabel, value: formatValue(items[active].end), color: VIZ.ink },
          ]}
          footer={changeText(items[active])}
        />
      )}
      <LiveReadout>
        {active !== null ? `${items[active].label}：${startLabel} ${formatValue(items[active].start)}，${endLabel} ${formatValue(items[active].end)}，${changeText(items[active])}` : ''}
      </LiveReadout>
    </div>
  )
}
