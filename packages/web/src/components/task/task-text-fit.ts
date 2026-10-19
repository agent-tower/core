let segmenter: Intl.Segmenter | undefined

/** Match CSS ellipsis without splitting an emoji or combining character. */
export function fitTaskText(text: string, width: number, measure: (value: string) => number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (measure(normalized) <= width) return normalized
  if (measure('…') > width) return ''

  const characters = typeof Intl.Segmenter === 'undefined'
    ? Array.from(normalized)
    : Array.from((segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' })).segment(normalized), part => part.segment)
  let low = 0
  let high = characters.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (measure(`${characters.slice(0, middle).join('')}…`) <= width) low = middle
    else high = middle - 1
  }
  return `${characters.slice(0, low).join('')}…`
}
