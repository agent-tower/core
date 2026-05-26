import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
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

function getAvatarStyle(avatar: string | null | undefined): CSSProperties | undefined {
  const trimmed = avatar?.trim() ?? ''
  if (!trimmed || !isColorAvatar(trimmed)) return undefined
  return {
    backgroundColor: trimmed,
    color: '#ffffff',
  }
}

export interface MemberAvatarProps {
  name: string
  avatar?: string | null
  className?: string
}

export function MemberAvatar({ name, avatar, className }: MemberAvatarProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const trimmedAvatar = avatar?.trim() ?? ''
  const shouldRenderImage = Boolean(trimmedAvatar) && isImageAvatar(trimmedAvatar) && failedSrc !== trimmedAvatar
  const fallbackText = useMemo(() => getAvatarText(trimmedAvatar, name), [name, trimmedAvatar])

  if (shouldRenderImage) {
    return (
      <img
        src={trimmedAvatar}
        alt={name}
        loading="lazy"
        onError={() => setFailedSrc(trimmedAvatar)}
        className={cn('h-7 w-7 shrink-0 rounded-full border border-neutral-200 bg-white object-cover', className)}
      />
    )
  }

  return (
    <div
      className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-neutral-200 bg-neutral-100 text-[10px] font-semibold text-neutral-600', className)}
      style={getAvatarStyle(trimmedAvatar)}
      aria-label={name}
    >
      {fallbackText}
    </div>
  )
}
