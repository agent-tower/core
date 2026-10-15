import type { ReactNode } from 'react'
import { Tooltip as TooltipPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'
import { KbdGroup } from '../actions/kbd'

export interface TooltipProps {
  content: ReactNode
  /** 快捷键，跟在说明文字后面，如 ['⌘', 'K'] */
  shortcut?: ReactNode[]
  children: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  delayDuration?: number
  disabled?: boolean
  className?: string
}

/**
 * 悬停提示：给图标按钮、截断文本补充一句话说明。深色反色面、无箭头。
 * 只放补充信息——任何必须知道的内容都不能只藏在 Tooltip 里。
 * 子元素必须能接收 ref 和焦点（按钮 / 链接），键盘聚焦同样会出现。
 */
export function Tooltip({
  content,
  shortcut,
  children,
  side = 'top',
  align = 'center',
  delayDuration = 300,
  disabled = false,
  className,
}: TooltipProps) {
  if (disabled || !content) return <>{children}</>

  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={200}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side={side}
            align={align}
            sideOffset={6}
            collisionPadding={8}
            className={cn(
              'z-[100] flex max-w-[260px] items-center gap-2 rounded-lg bg-inverse px-2.5 py-1.5 text-xs leading-relaxed text-inverse-foreground shadow-popover',
              'origin-(--radix-tooltip-content-transform-origin) data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 duration-100',
              className,
            )}
          >
            <span className="min-w-0">{content}</span>
            {shortcut && <KbdGroup keys={shortcut} inverse className="shrink-0" />}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  )
}
