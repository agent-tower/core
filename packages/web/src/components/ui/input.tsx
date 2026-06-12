import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * 文本输入框 — 映射 DESIGN.md §4.2/§7：
 * radius md(8px)、focus 表现为「边框加深」（中性灰 --ring），不引入彩色描边。
 */
function Input({ className, type = 'text', ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground transition-colors',
        'placeholder:text-muted-foreground/70',
        'focus:border-ring focus:outline-none focus-visible:border-ring',
        'disabled:cursor-not-allowed disabled:bg-muted/50 disabled:text-muted-foreground',
        'aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  )
}

export { Input }
