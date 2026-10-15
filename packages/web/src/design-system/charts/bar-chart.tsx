import { useState, type KeyboardEvent } from 'react'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { useElementWidth, useSvgId } from '../lib/hooks'
import { bandLayout, columnPath, linearScale, niceDomain } from '../lib/scale'
import { VIZ } from '../tokens'
import { ChartPlaceholder, ChartTooltip, HatchPattern, LiveReadout, XLabels, YGrid } from './chart-parts'
import { CHART_FOCUS, crisp, defaultFormat, estimateLabelWidth, estimateTextWidth, nextIndexForKey, stackColors, type SeriesVariant } from './chart-utils'

const BAR_GAP = 2
const MAX_BAR = 24

function useBarInteraction(count: number) {
  const [active, setActive] = useState<number | null>(null)
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = nextIndexForKey(event.key, active, count)
    if (next === undefined) return
    event.preventDefault()
    setActive(next)
  }
  return { active, setActive, handleKeyDown }
}

/* ── 分组柱图 ─────────────────────────────────────────────── */

export interface BarSeries {
  id: string
  label: string
  values: number[]
  /** ink 实际（实心墨色）· context 对比（灰）· plan 计划 / 预算（斜纹） */
  variant?: SeriesVariant
}

export interface BarChartProps {
  labels: string[]
  series: BarSeries[]
  height?: number
  formatValue?: (value: number) => string
  /** 在哪一组柱顶标数值（默认最后一组，null 不标）；不要给每根柱都标数 */
  highlightIndex?: number | null
  /** 水平基准线：目标、均值 */
  baseline?: { value: number; label: string }
  'aria-label': string
  className?: string
}

/**
 * 柱图：比较各期大小。柱宽封顶 24px（不填满槽位），4px 数据端圆角、基线直角，相邻柱留 2px 白缝。
 * 实际 = 实心墨色，计划 / 预算 = 斜纹（实与虚）。悬停整组高亮，其余淡出。
 */
