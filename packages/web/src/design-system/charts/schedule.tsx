import type { ReactNode } from 'react'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { addDays } from '../lib/date'
import { formatPercent } from '../lib/format'
import { TONE_DOT, type Tone } from '../tokens'


/* ── 甘特图 ───────────────────────────────────────────────── */

export interface GanttTask {
  id: string
  label: string
  meta?: string
  /** 起止日（相对 start 的天数，含首尾） */
  start: number
  end: number
  /** 0–1 */
  progress: number
}

export interface GanttChartProps {
  tasks: GanttTask[]
  start: Date
  days: number
  /** 今天（相对 start 的天数） */
  today?: number
  locale?: string
  'aria-label': string
  className?: string
}

/**
 * 甘特图：任务排期与进度。已完成部分实心墨色，剩余部分斜纹（实与虚）；
 * 「今天」一根竖线贯穿所有行——应完成却未完成的剩余部分转红斜纹，逾期无需另加标记。
 */
export function GanttChart({ tasks, start, days, today, locale, className, ...props }: GanttChartProps) {
  const { t } = useI18n()
  const pct = (day: number) => `${(day / days) * 100}%`
  const weekStarts: number[] = []
  const months: { day: number; label: string }[] = []
  const monthFormat = new Intl.DateTimeFormat(locale, { month: 'short' })
  for (let day = 0; day < days; day++) {
    const date = addDays(start, day)
    if (date.getDay() === 1) weekStarts.push(day)
    if (day === 0 || date.getDate() === 1) months.push({ day, label: monthFormat.format(date) })
  }
  const showToday = today !== undefined && today >= 0 && today < days

  const todayLine = showToday && (
    <span aria-hidden="true" className="absolute inset-y-0 w-px bg-foreground/50" style={{ left: pct(today + 0.5) }} />
  )

  return (
    <div role="table" aria-label={props['aria-label']} className={cn('text-xs', className)}>
      <div role="row" className="grid grid-cols-[minmax(7rem,9rem)_minmax(0,1fr)] border-b border-border/60">
        <div role="columnheader" className="h-8" />
        <div role="columnheader" className="relative h-8">
          {months.map(month => (
            <span key={month.day} className="absolute top-1 text-[11px] font-medium text-foreground/80" style={{ left: pct(month.day) }}>
              {month.label}
            </span>
          ))}
          {weekStarts.map(day => (
            <span key={day} className="absolute bottom-0.5 -translate-x-1/2 text-[11px] tabular-nums text-muted-foreground" style={{ left: pct(day) }}>
              {addDays(start, day).getDate()}
            </span>
          ))}
          {showToday && (
            <span className="absolute -bottom-px z-[1] -translate-x-1/2 rounded bg-foreground px-1 py-px text-[11px] font-medium leading-[13px] text-background" style={{ left: pct(today + 0.5) }}>
              {t('Today')}
            </span>
          )}
        </div>
      </div>

      {tasks.map(task => {
        const done = Math.min(1, Math.max(0, task.progress))
        const late = showToday && task.end < today && done < 1
        const nearEnd = (task.end + 1) / days > 0.86
        return (
          <div key={task.id} role="row" className="group grid grid-cols-[minmax(7rem,9rem)_minmax(0,1fr)]">
            <div role="rowheader" className="flex min-w-0 flex-col justify-center py-1.5 pr-3">
              <span className="truncate text-xs text-foreground/90">{task.label}</span>
              {task.meta && <span className="truncate text-xs text-muted-foreground">{task.meta}</span>}
            </div>
            <div role="cell" className="relative h-11 transition-colors group-hover:bg-foreground/[0.02]">
              {weekStarts.map(day => (
                <span key={day} aria-hidden="true" className="absolute inset-y-0 w-px bg-viz-grid" style={{ left: pct(day) }} />
              ))}
              {todayLine}
              <div
                title={`${task.label} · ${formatPercent(done)}`}
                className="absolute top-1/2 flex h-2.5 -translate-y-1/2 overflow-hidden rounded-[3px]"
                style={{ left: pct(task.start), width: pct(task.end - task.start + 1) }}
              >
                <span className="h-full bg-viz-6" style={{ width: `${done * 100}%` }} />
                <span className={cn('hatch h-full flex-1', late ? 'bg-destructive/10 text-destructive/60' : 'bg-viz-0 text-viz-3')} />
              </div>
              <span
                className={cn('absolute top-1/2 -translate-y-1/2 whitespace-nowrap text-[11px] tabular-nums', late ? 'font-medium text-destructive-ink' : 'text-muted-foreground')}
                style={nearEnd ? { right: `calc(${(1 - task.start / days) * 100}% + 6px)` } : { left: `calc(${pct(task.end + 1)} + 6px)` }}
              >
                {formatPercent(done)}
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* ── 月历 ─────────────────────────────────────────────────── */

export interface CalendarEvent {
  id: string
  /** YYYY-MM-DD */
  date: string
  title: ReactNode
  /** 只有带状态含义的事件才上色（到期、失败），其余墨色 */
  tone?: Tone
  time?: string
}

export interface MonthCalendarProps {
  year: number
  /** 0–11 */
  month: number
  events: CalendarEvent[]
  /** YYYY-MM-DD */
  today?: string
  locale?: string
  maxPerDay?: number
  className?: string
}

function isoDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/**
 * 月历：一个月内的事件分布（发布、到期、例会）。今天是实心黑圆；非本月日期淡出；
 * 每格最多列 2 条，其余收成「+N」，完整列表放到点击后的详情里。
 */
export function MonthCalendar({ year, month, events, today, locale, maxPerDay = 2, className }: MonthCalendarProps) {
  const first = new Date(year, month, 1)
  const offset = (first.getDay() + 6) % 7
  const gridStart = new Date(year, month, 1 - offset)
  const weekdayFormat = new Intl.DateTimeFormat(locale, { weekday: 'short' })
  const byDate = new Map<string, CalendarEvent[]>()
  for (const event of events) {
    const list = byDate.get(event.date) ?? []
    list.push(event)
    byDate.set(event.date, list)
  }
  const cells = Array.from({ length: 42 }, (_, index) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index))

  return (
    <div className={cn('overflow-hidden rounded-lg border border-border/70', className)}>
      <div className="grid grid-cols-7 border-b border-border/60 bg-foreground/[0.015]">
        {cells.slice(0, 7).map(date => (
          <div key={date.getDay()} className="px-2 py-1.5 text-xs text-muted-foreground">{weekdayFormat.format(date)}</div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((date, index) => {
          const key = isoDate(date)
          const inMonth = date.getMonth() === month
          const isToday = key === today
          const list = byDate.get(key) ?? []
          return (
            <div
              key={key}
              className={cn(
                'min-h-[84px] border-border/60 p-1.5',
                index % 7 !== 6 && 'border-r',
                index < 35 && 'border-b',
                !inMonth && 'bg-foreground/[0.015]',
              )}
            >
              <span
                className={cn(
                  'inline-flex size-5 items-center justify-center rounded-full text-[11px] tabular-nums',
                  isToday ? 'bg-primary font-semibold text-primary-foreground' : inMonth ? 'text-foreground/80' : 'text-muted-foreground',
                )}
              >
                {date.getDate()}
              </span>
              <ul className="mt-1 space-y-0.5">
                {list.slice(0, maxPerDay).map(event => (
                  <li key={event.id} className={cn('flex min-w-0 items-center gap-1 text-xs leading-[18px]', !inMonth && 'opacity-50')}>
                    <span aria-hidden="true" className={cn('h-2.5 w-0.5 shrink-0 rounded-full', event.tone ? TONE_DOT[event.tone] : 'bg-viz-6')} />
                    {event.time && <span className="shrink-0 tabular-nums text-muted-foreground">{event.time}</span>}
                    <span className="truncate text-foreground/85">{event.title}</span>
                  </li>
                ))}
                {list.length > maxPerDay && (
                  <li className="pl-1.5 text-[11px] leading-4 text-muted-foreground">+{list.length - maxPerDay}</li>
                )}
              </ul>
            </div>
          )
        })}
      </div>
    </div>
  )
}
