import { cn } from '@/lib/utils'
import { TONE_DOT, type Tone } from '../tokens'

export interface LiveDotProps {
  tone?: Tone
  /** 是否扩散脉冲；只给「正在发生」的东西（Agent 正在运行、连接在线） */
  pulse?: boolean
  label?: string
  className?: string
}

/** 活跃点：实时状态指示。脉冲含 reduced-motion 降级 */
export function LiveDot({ tone = 'success', pulse = true, label, className }: LiveDotProps) {
  return (
    <span
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn('relative inline-flex size-2 shrink-0', className)}
    >
      {pulse && (
        <span className={cn('absolute inline-flex size-full rounded-full opacity-60 motion-safe:animate-ping', TONE_DOT[tone])} />
      )}
      <span className={cn('relative inline-flex size-2 rounded-full', TONE_DOT[tone])} />
    </span>
  )
}

/**
 * 思考中：逐字明暗扫过的文字（与会话日志的 ThinkingIndicator 同一套动画）。
 * 读屏只读一次完整文本，不逐字播报。
 */
export function ThinkingText({ text, className }: { text: string; className?: string }) {
  return (
    <span className={cn('inline-flex text-sm', className)}>
      <span className="sr-only">{text}</span>
      <span className="agent-thinking-shimmer" aria-hidden="true">
        {Array.from(text).map((character, index) => (
          <span key={`${character}-${index}`} className="agent-thinking-char" style={{ animationDelay: `${index * 45}ms` }}>
            {character}
          </span>
        ))}
      </span>
    </span>
  )
}

/** 进行中的省略号：「处理中...」末尾三个点依次出现 */
export function WorkingDots({ className }: { className?: string }) {
  return (
    <span className={cn('active-work-dots', className)} aria-hidden="true">
      <span>.</span>
      <span className="active-work-dots__second">.</span>
      <span className="active-work-dots__third">.</span>
    </span>
  )
}
