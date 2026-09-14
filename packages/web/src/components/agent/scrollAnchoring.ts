import type { VirtualItem, Virtualizer } from '@tanstack/react-virtual'

/**
 * Scroll-anchoring policy for dynamic row heights.
 *
 * TanStack's default compensates for *any* row that starts above the scroll
 * offset. A row that spans the viewport (a long streaming message, an expanded
 * thinking block) grows downwards, so compensating drags the reader into the
 * newly appended text. Only rows that **end above the viewport after this
 * resize** actually push the content below them.
 *
 * The predicate therefore has to compare two post-resize quantities:
 *
 * - `item` is the measurement cached *before* the resize, so the row's
 *   post-resize end is `item.end + delta` (`delta` is this resize's size
 *   change); using the stale `item.end` alone misjudges rows that were above
 *   the viewport when last measured and grew across the boundary.
 * - The viewport top has to come from the same coordinate system as the
 *   measurements: `getScrollOffset() + scrollAdjustments`, where
 *   `scrollAdjustments` holds the deltas already compensated for earlier rows in
 *   this measurement pass.
 *
 * Boundary: `postResizeEnd === viewportTop` counts as above — the row keeps no
 * visible pixel, so it is compensated. Rows that still intersect the viewport
 * after the resize (including the crossing case above) are never compensated,
 * which is what keeps the reader's position stable.
 *
 * Assigned on the virtualizer instance — it is an instance hook, not an option.
 */
export function shouldAdjustScrollPositionOnItemSizeChange(
  item: VirtualItem,
  delta: number,
  instance: Virtualizer<HTMLElement, Element>,
): boolean {
  const coordinates = instance as unknown as ScrollCoordinates
  const viewportTop = coordinates.getScrollOffset() + coordinates.scrollAdjustments
  return item.end + delta <= viewportTop
}

/**
 * The coordinate accessors virtual-core keeps private in its typings even
 * though its own default predicate reads exactly these two
 * (`item.start < getScrollOffset() + scrollAdjustments`). Reading them through
 * this narrow view keeps the comparison in the same coordinate system the
 * measurements use; `scrollOffset` alone would be stale, because a compensation
 * only reaches the DOM asynchronously through the next scroll event.
 */
interface ScrollCoordinates {
  getScrollOffset: () => number
  scrollAdjustments: number
}
