import type { ComponentProps } from 'react'
import { Slot } from 'radix-ui'
import { Spinner } from '../feedback/spinner'
import { buttonClassName, type ButtonSize, type ButtonTone, type ButtonVariant } from './button-styles'

export interface ButtonProps extends ComponentProps<'button'> {
  /**
   * primary 主操作（Charcoal，一屏一个）· secondary 描边白卡（默认）·
   * ghost 工具栏/行内 · soft 浅灰底的低强调 · link 文字链接
   */
  variant?: ButtonVariant
  /** danger 只用于删除、终止这类不可逆操作 */
  tone?: ButtonTone
  size?: ButtonSize
  /** 提交中：前置转圈并禁用（保持原色，不做半透明） */
  loading?: boolean
  block?: boolean
  /** 把样式交给唯一子元素（如路由 Link） */
  asChild?: boolean
}

export function Button({
  variant = 'secondary',
  tone = 'neutral',
  size = 'md',
  loading = false,
  block = false,
  asChild = false,
  className,
  disabled,
  children,
  type,
  ...props
}: ButtonProps) {
  const classes = buttonClassName({ variant, tone, size, block, loading, className })

  if (asChild) {
    return (
      <Slot.Root data-slot="button" className={classes} {...props}>
        {children}
      </Slot.Root>
    )
  }

  return (
    <button
      type={type ?? 'button'}
      data-slot="button"
      data-variant={variant}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <Spinner size={size === 'xs' ? 'xs' : 'sm'} />}
      {children}
    </button>
  )
}
