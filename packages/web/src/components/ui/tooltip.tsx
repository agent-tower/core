import type { ReactNode } from 'react'
import { Tooltip as DesignSystemTooltip } from '@/design-system'
import { cn } from '@/lib/utils'

export type TooltipSide = 'top' | 'bottom'
export type TooltipAlign = 'start' | 'center' | 'end'

interface TooltipProps {
  content: ReactNode
  children: ReactNode
  className?: string
  side?: TooltipSide
  align?: TooltipAlign
}

/**
 * 旧接口的悬停提示，内部是设计系统的 Tooltip（反色面、渲染在浮层里不会被裁切，键盘聚焦同样出现）。
 * 外面包一层 div 承接原来的布局类名；禁用的子元素不触发指针事件，交给这层接住，提示照样能出现。
 * 新代码直接用 `@/design-system` 的 Tooltip。
 */
export function Tooltip({ content, children, className, side = 'top', align = 'center' }: TooltipProps) {
  return (
    <DesignSystemTooltip content={content} side={side} align={align}>
      <div className={cn('relative inline-block [&>:disabled]:pointer-events-none', className)}>{children}</div>
    </DesignSystemTooltip>
  )
}
