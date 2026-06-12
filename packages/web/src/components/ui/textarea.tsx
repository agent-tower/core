import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * 多行文本域 — 默认「编辑区」灰底（bg-muted/40），聚焦转白底 + 中性灰边框加深。
 * 适合 prompt / script / JSON 等长文本输入；如需白底可传 className="bg-background"。
 */
function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'w-full rounded-lg border border-input bg-muted/40 px-3 py-2 text-sm leading-relaxed text-foreground transition-colors',
        'placeholder:text-muted-foreground/70',
        'focus:border-ring focus:bg-background focus:outline-none focus-visible:border-ring',
        'disabled:cursor-not-allowed disabled:bg-muted/50 disabled:text-muted-foreground',
        'aria-invalid:border-destructive',
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
