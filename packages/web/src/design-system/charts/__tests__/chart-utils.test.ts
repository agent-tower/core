import { describe, expect, it } from 'vitest'
import { estimateLabelWidth, estimateTextWidth, nextIndexForKey, visibleLabelIndices } from '../chart-utils'

describe('label width estimates', () => {
  it('counts CJK characters as two digits', () => {
    expect(estimateTextWidth('12')).toBeCloseTo(13.2)
    expect(estimateTextWidth('目标')).toBeCloseTo(26.4)
  })

  it('reserves the widest label plus a 10px gap', () => {
    expect(estimateLabelWidth(['1K', '800'])).toBe(30)
    expect(estimateLabelWidth([])).toBe(10)
  })
})

describe('nextIndexForKey', () => {
  it('starts from the last point and clamps at both ends', () => {
    expect(nextIndexForKey('ArrowRight', null, 5)).toBe(4)
    expect(nextIndexForKey('ArrowRight', 2, 5)).toBe(3)
    expect(nextIndexForKey('ArrowRight', 4, 5)).toBe(4)
    expect(nextIndexForKey('ArrowLeft', 0, 5)).toBe(0)
    expect(nextIndexForKey('Home', 3, 5)).toBe(0)
    expect(nextIndexForKey('End', 0, 5)).toBe(4)
  })

  it('leaves the cross axis to page scrolling', () => {
    expect(nextIndexForKey('ArrowDown', 1, 5)).toBeUndefined()
    expect(nextIndexForKey('ArrowRight', 1, 5, 'y')).toBeUndefined()
    expect(nextIndexForKey('ArrowDown', 1, 5, 'y')).toBe(2)
    expect(nextIndexForKey('ArrowRight', null, 0)).toBeUndefined()
  })
})

describe('visibleLabelIndices', () => {
  it('thins labels to fit and always keeps the last one', () => {
    expect([...visibleLabelIndices(14, 300, 36)].sort((a, b) => a - b)).toEqual([0, 2, 4, 6, 8, 10, 13])
  })

  it('shows the active label and hides neighbours it would collide with', () => {
    expect([...visibleLabelIndices(14, 300, 36, 5)].sort((a, b) => a - b)).toEqual([0, 2, 5, 8, 10, 13])
  })
})
