/**
 * 设计系统 token（TS 侧）。
 *
 * CSS 变量是唯一的值来源（src/index.css），这里只做两件事：
 * 1. 给组件一套「语气 → 类名」映射，保证同一语义在徽章、提示、图标里永远是同一种颜色；
 * 2. 给图表一组按角色命名的颜色引用（墨阶 / 对比灰 / 计划斜纹），图表代码只写角色不写色值。
 */

/** 语气：只有状态才有颜色，其余一律 neutral */
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

/** 图标、圆点、图形标记：基础状态色（白底上 ≥ 3:1） */
export const TONE_MARK: Record<Tone, string> = {
  neutral: 'text-muted-foreground',
  info: 'text-info',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-destructive',
}

/** 实心圆点 */
export const TONE_DOT: Record<Tone, string> = {
  neutral: 'bg-muted-foreground/60',
  info: 'bg-info',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-destructive',
}

/** 文字：*-ink，白底与浅着色底上 ≥ 4.5:1（neutral 用 foreground/70：muted 在 6% 灰底上只有 4.3:1） */
export const TONE_INK: Record<Tone, string> = {
  neutral: 'text-foreground/70',
  info: 'text-info-ink',
  success: 'text-success-ink',
  warning: 'text-warning-ink',
  danger: 'text-destructive-ink',
}

/** 浅着色底（徽章、提示条） */
export const TONE_SOFT: Record<Tone, string> = {
  neutral: 'bg-foreground/[0.06]',
  info: 'bg-info/10',
  success: 'bg-success/10',
  warning: 'bg-warning/10',
  danger: 'bg-destructive/10',
}

/** 实底（白字）：用 *-ink 作底色，白字才能达到 4.5:1 */
export const TONE_SOLID: Record<Tone, string> = {
  neutral: 'bg-primary text-primary-foreground',
  info: 'bg-info-ink text-white',
  success: 'bg-success-ink text-white',
  warning: 'bg-warning-ink text-white',
  danger: 'bg-destructive-ink text-white',
}

/** 图表角色色（CSS 变量引用，可直接写进 SVG 的 fill / stroke） */
export const VIZ = {
  /** 主数据：墨色（= Charcoal） */
  ink: 'var(--viz-6)',
  /** 对比 / 上期 / 其余：灰 */
  context: 'var(--viz-2)',
  /** 计划 / 预期的斜纹线色 */
  plan: 'var(--viz-3)',
  /** 空格子、轨道、斜纹底 */
  empty: 'var(--viz-0)',
  grid: 'var(--viz-grid)',
  axis: 'var(--viz-axis)',
  surface: 'var(--background)',
  label: 'var(--muted-foreground)',
  text: 'var(--foreground)',
} as const

/** 序列量级色阶：0 = 零值，6 = 最大 */
export const VIZ_RAMP = [
  'var(--viz-0)',
  'var(--viz-1)',
  'var(--viz-2)',
  'var(--viz-3)',
  'var(--viz-4)',
  'var(--viz-5)',
  'var(--viz-6)',
] as const

const ORDINAL_STEPS: Record<number, number[]> = {
  1: [6],
  2: [2, 6],
  3: [2, 4, 6],
  4: [2, 3, 4, 6],
  5: [2, 3, 4, 5, 6],
}

/**
 * 序数色阶：n 个有序类别（漏斗阶段、时长分桶）→ 由浅到深的墨阶。
 * 只取已通过 ordinal 校验的 2–6 档；超过 5 类说明该合并成「其他」或换成表格。
 */
export function ordinalRamp(count: number): string[] {
  const steps = ORDINAL_STEPS[Math.min(5, Math.max(1, count))]
  return steps.map(step => VIZ_RAMP[step])
}

/** 状态在图表中的标记色：只在数据本身就是状态时使用，且必须配图标或文字 */
export const STATUS_MARK: Record<Tone, string> = {
  neutral: 'var(--viz-2)',
  info: 'var(--info)',
  success: 'var(--success)',
  warning: 'var(--warning)',
  danger: 'var(--destructive)',
}

/** 动效时长（ms）与缓动，与 index.css 的 --ease-enter / --ease-move 一致 */
export const MOTION = {
  instant: 100,
  fast: 150,
  base: 200,
  enter: 250,
  move: 260,
  slow: 500,
  easeEnter: 'cubic-bezier(0.16, 1, 0.3, 1)',
  easeMove: 'cubic-bezier(0.2, 0, 0, 1)',
} as const

/**
 * 终端配色：与 xterm 主题（workspace/TerminalView）一致的 VS Code Dark。
 * 终端是全站唯一的常驻深色面，这组颜色只在终端 / 日志输出里使用。
 */
export const TERMINAL_THEME = {
  background: '#1e1e1e',
  foreground: '#d4d4d4',
  muted: '#808080',
  red: '#f44747',
  green: '#6a9955',
  yellow: '#d7ba7d',
  blue: '#569cd6',
  cyan: '#4ec9b0',
  magenta: '#c586c0',
} as const
