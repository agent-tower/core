import { useId, useMemo, type ReactNode } from 'react'
import { CircleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { hasNode } from '../lib/node'
import { FieldContext } from './field-context'

export interface FieldProps {
  label?: ReactNode
  /** 字段下方的说明；出现错误时被错误信息替换 */
  description?: ReactNode
  error?: ReactNode
  required?: boolean
  /** 标签行右侧的计数，如「12 / 24」 */
  counter?: ReactNode
  /** 指定控件 id；不传则自动生成并下发给内部控件 */
  htmlFor?: string
  className?: string
  children: ReactNode
}

/**
 * 字段：标签 + 控件 + 说明/错误。
 * 标签在上、说明在下；错误贴着字段出现，用 12px 红字 + 图标，不弹窗、不清空用户输入。
 */
export function Field({ label, description, error, required = false, counter, htmlFor, className, children }: FieldProps) {
  const autoId = useId()
  const id = htmlFor ?? `${autoId}-control`
  const messageId = `${autoId}-message`
  const hasMessage = Boolean(error || description)

  const context = useMemo(() => ({
    id,
    describedBy: hasMessage ? messageId : undefined,
    invalid: Boolean(error),
    required,
  }), [id, hasMessage, messageId, error, required])

  return (
    <div data-slot="field" className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      {(label || counter) && (
        <div className="flex items-baseline justify-between gap-3">
          {label && (
            <label htmlFor={id} className="text-[13px] font-medium text-foreground">
              {label}
              {required && <span aria-hidden="true" className="ml-0.5 text-destructive-ink">*</span>}
            </label>
          )}
          {hasNode(counter) && <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{counter}</span>}
        </div>
      )}
      <FieldContext.Provider value={context}>{children}</FieldContext.Provider>
      {error ? (
        <p id={messageId} className="flex items-start gap-1 text-xs leading-relaxed text-destructive-ink">
          <CircleAlert aria-hidden="true" className="mt-[3px] size-3 shrink-0" />
          <span>{error}</span>
        </p>
      ) : description ? (
        <p id={messageId} className="text-xs leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
    </div>
  )
}
