import { cn } from '@/lib/utils'
import { useSvgId } from '../lib/hooks'
import { linearScale } from '../lib/scale'
import { VIZ } from '../tokens'

export interface SparklineProps {
  values: number[]
  width?: number
  height?: number
  /** 面积淡填充（单系列趋势） */
  area?: boolean
  /** 标出最后一个点（当前值） */
  showLast?: boolean
  /** 基准线，如目标值或上期均值（虚线） */
  baseline?: number
  tone?: 'ink' | 'context'
  'aria-label'?: string
  className?: string
}

/**
 * 走势线：只看形状不看刻度的小折线，放在统计卡、表格行里。
 * 1.5px 线 + 最后一点圆点（带白描边）；不画坐标轴，具体数字交给旁边的文字。
 */
export function Sparkline({ values, width = 96, height = 28, area = false, showLast = true, baseline, tone = 'ink', className, ...props }: SparklineProps) {
  const gradientId = useSvgId('spark')
  if (values.length < 2) return null

  const pad = 3
  const all = baseline !== undefined ? [...values, baseline] : values
  const min = Math.min(...all)
  const max = Math.max(...all)
  const x = linearScale([0, values.length - 1], [pad, width - pad])
  const y = linearScale([min, max === min ? min + 1 : max], [height - pad, pad])
  const points = values.map((value, index) => [x(index), y(value)] as const)
  const line = points.map(([px, py], index) => `${index === 0 ? 'M' : 'L'}${px.toFixed(1)},${py.toFixed(1)}`).join('')
  const color = tone === 'ink' ? VIZ.ink : VIZ.context
  const [lastX, lastY] = points[points.length - 1]

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={props['aria-label']}
      aria-hidden={props['aria-label'] ? undefined : true}
      className={cn('shrink-0 overflow-visible', className)}
    >
      {area && (
        <>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.12} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <path d={`${line}L${lastX.toFixed(1)},${height}L${points[0][0].toFixed(1)},${height}Z`} fill={`url(#${gradientId})`} />
        </>
      )}
      {baseline !== undefined && (
        <line x1={pad} x2={width - pad} y1={y(baseline)} y2={y(baseline)} stroke={VIZ.axis} strokeWidth={1} strokeDasharray="2 2" />
      )}
      <path d={line} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      {showLast && <circle cx={lastX} cy={lastY} r={2.5} fill={color} stroke={VIZ.surface} strokeWidth={1.5} />}
    </svg>
  )
}