export function BarChart({ labels, series, height = 220, formatValue = defaultFormat, highlightIndex, baseline, className, ...props }: BarChartProps) {
  const [measureRef, width] = useElementWidth<HTMLDivElement>()
  const { active, setActive, handleKeyDown } = useBarInteraction(labels.length)
  const hatchId = useSvgId('bar-hatch')

  const count = labels.length
  const numbers = series.flatMap(item => item.values)
  const domain = niceDomain(baseline ? [...numbers, baseline.value] : numbers, { count: 4 })
  const top = 18
  const bottom = 26
  const left = estimateLabelWidth(domain.ticks.map(formatValue))
  const plotW = Math.max(0, width - left - 8)
  const plotH = Math.max(0, height - top - bottom)
  const y = linearScale([domain.min, domain.max], [top + plotH, top])
  const zero = y(Math.max(0, domain.min))
  const band = bandLayout(count, left, left + plotW, { paddingInner: 0.35, paddingOuter: 0.2 })
  const barWidth = Math.max(2, Math.min(MAX_BAR, (band.bandwidth - BAR_GAP * (series.length - 1)) / Math.max(1, series.length)))
  const groupWidth = barWidth * series.length + BAR_GAP * (series.length - 1)
  const labelIndex = highlightIndex === undefined ? count - 1 : highlightIndex
  const fill = (variant: SeriesVariant = 'ink') => (variant === 'plan' ? `url(#${hatchId})` : variant === 'context' ? VIZ.context : VIZ.ink)
  const barX = (index: number, seriesIndex: number) => band.center(index) - groupWidth / 2 + seriesIndex * (barWidth + BAR_GAP)
  const groupTop = (index: number) => Math.min(...series.map(item => y(Math.max(0, item.values[index] ?? 0))))
  // 标数的是实际（第一个 ink 系列）：数字落在它自己的柱顶；放不下又会压到更高的邻柱时，退到整组上方居中
  const valueLabel = (() => {
    if (labelIndex === null || labelIndex < 0 || labelIndex >= count) return null
    const seriesIndex = Math.max(0, series.findIndex(item => (item.variant ?? 'ink') === 'ink'))
    const value = series[seriesIndex]?.values[labelIndex] ?? 0
    const text = formatValue(value)
    const barTop = y(Math.max(0, value))
    const onBar = estimateTextWidth(text) <= barWidth + BAR_GAP * 2 || barTop <= groupTop(labelIndex)
    return {
      text,
      x: onBar ? barX(labelIndex, seriesIndex) + barWidth / 2 : band.center(labelIndex),
      y: (onBar ? barTop : groupTop(labelIndex)) - 6,
    }
  })()

  return (
    <div ref={measureRef} className={cn('relative w-full', className)} onPointerLeave={() => setActive(null)}>
      {width === 0 ? (
        <ChartPlaceholder height={height} />
      ) : (
        <div role="img" aria-label={props['aria-label']} tabIndex={0} onKeyDown={handleKeyDown} onBlur={() => setActive(null)} className={CHART_FOCUS}>
          <svg width={width} height={height} className="block overflow-visible" aria-hidden="true">
            <defs>
              <HatchPattern id={hatchId} />
            </defs>
            <YGrid ticks={domain.ticks} y={y} left={left} right={left + plotW} format={formatValue} />
            {labels.map((label, index) => (
              <g key={label + index} opacity={active !== null && active !== index ? 0.4 : 1} className="transition-opacity duration-150">
                {series.map((item, seriesIndex) => {
                  const value = item.values[index] ?? 0
                  const barTop = y(Math.max(0, value))
                  return <path key={item.id} d={columnPath(barX(index, seriesIndex), barTop, barWidth, zero - barTop, 4)} fill={fill(item.variant)} />
                })}
                {valueLabel && labelIndex === index && (
                  <text x={valueLabel.x} y={valueLabel.y} textAnchor="middle" className="fill-foreground text-[11px] font-semibold tabular-nums">
                    {valueLabel.text}
                  </text>
                )}
              </g>
            ))}
            {baseline && (
              <g>
                <line x1={left} x2={left + plotW} y1={crisp(y(baseline.value))} y2={crisp(y(baseline.value))} stroke="var(--viz-4)" strokeWidth={1} strokeDasharray="4 3" />
                <text x={left + plotW} y={y(baseline.value) - 5} textAnchor="end" className="fill-muted-foreground text-[11px] tabular-nums">
                  {baseline.label} {formatValue(baseline.value)}
                </text>
              </g>
            )}
            <XLabels labels={labels} x={band.center} y={height - 8} width={plotW} minGap={36} activeIndex={active} />
            {labels.map((label, index) => (
              <rect
                key={`hit-${label}-${index}`}
                x={band.center(index) - band.step / 2}
                y={top}
                width={band.step}
                height={plotH}
                fill="transparent"
                onPointerEnter={() => setActive(index)}
              />
            ))}
          </svg>
        </div>
      )}
      {active !== null && width > 0 && (
        <ChartTooltip
          x={band.center(active) + groupWidth / 2}
          y={groupTop(active)}
          containerWidth={width}
          containerHeight={height}
          title={labels[active]}
          rows={series.map(item => ({
            label: item.label,
            value: formatValue(item.values[active] ?? 0),
            color: item.variant === 'context' ? VIZ.context : VIZ.ink,
            swatch: item.variant === 'plan' ? 'hatch' : 'solid',
          }))}
        />
      )}
      <LiveReadout>
        {active !== null ? `${labels[active]}：${series.map(item => `${item.label} ${formatValue(item.values[active] ?? 0)}`).join('，')}` : ''}
      </LiveReadout>
    </div>
  )
}

/* ── 堆叠柱图 ─────────────────────────────────────────────── */

export interface StackedBarChartProps {
  labels: string[]
  /** 自下而上的分段（应是有序类别：时长分桶、规模档位） */
  segments: { id: string; label: string }[]
  /** data[类别][分段] */
  data: number[][]
  /** 分段颜色，默认序数墨阶：最下层最深 */
  colors?: string[]
  height?: number
  formatValue?: (value: number) => string
  /** 在哪一根柱顶标合计（默认最后一根） */
  highlightIndex?: number | null
  'aria-label': string
  className?: string
}

/**
 * 堆叠柱：看构成随时间的变化。分段之间 2px 白缝分隔（不画描边），顶段带圆角。
 * 分段应是有序类别，用同色相深浅区分；无序类别超过 3 个时改用小多图或表格。
 */
