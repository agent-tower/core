import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { formatRelativeTime, useNow } from '../lib/clock'

export interface RelativeTimeProps {
  value: Date | number | string
  /** 固定「现在」（测试、静态展示）；不传则用共享时钟，每 30 秒刷新 */
  now?: number
  className?: string
}

/** 相对时间：tabular 数字、灰色，悬停显示完整时间 */
export function RelativeTime({ value, now, className }: RelativeTimeProps) {
  const { t, locale } = useI18n()
  const clock = useNow()
  const date = value instanceof Date ? value : new Date(value)
  return (
    <time
      dateTime={date.toISOString()}
      title={date.toLocaleString(locale)}
      className={cn('shrink-0 tabular-nums text-muted-foreground', className)}
    >
      {formatRelativeTime(date, now ?? clock, t, locale)}
    </time>
  )
}
