import { useState, type KeyboardEvent, type PointerEvent } from 'react'
import { cn } from '@/lib/utils'
import { useElementWidth, useSvgId } from '../lib/hooks'
import { clamp, linearScale, niceDomain } from '../lib/scale'
import { VIZ } from '../tokens'
import { ChartPlaceholder, ChartTooltip, LiveReadout, XLabels, YGrid } from './chart-parts'
import { CHART_FOCUS, crisp, defaultFormat, estimateLabelWidth, nextIndexForKey, SERIES_COLOR, type SeriesVariant } from './chart-utils'

export interface LineSeries {
  id: string
  label: string
  values: (number | null)[]
  variant?: SeriesVariant
  /** 面积淡填充：只给主系列 */
  area?: boolean
}

export interface LineChartProps {
  labels: string[]
  series: LineSeries[]
  height?: number
  formatValue?: (value: number) => string
  /** 竖线标记：今天、发布日 */
  marker?: { index: number; label: string }
  /** 水平基准线：目标、均值（虚线） */
  baseline?: { value: number; label: string }
  /** 线尾直接标注；标签会相撞时自动放弃，交给图例与提示 */
  endLabels?: boolean
  'aria-label': string
  className?: string
}

type Point = readonly [number, number]

function linePath(points: (Point | null)[]) {
  let d = ''
  let drawing = false
  for (const point of points) {
    if (!point) {
      drawing = false
      continue
    }
    d += `${drawing ? 'L' : 'M'}${point[0].toFixed(1)},${point[1].toFixed(1)}`
    drawing = true
  }
  return d
}

function areaPaths(points: (Point | null)[], floor: number) {
  const runs: Point[][] = []
  let run: Point[] = []
  for (const point of points) {
    if (point) run.push(point)
    else if (run.length) {
      runs.push(run)
      run = []
    }
  }
  if (run.length) runs.push(run)
  return runs
    .filter(segment => segment.length > 1)
    .map(segment => `${linePath(segment)}L${segment[segment.length - 1][0].toFixed(1)},${floor}L${segment[0][0].toFixed(1)},${floor}Z`)
}

function lastIndexOf(values: (number | null)[]) {
  for (let index = values.length - 1; index >= 0; index--) {
    if (values[index] !== null && Number.isFinite(values[index])) return index
  }
  return -1
}

/**
 * 折线图：看趋势。主系列墨色实线 + 淡面积，对比系列灰线，计划 / 目标虚线。
 * 悬停十字线吸附到最近的 X，提示里一次列出全部系列；聚焦后方向键逐点移动。
 */
