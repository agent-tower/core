import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { SlashCommandOption } from '@agent-tower/shared'
import { SlashCommandList } from './SlashCommandList'

interface SlashCommandPopoverProps {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  commands: SlashCommandOption[]
  selectedIndex: number
  query: string
  hasCatalog: boolean
  title?: string
  queryPrefix?: string
  emptyCatalogMessage?: string
  emptyQueryMessage?: string
  insertionHint?: string
  compact?: boolean
  onSelect: (command: SlashCommandOption) => void
}

interface PopoverPosition {
  top: number
  left: number
  width: number
  maxHeight: number
}

const VIEWPORT_MARGIN = 12
const ANCHOR_GAP = 8

export function SlashCommandPopover({
  open,
  anchorRef,
  commands,
  selectedIndex,
  query,
  hasCatalog,
  title,
  queryPrefix,
  emptyCatalogMessage,
  emptyQueryMessage,
  insertionHint,
  compact = false,
  onSelect,
}: SlashCommandPopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<PopoverPosition | null>(null)

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }

    const anchor = anchorRef.current
    if (!anchor) return

    let frameId = 0

    const updatePosition = () => {
      const anchorElement = anchorRef.current
      if (!anchorElement) return

      const rect = anchorElement.getBoundingClientRect()
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      const minWidth = compact ? 260 : 320
      const maxWidth = compact ? viewportWidth - VIEWPORT_MARGIN * 2 : 560
      const width = Math.min(
        Math.max(rect.width, minWidth),
        Math.max(minWidth, maxWidth)
      )
      const left = Math.min(
        Math.max(VIEWPORT_MARGIN, rect.left),
        Math.max(VIEWPORT_MARGIN, viewportWidth - VIEWPORT_MARGIN - width)
      )

      const roomBelow = viewportHeight - rect.bottom - ANCHOR_GAP - VIEWPORT_MARGIN
      const roomAbove = rect.top - ANCHOR_GAP - VIEWPORT_MARGIN
      const panelHeight = panelRef.current?.offsetHeight ?? (compact ? 220 : 280)
      const preferredMaxHeight = compact ? 240 : 320
      const shouldPlaceAbove = roomBelow < 180 && roomAbove > roomBelow
      const availableHeight = shouldPlaceAbove ? roomAbove : roomBelow
      const maxHeight = Math.max(120, Math.min(preferredMaxHeight, availableHeight))
      const top = shouldPlaceAbove
        ? Math.max(VIEWPORT_MARGIN, rect.top - ANCHOR_GAP - Math.min(panelHeight, maxHeight))
        : Math.min(
            viewportHeight - VIEWPORT_MARGIN - Math.min(panelHeight, maxHeight),
            rect.bottom + ANCHOR_GAP
          )

      setPosition({ top, left, width, maxHeight })
    }

    const scheduleUpdate = () => {
      cancelAnimationFrame(frameId)
      frameId = requestAnimationFrame(updatePosition)
    }

    scheduleUpdate()

    const resizeObserver = new ResizeObserver(scheduleUpdate)
    resizeObserver.observe(anchor)
    if (panelRef.current) resizeObserver.observe(panelRef.current)

    window.addEventListener('resize', scheduleUpdate)
    window.addEventListener('scroll', scheduleUpdate, true)
    window.visualViewport?.addEventListener('resize', scheduleUpdate)
    window.visualViewport?.addEventListener('scroll', scheduleUpdate)

    return () => {
      cancelAnimationFrame(frameId)
      resizeObserver.disconnect()
      window.removeEventListener('resize', scheduleUpdate)
      window.removeEventListener('scroll', scheduleUpdate, true)
      window.visualViewport?.removeEventListener('resize', scheduleUpdate)
      window.visualViewport?.removeEventListener('scroll', scheduleUpdate)
    }
  }, [anchorRef, commands.length, compact, open, query, selectedIndex])

  if (!open || !position || typeof document === 'undefined') return null

  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-[120]">
      <div
        ref={panelRef}
        className="pointer-events-auto fixed overflow-hidden rounded-xl border border-border bg-background shadow-popover "
        style={{
          top: position.top,
          left: position.left,
          width: position.width,
          maxHeight: position.maxHeight,
        }}
      >
        <SlashCommandList
          commands={commands}
          selectedIndex={selectedIndex}
          query={query}
          hasCatalog={hasCatalog}
          title={title}
          queryPrefix={queryPrefix}
          emptyCatalogMessage={emptyCatalogMessage}
          emptyQueryMessage={emptyQueryMessage}
          insertionHint={insertionHint}
          compact={compact}
          onSelect={onSelect}
        />
      </div>
    </div>,
    document.body
  )
}
