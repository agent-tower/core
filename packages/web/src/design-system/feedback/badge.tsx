import type { ComponentProps, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { TONE_DOT, TONE_INK, TONE_SOFT, TONE_SOLID, type Tone } from '../tokens'

export type BadgeVariant = 'soft' | 'outline' | 'solid' | 'dot'

export interface BadgeProps extends ComponentProps<'span'> {
  tone?: Tone
  /** soft 浅底（默认）· outline 描边 · solid 实底（每屏最多一处）· dot 圆点 + 文字（状态列表首选） */
  variant?: BadgeVariant
  size?: 'sm' | 'md'
  /** pill 全圆角（状态、计数）· tag 4px 小圆角（标签、编号、优先级） */
  shape?: 'pill' | 'tag'
  icon?: ReactNode
}

const SIZE = {
  sm: 'h-[18px] px-1.5 text-[10px] gap-1 [&_svg]:size-2.5',
  md: 'h-5 px-2 text-[11px] gap-1 [&_svg]:size-3',
}

/**
 * 标签：一两个字的状态、数量或属性。
 * 文字永远用 *-ink（保证对比度），颜色只出现在状态上；没有状态含义的标签一律 neutral。
 */
export function Badge({
  tone = 'neutral',
  variant = 'soft',
  size = 'md',
  shape = 'pill',
  icon,
  className,
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      data-slot="badge"
      className={cn(
        'inline-flex shrink-0 items-center whitespace-nowrap font-medium leading-none [&_svg]:shrink-0',
        SIZE[size],
        shape === 'pill' ? 'rounded-full' : 'rounded',
        variant === 'soft' && [TONE_SOFT[tone], TONE_INK[tone]],
        variant === 'outline' && [
          'bg-background ring-1 ring-inset',
          tone === 'neutral' ? 'text-foreground/80 ring-border' : [TONE_INK[tone], 'ring-current/25'],
        ],
        variant === 'solid' && TONE_SOLID[tone],
        variant === 'dot' && 'px-0 text-foreground/80',
        className,
      )}
      {...props}
    >
      {variant === 'dot' && <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', TONE_DOT[tone])} />}
      {icon}
      {children}
    </span>
  )
}

export interface CountBadgeProps extends Omit<ComponentProps<'span'>, 'children'> {
  count: number
  /** 超过上限显示「99+」 */
  max?: number
  /** 需要用户介入时才高亮（如待审查），其余计数保持安静 */
  tone?: Tone
}

/** 计数：分组标题、导航行右侧的数量。默认安静的灰字，只有需要介入时才上色 */
export function CountBadge({ count, max = 99, tone = 'neutral', className, ...props }: CountBadgeProps) {
  const text = count > max ? `${max}+` : String(count)
  return (
    <span
      data-slot="count-badge"
      className={cn(
        'inline-flex shrink-0 items-center justify-center text-[11px] leading-4 tabular-nums',
        tone === 'neutral'
          ? 'font-normal text-muted-foreground'
          : ['min-w-4 rounded-full px-1.5 font-semibold', TONE_SOFT[tone], TONE_INK[tone]],
        className,
      )}
      {...props}
    >
      {text}
    </span>
  )
}
