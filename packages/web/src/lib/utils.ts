import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Get the visual width of a string, counting CJK characters as 2 and others as 1.
 */
function getVisualWidth(str: string): number {
  let width = 0
  for (const char of str) {
    const code = char.codePointAt(0)!
    // CJK Unified Ideographs, CJK Extension A, Fullwidth forms, common CJK punctuation
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0x3000 && code <= 0x303f)
    ) {
      width += 2
    } else {
      width += 1
    }
  }
  return width
}

/**
 * Truncate a string in the middle when its visual width exceeds maxWidth.
 * Keeps the head and tail, joining them with '…'.
 * CJK characters count as width 2.
 */
export function truncateMiddle(str: string, maxWidth: number): string {
  if (getVisualWidth(str) <= maxWidth) return str

  // Reserve 1 for the ellipsis character
  const budget = maxWidth - 1
  const headBudget = Math.ceil(budget / 2)
  const tailBudget = Math.floor(budget / 2)

  let head = ''
  let headW = 0
  for (const char of str) {
    const w = getVisualWidth(char)
    if (headW + w > headBudget) break
    head += char
    headW += w
  }

  // Build tail from the end
  const chars = [...str]
  let tail = ''
  let tailW = 0
  for (let i = chars.length - 1; i >= 0; i--) {
    const w = getVisualWidth(chars[i])
    if (tailW + w > tailBudget) break
    tail = chars[i] + tail
    tailW += w
  }

  return head + '…' + tail
}

/**
 * Truncate a string at the end when its visual width exceeds maxWidth.
 * Keeps the head within maxWidth minus the marker's width, then appends the marker.
 * CJK characters count as width 2.
 */
export function truncateEnd(str: string, maxWidth: number, marker = '…'): string {
  if (getVisualWidth(str) <= maxWidth) return str

  const budget = maxWidth - getVisualWidth(marker)
  let head = ''
  let headW = 0
  for (const char of str) {
    const w = getVisualWidth(char)
    if (headW + w > budget) break
    head += char
    headW += w
  }

  return head + marker
}
