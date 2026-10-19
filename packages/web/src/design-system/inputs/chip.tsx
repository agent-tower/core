import type { ComponentProps, ReactNode } from 'react'
import { X } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

export interface ChipProps extends ComponentProps<'button'> {
  selected?: boolean
  icon?: ReactNode
  count?: number
  size?: 'sm' | 'md'
}

/**
 * 筛选胶囊：可多选的筛选条件（项目、Agent、状态）。
 * 未选是描边白胶囊，选中是 Charcoal 实心——和开关「开」的颜色一致。
 * 一组胶囊放在内容上方同一行，作用于下方全部内容。
 */
export function Chip({ selected = false, icon, count, size = 'md', className, children, type, ...props }: ChipProps) {
  return (
    <button
      type={type ?? 'button'}
      aria-pressed={selected}
      data-slot="chip"
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full font-medium transition-[background-color,color,box-shadow] duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-40',
        size === 'md' ? 'h-7 px-3 text-xs [&_svg]:size-3.5' : 'h-6 px-2.5 text-xs [&_svg]:size-3',
        selected
          ? 'bg-primary text-primary-foreground hover:bg-primary/90'
          : 'bg-background text-foreground/80 ring-1 ring-inset ring-border hover:bg-accent hover:text-foreground',
        className,
      )}
      {...props}
    >
      {icon}
      {children}
      {count !== undefined && <span className={cn('tabular-nums', selected ? 'text-primary-foreground/60' : 'text-muted-foreground')}>{count}</span>}
    </button>
  )
}

export interface TagProps extends ComponentProps<'span'> {
  icon?: ReactNode
  /** 传入即显示移除按钮 */
  onRemove?: () => void
  removeLabel?: string
}

/** 标签：已添加的条目（文件、成员、关键词），可移除。静态的状态/属性用 Badge */
export function Tag({ icon, onRemove, removeLabel, className, children, ...props }: TagProps) {
  const { t } = useI18n()
  return (
    <span
      data-slot="tag"
      className={cn(
        'inline-flex h-6 max-w-full shrink-0 items-center gap-1 rounded-md bg-foreground/[0.05] pl-2 text-xs text-foreground/80 [&_svg]:size-3',
        onRemove ? 'pr-0.5' : 'pr-2',
        className,
      )}
      {...props}
    >
      {icon && <span className="flex shrink-0 text-muted-foreground">{icon}</span>}
      <span className="min-w-0 truncate">{children}</span>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel ?? t('Remove')}
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/[0.08] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <X aria-hidden="true" />
        </button>
      )}
    </span>
  )
}
