import { useId, type ReactNode } from 'react'
import { Check, Minus } from 'lucide-react'
import { Checkbox as CheckboxPrimitive, RadioGroup as RadioGroupPrimitive, Switch as SwitchPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'

/* ── 开关 ─────────────────────────────────────────────────── */

export interface SwitchProps {
  checked?: boolean
  defaultChecked?: boolean
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
  /** sm 16px 高（胶囊、行内）· md 20px 高（设置行，默认） */
  size?: 'sm' | 'md'
  id?: string
  'aria-label'?: string
  className?: string
}

/** 开关：立即生效的二元设置。开 = Charcoal，关 = 浅灰轨道；需要「保存」才生效的用 Checkbox */
export function Switch({ size = 'md', className, ...props }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'peer relative inline-flex shrink-0 cursor-pointer items-center rounded-full transition-colors duration-150 outline-none',
        'focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-40',
        'bg-foreground/15 data-[state=checked]:bg-primary',
        size === 'md' ? 'h-5 w-9' : 'h-4 w-7',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          'pointer-events-none block rounded-full bg-background shadow-raised transition-transform duration-150 motion-reduce:transition-none',
          size === 'md'
            ? 'size-4 translate-x-0.5 data-[state=checked]:translate-x-[18px]'
            : 'size-3 translate-x-0.5 data-[state=checked]:translate-x-3.5',
        )}
      />
    </SwitchPrimitive.Root>
  )
}

/* ── 复选框 ───────────────────────────────────────────────── */

export interface CheckboxProps {
  checked?: boolean | 'indeterminate'
  defaultChecked?: boolean
  onCheckedChange?: (checked: boolean | 'indeterminate') => void
  disabled?: boolean
  label?: ReactNode
  description?: ReactNode
  id?: string
  'aria-label'?: string
  className?: string
}

/** 复选框：多选、批量选择、需要提交的确认项。可带标签与说明，整行可点 */
export function Checkbox({ label, description, id, className, ...props }: CheckboxProps) {
  const autoId = useId()
  const controlId = id ?? autoId
  const box = (
    <CheckboxPrimitive.Root
      id={controlId}
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-foreground/25 bg-background shadow-raised transition-colors outline-none',
        'focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-40',
        'data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground',
        'data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary data-[state=indeterminate]:text-primary-foreground',
        !label && className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center">
        {props.checked === 'indeterminate'
          ? <Minus className="size-3" strokeWidth={3} aria-hidden="true" />
          : <Check className="size-3" strokeWidth={3} aria-hidden="true" />}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )

  if (!label) return box

  return (
    <div className={cn('flex items-start gap-2.5', className)}>
      <span className="flex h-5 items-center">{box}</span>
      <label htmlFor={controlId} className={cn('cursor-pointer select-none', props.disabled && 'cursor-not-allowed opacity-50')}>
        <span className="block text-[13px] leading-5 text-foreground">{label}</span>
        {description && <span className="block text-xs leading-relaxed text-muted-foreground">{description}</span>}
      </label>
    </div>
  )
}

/* ── 单选组 ───────────────────────────────────────────────── */

export interface RadioOption {
  value: string
  label: ReactNode
  description?: ReactNode
  disabled?: boolean
}

export interface RadioGroupProps {
  options: RadioOption[]
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  orientation?: 'vertical' | 'horizontal'
  'aria-label'?: string
  className?: string
}

/** 单选组：2–5 个需要读说明才能选的互斥选项（权限档位、工作区模式）。选中 = 粗黑环，与滑块同一形状 */
export function RadioGroup({ options, orientation = 'vertical', className, ...props }: RadioGroupProps) {
  const baseId = useId()
  return (
    <RadioGroupPrimitive.Root
      orientation={orientation}
      className={cn(orientation === 'vertical' ? 'flex flex-col gap-3' : 'flex flex-wrap gap-x-5 gap-y-2', className)}
      {...props}
    >
      {options.map(option => {
        const itemId = `${baseId}-${option.value}`
        return (
          <div key={option.value} className="flex items-start gap-2.5">
            <span className="flex h-5 items-center">
              <RadioGroupPrimitive.Item
                id={itemId}
                value={option.value}
                disabled={option.disabled}
                className={cn(
                  'size-4 shrink-0 rounded-full border border-foreground/25 bg-background shadow-raised transition-[border-color,border-width] duration-150 outline-none',
                  'focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-40',
                  'data-[state=checked]:border-[5px] data-[state=checked]:border-primary',
                )}
              />
            </span>
            <label htmlFor={itemId} className={cn('cursor-pointer select-none', option.disabled && 'cursor-not-allowed opacity-50')}>
              <span className="block text-[13px] leading-5 text-foreground">{option.label}</span>
              {option.description && <span className="block text-xs leading-relaxed text-muted-foreground">{option.description}</span>}
            </label>
          </div>
        )
      })}
    </RadioGroupPrimitive.Root>
  )
}
