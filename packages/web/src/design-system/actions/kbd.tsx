import type { ComponentProps, ReactNode } from 'react'
import { Fragment } from 'react'
import { cn } from '@/lib/utils'

export interface KbdProps extends ComponentProps<'kbd'> {
  /** 在深色面（Tooltip）里使用 */
  inverse?: boolean
}

/** 按键：⏎ ⌘ K 这类单个键帽，用于快捷键提示 */
export function Kbd({ inverse = false, className, ...props }: KbdProps) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded px-1 font-sans text-[11px] font-medium leading-none',
        inverse
          ? 'border border-inverse-foreground/20 bg-inverse-foreground/10 text-inverse-foreground/80'
          : 'border border-border bg-muted/60 text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}

export interface KbdGroupProps {
  keys: ReactNode[]
  inverse?: boolean
  /** 组合键之间的连接符，默认不显示（⌘ K） */
  separator?: ReactNode
  className?: string
}

/** 组合键：⌘ K / Ctrl + Enter */
export function KbdGroup({ keys, inverse, separator, className }: KbdGroupProps) {
  return (
    <span className={cn('inline-flex items-center gap-0.5', className)}>
      {keys.map((key, index) => (
        <Fragment key={index}>
          {index > 0 && separator ? <span className="px-0.5 text-[11px] text-muted-foreground">{separator}</span> : null}
          <Kbd inverse={inverse}>{key}</Kbd>
        </Fragment>
      ))}
    </span>
  )
}
