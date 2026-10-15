import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { formatPercent } from '../lib/format'
import { hasNode } from '../lib/node'
import { Ring } from '../marks/ring'
import { HealthBadge, type Health } from '../marks/state'
import { Track } from '../marks/track'

export interface KeyResult {
  id: string
  /** KR1 / KR2 */
  code?: string
  title: ReactNode
  /** 0–1 */
  progress: number
  /** 此刻应达到的进度（0–1），在进度条上画预期线 */
  expected?: number
  /** 当前值 / 目标值，如「173.6万 / 200万」 */
  current?: ReactNode
}

export interface ObjectiveCardProps {
  code?: string
  title: ReactNode
  meta?: ReactNode
  health?: Health
  progress: number
  keyResults: KeyResult[]
  className?: string
}

/**
 * 目标卡（目标与关键结果 / 里程碑）：左上进度环给整体完成度，右上是健康度；
 * 每条关键结果一行：编号 · 名称 · 当前值 · 百分比，下方进度条带预期线——落后多少一眼可见。
 */
export function ObjectiveCard({ code, title, meta, health, progress, keyResults, className }: ObjectiveCardProps) {
  return (
    <article className={cn('rounded-xl border border-border/70 bg-background p-4', className)}>
      <header className="flex items-start gap-3">
        <Ring value={progress} size={44} thickness={4} />
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex items-center gap-1.5">
            {code && <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{code}</span>}
            <h4 className="truncate text-sm font-semibold leading-5 text-foreground">{title}</h4>
          </div>
          {hasNode(meta) && <p className="truncate text-[11px] leading-4 text-muted-foreground">{meta}</p>}
        </div>
        {health && <HealthBadge health={health} className="mt-0.5" />}
      </header>
      <ul className="mt-3 flex flex-col gap-2.5">
        {keyResults.map(keyResult => (
          <li key={keyResult.id}>
            <div className="flex items-baseline gap-2">
              {keyResult.code && <span className="w-7 shrink-0 font-mono text-[10px] text-muted-foreground">{keyResult.code}</span>}
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground/85">{keyResult.title}</span>
              {hasNode(keyResult.current) && <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{keyResult.current}</span>}
              <span className="w-9 shrink-0 text-right text-xs font-semibold tabular-nums text-foreground">{formatPercent(keyResult.progress)}</span>
            </div>
            <Track value={keyResult.progress} expected={keyResult.expected} size="xs" className={cn('mt-1.5', keyResult.code && 'ml-9 w-[calc(100%-2.25rem)]')} />
          </li>
        ))}
      </ul>
    </article>
  )
}
