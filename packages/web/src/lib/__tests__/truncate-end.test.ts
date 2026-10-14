import { describe, expect, it } from 'vitest'
import { truncateEnd } from '@/lib/utils'

describe('truncateEnd', () => {
  it('keeps strings within the visual width untouched', () => {
    expect(truncateEnd('agent-cli', 9, '..')).toBe('agent-cli')
    expect(truncateEnd('官网改版', 8, '..')).toBe('官网改版')
  })

  it('reserves room for the marker when truncating', () => {
    expect(truncateEnd('agent-tower', 9, '..')).toBe('agent-t..')
    expect(truncateEnd('agent-tower', 6)).toBe('agent…')
  })

  it('counts CJK characters as width 2', () => {
    expect(truncateEnd('官网改版项目', 9, '..')).toBe('官网改..')
  })
})
