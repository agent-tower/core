import { useId, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { Collapsible } from 'radix-ui'
import { cn } from '@/lib/utils'
import { CountBadge } from '../feedback/badge'
import type { Tone } from '../tokens'

export interface NavGroupProps {
  title: ReactNode
  /** 标题前的图标，如任务分组的状态图标——每组只出现一次，行里不再重复 */
  icon?: ReactNode
  count?: number
  /** 计数需要用户介入时上色（如「待审查」用 warning），其余保持灰字 */
  countTone?: Tone
  /** 标题吸顶：放在滚动容器里时，长列表滚到中间也能看出当前分组（底色为侧栏灰，只用在侧栏里） */
  sticky?: boolean
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children: ReactNode
  className?: string
}

/**
 * 侧栏分组：12px 灰色标题 + 折叠箭头 + 右侧计数。空分组只保留标题与「0」，不显示占位。
 * 折叠状态由用户决定，常用分组默认展开。
 */
export function NavGroup({ title, icon, count, countTone = 'neutral', sticky = false, defaultOpen = true, open, onOpenChange, children, className }: NavGroupProps) {
  const titleId = useId()
  return (
    <Collapsible.Root defaultOpen={defaultOpen} open={open} onOpenChange={onOpenChange} className={cn('mb-2', className)}>
      {/* 吸顶的是外层方角底色，圆角的悬停底色留在按钮上，滚过去的行不会从圆角处露出来 */}
      <div className={cn(sticky && 'sticky top-0 z-10 bg-sidebar')}>
        <Collapsible.Trigger
          data-sidebar-item=""
          className="group/header flex h-7 w-full items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          {icon && <span className="mr-0.5 flex shrink-0 [&_svg]:size-3.5">{icon}</span>}
          <span id={titleId} className="truncate">{title}</span>
          <ChevronRight
            aria-hidden="true"
            className="size-3 shrink-0 text-muted-foreground/60 transition-transform duration-150 group-hover/header:text-muted-foreground group-data-[state=open]/header:rotate-90"
          />
          {count !== undefined && <CountBadge count={count} tone={count > 0 ? countTone : 'neutral'} className="ml-auto" />}
        </Collapsible.Trigger>
      </div>
      <Collapsible.Content role="group" aria-labelledby={titleId} className="mt-0.5 flex flex-col gap-px">
        {children}
      </Collapsible.Content>
    </Collapsible.Root>
  )
}
