import type { ComponentProps, CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import { FIELD_DISABLED, FIELD_INVALID, FIELD_SHELL, useFieldControl } from './field-context'

export interface TextareaProps extends ComponentProps<'textarea'> {
  invalid?: boolean
  /** 随内容增高（field-sizing），在 minRows 与 maxRows 之间 */
  autoResize?: boolean
  minRows?: number
  maxRows?: number
}

const LINE_HEIGHT = 22
const VERTICAL_PADDING = 18

/** 多行输入：prompt、脚本、说明文字。白底，焦点边框加深 */
export function Textarea({
  invalid,
  autoResize = false,
  minRows = 3,
  maxRows = 10,
  className,
  style,
  id,
  disabled,
  required,
  'aria-describedby': ariaDescribedBy,
  ...props
}: TextareaProps) {
  const field = useFieldControl()
  const isInvalid = invalid ?? field?.invalid ?? false
  const sizing: CSSProperties = autoResize
    ? {
        fieldSizing: 'content',
        minHeight: minRows * LINE_HEIGHT + VERTICAL_PADDING,
        maxHeight: maxRows * LINE_HEIGHT + VERTICAL_PADDING,
      } as CSSProperties
    : {}

  return (
    <textarea
      data-slot="textarea"
      id={id ?? field?.id}
      disabled={disabled}
      required={required ?? field?.required}
      aria-invalid={isInvalid || undefined}
      aria-describedby={ariaDescribedBy ?? field?.describedBy}
      rows={autoResize ? undefined : minRows}
      style={{ ...sizing, ...style }}
      className={cn(
        FIELD_SHELL,
        'block w-full resize-none px-3 py-2 text-sm leading-[22px] outline-none placeholder:text-muted-foreground/70 focus:border-ring',
        isInvalid && FIELD_INVALID,
        disabled && FIELD_DISABLED,
        className,
      )}
      {...props}
    />
  )
}
