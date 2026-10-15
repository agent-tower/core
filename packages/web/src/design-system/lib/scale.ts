/**
 * 图表几何工具：比例尺、刻度、柱形与弧形路径。
 * 纯函数、无依赖，所有图表组件共用，保证同一套「细柱 + 4px 数据端圆角 + 直角基线」画法。
 */

export type Pair = readonly [number, number]

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

/** 线性比例尺：domain → range */
export function linearScale(domain: Pair, range: Pair) {
  const [d0, d1] = domain
  const [r0, r1] = range
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0)
  return (value: number) => r0 + (value - d0) * k
}

/** 「好读」的刻度步长：1 / 2 / 5 × 10ⁿ */
export function niceStep(span: number, count: number) {
  if (!(span > 0) || count <= 0) return 1
  const raw = span / count
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const residual = raw / magnitude
  const factor = residual >= 7.5 ? 10 : residual >= 3.5 ? 5 : residual >= 1.5 ? 2 : 1
  return factor * magnitude
}

function roundToStep(value: number, step: number) {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)))
  return Number(value.toFixed(decimals))
}

export interface NiceDomain {
  min: number
  max: number
  ticks: number[]
}

/** 把数据范围扩到整齐的刻度上；默认包含 0（柱形必须从 0 起） */
export function niceDomain(
  values: readonly number[],
  { count = 4, includeZero = true }: { count?: number; includeZero?: boolean } = {},
): NiceDomain {
  const finite = values.filter(Number.isFinite)
  let lo = finite.length ? Math.min(...finite) : 0
  let hi = finite.length ? Math.max(...finite) : 1
  if (includeZero) {
    lo = Math.min(0, lo)
    hi = Math.max(0, hi)
  }
  if (lo === hi) hi = lo + 1
  const step = niceStep(hi - lo, count)
  const min = roundToStep(Math.floor(lo / step) * step, step)
  const max = roundToStep(Math.ceil(hi / step) * step, step)
  const ticks: number[] = []
  for (let value = min; value <= max + step / 2; value += step) ticks.push(roundToStep(value, step))
  return { min, max, ticks }
}

/** 等分带：柱形 / 分组的横向布局 */
export function bandLayout(
  count: number,
  start: number,
  end: number,
  { paddingInner = 0.4, paddingOuter = 0.2 }: { paddingInner?: number; paddingOuter?: number } = {},
) {
  const n = Math.max(1, count)
  const step = (end - start) / (n - paddingInner + paddingOuter * 2)
  const bandwidth = step * (1 - paddingInner)
  const offset = start + step * paddingOuter
  return {
    step,
    bandwidth,
    x: (index: number) => offset + index * step,
    center: (index: number) => offset + index * step + bandwidth / 2,
  }
}

/** 纵向柱：数据端（顶部）圆角，基线端直角 */
export function columnPath(x: number, y: number, width: number, height: number, radius = 4) {
  if (!(height > 0) || !(width > 0)) return ''
  const r = Math.min(radius, width / 2, height)
  return [
    `M${x},${y + height}`,
    `V${y + r}`,
    `A${r},${r} 0 0 1 ${x + r},${y}`,
    `H${x + width - r}`,
    `A${r},${r} 0 0 1 ${x + width},${y + r}`,
    `V${y + height}`,
    'Z',
  ].join('')
}

/** 横向条：数据端（右侧）圆角，基线端直角 */
export function barPath(x: number, y: number, width: number, height: number, radius = 4) {
  if (!(height > 0) || !(width > 0)) return ''
  const r = Math.min(radius, height / 2, width)
  return [
    `M${x},${y}`,
    `H${x + width - r}`,
    `A${r},${r} 0 0 1 ${x + width},${y + r}`,
    `V${y + height - r}`,
    `A${r},${r} 0 0 1 ${x + width - r},${y + height}`,
    `H${x}`,
    'Z',
  ].join('')
}

function polar(cx: number, cy: number, radius: number, angle: number): Pair {
  // 0 rad = 12 点方向，顺时针
  return [cx + radius * Math.sin(angle), cy - radius * Math.cos(angle)]
}

/** 环形扇区（donut / ring）。角度为弧度，0 = 12 点方向，顺时针 */
export function arcPath(cx: number, cy: number, outer: number, inner: number, start: number, end: number): string {
  const sweep = end - start
  if (sweep <= 0) return ''
  if (sweep >= Math.PI * 2 - 1e-6) {
    // 整圆：两段半圆拼接，避免起止点重合导致路径退化
    const mid = start + Math.PI
    return `${arcPath(cx, cy, outer, inner, start, mid)}${arcPath(cx, cy, outer, inner, mid, start + Math.PI * 2 - 1e-6)}`
  }
  const large = sweep > Math.PI ? 1 : 0
  const [x0, y0] = polar(cx, cy, outer, start)
  const [x1, y1] = polar(cx, cy, outer, end)
  const [x2, y2] = polar(cx, cy, inner, end)
  const [x3, y3] = polar(cx, cy, inner, start)
  return [
    `M${x0},${y0}`,
    `A${outer},${outer} 0 ${large} 1 ${x1},${y1}`,
    `L${x2},${y2}`,
    `A${inner},${inner} 0 ${large} 0 ${x3},${y3}`,
    'Z',
  ].join('')
}

/**
 * 标签避让：保持原有上下顺序，相邻至少间隔 minGap，并收回到 [lo, hi] 内。
 * 返回与输入同序的新位置（用于斜坡图两端标签，移动过的标签配引导线）。
 */
export function dodge(positions: readonly number[], minGap: number, [lo, hi]: Pair): number[] {
  const order = positions.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value)
  const placed = order.map(item => item.value)
  const pushDown = () => {
    for (let k = 1; k < placed.length; k++) placed[k] = Math.max(placed[k], placed[k - 1] + minGap)
  }
  pushDown()
  const last = placed.length - 1
  if (last >= 0 && placed[last] > hi) {
    placed[last] = hi
    for (let k = last - 1; k >= 0; k--) placed[k] = Math.min(placed[k], placed[k + 1] - minGap)
  }
  if (last >= 0 && placed[0] < lo) {
    // 空间不够时优先保证顶部不出界，底部允许略超
    placed[0] = lo
    pushDown()
  }
  const result = new Array<number>(positions.length)
  order.forEach((item, k) => {
    result[item.index] = placed[k]
  })
  return result
}

/** 把数值按阈值量化成 0..steps-1 的档位（热力图 / 日历热力） */
export function quantize(value: number, max: number, steps: number) {
  if (!(value > 0) || !(max > 0)) return 0
  return clamp(Math.ceil((value / max) * (steps - 1)), 1, steps - 1)
}
