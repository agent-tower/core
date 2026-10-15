import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { FIELD_DISABLED, FIELD_INVALID, FIELD_SHELL, FIELD_SIZE, useFieldControl } from './field-context'

export interface InputProps extends Omit<ComponentProps<'input'>, 'size' | 'prefix'> {
  /** sm 32px（工具栏、表格内）· md 36px（表单，默认） */
  size?: keyof typeof FIELD_SIZE
  /** 前缀：图标或单位 */
  prefix?: ReactNode
  /** 后缀：单位、清除按钮、快捷键 */
  suffix?: ReactNode
  invalid?: boolean
  containerClassName?: string
}

/** 单行输入框。焦点 = 边框加深（中性灰），错误 = 红边框，禁用 = 浅灰底 */
export function Input({
  size = 'md',
  prefix,
  suffix,
  invalid,
  className,
  containerClassName,
  id,
  disabled,
  required,
  'aria-describedby': ariaDescribedBy,
  ...props
}: InputProps) {
  const field = useFieldControl()
  const isInvalid = invalid ?? field?.invalid ?? false

  return (
    <div
      data-slot="input"
      className={cn(
        FIELD_SHELL,
        'flex w-full min-w-0 items-center gap-2 focus-within:border-ring',
        FIELD_SIZE[size],
        isInvalid && FIELD_INVALID,
        disabled && FIELD_DISABLED,
        containerClassName,
      )}
    >
      {prefix && <span className="flex shrink-0 items-center text-muted-foreground [&_svg]:size-4">{prefix}</span>}
      <input
        id={id ?? field?.id}
        disabled={disabled}
        required={required ?? field?.required}
        aria-invalid={isInvalid || undefined}
        aria-describedby={ariaDescribedBy ?? field?.describedBy}
        className={cn('h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed', className)}
        {...props}
      />
      {suffix && <span className="flex shrink-0 items-center text-muted-foreground [&_svg]:size-4">{suffix}</span>}
    </div>
  )
}
