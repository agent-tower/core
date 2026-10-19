import type { ReactNode } from 'react'
import { ToggleGroup } from 'radix-ui'
import { cn } from '@/lib/utils'
import { useControllableState } from '../lib/hooks'

export interface SegmentedOption {
  value: string
  label: ReactNode
  icon?: ReactNode
  count?: number
  disabled?: boolean
}

export interface SegmentedProps {
  options: SegmentedOption[]
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  size?: 'sm' | 'md'
  /** 撑满容器，等分宽度 */
  block?: boolean
  'aria-label': string
  className?: string
}

/**
 * 分段选择：2–5 个互斥选项、切换后原地刷新内容（视图、时间范围、筛选口径）。
 * 选中段是浮起的白卡——和侧栏选中行是同一种材质，表达「这一项正在展示」。
 * 方向键在段之间移动，始终有且只有一项选中。
 */
export function Segmented({ options, value, defaultValue, onValueChange, size = 'md', block = false, className, ...props }: SegmentedProps) {
  const [current, setCurrent] = useControllableState({ value, defaultValue: defaultValue ?? options[0]?.value ?? '', onChange: onValueChange })

  return (
    <ToggleGroup.Root
      type="single"
      value={current}
      onValueChange={next => {
        if (next) setCurrent(next)
      }}
      aria-label={props['aria-label']}
      className={cn(
        'items-center gap-0.5 rounded-lg bg-foreground/[0.05] p-0.5',
        // w-fit：放进纵向 flex 容器时也不被拉伸
        block ? 'flex w-full' : 'inline-flex w-fit',
        className,
      )}
    >
      {options.map(option => (
        <ToggleGroup.Item
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          className={cn(
            'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium text-foreground/70 transition-[color,background-color,box-shadow] duration-150',
            'hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-40',
            'data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-raised data-[state=on]:ring-1 data-[state=on]:ring-border/80',
            size === 'md' ? 'h-7 px-3 text-xs [&_svg]:size-3.5' : 'h-6 px-2.5 text-xs [&_svg]:size-3',
            block && 'flex-1',
          )}
        >
          {option.icon}
          {option.label}
          {option.count !== undefined && <span className="tabular-nums text-foreground/65">{option.count}</span>}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  )
}
