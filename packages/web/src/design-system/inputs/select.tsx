import type { ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { Select as SelectPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'
import { MENU_INDICATOR, MENU_ITEM, MENU_ITEM_CHECKABLE, MENU_SURFACE } from '../overlays/menu-styles'
import { FIELD_DISABLED, FIELD_INVALID, FIELD_SHELL, FIELD_SIZE, useFieldControl } from './field-context'

export interface SelectOption {
  /** 不能为空字符串（Radix 约定）；「无」用一个明确的值表示 */
  value: string
  label: ReactNode
  description?: ReactNode
  icon?: ReactNode
  disabled?: boolean
}

export interface SelectProps {
  options: SelectOption[]
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  placeholder?: ReactNode
  size?: keyof typeof FIELD_SIZE
  disabled?: boolean
  invalid?: boolean
  id?: string
  'aria-label'?: string
  className?: string
  contentClassName?: string
}

/**
 * 选择框：从 5 个以上互斥选项里选一个（少于 5 个用 Segmented 或 Radio，全部可见更快）。
 * 触发器与输入框同外壳；浮层与菜单同材质，选中项加粗 + 右侧对勾，可带说明行。
 */
export function Select({
  options,
  value,
  defaultValue,
  onValueChange,
  placeholder,
  size = 'md',
  disabled,
  invalid,
  id,
  className,
  contentClassName,
  ...props
}: SelectProps) {
  const field = useFieldControl()
  const isInvalid = invalid ?? field?.invalid ?? false

  return (
    <SelectPrimitive.Root value={value} defaultValue={defaultValue} onValueChange={onValueChange} disabled={disabled}>
      <SelectPrimitive.Trigger
        id={id ?? field?.id}
        aria-label={props['aria-label']}
        aria-invalid={isInvalid || undefined}
        aria-describedby={field?.describedBy}
        className={cn(
          FIELD_SHELL,
          FIELD_SIZE[size],
          'group flex w-full min-w-0 items-center justify-between gap-2 text-left outline-none focus-visible:border-ring data-[state=open]:border-ring data-[placeholder]:text-muted-foreground/70',
          isInvalid && FIELD_INVALID,
          disabled && FIELD_DISABLED,
          className,
        )}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2 truncate [&_svg]:size-4">
          <SelectPrimitive.Value placeholder={placeholder} />
        </span>
        <SelectPrimitive.Icon asChild>
          <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-180" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            MENU_SURFACE,
            'max-h-(--radix-select-content-available-height) min-w-(--radix-select-trigger-width) origin-(--radix-select-content-transform-origin)',
            contentClassName,
          )}
        >
          <SelectPrimitive.Viewport>
            {options.map(option => (
              <SelectPrimitive.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className={cn(MENU_ITEM, MENU_ITEM_CHECKABLE, 'group/item items-start data-[state=checked]:text-foreground')}
              >
                {option.icon && <span className="mt-0.5 flex shrink-0 text-muted-foreground">{option.icon}</span>}
                <span className="min-w-0 flex-1">
                  <SelectPrimitive.ItemText>
                    <span className="flex items-center gap-2 truncate group-data-[state=checked]/item:font-medium">{option.label}</span>
                  </SelectPrimitive.ItemText>
                  {option.description && (
                    <span className="mt-0.5 block whitespace-normal text-[11px] leading-snug text-muted-foreground">{option.description}</span>
                  )}
                </span>
                <SelectPrimitive.ItemIndicator className={cn(MENU_INDICATOR, 'top-2')}>
                  <Check className="size-3.5" />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  )
}
