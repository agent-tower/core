import { useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { buttonClassName, type ButtonSize, type ButtonVariant } from './button-styles'

async function writeClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  // 非安全上下文（隧道 http 访问）没有 Clipboard API，退回 execCommand
  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  textarea.remove()
}

export interface CopyButtonProps {
  value: string
  /** icon 仅图标（默认）· text 图标 + 文字 */
  display?: 'icon' | 'text'
  variant?: ButtonVariant
  size?: ButtonSize
  label?: string
  copiedLabel?: string
  onCopied?: () => void
  className?: string
}

/** 复制：点击后图标变对勾 1.6 秒，文案同步变成「已复制」，读屏同样播报 */
export function CopyButton({
  value,
  display = 'icon',
  variant = 'ghost',
  size = 'sm',
  label,
  copiedLabel,
  onCopied,
  className,
}: CopyButtonProps) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  const idleText = label ?? t('Copy')
  const doneText = copiedLabel ?? t('Copied')
  const text = copied ? doneText : idleText

  const handleClick = async () => {
    try {
      await writeClipboard(value)
      setCopied(true)
      onCopied?.()
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  const glyph = copied ? <Check className="text-success" /> : <Copy />

  return (
    <button
      type="button"
      data-slot="copy-button"
      onClick={handleClick}
      aria-label={display === 'icon' ? text : undefined}
      title={display === 'icon' ? idleText : undefined}
      className={buttonClassName({ variant, size, iconOnly: display === 'icon', className: cn(display === 'text' && 'tabular-nums', className) })}
    >
      {glyph}
      {display === 'text' && <span>{text}</span>}
      <span className="sr-only" aria-live="polite">{copied ? doneText : ''}</span>
    </button>
  )
}
