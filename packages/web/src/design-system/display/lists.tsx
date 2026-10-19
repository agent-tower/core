import type { ReactNode } from 'react'
import { ArrowDown, ArrowUp, CircleCheck, CircleDashed, CircleSlash, LoaderCircle, type LucideIcon } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { hasNode } from '../lib/node'
import { TONE_INK, TONE_MARK, type Tone } from '../tokens'

/* ── 待办 ─────────────────────────────────────────────────── */

export type TodoState = 'todo' | 'doing' | 'done' | 'cancelled'

/**
 * 与任务状态同一套 lucide 线性图标、同一种颜色（components/task/status-styles）：一个含义只对应一个图标。
 * 图标不加动画，也不用实心块面。
 */
const TODO_STATE: Record<TodoState, { icon: LucideIcon; label: string; className: string }> = {
  todo: { icon: CircleDashed, label: 'Pending', className: TONE_MARK.neutral },
  doing: { icon: LoaderCircle, label: 'Running', className: TONE_MARK.info },
  done: { icon: CircleCheck, label: 'Done', className: 'text-success/80' },
  cancelled: { icon: CircleSlash, label: 'Cancelled', className: 'text-muted-foreground/70' },
}

/** 待办状态图标：业务里的待办（如 Agent 的计划清单）也用它，保证同一状态同一图标 */
export function TodoStateIcon({ state, className }: { state: TodoState; className?: string }) {
  const { icon: Icon, className: tone } = TODO_STATE[state]
  return <Icon aria-hidden="true" className={cn('size-4 shrink-0', tone, className)} />
}

export interface TodoItem {
  id: string
  title: ReactNode
  state: TodoState
  /** 标签：所属项目、Agent */
  tag?: ReactNode
  meta?: ReactNode
  /** 截止：只有临近或逾期时才上色 */
  due?: { label: ReactNode; tone?: Tone }
}

export interface TodoListProps {
  items: TodoItem[]
  /** 传入后状态图标可点击，在完成 / 未完成之间切换 */
  onToggle?: (id: string) => void
  /** 顶部的状态计数 */
  summary?: boolean
  className?: string
}

/**
 * 待办清单：一行一件事。状态图标与任务状态同一套（待开始 / 进行中 / 已完成 / 已取消），已完成划线淡出但不消失；
 * 只有临近 / 逾期的截止日上色，其余元信息保持灰色。
 */
