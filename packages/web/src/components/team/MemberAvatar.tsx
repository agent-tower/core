import { useMemo } from 'react'
import { Avatar, type AvatarSize } from '@/design-system'
import { cn } from '@/lib/utils'

function getInitials(name: string) {
  const trimmed = name.trim()
  if (!trimmed) return '?'
  const parts = trimmed.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    return `${parts[0]![0] ?? ''}${parts[1]![0] ?? ''}`.toUpperCase()
  }
  return Array.from(trimmed).slice(0, 2).join('').toUpperCase()
}

function isColorAvatar(value: string): boolean {
  const trimmed = value.trim()
  return /^#([0-9a-f]{3,8})$/i.test(trimmed)
    || /^rgba?\(/i.test(trimmed)
    || /^hsla?\(/i.test(trimmed)
}

function isImageAvatar(value: string): boolean {
  const trimmed = value.trim()
  return trimmed.startsWith('/')
    || trimmed.startsWith('http://')
    || trimmed.startsWith('https://')
    || trimmed.startsWith('data:image/')
    || trimmed.startsWith('blob:')
}

function getAvatarText(avatar: string | null | undefined, name: string) {
  const trimmed = avatar?.trim() ?? ''
  if (!trimmed || isColorAvatar(trimmed) || isImageAvatar(trimmed)) {
    return getInitials(name)
  }
  if (trimmed.length <= 2) return trimmed.toUpperCase()
  return trimmed.slice(0, 2).toUpperCase()
}

export interface MemberAvatarProps {
  name: string
  avatar?: string | null
  /** 设计系统档位；xs 及更小只放得下一个汉字，缩写取第一个字 */
  size?: AvatarSize
  className?: string
}

/**
 * 团队成员 / Agent 头像：设计系统的 Avatar（单色底 + 缩写，有图片用图片，加载失败退回缩写）。
 * 缩写按角色名取前两个字；avatar 存的是 1–2 个字符时直接显示它。
 * 旧数据里存的色值不再用作底色，按缩写显示。
 */
export function MemberAvatar({ name, avatar, size, className }: MemberAvatarProps) {
  const trimmedAvatar = avatar?.trim() ?? ''
  const fallbackText = useMemo(() => {
    const text = getAvatarText(trimmedAvatar, name)
    return size === 'xs' && /[\u3400-\u9fff]/.test(text) ? Array.from(text)[0]! : text
  }, [name, trimmedAvatar, size])

  return (
    <Avatar
      name={name}
      src={trimmedAvatar && isImageAvatar(trimmedAvatar) ? trimmedAvatar : undefined}
      initials={fallbackText}
      size={size}
      className={cn(!size && 'size-7 text-[10px]', className)}
    />
  )
}
