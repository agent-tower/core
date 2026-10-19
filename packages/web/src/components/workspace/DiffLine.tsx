import React from 'react'
import { cn } from '@/lib/utils'

/**
 * unified diff 的一行：新增浅绿底、删除浅红底、块头（@@）蓝字，diff / index 头灰字。
 * 行号只是 diff 文本里的序号，不是文件行号，按装饰处理（与 CodeBlock 的行号一致）。
 * 外层容器负责等宽字体与行高（font-mono text-xs leading-5）。
 */
export const DiffLine: React.FC<{ line: string; lineNum: number }> = ({ line, lineNum }) => {
  let bgClass = ''
  let textClass = 'text-foreground/90'

  if (line.startsWith('+') && !line.startsWith('+++')) {
    bgClass = 'bg-success/10'
  } else if (line.startsWith('-') && !line.startsWith('---')) {
    bgClass = 'bg-destructive/10'
  } else if (line.startsWith('@@')) {
    bgClass = 'bg-info/5'
    textClass = 'text-info-ink'
  } else if (line.startsWith('diff ') || line.startsWith('index ')) {
    textClass = 'text-muted-foreground'
  }

  return (
    <div className={cn('flex', bgClass)}>
      <span aria-hidden="true" className="w-10 shrink-0 select-none border-r border-border/60 pr-2 text-right text-muted-foreground/50">
        {lineNum}
      </span>
      <span className={cn('whitespace-pre pl-2', textClass)}>{line}</span>
    </div>
  )
}
