import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

const AVATAR_SIZE = {
  xs: 'size-5 text-[9px]',
  sm: 'size-6 text-[10px]',
  md: 'size-8 text-xs',
  lg: 'size-10 text-sm',
} as const

export type AvatarSize = keyof typeof AVATAR_SIZE

/** 姓名缩写：中文取最后 2 个字（王小明 → 小明，24px 及以下只取 1 个字），英文取前两个单词首字母 */
function initialsOf(name: string, size: AvatarSize) {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  if (/[㐀-鿿]/.test(trimmed)) return Array.from(trimmed).slice(size === 'xs' || size === 'sm' ? -1 : -2).join('')
  const words = trimmed.split(/\s+/)
  return (words.length > 1 ? `${words[0][0]}${words[1][0]}` : trimmed.slice(0, size === 'xs' ? 1 : 2)).toUpperCase()
}

export interface AvatarProps {
  name: string
  src?: string
  size?: AvatarSize
  /** circle 人 · square 项目 / Agent / 机器人 */
  shape?: 'circle' | 'square'
  /** 叠放时的白色描边 */
  ring?: boolean
  className?: string
}

/**
 * 头像：单色底 + 缩写，不给每个人分配颜色（颜色只留给状态）。
 * 图片加载失败自动退回缩写。
 */
export function Avatar({ name, src, size = 'sm', shape = 'circle', ring = false, className }: AvatarProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const showImage = Boolean(src) && failedSrc !== src
  return (
    <span
      title={name}
      className={cn(
        // 底色必须不透明：叠放时下一个头像要完全盖住上一个
        'relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden bg-muted font-medium text-foreground/70',
        AVATAR_SIZE[size],
        shape === 'circle' ? 'rounded-full' : 'rounded-md',
        ring && 'ring-2 ring-background',
        className,
      )}
    >
      {showImage ? (
        <img src={src} alt={name} className="size-full object-cover" onError={() => setFailedSrc(src ?? null)} />
      ) : (
        <span aria-label={name} role="img">{initialsOf(name, size)}</span>
      )}
    </span>
  )
}

export interface AvatarGroupProps {
  people: { name: string; src?: string }[]
  max?: number
  size?: AvatarSize
  className?: string
}

/** 头像组：叠放 + 白描边，超出部分收成「+N」 */
export function AvatarGroup({ people, max = 4, size = 'sm', className }: AvatarGroupProps) {
  const visible = people.slice(0, max)
  const rest = people.length - visible.length
  return (
    <span className={cn('inline-flex items-center', className)}>
      {visible.map((person, index) => (
        <Avatar key={`${person.name}-${index}`} name={person.name} src={person.src} size={size} ring className={index > 0 ? '-ml-1.5' : undefined} />
      ))}
      {rest > 0 && (
        <span
          title={people.slice(max).map(person => person.name).join('、')}
          className={cn('-ml-1.5 inline-flex shrink-0 items-center justify-center rounded-full bg-muted font-medium tabular-nums text-foreground/70 ring-2 ring-background', AVATAR_SIZE[size])}
        >
          +{rest}
        </span>
      )}
    </span>
  )
}

export interface MessageBubbleProps {
  /** user 右侧灰色气泡 · agent 左侧无气泡正文 */
  from: 'user' | 'agent'
  author?: ReactNode
  avatar?: ReactNode
  time?: ReactNode
  children: ReactNode
  className?: string
}

/**
 * 对话消息：用户消息是右侧灰气泡（右上角收尖）；Agent 回复不加气泡，直接是正文——
 * 长回复、代码块、表格才有足够的宽度。
 */
export function MessageBubble({ from, author, avatar, time, children, className }: MessageBubbleProps) {
  if (from === 'user') {
    return (
      <div className={cn('flex flex-col items-end gap-1', className)}>
        <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-foreground/[0.08] px-3.5 py-2.5 text-[13px] leading-relaxed text-foreground">
          {children}
        </div>
        {time && <span className="pr-1 text-[11px] text-muted-foreground">{time}</span>}
      </div>
    )
  }
  return (
    <div className={cn('flex gap-2.5', className)}>
      {avatar && <span className="mt-0.5 flex shrink-0">{avatar}</span>}
      <div className="min-w-0 flex-1">
        {(author || time) && (
          <div className="mb-1 flex items-baseline gap-2">
            {author && <span className="text-xs font-medium text-foreground">{author}</span>}
            {time && <span className="text-[11px] text-muted-foreground">{time}</span>}
          </div>
        )}
        <div className="text-[13px] leading-relaxed text-foreground/90">{children}</div>
      </div>
    </div>
  )
}
