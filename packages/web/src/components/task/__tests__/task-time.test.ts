import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const now = new Date(2026, 9, 16, 12)
const t = (source: string, values?: Record<string, number>) => source.replace('{count}', String(values?.count))

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(now)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('task timestamps', () => {
  it('keeps recent timestamps relative and clamps future times', async () => {
    const { formatTaskUpdatedAt } = await import('../task-time')
    const formatAge = (seconds: number) => formatTaskUpdatedAt(new Date(now.getTime() - seconds * 1000).toISOString(), t, 'en')
    expect(formatAge(-60)).toBe('now')
    expect(formatAge(59)).toBe('now')
    expect(formatAge(60)).toBe('1m')
    expect(formatAge(3600)).toBe('1h')
    expect(formatAge(86400)).toBe('1d')
    expect(formatAge(6 * 86400)).toBe('6d')
  })

  it('preserves locale-specific dates for older tasks and previous years', async () => {
    const { formatTaskUpdatedAt } = await import('../task-time')
    const sameYear = new Date(2026, 9, 1, 12).toISOString()
    const previousYear = new Date(2025, 8, 1, 12).toISOString()
    expect(formatTaskUpdatedAt(sameYear, t, 'en')).toBe('10/1')
    expect(formatTaskUpdatedAt(sameYear, t, 'zh-CN')).toBe('10/1')
    expect(formatTaskUpdatedAt(previousYear, t, 'en')).toBe('9/2025')
    expect(formatTaskUpdatedAt(previousYear, t, 'zh-CN')).toBe('2025/9')
  })

  it('bounds native date formatter allocation across large lists and refreshes', async () => {
    const formatters = vi.spyOn(Intl, 'DateTimeFormat')
    const localizedDates = vi.spyOn(Date.prototype, 'toLocaleDateString')
    const { formatTaskUpdatedAt } = await import('../task-time')
    const dates = Array.from({ length: 1000 }, (_, index) => new Date(2024, 0, index % 365 + 1).toISOString())

    for (let tick = 0; tick < 3; tick++) {
      vi.setSystemTime(now.getTime() + tick * 30_000)
      for (const locale of ['en', 'zh-CN'] as const) {
        for (const date of dates) expect(formatTaskUpdatedAt(date, t, locale)).not.toBe('')
      }
    }

    // Both APIs allocate ICU formatters when given options; allocation should
    // depend on supported date formats/locales, never task count or timer ticks.
    expect(formatters.mock.calls.length + localizedDates.mock.calls.length).toBeLessThanOrEqual(4)
  })

  it('keeps a malformed timestamp from breaking the task list', async () => {
    const { formatTaskUpdatedAt } = await import('../task-time')
    expect(formatTaskUpdatedAt('invalid timestamp', t, 'en')).toBe('—')
  })
})