export function LineChart({ labels, series, height = 220, formatValue = defaultFormat, marker, baseline, endLabels = true, className, ...props }: LineChartProps) {
  const [measureRef, width] = useElementWidth<HTMLDivElement>()
  const [active, setActive] = useState<number | null>(null)
  const areaId = useSvgId('line-area')

  const count = labels.length
  const numbers = series.flatMap(item => item.values.filter((value): value is number => value !== null && Number.isFinite(value)))
  const domain = niceDomain(baseline ? [...numbers, baseline.value] : numbers, { count: 4 })

  const top = marker ? 24 : 14
  const bottom = 26
  const plotH = Math.max(0, height - top - bottom)
  const y = linearScale([domain.min, domain.max], [top + plotH, top])

  // 线尾标签：先算纵向位置判断是否相撞，再决定右侧留白
  const lastIndices = series.map(item => lastIndexOf(item.values))
  const endTexts = series.map((item, index) => (lastIndices[index] >= 0 ? formatValue(item.values[lastIndices[index]] as number) : ''))
  const endYs = series.map((item, index) => (lastIndices[index] >= 0 ? y(item.values[lastIndices[index]] as number) : null)).filter((value): value is number => value !== null).sort((a, b) => a - b)
  const collides = endYs.some((value, index) => index > 0 && value - endYs[index - 1] < 14)
  const showEndLabels = endLabels && series.length <= 4 && !collides

  const left = estimateLabelWidth(domain.ticks.map(formatValue))
  const right = showEndLabels ? estimateLabelWidth(series.map((item, index) => `${endTexts[index]} ${item.label}`)) + 6 : 12
  const plotW = Math.max(0, width - left - right)
  const x = (index: number) => left + (count <= 1 ? plotW / 2 : (index / (count - 1)) * plotW)

  const points = series.map(item => item.values.map((value, index) => (value === null || !Number.isFinite(value) ? null : ([x(index), y(value)] as const))))
  const floor = y(Math.max(domain.min, 0))

  const handlePointerMove = (event: PointerEvent<SVGRectElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientX - rect.left) / Math.max(1, rect.width)
    setActive(clamp(Math.round(ratio * (count - 1)), 0, Math.max(0, count - 1)))
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = nextIndexForKey(event.key, active, count)
    if (next === undefined) return
    event.preventDefault()
    setActive(next)
  }

  const readValue = (item: LineSeries, index: number) => {
    const value = item.values[index]
    return value === null || value === undefined ? '—' : formatValue(value)
  }

  return (
    <div ref={measureRef} className={cn('relative w-full', className)}>
      {width === 0 ? (
        <ChartPlaceholder height={height} />
      ) : (
        <div role="img" aria-label={props['aria-label']} tabIndex={0} onKeyDown={handleKeyDown} onBlur={() => setActive(null)} className={CHART_FOCUS}>
          <svg width={width} height={height} className="block overflow-visible" aria-hidden="true">
            <defs>
              <linearGradient id={areaId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={VIZ.ink} stopOpacity={0.1} />
                <stop offset="100%" stopColor={VIZ.ink} stopOpacity={0.01} />
              </linearGradient>
            </defs>

            <YGrid ticks={domain.ticks} y={y} left={left} right={left + plotW} format={formatValue} />

            {baseline && (
              <g>
                <line x1={left} x2={left + plotW} y1={crisp(y(baseline.value))} y2={crisp(y(baseline.value))} stroke="var(--viz-4)" strokeWidth={1} strokeDasharray="4 3" />
                <text x={left + plotW} y={y(baseline.value) - 5} textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">
                  {baseline.label} {formatValue(baseline.value)}
                </text>
              </g>
            )}

            {series.map((item, index) => item.area && areaPaths(points[index], floor).map((d, runIndex) => (
              <path key={`${item.id}-area-${runIndex}`} d={d} fill={`url(#${areaId})`} />
            )))}

            {series.map((item, index) => {
              const variant = item.variant ?? 'ink'
              return (
                <path
                  key={item.id}
                  d={linePath(points[index])}
                  fill="none"
                  stroke={SERIES_COLOR[variant]}
                  strokeWidth={2}
                  strokeDasharray={variant === 'plan' ? '5 4' : undefined}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )
            })}

            {marker && marker.index >= 0 && marker.index < count && (
              <g>
                <line x1={crisp(x(marker.index))} x2={crisp(x(marker.index))} y1={top} y2={top + plotH} stroke={VIZ.text} strokeOpacity={0.35} strokeWidth={1} />
                <rect x={x(marker.index) - (marker.label.length * 11 + 10) / 2} y={top - 19} width={marker.label.length * 11 + 10} height={15} rx={4} fill={VIZ.text} />
                <text x={x(marker.index)} y={top - 8} textAnchor="middle" className="fill-background text-[10px] font-medium">{marker.label}</text>
              </g>
            )}

            {/* 线尾圆点 + 直接标签（计划线不画圆点） */}
            {series.map((item, index) => {
              const variant = item.variant ?? 'ink'
              const last = lastIndices[index]
              if (last < 0) return null
              const [px, py] = points[index][last] as Point
              return (
                <g key={`${item.id}-end`}>
                  {variant !== 'plan' && <circle cx={px} cy={py} r={4} fill={SERIES_COLOR[variant]} stroke={VIZ.surface} strokeWidth={2} />}
                  {showEndLabels && (
                    <text x={px + 9} y={py} dy="0.32em" className="text-[11px] tabular-nums">
                      <tspan className="fill-foreground font-semibold">{endTexts[index]}</tspan>
                      <tspan dx={4} className="fill-muted-foreground">{item.label}</tspan>
                    </text>
                  )}
                </g>
              )
            })}

            {active !== null && (
              <g>
                <line x1={crisp(x(active))} x2={crisp(x(active))} y1={top} y2={top + plotH} stroke={VIZ.axis} strokeWidth={1} />
                {series.map((item, index) => {
                  const point = points[index][active]
                  if (!point) return null
                  return <circle key={item.id} cx={point[0]} cy={point[1]} r={4} fill={SERIES_COLOR[item.variant ?? 'ink']} stroke={VIZ.surface} strokeWidth={2} />
                })}
              </g>
            )}

            <XLabels labels={labels} x={x} y={height - 8} width={plotW} activeIndex={active} />

            <rect
              x={left}
              y={top}
              width={plotW}
              height={plotH}
              fill="transparent"
              onPointerMove={handlePointerMove}
              onPointerLeave={() => setActive(null)}
            />
          </svg>
        </div>
      )}

      {active !== null && width > 0 && (
        <ChartTooltip
          x={x(active)}
          y={top + 4}
          containerWidth={width}
          containerHeight={height}
          title={labels[active]}
          rows={series.map(item => ({
            label: item.label,
            value: readValue(item, active),
            color: SERIES_COLOR[item.variant ?? 'ink'],
            swatch: item.variant === 'plan' ? 'dashed' : 'line',
          }))}
        />
      )}
      <LiveReadout>
        {active !== null ? `${labels[active]}：${series.map(item => `${item.label} ${readValue(item, active)}`).join('，')}` : ''}
      </LiveReadout>
    </div>
  )
}
