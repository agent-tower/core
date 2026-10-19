import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { VIZ } from '../tokens'

/** 图例样式要与图形一致：柱/面用方块，线用短线，计划用斜纹或虚线 */
export type LegendSwatch = 'solid' | 'hatch' | 'line' | 'dashed' | 'dot' | 'outline'

export interface LegendItem {
  label: ReactNode
  swatch?: LegendSwatch
  /** CSS 颜色（通常是 VIZ 角色色或状态色变量） */
  color?: string
  /** 可选的数值，跟在标签后 */
  value?: ReactNode
}

export function LegendSwatchMark({ swatch = 'solid', color = VIZ.ink }: { swatch?: LegendSwatch; color?: string }) {
  switch (swatch) {
    case 'hatch':
      return <span aria-hidden="true" className="hatch size-2.5 shrink-0 rounded-[2px] bg-viz-0" style={{ color: color === VIZ.ink ? VIZ.plan : color }} />
    case 'line':
      return <span aria-hidden="true" className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: color }} />
    case 'dashed':
      return (
        <svg aria-hidden="true" width="14" height="2" className="shrink-0">
          <line x1="0" y1="1" x2="14" y2="1" stroke={color} strokeWidth="2" strokeDasharray="3 2" />
        </svg>
      )
    case 'dot':
      return <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ background: color }} />
    case 'outline':
      return <span aria-hidden="true" className="size-2.5 shrink-0 rounded-[2px]" style={{ boxShadow: `inset 0 0 0 1px ${color}` }} />
    default:
      return <span aria-hidden="true" className="size-2.5 shrink-0 rounded-[2px]" style={{ background: color }} />
  }
}

/**
 * 图例：两个及以上系列必须有图例；单系列不放（标题已经说明画的是什么）。
 * 文字用灰色正文色，颜色只在色块上——文字永远不穿数据色。
 */
export function Legend({ items, className }: { items: LegendItem[]; className?: string }) {
  return (
    <ul className={cn('flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-muted-foreground', className)}>
      {items.map((item, index) => (
        <li key={index} className="inline-flex items-center gap-1.5">
          <LegendSwatchMark swatch={item.swatch} color={item.color} />
          <span>{item.label}</span>
          {item.value !== undefined && <span className="font-medium tabular-nums text-foreground/80">{item.value}</span>}
        </li>
      ))}
    </ul>
  )
}
