import { useEffect, useId, useRef, useState } from 'react'
import { Switch } from '@/design-system'
import { cn } from '@/lib/utils'

export interface SegmentedEffortOption {
  value: string
  label: string
}

interface SegmentedEffortSliderProps {
  options: SegmentedEffortOption[]
  value: string
  onChange: (value: string) => void
  label: string
  efficiencyLabel: string
  intelligenceLabel: string
  followCliLabel: string
  currentLabel: string
  disabled?: boolean
  error?: string | null
}

export function SegmentedEffortSlider({
  options,
  value,
  onChange,
  label,
  efficiencyLabel,
  intelligenceLabel,
  followCliLabel,
  currentLabel,
  disabled = false,
  error,
}: SegmentedEffortSliderProps) {
  const explicitIndex = options.findIndex(option => option.value === value)
  const followingCli = value === ''
  const lastExplicitValue = useRef<string | undefined>(explicitIndex >= 0 ? value : undefined)
  const draggingPointer = useRef<number | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    if (explicitIndex >= 0) lastExplicitValue.current = value
  }, [explicitIndex, value])

  const selectIndex = (index: number) => {
    if (disabled || followingCli || options.length === 0) return
    const next = options[Math.max(0, Math.min(options.length - 1, index))]
    if (next && next.value !== value) onChange(next.value)
  }

  const selectPointerPosition = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0) return
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    selectIndex(Math.round(ratio * (options.length - 1)))
  }

  const selectedOption = explicitIndex >= 0 ? options[explicitIndex] : undefined
  const percentage = explicitIndex < 0 || options.length < 2
    ? 0
    : (explicitIndex / (options.length - 1)) * 100
  const sliderId = useId()
  const labelId = `${sliderId}-label`
  const currentId = `${sliderId}-current`
  const errorId = `${sliderId}-error`

  return (
    <div className="space-y-2.5">
      <div className="flex min-h-8 items-center justify-between gap-3">
        <label id={labelId} className="text-xs font-medium text-foreground">{label}</label>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{followCliLabel}</span>
          <Switch
            checked={followingCli}
            disabled={disabled}
            onCheckedChange={(checked) => {
              if (checked) onChange('')
              else onChange(lastExplicitValue.current ?? options.find(option => option.value === 'medium')?.value ?? options[0]?.value ?? '')
            }}
            aria-label={followCliLabel}
          />
        </div>
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground" aria-hidden="true">
        <span>{efficiencyLabel}</span>
        <span>{intelligenceLabel}</span>
      </div>

      <div
        id={sliderId}
        ref={trackRef}
        role="slider"
        tabIndex={followingCli || disabled ? -1 : 0}
        aria-labelledby={labelId}
        aria-disabled={followingCli || disabled}
        aria-valuemin={0}
        aria-valuemax={Math.max(0, options.length - 1)}
        aria-valuenow={explicitIndex >= 0 ? explicitIndex : undefined}
        aria-valuetext={selectedOption ? `${selectedOption.label}, ${selectedOption.value}` : followCliLabel}
        aria-describedby={error ? `${currentId} ${errorId}` : currentId}
        onKeyDown={(event) => {
          if (followingCli || disabled || explicitIndex < 0) return
          let nextIndex = explicitIndex
          if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') nextIndex -= 1
          else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') nextIndex += 1
          else if (event.key === 'Home') nextIndex = 0
          else if (event.key === 'End') nextIndex = options.length - 1
          else return
          event.preventDefault()
          selectIndex(nextIndex)
        }}
        onPointerDown={(event) => {
          if (followingCli || disabled) return
          draggingPointer.current = event.pointerId
          setDragging(true)
          event.currentTarget.setPointerCapture?.(event.pointerId)
          selectPointerPosition(event.clientX)
        }}
        onPointerMove={(event) => {
          if (draggingPointer.current === event.pointerId) selectPointerPosition(event.clientX)
        }}
        onPointerUp={(event) => {
          if (draggingPointer.current !== event.pointerId) return
          draggingPointer.current = null
          setDragging(false)
          event.currentTarget.releasePointerCapture?.(event.pointerId)
        }}
        onPointerCancel={() => {
          draggingPointer.current = null
          setDragging(false)
        }}
        className={cn(
          'relative mx-2.5 flex h-11 touch-pan-y items-center outline-none select-none',
          followingCli || disabled ? 'cursor-not-allowed opacity-55' : 'cursor-pointer',
          'focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2',
        )}
      >
        <div className="absolute inset-x-0 h-1 rounded-full bg-border" />
        {!followingCli && (
          <div
            className="absolute left-0 h-1 rounded-full bg-primary transition-[width] duration-150 motion-reduce:transition-none"
            style={{ width: `${percentage}%` }}
          />
        )}
        {options.map((option, index) => (
          <span
            key={option.value}
            aria-hidden="true"
            className={cn(
              'absolute size-3 -translate-x-1/2 rounded-full border-2 transition-colors motion-reduce:transition-none',
              !followingCli && index <= explicitIndex ? 'border-primary bg-primary' : 'border-border bg-background',
            )}
            style={{ left: `${options.length < 2 ? 0 : (index / (options.length - 1)) * 100}%` }}
          />
        ))}
        {!followingCli && selectedOption && (
          <span
            aria-hidden="true"
            className={cn(
              'absolute size-5 -translate-x-1/2 rounded-full border-[5px] border-primary bg-background shadow-raised transition-[left,transform] duration-150 motion-reduce:transition-none',
              dragging && 'scale-110',
            )}
            style={{ left: `${percentage}%` }}
          />
        )}
      </div>

      <div id={currentId} className="min-h-5 text-center text-xs text-muted-foreground">
        {followingCli
          ? followCliLabel
          : `${currentLabel}: ${selectedOption?.label ?? value} (${selectedOption?.value ?? value})`}
      </div>
      {error && <p id={errorId} role="alert" className="text-xs text-destructive-ink">{error}</p>}
    </div>
  )
}
