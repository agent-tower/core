import { describe, expect, it } from 'vitest'
import { bandLayout, columnPath, dodge, linearScale, niceDomain, niceStep, quantize } from '../scale'

describe('niceStep', () => {
  it('rounds the raw step to 1 / 2 / 5 × 10ⁿ', () => {
    expect(niceStep(100, 4)).toBe(20)
    expect(niceStep(36, 4)).toBe(10)
    expect(niceStep(8, 4)).toBe(2)
    expect(niceStep(0.8, 4)).toBeCloseTo(0.2)
  })

  it('falls back to 1 for degenerate input', () => {
    expect(niceStep(0, 4)).toBe(1)
    expect(niceStep(10, 0)).toBe(1)
  })
})

describe('niceDomain', () => {
  it('extends the data range to whole ticks and includes zero by default', () => {
    expect(niceDomain([3, 36])).toEqual({ min: 0, max: 40, ticks: [0, 10, 20, 30, 40] })
  })

  it('handles negative values', () => {
    expect(niceDomain([-12, 30])).toEqual({ min: -20, max: 30, ticks: [-20, -10, 0, 10, 20, 30] })
  })

  it('ignores non-finite values and survives empty or flat data', () => {
    expect(niceDomain([Number.NaN, 8, Number.POSITIVE_INFINITY]).ticks).toEqual([0, 2, 4, 6, 8])
    expect(niceDomain([]).ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1])
    expect(niceDomain([5, 5], { includeZero: false })).toEqual({ min: 5, max: 6, ticks: [5, 5.2, 5.4, 5.6, 5.8, 6] })
  })
})

describe('linearScale', () => {
  it('maps the domain onto the range, including inverted ranges', () => {
    const y = linearScale([0, 10], [100, 0])
    expect(y(0)).toBe(100)
    expect(y(5)).toBe(50)
    expect(y(10)).toBe(0)
  })

  it('returns the range start for an empty domain', () => {
    expect(linearScale([3, 3], [10, 20])(42)).toBe(10)
  })
})

describe('bandLayout', () => {
  it('centres the bands inside the range', () => {
    const band = bandLayout(4, 0, 100, { paddingInner: 0.5, paddingOuter: 0.25 })
    expect(band.step).toBe(25)
    expect(band.bandwidth).toBe(12.5)
    expect(band.center(0)).toBe(12.5)
    expect(band.center(3)).toBe(87.5)
  })
})

describe('columnPath', () => {
  it('draws nothing for empty bars', () => {
    expect(columnPath(0, 0, 10, 0)).toBe('')
    expect(columnPath(0, 0, 0, 10)).toBe('')
  })

  it('never rounds a short bar more than its height', () => {
    expect(columnPath(0, 10, 20, 2, 4)).toContain('A2,2')
  })
})

describe('dodge', () => {
  it('pushes colliding labels apart and keeps the input order', () => {
    expect(dodge([10, 12, 50], 8, [0, 100])).toEqual([10, 18, 50])
    expect(dodge([50, 10], 8, [0, 100])).toEqual([50, 10])
  })

  it('pulls labels back inside the bounds', () => {
    expect(dodge([95, 98], 8, [0, 100])).toEqual([92, 100])
  })
})

describe('quantize', () => {
  it('maps zero to the empty level and any positive value to at least level 1', () => {
    expect(quantize(0, 10, 7)).toBe(0)
    expect(quantize(0.1, 10, 7)).toBe(1)
    expect(quantize(5, 10, 7)).toBe(3)
    expect(quantize(10, 10, 7)).toBe(6)
    expect(quantize(20, 10, 7)).toBe(6)
  })
})
