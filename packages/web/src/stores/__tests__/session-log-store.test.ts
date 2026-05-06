import { describe, expect, it } from 'vitest'
import type { NormalizedEntry } from '@agent-tower/shared/log-adapter'
import {
  normalizeServerConversation,
  shouldReplaceConversationWithSnapshot,
  type NormalizedConversation,
} from '../session-log-store'

function entry(id: string, content = id): NormalizedEntry {
  return {
    id,
    timestamp: 0,
    entryType: 'assistant_message',
    content,
  }
}

function conversation(entries: NormalizedEntry[], seq?: number): NormalizedConversation {
  return { entries, seq }
}

describe('session log snapshot reconciliation', () => {
  it('replaces local cache when server seq is newer', () => {
    const cached = conversation([entry('a')], 1)
    const snapshot = conversation([entry('a'), entry('b')], 2)

    expect(shouldReplaceConversationWithSnapshot(cached, snapshot)).toBe(true)
  })

  it('replaces truncated local cache even when last entry id matches', () => {
    const cached = {
      ...conversation([entry('b')], 2),
      isTruncated: true,
    }
    const snapshot = conversation([entry('a'), entry('b')], 2)

    expect(shouldReplaceConversationWithSnapshot(cached, snapshot)).toBe(true)
  })

  it('does not replace newer local cache with an older server snapshot', () => {
    const cached = conversation([entry('a'), entry('b')], 3)
    const snapshot = conversation([entry('a')], 2)

    expect(shouldReplaceConversationWithSnapshot(cached, snapshot)).toBe(false)
  })

  it('detects a changed last entry when seq and id match', () => {
    const cached = conversation([entry('a', 'partial')], 2)
    const snapshot = conversation([entry('a', 'complete')], 2)

    expect(shouldReplaceConversationWithSnapshot(cached, snapshot)).toBe(true)
  })

  it('normalizes server snapshots as complete cache entries', () => {
    const snapshot = normalizeServerConversation({
      entries: [entry('a')],
      seq: 1,
      isTruncated: true,
    })

    expect(snapshot.isTruncated).toBe(false)
    expect(snapshot.entries).toHaveLength(1)
  })
})
