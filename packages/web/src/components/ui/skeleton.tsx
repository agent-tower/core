import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * 骨架块 — DESIGN.md §6 加载态：bg-muted 圆角块 + 微弱脉动，
 * 含 prefers-reduced-motion 降级；骨架结构应与真实布局一致，避免跳动。
 */
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn('animate-pulse rounded-md bg-muted motion-reduce:animate-none', className)}
      {...props}
    />
  )
}

export { Skeleton }
