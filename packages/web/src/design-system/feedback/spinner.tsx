import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

const SPINNER_SIZE = { xs: 12, sm: 14, md: 16, lg: 20 } as const

export interface SpinnerProps {
  size?: keyof typeof SPINNER_SIZE
  /** 可见的说明文字，如「正在读取文件」。传入后整体作为 status 区域被读屏播报 */
  label?: ReactNode
  className?: string
}

/**
 * 转圈：只用于「正在发生、时长未知」的短等待（按钮提交、读取文件）。
 * 有固定结构的内容加载用 Skeleton；有确定进度的用 Track。
 * 减少动态效果时放慢而不是停止——它表达的是「还在进行」。
 */
export function Spinner({ size = 'sm', label, className }: SpinnerProps) {
  const px = SPINNER_SIZE[size]
  const glyph = (
    <svg
      viewBox="0 0 16 16"
      width={px}
      height={px}
      fill="none"
      aria-hidden="true"
      className={cn('shrink-0 animate-spin motion-reduce:[animation-duration:2.4s]', !label && className)}
    >
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeOpacity="0.18" strokeWidth="1.75" />
      <path d="M8 1.75a6.25 6.25 0 0 1 6.25 6.25" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  )

  if (!label) return glyph

  return (
    <span role="status" aria-live="polite" className={cn('inline-flex items-center gap-2 text-[13px] text-muted-foreground', className)}>
      {glyph}
      <span>{label}</span>
    </span>
  )
}
