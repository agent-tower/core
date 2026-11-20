import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { MsgStore } from '../msg-store.js'
import type { NormalizedConversation, NormalizedEntry } from '../types.js'

/**
 * The incremental snapshot cache must give the same document as a full replay.
 *
 * Streaming parsers resend the full value of a path with `replace`; MsgStore
 * drops the superseded replace from its history (`dropStaleReplaces`). That
 * used to throw the cache away, so every read during streaming rebuilt the
 * whole document. The cache now survives; these tests pin that a store read
 * between pushes ends in exactly the state of a store read only at the end.
 */

type Step =
  | { kind: 'add' }
  | { kind: 'content'; target: number; text: string }
  | { kind: 'status'; target: number; status: 'in_progress' | 'success' | 'failed' }
  | { kind: 'entry'; target: number; text: string }
  | { kind: 'entries'; size: number }
  | { kind: 'stdout' }
  | { kind: 'read' }

function toolEntry(index: number): NormalizedEntry {
  return { id: `e${index}`, timestamp: index, entryType: 'tool_use', content: `start ${index}`, metadata: { status: 'in_progress' } }
}

function play(steps: Step[], readBetween: boolean, base?: NormalizedConversation): NormalizedConversation {
  const store = new MsgStore()
  if (base) store.restoreFromSnapshot(structuredClone(base))
  let count = base?.entries.length ?? 0
  for (const step of steps) {
    if (step.kind === 'add') {
      store.pushPatch([{ op: 'add', path: `/entries/${count}`, value: toolEntry(count) }])
      count += 1
    } else if (step.kind === 'content' && count > 0) {
      store.pushPatch([{ op: 'replace', path: `/entries/${step.target % count}/content`, value: step.text }])
    } else if (step.kind === 'status' && count > 0) {
      store.pushPatch([{ op: 'replace', path: `/entries/${step.target % count}/metadata/status`, value: step.status }])
    } else if (step.kind === 'entry' && count > 0) {
      const target = step.target % count
      store.pushPatch([{ op: 'replace', path: `/entries/${target}`, value: { ...toolEntry(target), content: step.text } }])
    } else if (step.kind === 'entries') {
      // ACP history reconciliation replaces the whole array (contract op 6).
      count = step.size
      store.pushPatch([{ op: 'replace', path: '/entries', value: Array.from({ length: count }, (_, index) => toolEntry(index)) }])
    } else if (step.kind === 'stdout') {
      store.pushStdout('chunk')
    } else if (step.kind === 'read' && readBetween) {
      store.getSnapshot()
    }
  }
  return store.getSnapshot()
}

const step: fc.Arbitrary<Step> = fc.oneof(
  fc.constant<Step>({ kind: 'add' }),
  fc.record({ kind: fc.constant('content' as const), target: fc.nat(6), text: fc.string({ maxLength: 8 }) }),
  fc.record({ kind: fc.constant('status' as const), target: fc.nat(6), status: fc.constantFrom('in_progress' as const, 'success' as const, 'failed' as const) }),
  fc.record({ kind: fc.constant('entry' as const), target: fc.nat(6), text: fc.string({ maxLength: 8 }) }),
  fc.record({ kind: fc.constant('entries' as const), size: fc.nat(4) }),
  fc.constant<Step>({ kind: 'stdout' }),
  fc.constant<Step>({ kind: 'read' }),
)

describe('MsgStore incremental snapshot cache', () => {
  it('matches a full replay for any interleaving of pushes and reads', () => {
    fc.assert(fc.property(fc.array(step, { maxLength: 60 }), (steps) => {
      expect(play(steps, true)).toEqual(play(steps, false))
    }), { numRuns: 300 })
  })

  it('matches a full replay on top of a restored snapshot', () => {
    const base: NormalizedConversation = { entries: [toolEntry(0), toolEntry(1)], seq: 7 }
    fc.assert(fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
      expect(play(steps, true, base)).toEqual(play(steps, false, base))
    }), { numRuns: 200 })
  })

  it('keeps reads incremental while one entry streams', () => {
    const store = new MsgStore()
    store.pushPatch([{ op: 'add', path: '/entries/0', value: toolEntry(0) }])
    store.pushPatch([{ op: 'add', path: '/entries/1', value: toolEntry(1) }])
    const settled = store.getSnapshot().entries[0]
    for (let index = 0; index < 50; index += 1) {
      store.pushPatch([{ op: 'replace', path: '/entries/1/content', value: `text ${index}` }])
      store.pushStdout(`line ${index}`)
      const snapshot = store.getSnapshot()
      expect(snapshot.entries[1].content).toBe(`text ${index}`)
      // A full replay re-creates every entry; the incremental path keeps them.
      expect(snapshot.entries[0]).toBe(settled)
    }
    // The superseded replaces were dropped from the history all the same.
    const patches = store.getMessages().filter((message) => message.type === 'patch')
    expect(patches).toHaveLength(3)
  })
})
