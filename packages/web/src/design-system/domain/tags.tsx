import type { AgentType } from '@agent-tower/shared'
import { GitBranch } from 'lucide-react'
import { AgentLogo } from '@/components/agent/AgentLogo'
import { getAgentLabel } from '@/lib/agent-meta'
import { cn } from '@/lib/utils'
import { projectDotClass, shortenProjectName } from './format'

/** 项目圆点：项目标识色只出现在圆点和项目名上，不做大面积底色 */
export function ProjectDot({ color, className }: { color: string; className?: string }) {
  return <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', projectDotClass(color), className)} />
}

export interface ProjectTagProps {
  name: string
  /** 项目色类名，如 text-indigo-600 */
  color: string
  /** 截短长名（默认开启，完整名放在 title） */
  shorten?: boolean
  className?: string
}

/**
 * 项目标签（任务行元信息）：文字从项目色渐变到灰，不额外占宽度也能按颜色区分项目。
 * 只作提示——长名截短，完整名称见悬停。
 */
export function ProjectTag({ name, color, shorten = true, className }: ProjectTagProps) {
  return (
    <span
      title={name}
      className={cn('shrink-0 whitespace-nowrap rounded bg-foreground/[0.05] px-1 py-0.5 text-[10px] font-medium leading-none', className)}
    >
      <span className={cn(color, 'bg-[linear-gradient(90deg,currentColor_0.6em,var(--muted-foreground)_2.6em)] bg-clip-text [-webkit-text-fill-color:transparent]')}>
        {shorten ? shortenProjectName(name) : name}
      </span>
    </span>
  )
}

export interface AgentMarkProps {
  agentType?: AgentType | string | null
  /** 覆盖默认名称（如 Provider 名） */
  label?: string
  showLabel?: boolean
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const AGENT_LOGO_SIZE = { sm: 'size-3.5', md: 'size-4', lg: 'size-5' }

/** Agent 标识：官方 logo + 名称。Agent 靠 logo 区分身份，不分配颜色 */
export function AgentMark({ agentType, label, showLabel = true, size = 'md', className }: AgentMarkProps) {
  const name = label ?? getAgentLabel(agentType, 'Agent')
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', size === 'sm' ? 'text-xs' : 'text-[13px]', className)} title={showLabel ? undefined : name}>
      <AgentLogo agentType={agentType} className={AGENT_LOGO_SIZE[size]} />
      {showLabel ? <span className="truncate text-foreground/80">{name}</span> : <span className="sr-only">{name}</span>}
    </span>
  )
}

/** 分支名：等宽小字，过长截断（完整名见悬停） */
export function BranchTag({ name, className }: { name: string; className?: string }) {
  return (
    <span title={name} className={cn('inline-flex min-w-0 items-center gap-1 text-muted-foreground', className)}>
      <GitBranch aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate font-mono text-[11px]">{name}</span>
    </span>
  )
}

export interface DiffStatProps {
  additions?: number
  deletions?: number
  /** 5 格比例条（GitHub 式） */
  bar?: boolean
  className?: string
}

/** 增删统计：+12 −3，绿红只给数字本身；比例条帮助一眼看出改动以增为主还是以删为主 */
export function DiffStat({ additions = 0, deletions = 0, bar = false, className }: DiffStatProps) {
  const total = additions + deletions
  const addCells = total === 0 ? 0 : Math.round((additions / total) * 5)
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5 font-mono text-[11px] tabular-nums', className)}>
      {additions > 0 && <span className="text-success-ink">+{additions}</span>}
      {deletions > 0 && <span className="text-destructive-ink">−{deletions}</span>}
      {total === 0 && <span className="text-muted-foreground">0</span>}
      {bar && (
        <span aria-hidden="true" className="flex gap-px">
          {Array.from({ length: 5 }).map((_, index) => (
            <span
              key={index}
              className={cn(
                'size-1.5 rounded-[1px]',
                total === 0 ? 'bg-foreground/10' : index < addCells ? 'bg-success' : 'bg-destructive',
              )}
            />
          ))}
        </span>
      )}
    </span>
  )
}
