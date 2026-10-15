import { formatNumber } from '../lib/format'
import { ordinalRamp, VIZ } from '../tokens'

/** ink 主数据（实线 / 实心）· context 对比 / 上期（灰）· plan 计划 / 目标（虚线 / 斜纹）——「实与虚」 */
export type SeriesVariant = 'ink' | 'context' | 'plan'

export const SERIES_COLOR: Record<SeriesVariant, string> = {
  ink: VIZ.ink,
  context: VIZ.context,
  plan: 'var(--viz-4)',
}

/** 1px 线画在半像素上才清晰 */
export function crisp(value: number) {
  return Math.round(value) + 0.5
}

/** 估算 11px 文字宽度（tabular 数字约 6.6px/字，中文按 2 字宽计） */
export function estimateTextWidth(label: string) {
  return Array.from(label).reduce((sum, char) => sum + (char.charCodeAt(0) > 0x2e80 ? 2 : 1), 0) * 6.6
}

/** 估算刻度文字所需宽度：最宽的一条 + 10px 间距 */
export function estimateLabelWidth(labels: string[]) {
  return Math.ceil(Math.max(0, ...labels.map(estimateTextWidth))) + 10
}

/** 默认数值格式：紧凑写法 */
export function defaultFormat(value: number) {
  return formatNumber(value, { compact: true })
}

/**
 * X 轴标签抽稀：按可用宽度每隔 step 个显示一个，末尾总是显示；
 * 有光标时显示光标处标签并隐藏与之相撞的邻居。
 */
export function visibleLabelIndices(count: number, width: number, minGap: number, activeIndex?: number | null) {
  const capacity = Math.max(2, Math.floor(width / minGap))
  const step = Math.max(1, Math.ceil(count / capacity))
  const visible = new Set<number>()
  for (let index = 0; index < count; index += step) visible.add(index)
  const lastIncluded = Math.floor((count - 1) / step) * step
  if (count > 0 && lastIncluded !== count - 1) {
    if (count - 1 - lastIncluded < step * 0.6 && lastIncluded !== 0) visible.delete(lastIncluded)
    visible.add(count - 1)
  }
  if (activeIndex !== null && activeIndex !== undefined && activeIndex >= 0 && activeIndex < count) {
    for (const index of [...visible]) {
      if (index !== activeIndex && Math.abs(index - activeIndex) < step) visible.delete(index)
    }
    visible.add(activeIndex)
  }
  return visible
}

/** 图表容器可聚焦：方向键移动光标，与悬停看到的一致 */
export const CHART_FOCUS = 'rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2'

/**
 * 方向键在 [0, count) 内移动光标；未激活时从最后一个点开始。
 * 只响应与图表方向一致的方向键，另一轴留给页面滚动。返回 undefined 表示该按键不处理。
 */
export function nextIndexForKey(key: string, current: number | null, count: number, axis: 'x' | 'y' = 'x'): number | undefined {
  if (count === 0) return undefined
  const from = current ?? count - 1
  const forward = axis === 'x' ? 'ArrowRight' : 'ArrowDown'
  const backward = axis === 'x' ? 'ArrowLeft' : 'ArrowUp'
  switch (key) {
    case forward:
      return current === null ? from : Math.min(count - 1, from + 1)
    case backward:
      return current === null ? from : Math.max(0, from - 1)
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return undefined
  }
}

/** 堆叠柱 / 环图的默认配色：序数墨阶，第一段最深（图例取色请用同一函数） */
export function stackColors(count: number) {
  return ordinalRamp(count).slice().reverse()
}
