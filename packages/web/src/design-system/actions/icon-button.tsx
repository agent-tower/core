import type { ComponentProps } from 'react'
import { Spinner } from '../feedback/spinner'
import { buttonClassName, type ButtonSize, type ButtonTone, type ButtonVariant } from './button-styles'

export interface IconButtonProps extends Omit<ComponentProps<'button'>, 'aria-label'> {
  /** 必填：读屏名称，同时作为悬停提示 */
  label: string
  variant?: ButtonVariant
  tone?: ButtonTone
  /** xs 24 · sm 28 · md 32（默认）· lg 36 · xl 44 */
  size?: ButtonSize
  loading?: boolean
  /** 不需要原生 title 提示时关闭（外层已有 Tooltip） */
  showTitle?: boolean
}

/**
 * 图标按钮：工具栏、行尾操作、关闭。默认 ghost——灰色图标，悬停才浮现底色。
 * 图标的含义不够自明时外包一层 Tooltip。
 */
export function IconButton({
  label,
  variant = 'ghost',
  tone = 'neutral',
  size = 'md',
  loading = false,
  showTitle = true,
  className,
  disabled,
  children,
  type,
  ...props
}: IconButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      data-slot="icon-button"
      aria-label={label}
      title={showTitle ? label : undefined}
      className={buttonClassName({ variant, tone, size, iconOnly: true, loading, className })}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? <Spinner size={size === 'xs' ? 'xs' : 'sm'} /> : children}
    </button>
  )
}