export function TodoList({ items, onToggle, summary = true, className }: TodoListProps) {
  const { t } = useI18n()
  const counts = {
    doing: items.filter(item => item.state === 'doing').length,
    todo: items.filter(item => item.state === 'todo').length,
    done: items.filter(item => item.state === 'done').length,
  }
  return (
    <div className={className}>
      {summary && (
        <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {(['doing', 'todo', 'done'] as const).map(state => (
            <span key={state} className="inline-flex items-center gap-1">
              <TodoStateIcon state={state} className="size-3.5" />
              {t(TODO_STATE[state].label)} <span className="tabular-nums text-foreground/80">{counts[state]}</span>
            </span>
          ))}
        </div>
      )}
      <ul className="flex flex-col">
        {items.map(item => {
          const finished = item.state === 'done' || item.state === 'cancelled'
          return (
            <li key={item.id} className="flex min-h-9 items-center gap-2.5 border-b border-border/40 py-1.5 last:border-0">
              {onToggle ? (
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={item.state === 'done'}
                  aria-label={typeof item.title === 'string' ? item.title : undefined}
                  onClick={() => onToggle(item.id)}
                  className="-m-1 flex shrink-0 rounded p-1 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  <TodoStateIcon state={item.state} />
                </button>
              ) : (
                <TodoStateIcon state={item.state} />
              )}
              <span className={cn('min-w-0 flex-1 truncate text-[13px]', finished ? 'text-muted-foreground line-through decoration-foreground/30' : 'text-foreground/90')}>
                {item.title}
              </span>
              {hasNode(item.tag) && <span className="shrink-0">{item.tag}</span>}
              {hasNode(item.meta) && <span className="shrink-0 text-xs text-muted-foreground">{item.meta}</span>}
              {item.due && (
                <span className={cn('w-14 shrink-0 text-right text-xs tabular-nums', item.due.tone && !finished ? cn('font-medium', TONE_INK[item.due.tone]) : 'text-muted-foreground')}>
                  {item.due.label}
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/* ── 日程 ─────────────────────────────────────────────────── */

export interface TimelineEntry {
  id: string
  time: string
  endTime?: string
  title: ReactNode
  tag?: ReactNode
  meta?: ReactNode
  /** 正在进行：时间轨变成墨色 */
  active?: boolean
}

export interface TimelineGroup {
  id: string
  title: ReactNode
  caption?: ReactNode
  entries: TimelineEntry[]
}

/** 日程：按天分组的时间线。左侧起止时间对齐成列，竖条表示时长，进行中的一项竖条变黑 */
export function Timeline({ groups, className }: { groups: TimelineGroup[]; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {groups.map(group => (
        <section key={group.id}>
          <h4 className="mb-1.5 flex items-baseline gap-2 text-xs font-semibold text-foreground">
            {group.title}
            {hasNode(group.caption) && <span className="font-normal text-muted-foreground">{group.caption}</span>}
          </h4>
          <ul className="flex flex-col gap-1">
            {group.entries.map(entry => (
              <li key={entry.id} className="grid grid-cols-[2.75rem_3px_minmax(0,1fr)] gap-x-2.5 py-1">
                <span className="flex flex-col pt-px text-right leading-4 tabular-nums">
                  <span className="text-xs text-foreground/80">{entry.time}</span>
                  {entry.endTime && <span className="text-[11px] text-muted-foreground">{entry.endTime}</span>}
                </span>
                <span aria-hidden="true" className={cn('rounded-full', entry.active ? 'bg-viz-6' : 'bg-viz-1')} />
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-[13px] text-foreground/90">{entry.title}</span>
                    {hasNode(entry.tag) && <span className="shrink-0">{entry.tag}</span>}
                  </div>
                  {hasNode(entry.meta) && <div className="truncate text-xs text-muted-foreground">{entry.meta}</div>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/* ── 动态 ─────────────────────────────────────────────────── */

export interface ActivityEntry {
  id: string
  avatar: ReactNode
  /** 一句话：「Claude Code 提交了 3 个文件」，主语加粗由调用方决定 */
  text: ReactNode
  time: ReactNode
  /** 附加内容：提交信息、评论摘录 */
  detail?: ReactNode
}

/** 动态流：谁在什么时候做了什么。头像之间用细线串起，时间右对齐；附加内容缩进在下方 */
export function ActivityFeed({ entries, className }: { entries: ActivityEntry[]; className?: string }) {
  return (
    <ol className={cn('flex flex-col', className)}>
      {entries.map((entry, index) => (
        <li key={entry.id} className="relative flex gap-2.5 pb-3 last:pb-0">
          {index < entries.length - 1 && <span aria-hidden="true" className="absolute bottom-0 left-[11px] top-7 w-px bg-border" />}
          <span className="relative flex size-6 shrink-0 items-center justify-center">{entry.avatar}</span>
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="flex items-baseline justify-between gap-3">
              <p className="min-w-0 text-[13px] leading-5 text-foreground/85">{entry.text}</p>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{entry.time}</span>
            </div>
            {hasNode(entry.detail) && <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{entry.detail}</div>}
          </div>
        </li>
      ))}
    </ol>
  )
}

/* ── 到期提醒 ─────────────────────────────────────────────── */

export interface DeadlineItem {
  id: string
  /** 距今天数：负数 = 已逾期，0 = 今天 */
  days: number
  title: ReactNode
  meta?: ReactNode
}

/** 到期提醒：大号天数先抓住视线。逾期红、3 天内琥珀、其余墨色——越紧急越醒目 */
export function DeadlineList({ items, className }: { items: DeadlineItem[]; className?: string }) {
  const { t } = useI18n()
  return (
    <ul className={cn('flex flex-col', className)}>
      {items.map(item => {
        const tone: Tone | null = item.days < 0 ? 'danger' : item.days <= 3 ? 'warning' : null
        const unit = item.days < 0 ? t('days overdue') : item.days === 0 ? t('Due today') : t('days left')
        return (
          <li key={item.id} className="flex items-center gap-3 border-b border-border/40 py-2 last:border-0">
            <div className="flex w-14 shrink-0 flex-col items-center leading-none">
              <span className={cn('text-xl font-semibold tabular-nums', tone ? TONE_INK[tone] : 'text-foreground')}>
                {item.days === 0 ? '0' : Math.abs(item.days)}
              </span>
              <span className={cn('mt-1 text-xs', tone ? TONE_INK[tone] : 'text-muted-foreground')}>{unit}</span>
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] text-foreground/90">{item.title}</div>
              {hasNode(item.meta) && <div className="truncate text-xs text-muted-foreground">{item.meta}</div>}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/* ── 排行榜 ───────────────────────────────────────────────── */

export interface LeaderEntry {
  id: string
  name: ReactNode
  avatar?: ReactNode
  meta?: ReactNode
  value: ReactNode
  /** 名次变化：正数上升 */
  change?: number
}

/** 排行榜：前三名的名次用墨色，其余灰；名次变化用箭头 + 数字，持平显示「—」 */
export function Leaderboard({ entries, className }: { entries: LeaderEntry[]; className?: string }) {
  return (
    <ol className={cn('flex flex-col', className)}>
      {entries.map((entry, index) => (
        <li key={entry.id} className="flex items-center gap-3 border-b border-border/40 py-2 last:border-0">
          <span className={cn('w-6 shrink-0 text-[15px] font-semibold tabular-nums', index < 3 ? 'text-foreground' : 'text-muted-foreground')}>
            {String(index + 1).padStart(2, '0')}
          </span>
          {entry.avatar}
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-foreground/90">{entry.name}</div>
            {hasNode(entry.meta) && <div className="truncate text-xs text-muted-foreground">{entry.meta}</div>}
          </div>
          {entry.change !== undefined && (
            <span
              className={cn(
                'inline-flex w-8 shrink-0 items-center justify-end gap-0.5 text-[11px] font-medium tabular-nums',
                entry.change > 0 ? 'text-success-ink' : entry.change < 0 ? 'text-destructive-ink' : 'text-muted-foreground',
              )}
            >
              {entry.change > 0 && <ArrowUp aria-hidden="true" className="size-3" strokeWidth={2.5} />}
              {entry.change < 0 && <ArrowDown aria-hidden="true" className="size-3" strokeWidth={2.5} />}
              {entry.change === 0 ? '—' : Math.abs(entry.change)}
            </span>
          )}
          <span className="w-16 shrink-0 text-right text-[13px] font-semibold tabular-nums text-foreground">{entry.value}</span>
        </li>
      ))}
    </ol>
  )
}

/* ── 公告 ─────────────────────────────────────────────────── */

export interface BulletinItem {
  id: string
  date: Date
  title: ReactNode
  body?: ReactNode
  badge?: ReactNode
  meta?: ReactNode
}

/** 公告：左侧日期块（日大月小），右侧标题 + 两行摘要；重要公告只加一个徽章，不整条变色 */
export function Bulletin({ items, locale, className }: { items: BulletinItem[]; locale?: string; className?: string }) {
  const monthFormat = new Intl.DateTimeFormat(locale, { month: 'short' })
  return (
    <ul className={cn('flex flex-col', className)}>
      {items.map(item => (
        <li key={item.id} className="flex gap-3 border-b border-border/40 py-2.5 last:border-0">
          <div className="flex w-10 shrink-0 flex-col items-center rounded-lg bg-foreground/[0.04] py-1 leading-none">
            <span className="text-lg font-semibold tabular-nums text-foreground">{item.date.getDate()}</span>
            <span className="mt-0.5 text-[11px] text-muted-foreground">{monthFormat.format(item.date)}</span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-[13px] font-medium text-foreground">{item.title}</span>
              {item.badge}
            </div>
            {item.body && <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{item.body}</p>}
            {hasNode(item.meta) && <div className="mt-1 text-xs text-muted-foreground">{item.meta}</div>}
          </div>
        </li>
      ))}
    </ul>
  )
}
