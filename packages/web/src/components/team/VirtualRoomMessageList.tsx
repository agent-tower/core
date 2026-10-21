import { useCallback, useEffect, useState, type ReactNode, type RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { shouldAdjustScrollPositionOnItemSizeChange } from '@/components/agent/scrollAnchoring'
import type { RoomTimelineItem } from './room-timeline-items'

// Scroll/measurement updates stay here, below both the input state and the
// room-wide translation/query subscriptions.
export function VirtualRoomMessageList({ items, renderItem, scrollElementRef, compact }: {
  items: RoomTimelineItem[]
  renderItem: (item: RoomTimelineItem) => ReactNode
  scrollElementRef: RefObject<HTMLElement | null>
  compact?: boolean
}) {
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [resolved, setResolved] = useState(false)
  const attachRoot = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    // Child refs attach before the parent's scroll ref on the first commit.
    const element = scrollElementRef.current ?? node.closest<HTMLElement>('[data-room-scroll]')
    setScrollElement(element)
    setViewportHeight(element?.clientHeight ?? 0)
    setResolved(true)
  }, [scrollElementRef])
  useEffect(() => {
    if (!scrollElement) return
    const update = () => setViewportHeight(scrollElement.clientHeight)
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(scrollElement)
    return () => observer.disconnect()
  }, [scrollElement])
  const scrollMargin = compact ? 12 : 16
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollElement,
    getItemKey: useCallback((index: number) => items[index].key, [items]),
    estimateSize: () => 160,
    overscan: 6,
    scrollMargin,
    measureElement: element => element.getBoundingClientRect().height,
  })
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = shouldAdjustScrollPositionOnItemSizeChange

  // Do not render the full history even once while resolving the viewport.
  if (!resolved) return <div ref={attachRoot} />
  return <div ref={attachRoot}>
    {viewportHeight > 0 ? (
      <div key="virtual" style={{ position: 'relative', height: virtualizer.getTotalSize(), width: '100%' }}>
        {virtualizer.getVirtualItems().map(row => (
          <div
            key={row.key}
            data-index={row.index}
            data-room-row={row.key}
            ref={virtualizer.measureElement}
            // A transform would trap Mermaid's fixed fullscreen overlay.
            style={{ position: 'absolute', top: row.start - scrollMargin, left: 0, width: '100%', paddingBottom: compact ? 10 : 12 }}
          >
            {renderItem(items[row.index])}
          </div>
        ))}
      </div>
    ) : (
      // Hidden panels and DOM tests get a bounded tail until measurable. Use a
      // different branch key to detach per-row measurement observers on switch.
      <div key="unmeasured" className={compact ? 'space-y-2.5' : 'space-y-3'}>
        {items.slice(-20).map(item => <div key={item.key} data-room-row={item.key}>{renderItem(item)}</div>)}
      </div>
    )}
  </div>
}
