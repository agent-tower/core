import { Children, Fragment, type ComponentProps, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * 面包屑（顶栏「Agent Tower / 项目 ▾」）：告诉用户「我在哪」，最后一级可下拉切换同级对象。
 * 分隔符是浅灰斜杠；层级不超过 3 级，更深的结构交给侧栏。
 */
export function Breadcrumb({ className, children, ...props }: ComponentProps<'nav'>) {
  const items = Children.toArray(children)
  return (
    <nav aria-label="Breadcrumb" className={cn('flex min-w-0 items-center', className)} {...props}>
      {items.map((child, index) => (
        <Fragment key={index}>
          {index > 0 && <span aria-hidden="true" className="mx-1.5 select-none text-muted-foreground/40">/</span>}
          {child}
        </Fragment>
      ))}
    </nav>
  )
}

export interface BreadcrumbItemProps extends ComponentProps<'button'> {
  icon?: ReactNode
  /** 可下拉切换（显示 ▾） */
  menu?: boolean
  current?: boolean
}

export function BreadcrumbItem({ icon, menu = false, current = false, className, children, type, ...props }: BreadcrumbItemProps) {
  return (
    <button
      type={type ?? 'button'}
      aria-current={current ? 'page' : undefined}
      className={cn(
        'group flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 data-[state=open]:bg-accent',
        current ? 'font-medium text-foreground/90' : 'text-muted-foreground hover:text-foreground',
        className,
      )}
      {...props}
    >
      {icon && <span className="flex shrink-0 [&_svg]:size-3.5">{icon}</span>}
      <span className="max-w-[200px] truncate">{children}</span>
      {menu && (
        <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-200 group-data-[state=open]:rotate-180" />
      )}
    </button>
  )
}
