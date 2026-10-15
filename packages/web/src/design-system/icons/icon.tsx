import type { LucideProps } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ICON_SIZE, icons, type IconName, type IconSize } from './registry'

export interface IconProps extends Omit<LucideProps, 'size' | 'ref'> {
  name: IconName
  /** 档位或像素值，默认 md（16px） */
  size?: IconSize | number
}

/**
 * 语义图标：按含义取图标，统一尺寸档位与描边。
 * ≥ 24px 的大图标（空状态等）描边降到 1.5，避免显得笨重。
 * 默认 aria-hidden；图标独立承载含义时请传 aria-label。
 */
export function Icon({ name, size = 'md', strokeWidth, className, ...props }: IconProps) {
  const Component = icons[name]
  const px = typeof size === 'number' ? size : ICON_SIZE[size]
  const labelled = Boolean(props['aria-label'])
  return (
    <Component
      size={px}
      strokeWidth={strokeWidth ?? (px >= 24 ? 1.5 : 2)}
      aria-hidden={labelled ? undefined : true}
      role={labelled ? 'img' : undefined}
      className={cn('shrink-0', className)}
      {...props}
    />
  )
}
