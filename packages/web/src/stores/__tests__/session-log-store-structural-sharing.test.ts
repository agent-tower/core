/**
 * P0-2 regression tests at the store boundary (contract §5.3).
 *
 * The store is where the structural-sharing document meets the degradation
 * contract: a rejected batch must leave the cached conversation untouched (same
 * object identity) so `useNormalizedLogs` can reload the authoritative
 * snapshot without a half-applied state in between.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { Operation } from 'fast-json-patch'
import {
  normalizedEntriesToLogEntries,
  type NormalizedEntry,
} from '@agent-tower/shared/log-adapter'
import { useSessionLogStore } from '../session-log-store'

function entry(id: string, content = id, metadata?: NormalizedEntry['metadata']): NormalizedEntry {
  return {
    id,
    timestamp: 1_700_000_000_000,
    entryType: metadata ? 'tool_use' : 'assistant_message',
    content,
    ...(metadata ? { metadata } : {}),
  }
}

let warnSpy: MockInstance
let errorSpy: MockInstance

beforeEach(() => {
  useSessionLogStore.getState().clear()
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
  errorSpy.mockRestore()
})

describe('sessionLogStore structural sharing (P0-2)', () => {
  it('keeps untouched entry references across live patches', () => {
    const first = entry('a')
    const second = entry('b')
    const store = useSessionLogStore.getState()
    store.setConversation('s1', { entries: [first, second], seq: 1 })
    const before = useSessionLogStore.getState().getConversation('s1')

    expect(useSessionLogStore.getState().applyPatch(
      's1',
      [{ op: 'replace', path: '/entries/1/content', value: 'streamed' }],
      2,
    )).toBe(true)

    const after = useSessionLogStore.getState().getConversation('s1')
    expect(after).not.toBe(before)
    expect(after?.entries).not.toBe(before?.entries)
    expect(after?.entries[0]).toBe(before?.entries[0])
    expect(after?.entries[1]).not.toBe(before?.entries[1])
    expect(after?.entries[1].content).toBe('streamed')
    expect(after?.seq).toBe(2)
  })

  it('does not clone unrelated entries of a long conversation', () => {
    const entries = Array.from({ length: 200 }, (_, index) => entry(`e${index}`, `content ${index}`))
    const store = useSessionLogStore.getState()
    store.setConversation('s1', { entries, seq: 1 })

    expect(useSessionLogStore.getState().applyPatch(
      's1',
      [{ op: 'replace', path: '/entries/150/content', value: 'patched' }],
      2,
    )).toBe(true)

    const after = useSessionLogStore.getState().getConversation('s1')
    entries.forEach((item, index) => {
      if (index !== 150) expect(after?.entries[index]).toBe(item)
    })
    expect(after?.entries[150]).not.toBe(entries[150])
    expect(after?.entries[150].content).toBe('patched')
  })

  it('copies the metadata parent chain when only the tool status changes', () => {
    const first = entry('a', 'out', { action: 'command_run', status: 'in_progress' })
    const store = useSessionLogStore.getState()
    store.setConversation('s1', { entries: [first], seq: 1 })

    expect(useSessionLogStore.getState().applyPatch(
      's1',
      [{ op: 'replace', path: '/entries/0/metadata/status', value: 'success' }],
      2,
    )).toBe(true)

    const after = useSessionLogStore.getState().getConversation('s1')
    expect(after?.entries[0].metadata).not.toBe(first.metadata)
    expect(after?.entries[0].metadata?.status).toBe('success')
    expect(first.metadata?.status).toBe('in_progress')
  })

  it('adopts replace /entries without aliasing the payload array', () => {
    const payload = [entry('x'), entry('y')]
    const store = useSessionLogStore.getState()
    store.setConversation('s1', { entries: [entry('a')], seq: 1 })

    expect(useSessionLogStore.getState().applyPatch(
      's1',
      [{ op: 'replace', path: '/entries', value: payload }],
      2,
    )).toBe(true)

    const after = useSessionLogStore.getState().getConversation('s1')
    expect(after?.entries).not.toBe(payload)
    expect(after?.entries[0]).toBe(payload[0])
    expect(after?.entries[1]).toBe(payload[1])
  })

  it('rejects an unsupported op with a warning and leaves the cache untouched', () => {
    const store = useSessionLogStore.getState()
    store.setConversation('s1', { entries: [entry('a'), entry('b')], seq: 1 })
    const before = useSessionLogStore.getState().getConversation('s1')

    const ok = useSessionLogStore.getState().applyPatch(
      's1',
      [{ op: 'remove', path: '/entries/0' }] as Operation[],
      2,
    )

    expect(ok).toBe(false)
    // Same object identity: nothing was half-applied, so the caller can reload
    // the authoritative snapshot from a consistent state.
    expect(useSessionLogStore.getState().getConversation('s1')).toBe(before)
    expect(warnSpy).toHaveBeenCalledWith(
      '[sessionLogStore] unsupported conversation patch op/path',
      { op: 'remove', path: '/entries/0' },
    )
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('keeps today’s error log when a supported op no longer fits the drifted state', () => {
    const store = useSessionLogStore.getState()
    store.setConversation('s1', { entries: [entry('a')], seq: 1 })
    const before = useSessionLogStore.getState().getConversation('s1')

    const ok = useSessionLogStore.getState().applyPatch(
      's1',
      [{ op: 'replace', path: '/entries/5/content', value: 'x' }],
      7,
    )

    expect(ok).toBe(false)
    expect(useSessionLogStore.getState().getConversation('s1')).toBe(before)
    expect(errorSpy).toHaveBeenCalledWith(
      '[sessionLogStore] applyPatch failed:',
      'entry does not exist',
    )
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('keeps LogEntry identity for untouched entries after a live patch (§6②)', () => {
    const first = entry('a', 'first')
    const second = entry('b', 'before')
    const store = useSessionLogStore.getState()
    store.setConversation('s1', { entries: [first, second], seq: 1 })

    const before = normalizedEntriesToLogEntries(
      useSessionLogStore.getState().getConversation('s1')?.entries ?? [],
    )
    expect(useSessionLogStore.getState().applyPatch(
      's1',
      [{ op: 'replace', path: '/entries/1/content', value: 'after' }],
      2,
    )).toBe(true)
    const after = normalizedEntriesToLogEntries(
      useSessionLogStore.getState().getConversation('s1')?.entries ?? [],
    )

    // P0-2 §6: structural sharing (①) + adapter reference cache (②) together
    // are what keeps the LogStream memo boundaries effective.
    expect(after[0]).toBe(before[0])
    expect(after[1]).not.toBe(before[1])
    expect(after[1].content).toBe('after')
    expect(before[1].content).toBe('before')
  })

  it('freezes stored snapshots and adopted values in dev/test', () => {
    const snapshotEntry = entry('a', 'a', { action: 'other', status: 'pending' })
    const store = useSessionLogStore.getState()
    store.setConversation('s1', { entries: [snapshotEntry], seq: 1 })

    const stored = useSessionLogStore.getState().getConversation('s1')
    expect(stored).toBeDefined()
    if (!stored) throw new Error('unreachable')
    // §3.4: the stored document (wrapper included) and every shared node are
    // frozen in dev/test, so a future in-place write fails loudly.
    expect(Object.isFrozen(stored)).toBe(true)
    expect(Object.isFrozen(stored.entries)).toBe(true)
    expect(Object.isFrozen(snapshotEntry)).toBe(true)
    expect(Object.isFrozen(snapshotEntry.metadata)).toBe(true)
    expect(() => {
      snapshotEntry.content = 'mutated'
    }).toThrow(TypeError)
    expect(() => {
      stored.seq = 99
    }).toThrow(TypeError)

    expect(useSessionLogStore.getState().applyPatch(
      's1',
      [{ op: 'replace', path: '/entries/0/content', value: 'patched' }],
      2,
    )).toBe(true)
    const patched = useSessionLogStore.getState().getConversation('s1')
    expect(patched).toBeDefined()
    if (!patched) throw new Error('unreachable')
    expect(Object.isFrozen(patched)).toBe(true)
    expect(Object.isFrozen(patched.entries)).toBe(true)
    expect(Object.isFrozen(patched.entries[0])).toBe(true)
    expect(() => {
      patched.seq = 5
    }).toThrow(TypeError)
    expect(() => {
      patched.entries[0].content = 'mutated'
    }).toThrow(TypeError)
  })

  it('keeps the dev/test freeze invariant after truncation', () => {
    const store = useSessionLogStore.getState()
    store.setConversation('s1', {
      entries: Array.from({ length: 600 }, (_, index) => entry(`e${index}`)),
      seq: 1,
    })

    store.truncateSession('s1')

    const truncated = useSessionLogStore.getState().getConversation('s1')
    expect(truncated?.isTruncated).toBe(true)
    expect(truncated?.entries).toHaveLength(500)
    expect(Object.isFrozen(truncated)).toBe(true)
    expect(Object.isFrozen(truncated?.entries)).toBe(true)
    expect(() => {
      truncated?.entries.push(entry('x'))
    }).toThrow(TypeError)
  })
})
