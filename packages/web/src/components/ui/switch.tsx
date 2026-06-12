import * as React from 'react'
import { cn } from '@/lib/utils'

interface SwitchProps extends Omit<React.ComponentProps<'button'>, 'onChange'> {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}

/**
 * 开关 — 全站唯一 toggle 实现（DESIGN.md §5/§7）：
 * 选中态 Charcoal（--primary）、键盘可达（role=switch + 中性灰焦点环）、动效含 reduced-motion 降级。
 */
function Switch({ checked, onCheckedChange, disabled, className, ...props }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-slot="switch"
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors outline-none',
        'focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-border',
        className,
      )}
      {...props}
    >
      <span
        className={cn(
          'pointer-events-none inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform motion-reduce:transition-none',
          checked ? 'translate-x-[18px]' : 'translate-x-[3px]',
        )}
      />
    </button>
  )
}

export { Switch }
