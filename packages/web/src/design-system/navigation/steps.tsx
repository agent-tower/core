import type { ReactNode } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export type StepStatus = 'done' | 'current' | 'upcoming'

function StepIndicator({ status, index }: { status: StepStatus; index: number }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative z-[1] flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums',
        status === 'done' && 'bg-primary text-primary-foreground',
        status === 'current' && 'bg-background text-foreground ring-[1.5px] ring-inset ring-foreground',
        status === 'upcoming' && 'bg-background text-muted-foreground ring-1 ring-inset ring-border',
      )}
    >
      {status === 'done' ? <Check className="size-3.5" strokeWidth={2.5} /> : index + 1}
    </span>
  )
}

export interface StepperStep {
  title: ReactNode
  description?: ReactNode
}

export interface StepperProps {
  steps: StepperStep[]
  /** 当前步骤下标；之前的为已完成 */
  current: number
  className?: string
}

/**
 * 步骤条（横向）：3–5 步的线性流程（引导、向导）。已完成 = 实心对勾，当前 = 黑环，未开始 = 灰环；
 * 连线随进度变黑。步骤多于 5 个或带内容时用 StepList。
 */
export function Stepper({ steps, current, className }: StepperProps) {
  return (
    <ol className={cn('flex w-full items-start', className)}>
      {steps.map((step, index) => {
        const status: StepStatus = index < current ? 'done' : index === current ? 'current' : 'upcoming'
        const isLast = index === steps.length - 1
        return (
          <li
            key={index}
            aria-current={status === 'current' ? 'step' : undefined}
            className={cn('flex min-w-0 items-start gap-2.5', !isLast && 'flex-1')}
          >
            <StepIndicator status={status} index={index} />
            <div className="min-w-0 pt-0.5">
              <div className={cn('truncate text-[13px] leading-5', status === 'upcoming' ? 'text-muted-foreground' : 'font-medium text-foreground')}>
                {step.title}
              </div>
              {step.description && <div className="truncate text-xs leading-[18px] text-muted-foreground">{step.description}</div>}
            </div>
            {!isLast && (
              <span aria-hidden="true" className={cn('mx-2 mt-3 h-px min-w-6 flex-1', index < current ? 'bg-foreground' : 'bg-border')} />
            )}
          </li>
        )
      })}
    </ol>
  )
}

export interface StepListItem {
  title: ReactNode
  description?: ReactNode
  /** 步骤下方的内容：命令、Prompt、按钮 */
  content?: ReactNode
  status?: StepStatus
}

/** 步骤清单（纵向）：带内容的操作指引（接入 MCP、配置 Agent）。竖线串起各步，已完成的步骤线变黑 */
export function StepList({ steps, className }: { steps: StepListItem[]; className?: string }) {
  return (
    <ol className={cn('flex flex-col', className)}>
      {steps.map((step, index) => {
        const status = step.status ?? 'upcoming'
        const isLast = index === steps.length - 1
        return (
          <li key={index} aria-current={status === 'current' ? 'step' : undefined} className="relative flex gap-3 pb-5 last:pb-0">
            {!isLast && (
              <span
                aria-hidden="true"
                className={cn('absolute left-3 top-7 bottom-1 w-px -translate-x-1/2', status === 'done' ? 'bg-foreground' : 'bg-border')}
              />
            )}
            <StepIndicator status={status} index={index} />
            <div className="min-w-0 flex-1 pt-0.5">
              <div className={cn('text-sm leading-5', status === 'upcoming' ? 'text-foreground/80' : 'font-medium text-foreground')}>{step.title}</div>
              {step.description && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{step.description}</p>}
              {step.content && <div className="mt-2.5">{step.content}</div>}
            </div>
          </li>
        )
      })}
    </ol>
  )
}
