import type { ReactNode } from 'react'
import { Check, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { hasNode } from '../lib/node'

/* ── 流程步骤（SOP） ──────────────────────────────────────── */

export type ProcessStatus = 'done' | 'current' | 'upcoming' | 'blocked'

export interface ProcessStep {
  id: string
  title: ReactNode
  owner?: ReactNode
  time?: ReactNode
  status: ProcessStatus
}

function ProcessMarker({ status }: { status: ProcessStatus }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded-md',
        status === 'done' && 'bg-primary text-primary-foreground',
        status === 'current' && 'bg-background ring-[1.5px] ring-inset ring-foreground',
        status === 'upcoming' && 'bg-background ring-1 ring-inset ring-border',
        status === 'blocked' && 'bg-destructive/10 text-destructive ring-1 ring-inset ring-destructive/50',
      )}
    >
      {status === 'done' && <Check className="size-3" strokeWidth={3} />}
      {status === 'current' && <span className="size-1.5 rounded-full bg-foreground" />}
      {status === 'blocked' && <TriangleAlert className="size-3" />}
    </span>
  )
}

/**
 * 流程步骤（SOP / 任务生命周期）：横向编号的阶段，已完成的连线变黑，当前步骤是黑框，
 * 受阻的步骤用红色——它是整条流程唯一需要处理的地方。窄屏横向滚动，不折行。
 */
export function ProcessSteps({ steps, className }: { steps: ProcessStep[]; className?: string }) {
  return (
    <div className={cn('overflow-x-auto scrollbar-app-thin pb-1', className)}>
      <ol className="flex min-w-max">
        {steps.map((step, index) => {
          const isLast = index === steps.length - 1
          return (
            <li key={step.id} aria-current={step.status === 'current' ? 'step' : undefined} className={cn('flex min-w-[128px] flex-col gap-2', !isLast && 'flex-1 pr-3')}>
              <div className="flex items-center gap-2">
                <ProcessMarker status={step.status} />
                {!isLast && <span aria-hidden="true" className={cn('h-px flex-1', step.status === 'done' ? 'bg-foreground' : 'bg-border')} />}
              </div>
              <div className="min-w-0 pr-2">
                <div className="font-mono text-[10px] text-muted-foreground">{String(index + 1).padStart(2, '0')}</div>
                <div className={cn('text-[13px] leading-5', step.status === 'upcoming' ? 'text-foreground/70' : 'font-medium text-foreground')}>{step.title}</div>
                {(step.owner || step.time) && (
                  <div className="text-[11px] leading-4 text-muted-foreground">
                    {step.owner}
                    {step.owner && step.time && ' · '}
                    {step.time}
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/* ── 拓扑树 ───────────────────────────────────────────────── */

export interface TopologyNode {
  id: string
  title: ReactNode
  subtitle?: ReactNode
  icon?: ReactNode
  /** 右上角的状态标记（LiveDot / 徽章） */
  status?: ReactNode
  /** 当前选中 / 关注的节点 */
  active?: boolean
  children?: TopologyNode[]
}

function TopologyBranch({ node }: { node: TopologyNode }) {
  return (
    <li>
      <div
        className={cn(
          'relative flex min-w-[92px] max-w-[148px] flex-col items-center gap-0.5 rounded-lg bg-background px-2.5 py-1.5 text-center shadow-raised ring-1',
          node.active ? 'ring-foreground/70' : 'ring-border/80',
        )}
      >
        {node.status && <span className="absolute right-1.5 top-1.5">{node.status}</span>}
        {node.icon && <span className="flex text-muted-foreground [&_img]:size-4 [&_svg]:size-4">{node.icon}</span>}
        <span className="max-w-full truncate text-xs font-medium text-foreground">{node.title}</span>
        {hasNode(node.subtitle) && <span className="max-w-full truncate text-[10px] text-muted-foreground">{node.subtitle}</span>}
      </div>
      {node.children?.length ? (
        <ul>
          {node.children.map(child => <TopologyBranch key={child.id} node={child} />)}
        </ul>
      ) : null}
    </li>
  )
}

/**
 * 拓扑树（TeamRun 团队 / 组织结构）：自上而下的层级，父子之间用折线连接。
 * 节点是小白卡；当前关注的节点加深描边。层级超过 3 层或节点超过 12 个时改用 TreeList。
 */
export function TopologyTree({ root, className }: { root: TopologyNode; className?: string }) {
  return (
    <div className={cn('overflow-x-auto scrollbar-app-thin pb-1', className)}>
      <ul className="ds-org-tree min-w-max">
        <TopologyBranch node={root} />
      </ul>
    </div>
  )
}
