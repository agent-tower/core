import type { ComponentProps, ReactNode } from 'react'
import { Tabs as TabsPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

/**
 * 标签页：同一对象的不同面（对话 / 变更 / 终端），切换的是整块内容区。
 * 下划线式：选中项正文色 + 2px Charcoal 下划线；字重不变，切换时不抖动。
 * 只是切换同一列表的筛选口径时用 Segmented。
 */
export const Tabs = TabsPrimitive.Root

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn('flex h-9 items-stretch gap-5 border-b border-border/60', className)}
      {...props}
    />
  )
}

export function TabsTrigger({ className, count, icon, children, ...props }: ComponentProps<typeof TabsPrimitive.Trigger> & { count?: number; icon?: ReactNode }) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        'relative -mb-px inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-0.5 text-[13px] font-medium text-muted-foreground transition-colors',
        'hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-40',
        'data-[state=active]:border-foreground data-[state=active]:text-foreground [&_svg]:size-3.5',
        className,
      )}
      {...props}
    >
      {icon}
      {children}
      {count !== undefined && <span className="text-[11px] font-normal tabular-nums text-muted-foreground">{count}</span>}
    </TabsPrimitive.Trigger>
  )
}

export function TabsContent({ className, ...props }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn('pt-4 outline-none', className)} {...props} />
}
