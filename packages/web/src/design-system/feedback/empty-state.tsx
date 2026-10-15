import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface EmptyStateProps {
  icon?: ReactNode
  title?: ReactNode
  description?: ReactNode
  /** 一个主操作；没有可做的事就不放按钮 */
  action?: ReactNode
  /** plain 直接放在内容区（默认）· dashed 虚线框，用于面板、列表、拖放区内部 */
  variant?: 'plain' | 'dashed'
  size?: 'sm' | 'md'
  className?: string
}

/**
 * 空状态：说清楚「这里为什么是空的、下一步做什么」。
 * 图标用浅灰细描边；文案一句话；主操作至多一个。位置略高于几何中心，视觉上更居中。
 */
export function EmptyState({ icon, title, description, action, variant = 'plain', size = 'md', className }: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn(
        'flex flex-col items-center justify-center text-center',
        size === 'md' ? 'px-6 py-10' : 'px-4 py-6',
        variant === 'dashed' && 'rounded-xl border border-dashed border-border bg-foreground/[0.015]',
        className,
      )}
    >
      {icon && (
        <div
          aria-hidden="true"
          className={cn(
            'mb-3 text-muted-foreground/40',
            size === 'md' ? '[&_svg]:size-9 [&_svg]:stroke-[1.5]' : '[&_svg]:size-7 [&_svg]:stroke-[1.5]',
          )}
        >
          {icon}
        </div>
      )}
      {title && <p className={cn('font-medium text-foreground', size === 'md' ? 'text-sm' : 'text-[13px]')}>{title}</p>}
      {description && (
        <p className={cn('max-w-xs text-muted-foreground', size === 'md' ? 'text-[13px]' : 'text-xs', title && 'mt-1')}>
          {description}
        </p>
      )}
      {action && <div className="mt-4 flex items-center gap-2">{action}</div>}
    </div>
  )
}