export function StackedBarChart({ labels, segments, data, colors, height = 220, formatValue = defaultFormat, highlightIndex, className, ...props }: StackedBarChartProps) {
  const { t } = useI18n()
  const [measureRef, width] = useElementWidth<HTMLDivElement>()
  const { active, setActive, handleKeyDown } = useBarInteraction(labels.length)

  const count = labels.length
  const palette = colors ?? stackColors(segments.length)
  const totals = data.map(row => row.reduce((sum, value) => sum + value, 0))
  const domain = niceDomain(totals, { count: 4 })
  const top = 18
  const bottom = 26
  const left = estimateLabelWidth(domain.ticks.map(formatValue))
  const plotW = Math.max(0, width - left - 8)
  const plotH = Math.max(0, height - top - bottom)
  const y = linearScale([domain.min, domain.max], [top + plotH, top])
  const band = bandLayout(count, left, left + plotW, { paddingInner: 0.4, paddingOuter: 0.2 })
  const barWidth = Math.max(2, Math.min(MAX_BAR, band.bandwidth))
  const labelIndex = highlightIndex === undefined ? count - 1 : highlightIndex

  // 预先算好每根柱的分段几何：自下而上累加，非底层分段让出 2px 白缝，最上一段带圆角
  const columns = labels.map((label, index) => {
    const row = data[index] ?? []
    const parts: { segmentIndex: number; top: number; height: number; rounded: boolean }[] = []
    let cumulative = 0
    let topSegment = -1
    for (let segmentIndex = 0; segmentIndex < row.length; segmentIndex++) {
      if (row[segmentIndex] > 0) topSegment = segmentIndex
    }
    for (let segmentIndex = 0; segmentIndex < row.length; segmentIndex++) {
      const value = row[segmentIndex]
      if (value <= 0) continue
      const base = y(cumulative)
      const isFirst = cumulative === 0
      cumulative += value
      const top = y(cumulative)
      const bottomEdge = isFirst ? base : base - BAR_GAP
      if (bottomEdge - top > 0) parts.push({ segmentIndex, top, height: bottomEdge - top, rounded: segmentIndex === topSegment })
    }
    return { key: `${label}-${index}`, index, x: band.center(index) - barWidth / 2, parts }
  })

  return (
    <div ref={measureRef} className={cn('relative w-full', className)} onPointerLeave={() => setActive(null)}>
      {width === 0 ? (
        <ChartPlaceholder height={height} />
      ) : (
        <div role="img" aria-label={props['aria-label']} tabIndex={0} onKeyDown={handleKeyDown} onBlur={() => setActive(null)} className={CHART_FOCUS}>
          <svg width={width} height={height} className="block overflow-visible" aria-hidden="true">
            <YGrid ticks={domain.ticks} y={y} left={left} right={left + plotW} format={formatValue} />
            {columns.map(column => (
              <g key={column.key} opacity={active !== null && active !== column.index ? 0.4 : 1} className="transition-opacity duration-150">
                {column.parts.map(part => part.rounded
                  ? <path key={part.segmentIndex} d={columnPath(column.x, part.top, barWidth, part.height, 4)} fill={palette[part.segmentIndex]} />
                  : <rect key={part.segmentIndex} x={column.x} y={part.top} width={barWidth} height={part.height} fill={palette[part.segmentIndex]} />)}
                {labelIndex === column.index && (
                  <text x={band.center(column.index)} y={y(totals[column.index]) - 6} textAnchor="middle" className="fill-foreground text-[11px] font-semibold tabular-nums">
                    {formatValue(totals[column.index])}
                  </text>
                )}
              </g>
            ))}
            <XLabels labels={labels} x={band.center} y={height - 8} width={plotW} minGap={36} activeIndex={active} />
            {labels.map((label, index) => (
              <rect
                key={`hit-${label}-${index}`}
                x={band.center(index) - band.step / 2}
                y={top}
                width={band.step}
                height={plotH}
                fill="transparent"
                onPointerEnter={() => setActive(index)}
              />
            ))}
          </svg>
        </div>
      )}
      {active !== null && width > 0 && (
        <ChartTooltip
          x={band.center(active) + barWidth / 2}
          y={y(totals[active])}
          containerWidth={width}
          containerHeight={height}
          title={labels[active]}
          rows={segments.map((segment, segmentIndex) => ({
            label: segment.label,
            value: formatValue(data[active]?.[segmentIndex] ?? 0),
            color: palette[segmentIndex],
            swatch: 'solid' as const,
          })).reverse()}
          footer={`${t('Total')} ${formatValue(totals[active])}`}
        />
      )}
      <LiveReadout>
        {active !== null ? `${labels[active]}：${segments.map((segment, segmentIndex) => `${segment.label} ${formatValue(data[active]?.[segmentIndex] ?? 0)}`).join('，')}` : ''}
      </LiveReadout>
    </div>
  )
}
