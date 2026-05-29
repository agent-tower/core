import type { ReactNode } from 'react'

export type TooltipSide = 'top' | 'bottom'

interface TooltipProps {
  content: ReactNode
  children: ReactNode
  className?: string
  side?: TooltipSide
}

/**
 * Hover tooltip using pure CSS (group-hover pattern).
 * Wrap any trigger element; the tooltip appears above on hover.
 */
export function Tooltip({ content, children, className = '', side = 'top' }: TooltipProps) {
  const tooltipPosition = side === 'bottom'
    ? 'top-full mt-2'
    : 'bottom-full mb-2'
  const arrowPosition = side === 'bottom'
    ? 'bottom-full border-b-neutral-900'
    : 'top-full border-t-neutral-900'

  return (
    <div className={`group/tooltip relative ${className}`}>
      {children}
      <div className={`absolute ${tooltipPosition} left-1/2 -translate-x-1/2 px-3 py-2 bg-neutral-900 text-white text-xs rounded-lg opacity-0 group-hover/tooltip:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-[100] shadow-lg`}>
        {content}
        <div className={`absolute ${arrowPosition} left-1/2 -translate-x-1/2 border-4 border-transparent`} />
      </div>
    </div>
  )
}
