/**
 * 数字格式化：图表刻度、统计卡、表格共用。
 * 规则：≥ 1 万（中文）/ 1K（英文）自动紧凑；百分比默认整数；带符号的变化量用真正的减号 −。
 */

const formatterCache = new Map<string, Intl.NumberFormat>()

function getFormatter(locale: string | undefined, options: Intl.NumberFormatOptions) {
  const key = `${locale ?? ''}|${JSON.stringify(options)}`
  let formatter = formatterCache.get(key)
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options)
    formatterCache.set(key, formatter)
  }
  return formatter
}

export interface FormatNumberOptions {
  /** 紧凑写法：12,800 → 1.3万 / 12.8K */
  compact?: boolean
  maximumFractionDigits?: number
  locale?: string
}

export function formatNumber(value: number, { compact = false, maximumFractionDigits, locale }: FormatNumberOptions = {}) {
  if (!Number.isFinite(value)) return '—'
  return getFormatter(locale, {
    notation: compact ? 'compact' : 'standard',
    maximumFractionDigits: maximumFractionDigits ?? (compact ? 1 : Math.abs(value) < 10 ? 1 : 0),
  }).format(value)
}

/** 比例 → 百分比文本：0.873 → 87% */
export function formatPercent(ratio: number, digits = 0) {
  if (!Number.isFinite(ratio)) return '—'
  return `${(ratio * 100).toFixed(digits)}%`
}

/** 带符号的变化量：0.12 → +12%，-0.031 → −3.1% */
export function formatSignedPercent(ratio: number, digits = 1) {
  if (!Number.isFinite(ratio)) return '—'
  const abs = Math.abs(ratio * 100)
  const text = Number.isInteger(abs) ? abs.toFixed(0) : abs.toFixed(digits)
  // 舍入后为 0 的微小变化不带符号，避免出现「+0.0%」
  if (Number(text) === 0) return '0%'
  return `${ratio > 0 ? '+' : '−'}${text}%`
}

/** 带符号的整数变化：3 → +3，-2 → −2 */
export function formatSignedNumber(value: number) {
  if (!Number.isFinite(value)) return '—'
  if (value > 0) return `+${formatNumber(value)}`
  if (value < 0) return `−${formatNumber(Math.abs(value))}`
  return '0'
}
