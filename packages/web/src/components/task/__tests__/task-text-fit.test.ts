import { describe, expect, it } from 'vitest'
import { fitTaskText } from '../task-text-fit'

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const measure = (value: string) => Array.from(segmenter.segment(value)).length

describe('task gradient text fitting', () => {
  it('matches the whitespace collapsing of the original single-line title', () => {
    expect(fitTaskText('  hello\n  world  ', 11, measure)).toBe('hello world')
  })
  it('fits a long title with an ellipsis inside the available width', () => {
    expect(fitTaskText('任务标题很长', 4, measure)).toBe('任务标…')
    expect(fitTaskText('abc', 1, measure)).toBe('…')
    expect(fitTaskText('abc', 0, measure)).toBe('')
  })
  it('keeps joined emoji and combining accents intact at the truncation boundary', () => {
    expect(fitTaskText('👨‍👩‍👧‍👦ab', 2, measure)).toBe('👨‍👩‍👧‍👦…')
    expect(fitTaskText('e\u0301ab', 2, measure)).toBe('e\u0301…')
  })
})
