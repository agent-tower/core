import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface PanelProps extends Omit<ComponentProps<'section'>, 'title'> {
  title?: ReactNode
  description?: ReactNode
  /** 标题行右侧：链接、筛选、更多菜单 */
  actions?: ReactNode
  footer?: ReactNode
  /** plain 白卡（默认）· muted 浅灰次级区（附属配置、说明） */
  variant?: 'plain' | 'muted'
  padding?: 'none' | 'sm' | 'md'
}

const BODY_PADDING = { none: '', sm: 'px-3 pb-3', md: 'px-4 pb-4' }

/**
 * 面板：内容岛里的一块独立信息（待办、动态、图表）。14px 圆角、1px 细边、不加阴影——
 * 层次靠边框与留白，阴影留给浮起的东西（选中行、浮层）。
 */
export function Panel({ title, description, actions, footer, variant = 'plain', padding = 'md', className, children, ...props }: PanelProps) {
  const hasHeader = Boolean(title || actions)
  return (
    <section
      data-slot="panel"
      className={cn(
        'flex min-w-0 flex-col rounded-xl border',
        variant === 'plain' ? 'border-border/70 bg-background' : 'border-border/60 bg-muted/40',
        className,
      )}
      {...props}
    >
      {hasHeader && (
        <header className={cn('flex items-start justify-between gap-3 pb-2.5 pt-3.5', padding === 'sm' ? 'px-3' : 'px-4')}>
          <div className="min-w-0">
            {title && <h3 className="truncate text-[13px] font-semibold leading-5 text-foreground">{title}</h3>}
            {description && <p className="text-[11px] leading-4 text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="-mr-1 -mt-0.5 flex shrink-0 items-center gap-1">{actions}</div>}
        </header>
      )}
      <div className={cn('min-w-0 flex-1', BODY_PADDING[padding], !hasHeader && padding !== 'none' && (padding === 'sm' ? 'pt-3' : 'pt-4'))}>
        {children}
      </div>
      {footer && <footer className="border-t border-border/60 px-4 py-2.5 text-xs text-muted-foreground">{footer}</footer>}
    </section>
  )
}
