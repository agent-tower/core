import type { ReactNode } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { DropdownMenu as MenuPrimitive } from 'radix-ui'
import { cn } from '@/lib/utils'
import { useControllableState } from '../lib/hooks'
import { MENU_INDICATOR, MENU_ITEM, MENU_ITEM_CHECKABLE, MENU_LABEL, MENU_SURFACE } from '../overlays/menu-styles'

export interface ChipSelectOption {
  value: string
  label: string
  description?: ReactNode
  icon?: ReactNode
  disabled?: boolean
}

export interface ChipSelectProps {
  options: ChipSelectOption[]
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  /** 触发器图标；不传则用选中项的图标 */
  icon?: ReactNode
  placeholder?: string
  /** 读屏名称，同时作为菜单标题 */
  'aria-label': string
  showMenuLabel?: boolean
  disabled?: boolean
  /** 菜单宽度：带说明行的选项用 lg */
  menuWidth?: 'sm' | 'md' | 'lg'
  className?: string
}

const MENU_WIDTH = {
  sm: 'w-48',
  md: 'w-60',
  lg: 'w-80',
}

/**
 * 胶囊选择器：输入卡下方、工具栏里的轻量参数选择（项目 / Agent / 工作区模式）。
 * 平时只是一行灰字 + 图标，悬停才浮出底色；菜单可带说明与不可用原因。
 */
export function ChipSelect({
  options,
  value,
  defaultValue,
  onValueChange,
  icon,
  placeholder,
  showMenuLabel = false,
  disabled,
  menuWidth = 'md',
  className,
  ...props
}: ChipSelectProps) {
  const [current, setCurrent] = useControllableState({ value, defaultValue: defaultValue ?? '', onChange: onValueChange })
  const selected = options.find(option => option.value === current)
  const label = props['aria-label']

  return (
    <MenuPrimitive.Root>
      <MenuPrimitive.Trigger
        disabled={disabled}
        aria-label={`${label}: ${selected?.label ?? placeholder ?? ''}`}
        className={cn(
          'group inline-flex h-7 max-w-full items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors',
          'hover:bg-accent data-[state=open]:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-40',
          selected ? 'text-foreground/80' : 'text-muted-foreground',
          className,
        )}
      >
        {(icon ?? selected?.icon) && (
          <span className="flex shrink-0 text-muted-foreground [&_svg]:size-3.5">{icon ?? selected?.icon}</span>
        )}
        <span className="max-w-[120px] truncate">{selected?.label ?? placeholder}</span>
        <ChevronDown aria-hidden="true" className="size-3 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-180" />
      </MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Content
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className={cn(MENU_SURFACE, 'max-h-[min(60vh,320px)] max-w-[calc(100vw-2rem)] overflow-y-auto origin-(--radix-dropdown-menu-content-transform-origin)', MENU_WIDTH[menuWidth])}
        >
          {showMenuLabel && <MenuPrimitive.Label className={MENU_LABEL}>{label}</MenuPrimitive.Label>}
          <MenuPrimitive.RadioGroup value={current} onValueChange={setCurrent}>
            {options.map(option => (
              <MenuPrimitive.RadioItem
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className={cn(MENU_ITEM, MENU_ITEM_CHECKABLE, 'group/item items-start data-[disabled]:opacity-50')}
              >
                {option.icon && <span className="mt-0.5 flex shrink-0 text-muted-foreground [&_svg]:size-3.5">{option.icon}</span>}
                <span className="min-w-0 flex-1">
                  <span className="block truncate group-data-[state=checked]/item:font-medium group-data-[state=checked]/item:text-foreground">
                    {option.label}
                  </span>
                  {option.description && (
                    <span className="mt-0.5 block whitespace-normal text-xs leading-[18px] text-muted-foreground">{option.description}</span>
                  )}
                </span>
                <MenuPrimitive.ItemIndicator className={cn(MENU_INDICATOR, 'top-2')}>
                  <Check className="size-3.5" />
                </MenuPrimitive.ItemIndicator>
              </MenuPrimitive.RadioItem>
            ))}
          </MenuPrimitive.RadioGroup>
        </MenuPrimitive.Content>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  )
}
