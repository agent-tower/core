import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Ellipsis } from 'lucide-react'
import { Button, Popover, PopoverContent, PopoverTrigger } from '@/design-system'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

export interface TaskToolbarItem {
  id: string
  label: string
  control: ReactNode
  /** An inert trigger with the same dimensions, without menus or data hooks. */
  measure: ReactNode
  changed?: boolean
}

/** Only the left options participate in overflow. The mode switch is a fixed sibling. */
export function TaskOptionsToolbar({ items, fixed, disabled }: {
  items: TaskToolbarItem[]
  fixed?: ReactNode
  disabled?: boolean
}) {
  const { t } = useI18n()
  const containerRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLDivElement>(null)
  const [visibleCount, setVisibleCount] = useState(items.length)
  const [open, setOpen] = useState(false)

  useLayoutEffect(() => {
    const container = containerRef.current
    const measure = measureRef.current
    if (!container || !measure) return
    const update = () => {
      const available = container.clientWidth
      if (!available) return // Hidden views and DOM tests have no layout yet.
      const widths = Array.from(measure.children).map(node => node.getBoundingClientRect().width)
      const moreWidth = widths.pop() ?? 0
      const gap = parseFloat(getComputedStyle(container).columnGap) || 0
      let count = widths.length
      let width = widths.reduce((sum, value) => sum + value, 0) + gap * Math.max(0, count - 1)
      if (width > available) {
        width += moreWidth + gap
        while (count > 1 && width > available) width -= (widths[--count] ?? 0) + gap
      }
      setVisibleCount(count)
      if (count === items.length) setOpen(false)
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(container)
    for (const child of measure.children) observer.observe(child)
    return () => observer.disconnect()
  }, [items])

  const visible = items.slice(0, visibleCount)
  const overflow = items.slice(visibleCount)
  const hasChanges = overflow.some(item => item.changed)
  const moreContents = <><Ellipsis size={14} /><span>{t('More options')}</span><span aria-hidden="true" className={cn('size-1 shrink-0 rounded-full bg-foreground', !hasChanges && 'invisible')} /></>
  const moreClass = 'h-7 shrink-0 gap-1.5 px-2 text-xs font-medium pointer-coarse:min-h-11'

  return (
    <div className="relative mt-2.5 flex min-w-0 items-center gap-3 px-0.5" data-task-options-toolbar>
      <div ref={containerRef} className="flex min-w-0 flex-1 items-center gap-1.5" data-task-options>
        {visible.map((item, index) => (
          <div key={item.id} data-task-option={item.id} className={cn(index === 0 ? 'min-w-0 shrink [&_button]:max-w-full' : 'shrink-0')}>
            {item.control}
          </div>
        ))}
        {overflow.length > 0 && (
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" disabled={disabled} className={moreClass}
                aria-label={hasChanges ? t('More task options (modified)') : t('More task options')}>
                {moreContents}
              </Button>
            </PopoverTrigger>
            <PopoverContent aria-label={t('More task options')} className="w-80 max-w-[calc(100vw-1rem)] space-y-2">
              {overflow.map(item => (
                <div key={item.id} data-task-option={item.id} className="flex min-w-0 items-center justify-between gap-3">
                  <span className="shrink-0 text-xs text-muted-foreground">{item.label}</span>
                  <div className="min-w-0 [&_button]:max-w-full">{item.control}</div>
                </div>
              ))}
            </PopoverContent>
          </Popover>
        )}
      </div>
      {fixed && <div className="shrink-0" data-task-mode-switch>{fixed}</div>}
      <div aria-hidden="true" inert className="pointer-events-none invisible absolute inset-x-0 top-0 h-0 overflow-hidden">
        <div ref={measureRef} className="flex w-max gap-1.5">
          {items.map(item => <div key={item.id} className="shrink-0">{item.measure}</div>)}
          <Button asChild variant="ghost" size="sm" className={moreClass}><span>{moreContents}</span></Button>
        </div>
      </div>
    </div>
  )
}
