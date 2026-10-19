import type { AppLocale } from '@agent-tower/shared'

type Translate = (source: string, values?: Record<string, number>) => string

const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

// Reuse ICU formatters across rows and 30-second updates. Calling
// toLocaleDateString with options creates a formatter for every old task.
// AppLocale limits this cache to the two supported application locales.
const dateFormatters = new Map<AppLocale, {
  monthDay: Intl.DateTimeFormat
  yearMonth: Intl.DateTimeFormat
}>()

function getDateFormatters(locale: AppLocale) {
  let formatters = dateFormatters.get(locale)
  if (!formatters) {
    formatters = {
      monthDay: new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' }),
      yearMonth: new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'numeric' }),
    }
    dateFormatters.set(locale, formatters)
  }
  return formatters
}

/** Compact task timestamp: relative within a week, then month/day or year/month. */
export function formatTaskUpdatedAt(isoString: string, t: Translate, locale: AppLocale): string {
  const time = new Date(isoString)
  if (!Number.isFinite(time.getTime())) return '—'

  const now = new Date()
  const diff = Math.max(0, Math.floor((now.getTime() - time.getTime()) / 1000))
  if (diff < MINUTE) return t('now')
  if (diff < HOUR) return t('{count}m', { count: Math.floor(diff / MINUTE) })
  if (diff < DAY) return t('{count}h', { count: Math.floor(diff / HOUR) })
  if (diff < 7 * DAY) return t('{count}d', { count: Math.floor(diff / DAY) })

  const formatters = getDateFormatters(locale)
  return (time.getFullYear() === now.getFullYear()
    ? formatters.monthDay
    : formatters.yearMonth).format(time)
}
