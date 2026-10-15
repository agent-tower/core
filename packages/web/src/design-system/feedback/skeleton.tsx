import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/**
 * 骨架块：有固定结构的内容加载时使用，几何必须与真实内容一致，加载完成时不跳动。
 * 刷新已有数据时不要闪骨架——保留旧内容并降低不透明度。
 */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn('rounded-full bg-foreground/[0.06] motion-safe:animate-pulse', className)}
      {...props}
    />
  )
}

const LINE_WIDTHS = ['92%', '78%', '64%', '86%', '52%']

/** 多行文字骨架：行宽错落，最后一行最短 */
export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={cn('space-y-2', className)}>
      {Array.from({ length: lines }).map((_, index) => (
        <Skeleton
          key={index}
          className="h-2.5"
          style={{ width: index === lines - 1 ? '42%' : LINE_WIDTHS[index % LINE_WIDTHS.length] }}
        />
      ))}
    </div>
  )
}

/** 列表行骨架：与 32px 侧栏任务行同几何（标题 + 右侧元信息；行首不放状态图标） */
export function SkeletonRows({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div aria-hidden="true" className={cn('motion-safe:animate-pulse', className)}>
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="flex h-8 items-center gap-2.5 px-2">
          <div className="h-3 rounded-full bg-foreground/[0.06]" style={{ width: `${64 - (index % 3) * 14}%` }} />
          <div className="ml-auto h-2.5 w-8 shrink-0 rounded-full bg-foreground/[0.05]" />
        </div>
      ))}
    </div>
  )
}
