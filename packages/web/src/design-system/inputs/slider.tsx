import { Slider as SliderPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'
import { useControllableState } from '../lib/hooks'

export interface SliderProps {
  value?: number[]
  defaultValue?: number[]
  onValueChange?: (value: number[]) => void
  onValueCommit?: (value: number[]) => void
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  /** 刻度点（取值），用于分档滑块 */
  marks?: number[]
  'aria-label'?: string
  className?: string
}

/**
 * 滑块：在连续或分档的范围里取值（推理强度、并发数）。
 * 轨道 4px，已选段 Charcoal，滑块是白芯黑环；分档时显示刻度点，已越过的刻度变实心。
 * 精确数值必须同时以文字显示在旁边，不能只靠滑块位置。
 */
export function Slider({ value, defaultValue, onValueChange, onValueCommit, min = 0, max = 100, step = 1, disabled, marks, className, ...props }: SliderProps) {
  const [current, setCurrent] = useControllableState({ value, defaultValue: defaultValue ?? [min], onChange: onValueChange })
  const span = max - min || 1
  const low = current.length > 1 ? Math.min(...current) : min
  const high = Math.max(...current)

  return (
    <SliderPrimitive.Root
      value={current}
      onValueChange={setCurrent}
      onValueCommit={onValueCommit}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      className={cn('relative flex h-5 w-full touch-none select-none items-center data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50', className)}
    >
      <SliderPrimitive.Track className="relative h-1 w-full grow rounded-full bg-foreground/10">
        <SliderPrimitive.Range className="absolute h-full rounded-full bg-primary" />
        {marks?.map(mark => (
          <span
            key={mark}
            aria-hidden="true"
            className={cn(
              'absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full',
              mark >= low && mark <= high ? 'bg-primary' : 'bg-foreground/20',
            )}
            style={{ left: `${((mark - min) / span) * 100}%` }}
          />
        ))}
      </SliderPrimitive.Track>
      {current.map((_, index) => (
        <SliderPrimitive.Thumb
          key={index}
          aria-label={props['aria-label']}
          className="block size-4 rounded-full border-4 border-primary bg-background shadow-raised transition-[transform,box-shadow] duration-150 hover:scale-110 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-ring/30 motion-reduce:transition-none"
        />
      ))}
    </SliderPrimitive.Root>
  )
}
