import { describe, expect, it } from 'vitest'
import { addDays } from '../date'

describe('addDays', () => {
  it('crosses month and year boundaries', () => {
    expect(addDays(new Date(2026, 9, 31), 1)).toEqual(new Date(2026, 10, 1))
    expect(addDays(new Date(2026, 0, 1), -1)).toEqual(new Date(2025, 11, 31))
  })

  it('lands on local midnight of the next calendar day all year round (DST-safe)', () => {
    let day = new Date(2026, 0, 1)
    for (let index = 0; index < 365; index++) {
      const next = addDays(day, 1)
      const expected = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
      expect(next.getFullYear()).toBe(expected.getFullYear())
      expect(next.getMonth()).toBe(expected.getMonth())
      expect(next.getDate()).toBe(expected.getDate())
      expect(next.getHours()).toBe(0)
      day = next
    }
  })
})
