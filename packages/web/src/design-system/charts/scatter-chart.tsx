import { useState, type KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'
import { useElementWidth } from '../lib/hooks'
import { linearScale, niceDomain } from '../lib/scale'
import { VIZ } from '../tokens'
import { ChartPlaceholder, ChartTooltip, LiveReadout, YGrid } from './chart-parts'
import { CHART_FOCUS, crisp, defaultFormat, estimateLabelWidth, estimateTextWidth, nextIndexForKey } from './chart-utils'

export interface ScatterPoint {
  id: string
  x: number
  y: number
  label?: string
  /** 需要读者注意的点（离群、当前对象）：墨色，其余为灰 */
  emphasis?: boolean
}

export interface ScatterChartProps {
  points: ScatterPoint[]
  xLabel: string
  yLabel: string
  height?: number
  formatX?: (value: number) => string
  formatY?: (value: number) => string
  'aria-label': string
  className?: string
}

/**
 * 散点图：两个度量之间的关系（时长 × Token）。点 8px 带 2px 白描边，重叠时仍可分辨；
 * 每个点的可悬停范围是 24px，不需要瞄准。有 emphasis 的点用墨色并直接写上 label，其余为灰。
 * 方向键按 X 从小到大逐点移动。
 */
export function ScatterChart({ points, xLabel, yLabel, height = 240, formatX = defaultFormat, formatY = defaultFormat, className, ...props }: ScatterChartProps) {
  const [measureRef, width] = useElementWidth<HTMLDivElement>()
  const [active, setActive] = useState<string | null>(null)

  const xDomain = niceDomain(points.map(point => point.x), { count: 5 })
  const yDomain = niceDomain(points.map(point => point.y), { count: 4 })
  const left = estimateLabelWidth(yDomain.ticks.map(formatY))
  const top = 18
  const bottom = 36
  const right = 12
  const plotW = Math.max(0, width - left - right)
  const plotH = Math.max(0, height - top - bottom)
  const x = linearScale([xDomain.min, xDomain.max], [left, left + plotW])
  const y = linearScale([yDomain.min, yDomain.max], [top + plotH, top])
  const hasEmphasis = points.some(point => point.emphasis)
  const activePoint = points.find(point => point.id === active)
  // 主角点最后画，压在灰点之上
  const ordered = [...points].sort((a, b) => Number(Boolean(a.emphasis)) - Number(Boolean(b.emphasis)))
  const byX = [...points].sort((a, b) => a.x - b.x || a.y - b.y)

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = byX.findIndex(point => point.id === active)
    const next = nextIndexForKey(event.key, current === -1 ? null : current, byX.length)
    if (next === undefined) return
    event.preventDefault()
    setActive(byX[next].id)
  }

  return (
    <div ref={measureRef} className={cn('relative w-full', className)} onPointerLeave={() => setActive(null)}>
      {width === 0 ? (
        <ChartPlaceholder height={height} />
      ) : (
        <div role="img" aria-label={props['aria-label']} tabIndex={0} onKeyDown={handleKeyDown} onBlur={() => setActive(null)} className={CHART_FOCUS}>
          <svg width={width} height={height} className="block overflow-visible" aria-hidden="true">
            <YGrid ticks={yDomain.ticks} y={y} left={left} right={left + plotW} format={formatY} />
            {xDomain.ticks.map(tick => (
              <g key={tick}>
                <line x1={crisp(x(tick))} x2={crisp(x(tick))} y1={top} y2={top + plotH} stroke={tick === xDomain.min ? VIZ.axis : VIZ.grid} />
                <text x={x(tick)} y={top + plotH + 16} textAnchor="middle" className="fill-muted-foreground text-[11px] tabular-nums">{formatX(tick)}</text>
              </g>
            ))}
            <text x={left + plotW} y={height - 2} textAnchor="end" className="fill-muted-foreground text-[11px]">{xLabel} →</text>
            <text x={left} y={top - 6} textAnchor="start" className="fill-muted-foreground text-[11px]">↑ {yLabel}</text>
            {ordered.map(point => {
              const strong = !hasEmphasis || point.emphasis || point.id === active
              return (
                <g key={point.id} onPointerEnter={() => setActive(point.id)}>
                  <circle cx={x(point.x)} cy={y(point.y)} r={12} fill="transparent" />
                  <circle
                    cx={x(point.x)}
                    cy={y(point.y)}
                    r={point.id === active ? 5 : 4}
                    fill={strong ? VIZ.ink : VIZ.context}
                    stroke={VIZ.surface}
                    strokeWidth={2}
                  />
                </g>
              )
            })}
            {ordered.map(point => {
              if (!point.emphasis || !point.label) return null
              // 默认写在点的右侧，放不下就换到左侧；白色描边让文字压在网格线上也清楚
              const cx = x(point.x)
              const flip = cx + 9 + estimateTextWidth(point.label) > left + plotW
              return (
                <text
                  key={`label-${point.id}`}
                  x={flip ? cx - 9 : cx + 9}
                  y={y(point.y) + 4}
                  textAnchor={flip ? 'end' : 'start'}
                  stroke={VIZ.surface}
                  strokeWidth={3}
                  strokeLinejoin="round"
                  paintOrder="stroke"
                  className="pointer-events-none fill-foreground text-[11px]"
                >
                  {point.label}
                </text>
              )
            })}
          </svg>
        </div>
      )}
      {activePoint && width > 0 && (
        <ChartTooltip
          x={x(activePoint.x)}
          y={y(activePoint.y)}
          containerWidth={width}
          containerHeight={height}
          title={activePoint.label}
          rows={[
            { label: xLabel, value: formatX(activePoint.x), swatch: 'dot' },
            { label: yLabel, value: formatY(activePoint.y), swatch: 'dot' },
          ]}
        />
      )}
      <LiveReadout>
        {activePoint ? `${activePoint.label ? `${activePoint.label}：` : ''}${xLabel} ${formatX(activePoint.x)}，${yLabel} ${formatY(activePoint.y)}` : ''}
      </LiveReadout>
    </div>
  )
}
