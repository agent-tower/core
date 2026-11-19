import { describe, expect, it } from 'vitest'
import {
  AUTO_COLLAPSE_LINES, CARD_HEADER_HEIGHT, SECTION_HEIGHT, buildReviewRows, currentReviewCard,
  estimateReviewRow, filterReviewRows, type CardRow,
} from '../review-rows'

const a = { path: 'src/a.ts', status: 'M', additions: 8, deletions: 2 }
const b = { path: 'b.ts', status: 'A' }
const rows = buildReviewRows({ uncommitted: [a, b], committed: [a] })
const card = rows[1] as CardRow

describe('review rows', () => {
  it('flattens each view and keeps distinct, stable file keys across reordering and version changes', () => {
    expect(rows.map(row => row.key)).toEqual([
      'section:uncommitted', 'uncommitted:src/a.ts', 'uncommitted:b.ts', 'section:committed', 'committed:src/a.ts',
    ])
    expect(buildReviewRows({ uncommitted: [b, { ...a, token: 'new' }], committed: [] }).map(row => row.key))
      .toEqual(['section:uncommitted', 'uncommitted:b.ts', 'uncommitted:src/a.ts'])
    expect(buildReviewRows(undefined, 'sha', [b, a]).map(row => row.key)).toEqual(['sha:b.ts', 'sha:src/a.ts'])
    expect(filterReviewRows(rows, ' B.TS ')).toEqual([{ ...rows[0], count: 1 }, rows[2]])
    expect(buildReviewRows({ uncommitted: [], committed: [] })).toEqual([])
  })

  it('estimates headers, counted changes, unknown files, notices and cached text', () => {
    expect(estimateReviewRow(rows[0])).toBe(SECTION_HEIGHT)
    expect(estimateReviewRow(card, { collapsed: true })).toBe(CARD_HEADER_HEIGHT)
    expect(estimateReviewRow(card)).toBe(CARD_HEADER_HEIGHT + 1 + (8 + 2 + 12) * 20)
    expect(estimateReviewRow({ ...card, entry: { ...a, additions: 15_000 } })).toBe(CARD_HEADER_HEIGHT + 1 + AUTO_COLLAPSE_LINES * 20)
    expect(estimateReviewRow(rows[2])).toBe(CARD_HEADER_HEIGHT + 1 + 80)
    expect(estimateReviewRow(card, {}, { kind: 'binary', token: '1', oldSize: 20, newSize: 40 })).toBe(CARD_HEADER_HEIGHT + 1 + 80)
    expect(estimateReviewRow(card, {}, { diff: '+a\n-b\n' })).toBe(CARD_HEADER_HEIGHT + 1 + 3 * 20)
    const answer = { diff: Array(502).fill('+a').join('\n') }
    expect(estimateReviewRow(card, {}, answer)).toBe(CARD_HEADER_HEIGHT + 1 + AUTO_COLLAPSE_LINES * 20 + 32)
    expect(estimateReviewRow(card, { expanded: true }, answer)).toBe(CARD_HEADER_HEIGHT + 1 + 502 * 20)
  })

  it('finds the current file from offsets across gaps and section headers', () => {
    const items = [0, 44, 130, 205, 249].map((start, index) => ({ index, start }))
    expect(currentReviewCard(rows, [], 0)).toBeUndefined()
    expect(currentReviewCard(rows, items, 0)).toBe(rows[1])
    expect(currentReviewCard(rows, items, 121)).toBe(rows[1])
    expect(currentReviewCard(rows, items, 122)).toBe(rows[2])
    expect(currentReviewCard(rows, items.slice(1), 208)).toBe(rows[2])
    expect(currentReviewCard(rows, items.slice(2), 249)).toBe(rows[4])
  })
})
