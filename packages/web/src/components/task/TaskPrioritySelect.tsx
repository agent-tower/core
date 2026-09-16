import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronsDown, ChevronsUp, Minus, SignalHigh } from 'lucide-react'
import type { TaskPriority } from '@agent-tower/shared'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { TASK_PRIORITY_OPTIONS, getTaskPriorityOption } from './task-priority'

function PriorityIcon({ iconName, className }: { iconName: string; className?: string }) {
  switch (iconName) {
    case 'chevrons-up': return <ChevronsUp className={className} aria-hidden="true" />
    case 'signal-high': return <SignalHigh className={className} aria-hidden="true" />
    case 'chevrons-down': return <ChevronsDown className={className} aria-hidden="true" />
    default: return <Minus className={className} aria-hidden="true" />
  }
}

export function TaskPriorityIndicator({ priority, className }: { priority?: number; className?: string }) {
  const option = getTaskPriorityOption(priority)
  return (
    <span
      className={cn('inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none', option.className, className)}
      title={`${option.code} · ${option.label}`}
    >
      {option.code}
    </span>
  )
}

interface TaskPrioritySelectProps {
  value?: number
  onChange?: (value: TaskPriority) => void
  disabled?: boolean
  compact?: boolean
}

export function TaskPrioritySelect({ value, onChange, disabled = false, compact = false }: TaskPrioritySelectProps) {
  const { t } = useI18n()
  const [isOpen, setIsOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const current = getTaskPriorityOption(value)

  useEffect(() => {
    if (!isOpen) return
    const handlePointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setIsOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [isOpen])

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled || !onChange}
        onClick={() => setIsOpen(open => !open)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={t('Task priority')}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:opacity-50',
          compact ? 'px-1.5 py-1' : 'px-2 py-1.5',
          current.className,
        )}
      >
        <PriorityIcon iconName={current.iconName} className="size-3.5" />
        <span>{t(current.label)}</span>
        {onChange ? <ChevronDown className={cn('size-3 transition-transform', isOpen && 'rotate-180')} aria-hidden="true" /> : null}
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-36 rounded-lg border border-border bg-popover p-1 shadow-lg" role="listbox" aria-label={t('Task priority')}>
          {TASK_PRIORITY_OPTIONS.map(option => {
            const selected = option.value === current.value
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                onClick={() => {
                  onChange?.(option.value)
                  setIsOpen(false)
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs text-foreground/80 transition-colors hover:bg-accent"
              >
                <span className={cn('inline-flex size-5 items-center justify-center rounded', option.className)}>
                  <PriorityIcon iconName={option.iconName} className="size-3.5" />
                </span>
                <span className="flex-1">{option.code} · {t(option.label)}</span>
                {selected ? <Check className="size-3.5 text-foreground" aria-hidden="true" /> : null}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
