/**
 * P0-2 契约 §6②：NormalizedEntry → LogEntry 的引用缓存。
 *
 * 结构化共享保住条目引用只是第一个充分条件；本文件锁定第二个条件——
 * 同一个条目对象必须始终产出同一个 LogEntry 对象，否则 `LogStream` 的
 * `memo()` 边界每帧都会失效。
 */
import { describe, expect, it } from 'vitest'
import {
  LogType,
  normalizedEntriesToLogEntries,
  normalizedEntryToLogEntry,
  type NormalizedEntry,
} from '../log-adapter.js'

function entry(id: string, content = id): NormalizedEntry {
  return {
    id,
    timestamp: 1_700_000_000_000,
    entryType: 'assistant_message',
    content,
  }
}

describe('log adapter reference cache (P0-2 §6②)', () => {
  it('returns the same LogEntry object for the same NormalizedEntry reference', () => {
    const source = entry('a')
    const first = normalizedEntryToLogEntry(source)
    const second = normalizedEntryToLogEntry(source)

    expect(first).not.toBeNull()
    expect(second).toBe(first)
  })

  it('does not conflate structurally equal but distinct entries', () => {
    const first = entry('a', 'same')
    const second = entry('a', 'same')

    expect(second).not.toBe(first)
    expect(normalizedEntryToLogEntry(second)).not.toBe(normalizedEntryToLogEntry(first))
    expect(normalizedEntryToLogEntry(second)).toEqual(normalizedEntryToLogEntry(first))
  })

  it('keeps LogEntry identity when structural sharing rebuilds the entries array', () => {
    const untouched = entry('untouched')
    const patched = entry('patched', 'before')
    const beforeEntries = [untouched, patched]
    const afterEntries = [untouched, { ...patched, content: 'after' }]

    const before = normalizedEntriesToLogEntries(beforeEntries)
    const after = normalizedEntriesToLogEntries(afterEntries)

    expect(afterEntries).not.toBe(beforeEntries)
    // The untouched row keeps its LogEntry (this is what makes memo() hold) …
    expect(after[0]).toBe(before[0])
    // … while the patched row gets a new object and the old one is untouched.
    expect(after[1]).not.toBe(before[1])
    expect(after[1].content).toBe('after')
    expect(before[1].content).toBe('before')
  })

  it('caches null conversions instead of recomputing filtered entries', () => {
    const source: NormalizedEntry = {
      id: 'usage',
      timestamp: 0,
      entryType: 'token_usage_info',
      content: '',
    }

    expect(normalizedEntryToLogEntry(source)).toBeNull()
    expect(normalizedEntryToLogEntry(source)).toBeNull()
    expect(normalizedEntriesToLogEntries([source])).toEqual([])
  })

  it('returns a fresh array each call so callers may append the cursor entry', () => {
    const entries = [entry('a'), entry('b')]
    const first = normalizedEntriesToLogEntries(entries)
    const second = normalizedEntriesToLogEntries(entries)

    expect(first).not.toBe(second)
    expect(first).toEqual(second)

    first.push({ id: 'cursor', type: LogType.Cursor, content: '' })
    expect(normalizedEntriesToLogEntries(entries)).toHaveLength(2)
  })

  it('tolerates a non-object entry value instead of throwing', () => {
    const entries = ['not-an-entry', entry('a')] as unknown as NormalizedEntry[]

    expect(() => normalizedEntriesToLogEntries(entries)).not.toThrow()
    expect(normalizedEntriesToLogEntries(entries).map((item) => item.id)).toEqual(['a'])
  })
})
