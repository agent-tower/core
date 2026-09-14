/**
 * P0-2 differential tests against `fast-json-patch@3.1.1` (contract §5.1) plus
 * the §7 boundary cases and the §3 structural-sharing identity assertions.
 *
 * Baseline runs use the same call shape as the code being replaced:
 * `applyPatch(doc, patch, true, false)`.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { applyPatch, type Operation } from 'fast-json-patch'
import type { NormalizedEntry } from '@agent-tower/shared/log-adapter'
import {
  DEV_FREEZE_ENABLED,
  applyConversationPatch,
  freezeConversationInDev,
  type NormalizedConversation,
} from '../conversation-patch'

function entry(
  id: string,
  content = id,
  metadata?: NormalizedEntry['metadata'],
): NormalizedEntry {
  return {
    id,
    timestamp: 1_700_000_000_000,
    entryType: metadata ? 'tool_use' : 'assistant_message',
    content,
    ...(metadata ? { metadata } : {}),
  }
}

function conversation(entries: NormalizedEntry[], seq?: number): NormalizedConversation {
  return { sessionId: 'session-1', entries, seq }
}

type BaselineResult =
  | { ok: true; document: NormalizedConversation }
  | { ok: false }

function runBaseline(
  document: NormalizedConversation,
  patch: Operation[],
): BaselineResult {
  try {
    // The baseline adopts `replace /entries` values by reference and later ops
    // in the same batch mutate that array, so it must never see the caller's
    // patch object (and never let one run leak into the next comparison).
    const result = applyPatch(document, structuredClone(patch), true, false)
    return { ok: true, document: result.newDocument as NormalizedConversation }
  } catch {
    return { ok: false }
  }
}

/**
 * §5.1: success paths must match the baseline exactly; failure is only allowed
 * where the baseline fails too (or in a documented intentional divergence).
 */
function expectSameAsBaseline(
  document: NormalizedConversation,
  patch: Operation[],
): NormalizedConversation {
  const baseline = runBaseline(document, patch)
  const result = applyConversationPatch(document, patch)

  expect(baseline.ok).toBe(true)
  expect(result.ok).toBe(true)
  if (!baseline.ok || !result.ok) throw new Error('unreachable')
  expect(JSON.stringify(result.conversation)).toBe(JSON.stringify(baseline.document))
  return result.conversation
}

/** Supported op with a value the baseline also rejects (out of range / bad index). */
function expectRejectedLikeBaseline(
  document: NormalizedConversation,
  patch: Operation[],
): 'unsupported' | 'failed' {
  const baseline = runBaseline(document, patch)
  const result = applyConversationPatch(document, patch)

  expect(baseline.ok).toBe(false)
  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('unreachable')
  return result.kind
}

/** Intentional divergence (§5.1 list + §4 unknown paths): never compared to the baseline. */
function expectUnsupported(
  document: NormalizedConversation,
  patch: Operation[],
): void {
  const result = applyConversationPatch(document, patch)

  expect(result.ok).toBe(false)
  if (result.ok) throw new Error('unreachable')
  expect(result.kind).toBe('unsupported')
  expect(warnSpy).toHaveBeenCalledWith(
    '[sessionLogStore] unsupported conversation patch op/path',
    expect.objectContaining({ op: patch[0]?.op, path: patch[0]?.path }),
  )
}

let warnSpy: MockInstance

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
})

describe('conversation patch differential vs fast-json-patch', () => {
  it('appends with add /entries/{length} and shares every previous entry', () => {
    const first = entry('a')
    const second = entry('b')
    const appended = entry('c')
    const document = conversation([first, second], 2)

    const next = expectSameAsBaseline(document, [
      { op: 'add', path: '/entries/2', value: appended },
    ])

    expect(next).not.toBe(document)
    expect(next.entries).not.toBe(document.entries)
    expect(next.entries[0]).toBe(first)
    expect(next.entries[1]).toBe(second)
    expect(next.entries[2]).toBe(appended)
    expect(next.sessionId).toBe('session-1')
    expect(next.seq).toBe(2)
  })

  it('inserts in the middle with add /entries/{i} and shifts the tail by reference', () => {
    const a = entry('a')
    const b = entry('b')
    const inserted = entry('new')
    const document = conversation([a, b])

    const next = expectSameAsBaseline(document, [
      { op: 'add', path: '/entries/1', value: inserted },
    ])

    expect(next.entries.map((item) => item.id)).toEqual(['a', 'new', 'b'])
    expect(next.entries[0]).toBe(a)
    expect(next.entries[1]).toBe(inserted)
    expect(next.entries[2]).toBe(b)
  })

  it('treats add /sessionId as a root member upsert', () => {
    const a = entry('a')
    const document = conversation([a])
    delete document.sessionId

    const added = expectSameAsBaseline(document, [
      { op: 'add', path: '/sessionId', value: 'session-2' },
    ])
    expect(added.sessionId).toBe('session-2')
    expect(added.entries).toBe(document.entries)

    const overwritten = expectSameAsBaseline(added, [
      { op: 'add', path: '/sessionId', value: 'session-3' },
    ])
    expect(overwritten.sessionId).toBe('session-3')
    expect(overwritten.entries).toBe(added.entries)
  })

  it('replaces a whole entry and keeps the other entries identical', () => {
    const a = entry('a')
    const b = entry('b')
    const replacement = entry('b', 'rewritten')
    const document = conversation([a, b])

    const next = expectSameAsBaseline(document, [
      { op: 'replace', path: '/entries/1', value: replacement },
    ])

    expect(next.entries[0]).toBe(a)
    expect(next.entries[1]).toBe(replacement)
    expect(document.entries[1]).toBe(b)
  })

  it('replaces entry content by copying only the parent chain', () => {
    const metadata = { action: 'file_edit' as const, status: 'in_progress' as const }
    const a = entry('a', 'before', metadata)
    const b = entry('b')
    const document = conversation([a, b])

    const next = expectSameAsBaseline(document, [
      { op: 'replace', path: '/entries/0/content', value: 'after' },
    ])

    expect(next).not.toBe(document)
    expect(next.entries).not.toBe(document.entries)
    expect(next.entries[0]).not.toBe(a)
    expect(next.entries[0].content).toBe('after')
    expect(next.entries[0].metadata).toBe(a.metadata)
    expect(next.entries[1]).toBe(b)
    expect(a.content).toBe('before')
  })

  it('replaces tool status by copying entry and metadata, leaving old metadata untouched', () => {
    const metadata = {
      action: 'command_run' as const,
      toolName: 'bash',
      status: 'in_progress' as const,
      toolLocations: [{ path: '/repo/a.ts', line: 3 }],
    }
    const a = entry('a', 'output', metadata)
    const document = conversation([a])

    const next = expectSameAsBaseline(document, [
      { op: 'replace', path: '/entries/0/metadata/status', value: 'success' },
    ])

    expect(next.entries[0]).not.toBe(a)
    expect(next.entries[0].metadata).not.toBe(a.metadata)
    expect(next.entries[0].metadata?.status).toBe('success')
    // The old entry keeps the old metadata object (nothing was written in place).
    expect(a.metadata?.status).toBe('in_progress')
    // Untouched metadata fields keep their references.
    expect(next.entries[0].metadata?.toolLocations).toBe(metadata.toolLocations)
    expect(next.entries[0].content).toBe('output')
  })

  it('replaces the root entries array with a fresh array that reuses the patch elements', () => {
    const a = entry('a')
    const b = entry('b')
    const replacement = [b, a]
    const document = conversation([a])

    const next = expectSameAsBaseline(document, [
      { op: 'replace', path: '/entries', value: replacement },
    ])

    expect(next.entries).not.toBe(replacement)
    expect(next.entries[0]).toBe(b)
    expect(next.entries[1]).toBe(a)
    expect(replacement).toHaveLength(2)
  })

  it('applies ops strictly in order (insert before/after a content replace)', () => {
    const a = entry('a')
    const b = entry('b')
    const c = entry('c', 'original')
    const inserted = entry('new')
    const document = conversation([a, b, c])

    const replaceThenInsert = expectSameAsBaseline(document, [
      { op: 'replace', path: '/entries/2/content', value: 'patched' },
      { op: 'add', path: '/entries/0', value: inserted },
    ])
    const insertThenReplace = expectSameAsBaseline(document, [
      { op: 'add', path: '/entries/0', value: inserted },
      { op: 'replace', path: '/entries/2/content', value: 'patched' },
    ])

    expect(replaceThenInsert.entries.map((item) => item.content)).toEqual([
      'new',
      'a',
      'b',
      'patched',
    ])
    expect(insertThenReplace.entries.map((item) => item.content)).toEqual([
      'new',
      'a',
      'patched',
      'original',
    ])
    // Same batch, different order → different entry ends up patched.
    expect(replaceThenInsert.entries[3]).not.toBe(insertThenReplace.entries[2])
    expect(replaceThenInsert.entries[3].id).toBe('c')
    expect(insertThenReplace.entries[2].id).toBe('b')
    expect(replaceThenInsert.entries[3].content).toBe('patched')
    expect(insertThenReplace.entries[3].content).toBe('original')
  })

  it('accumulates index shifts for consecutive adds at the same path', () => {
    const a = entry('a')
    const b = entry('b')
    const first = entry('x')
    const second = entry('y')
    const document = conversation([a, b])

    const next = expectSameAsBaseline(document, [
      { op: 'add', path: '/entries/1', value: first },
      { op: 'add', path: '/entries/1', value: second },
    ])

    expect(next.entries.map((item) => item.id)).toEqual(['a', 'y', 'x', 'b'])
  })

  it('keeps untouched references across a mixed multi-op batch', () => {
    const a = entry('a', 'a', { action: 'other', status: 'pending' })
    const b = entry('b')
    const c = entry('c')
    const document = conversation([a, b, c])

    const next = expectSameAsBaseline(document, [
      { op: 'replace', path: '/entries/0/metadata/status', value: 'success' },
      { op: 'replace', path: '/entries/2/content', value: 'streamed' },
      { op: 'add', path: '/entries/3', value: entry('d') },
    ])

    expect(next.entries[0]).not.toBe(a)
    expect(next.entries[1]).toBe(b)
    expect(next.entries[2]).not.toBe(c)
    expect(next.entries[2].metadata).toBe(c.metadata)
    expect(next.entries[3].content).toBe('d')
  })

  it('accepts an empty batch without touching the document', () => {
    const document = conversation([entry('a')], 4)
    const result = applyConversationPatch(document, [])

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.conversation).toBe(document)
  })

  it('rejects a non-array patch instead of throwing', () => {
    const document = conversation([entry('a')])
    const result = applyConversationPatch(document, null as unknown as Operation[])

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.kind).toBe('failed')
  })
})

describe('conversation patch boundary behaviour (§4 / §7 D1–D9)', () => {
  const document = conversation([entry('a'), entry('b')])

  it('rejects add /entries/{len+k} (D4) like the baseline', () => {
    expect(expectRejectedLikeBaseline(document, [
      { op: 'add', path: '/entries/5', value: entry('x') },
    ])).toBe('unsupported')
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('rejects out-of-range replace /entries/{i} (D1) like the baseline', () => {
    expect(expectRejectedLikeBaseline(document, [
      { op: 'replace', path: '/entries/2', value: entry('x') },
    ])).toBe('unsupported')
    expect(expectRejectedLikeBaseline(document, [
      { op: 'replace', path: '/entries/9', value: entry('x') },
    ])).toBe('unsupported')
    expect(warnSpy).toHaveBeenCalledTimes(2)
  })

  it('rejects non-integer array indices like the baseline', () => {
    expect(expectRejectedLikeBaseline(document, [
      { op: 'add', path: '/entries/-1', value: entry('x') },
    ])).toBe('unsupported')
    expect(expectRejectedLikeBaseline(document, [
      { op: 'replace', path: '/entries/1.5', value: entry('x') },
    ])).toBe('unsupported')
  })

  it('rejects replace paths with non-canonical (leading-zero) indices', () => {
    const withStatus = conversation([
      entry('a', 'a', { action: 'other', status: 'pending' }),
      entry('b'),
    ])
    const patches: Operation[][] = [
      [{ op: 'replace', path: '/entries/00', value: entry('x') }],
      [{ op: 'replace', path: '/entries/01', value: entry('x') }],
      [{ op: 'replace', path: '/entries/00/content', value: 'x' }],
      [{ op: 'replace', path: '/entries/00/metadata/status', value: 'success' }],
    ]

    for (const patch of patches) {
      const label = patch[0].path
      // The baseline walks the raw pointer, so `"00"` is not the `"0"` property.
      expect(runBaseline(withStatus, patch).ok, label).toBe(false)
      const result = applyConversationPatch(withStatus, patch)
      expect(result.ok, label).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.kind, label).toBe('unsupported')
    }
    expect(warnSpy).toHaveBeenCalledTimes(patches.length)
  })

  it('discards a mixed batch that contains a non-canonical replace index', () => {
    const a = entry('a')
    const b = entry('b')
    const document = conversation([a, b])
    const before = JSON.stringify(document)

    const result = applyConversationPatch(document, [
      { op: 'replace', path: '/entries/1/content', value: 'patched' },
      { op: 'replace', path: '/entries/00/content', value: 'illegal' },
    ])

    expect(result.ok).toBe(false)
    expect(JSON.stringify(document)).toBe(before)
    expect(document.entries[1]).toBe(b)
    expect(document.entries[1].content).toBe('b')
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('rejects add with a non-canonical (leading-zero) index as an explicit divergence', () => {
    const a = entry('a')
    const b = entry('b')
    const document = conversation([a, b])

    // The baseline validates `add` with `isInteger` and coerces with `~~key`, so
    // `/entries/00` inserts at 0. P0-2 accepts canonical indices only — for both
    // `add` and `replace` (§5.1) — so the malformed pointer degrades the whole
    // batch to the authoritative snapshot instead of writing to an inferred
    // index.
    const zeroPadded: Operation[] = [{ op: 'add', path: '/entries/00', value: entry('x') }]
    expect(runBaseline(document, zeroPadded).ok).toBe(true)
    expectUnsupported(document, zeroPadded)

    // `007` is merely out of bounds for a 2-entry document; with a longer
    // document the baseline would silently insert at 7.
    const longer = conversation(Array.from({ length: 10 }, (_, index) => entry(`e${index}`)))
    const padded: Operation[] = [{ op: 'add', path: '/entries/007', value: entry('x') }]
    expect(runBaseline(longer, padded).ok).toBe(true)
    expectUnsupported(longer, padded)
  })

  it('rejects add indices outside the exactly-representable range (explicit divergence)', () => {
    const a = entry('a')
    const b = entry('b')
    const document = conversation([a, b])

    // The baseline coerces with `~~key` (ToInt32): 4294967296 and 9007199254740992
    // wrap to 0 (silently inserted at the head), and 9007199254740991 — a safe
    // integer — wraps to -1 (inserted before the last element). All of them
    // "succeed" at the wrong position, so P0-2 rejects the batch and reloads the
    // authoritative snapshot instead (§5.1, intentional divergence).
    for (const segment of ['4294967296', '9007199254740991', '9007199254740992']) {
      const patch: Operation[] = [{ op: 'add', path: `/entries/${segment}`, value: entry('x') }]
      expect(runBaseline(document, patch).ok, segment).toBe(true)
      const result = applyConversationPatch(document, patch)
      expect(result.ok, segment).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.kind, segment).toBe('unsupported')
    }
    expect(warnSpy).toHaveBeenCalledTimes(3)
    // No failed batch touched the document.
    expect(document.entries[0]).toBe(a)
    expect(document.entries[1]).toBe(b)
  })

  it('rejects ToInt32-wrapping indices on a document long enough to reach them', () => {
    // `2147483648`/`2147483649` are canonical *and* safe integers, so the old
    // parser returned them and the caller's `index > entries.length` bound was
    // the only guard left. A document whose `length` reaches the index passes
    // that guard, so the batch used to `splice(literalIndex, 0, value)` at the
    // tail — while the baseline coerces with `~~key` (ToInt32) to a negative
    // start (`~~2147483648 === -2147483648`) and lands at index 0. §2.1/D9
    // rejects everything `~~` would wrap *before* any length comparison.
    //
    // Sparse shells keep this O(1): only `length` is materialized, so neither
    // the rejection path nor the assertions below walk (or copy) the document.
    for (const segment of ['2147483648', '2147483649']) {
      const length = Number(segment)
      const entries = new Array<NormalizedEntry>(length)
      const document = conversation(entries)

      expectUnsupported(document, [
        { op: 'add', path: `/entries/${segment}`, value: entry('x') },
      ])
      expect(document.entries).toBe(entries)
      expect(document.entries).toHaveLength(length)
    }
  })

  it('keeps a canonical, large, in-range index baseline-equal', () => {
    const entries = Array.from({ length: 12_000 }, (_, index) => entry(`e${index}`))
    const document = conversation(entries)

    // `11999` is canonical and exactly representable, so the baseline's `~~` is
    // the identity and both implementations insert at the same position.
    const inserted = entry('x')
    const next = expectSameAsBaseline(document, [
      { op: 'add', path: '/entries/11999', value: inserted },
    ])
    expect(next.entries).toHaveLength(12_001)
    expect(next.entries[11999]).toBe(inserted)
    expect(next.entries[11998]).toBe(entries[11998])
    expect(next.entries[12000]).toBe(entries[11999])

    const target = entry('z')
    const replaced = expectSameAsBaseline(document, [
      { op: 'replace', path: '/entries/11999', value: target },
    ])
    expect(replaced.entries[11999]).toBe(target)
    expect(replaced.entries[0]).toBe(entries[0])
  })

  it('discards a mixed batch that contains a non-representable add index', () => {
    const a = entry('a')
    const b = entry('b')
    const document = conversation([a, b])
    const before = JSON.stringify(document)

    const result = applyConversationPatch(document, [
      { op: 'replace', path: '/entries/1/content', value: 'patched' },
      { op: 'add', path: '/entries/9007199254740992', value: entry('x') },
    ])

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.kind).toBe('unsupported')
    expect(JSON.stringify(document)).toBe(before)
    expect(document.entries[1]).toBe(b)
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('rejects content replace on a missing entry (drift → reload)', () => {
    expect(expectRejectedLikeBaseline(document, [
      { op: 'replace', path: '/entries/7/content', value: 'x' },
    ])).toBe('failed')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('rejects status replace when metadata or status is missing (like the baseline)', () => {
    const withoutMetadata = conversation([entry('a')])
    const baseline = runBaseline(withoutMetadata, [
      { op: 'replace', path: '/entries/0/metadata/status', value: 'success' },
    ])
    expect(baseline.ok).toBe(false)
    const result = applyConversationPatch(withoutMetadata, [
      { op: 'replace', path: '/entries/0/metadata/status', value: 'success' },
    ])
    expect(result.ok).toBe(false)

    const withoutStatus = conversation([entry('a', 'a', { action: 'other' })])
    expect(runBaseline(withoutStatus, [
      { op: 'replace', path: '/entries/0/metadata/status', value: 'success' },
    ]).ok).toBe(false)
    expect(applyConversationPatch(withoutStatus, [
      { op: 'replace', path: '/entries/0/metadata/status', value: 'success' },
    ]).ok).toBe(false)
  })

  it('rejects remove even though the baseline applies it (D2, intentional divergence)', () => {
    const patch: Operation[] = [{ op: 'remove', path: '/entries/0' }]
    expect(runBaseline(document, patch).ok).toBe(true)
    expectUnsupported(document, patch)
  })

  it('rejects add /entries/- even though the baseline applies it (D8)', () => {
    const patch: Operation[] = [{ op: 'add', path: '/entries/-', value: entry('x') }]
    expect(runBaseline(document, patch).ok).toBe(true)
    expectUnsupported(document, patch)
  })

  it('rejects move / copy / test (D3, intentional divergence)', () => {
    const move: Operation[] = [{ op: 'move', from: '/entries/0', path: '/entries/1' }]
    const copy: Operation[] = [{ op: 'copy', from: '/entries/0', path: '/entries/1' }]
    const test: Operation[] = [{ op: 'test', path: '/entries/0/id', value: 'a' }]

    expect(runBaseline(document, move).ok).toBe(true)
    expect(runBaseline(document, copy).ok).toBe(true)
    expect(runBaseline(document, test).ok).toBe(true)
    expectUnsupported(document, move)
    expectUnsupported(document, copy)
    expectUnsupported(document, test)
  })

  it('rejects unknown paths instead of guessing semantics (§4)', () => {
    for (const path of ['/entries/0/metadata/other', '/nope', '/entries/0/unknown', '/']) {
      const patch: Operation[] = [{ op: 'replace', path, value: 'x' }]
      const result = applyConversationPatch(document, patch)
      expect(result.ok, path).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.kind, path).toBe('unsupported')
    }
    expect(warnSpy).toHaveBeenCalledTimes(4)
  })

  it('rejects near-miss op/path pairs outside the six supported combos', () => {
    for (const patch of [
      [{ op: 'add', path: '/entries', value: [] }],
      [{ op: 'add', path: '/entries/0/content', value: 'x' }],
      [{ op: 'replace', path: '/sessionId', value: 'other' }],
      [{ op: 'replace', path: '/entries/0/metadata', value: {} }],
    ] as Operation[][]) {
      const result = applyConversationPatch(document, patch)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.kind).toBe('unsupported')
    }
  })

  it('stays baseline-equal for a wrong-typed replace /entries value', () => {
    // §1 declares the value type as `NormalizedEntry[]`; a non-array value is
    // never produced by the server. The baseline still applies it
    // (`doc.entries = value`), so this implementation does the same instead of
    // inventing a value-shape validation that would diverge from the baseline.
    const patch = [{ op: 'replace', path: '/entries', value: 'not-an-array' }] as unknown as Operation[]
    const next = expectSameAsBaseline(document, patch)

    expect(next.entries).toBe('not-an-array')
  })

  it('rejects add/replace without a value like the baseline validator', () => {
    const patch = [{ op: 'add', path: '/sessionId' }] as unknown as Operation[]
    expect(runBaseline(document, patch).ok).toBe(false)
    expect(applyConversationPatch(document, patch).ok).toBe(false)
  })

  it('rejects patch values containing undefined like the baseline validator', () => {
    const value = {
      id: 'x',
      timestamp: 0,
      entryType: 'assistant_message',
      content: 'c',
      metadata: undefined,
    }
    const patch = [{ op: 'add', path: '/entries/2', value }] as unknown as Operation[]

    expect(runBaseline(document, patch).ok).toBe(false)
    const result = applyConversationPatch(document, patch)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.kind).toBe('failed')
  })

  it('requires the replaced key to be defined (null counts as present, §2.3)', () => {
    // §2.3/§2.4: `replace` targets an existing member. The baseline walks the
    // pointer and treats `obj[key] === undefined` as unresolvable, so an explicit
    // `content: undefined` fails while `content: null` is replaced normally.
    const nullContent = conversation([
      { ...entry('a'), content: null } as unknown as NormalizedEntry,
    ])
    const nullPatch: Operation[] = [
      { op: 'replace', path: '/entries/0/content', value: 'after' },
    ]
    expect(runBaseline(nullContent, nullPatch).ok).toBe(true)
    const replaced = applyConversationPatch(nullContent, nullPatch)
    expect(replaced.ok).toBe(true)
    if (!replaced.ok) throw new Error('unreachable')
    expect(replaced.conversation.entries[0].content).toBe('after')

    const undefinedContent = conversation([
      { ...entry('a'), content: undefined } as unknown as NormalizedEntry,
    ])
    expect(runBaseline(undefinedContent, nullPatch).ok).toBe(false)
    const rejected = applyConversationPatch(undefinedContent, nullPatch)
    expect(rejected.ok).toBe(false)
    if (rejected.ok) throw new Error('unreachable')
    expect(rejected.kind).toBe('failed')
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('adopts wrong-typed scalar values like the baseline (no value-shape validation)', () => {
    // §5.1: the contract fixes the *produced* value types, not a validator. The
    // baseline assigns whatever it is given, so a non-string `content` is adopted
    // as-is instead of inventing a shape check that would diverge.
    const document = conversation([entry('a', 'before')])
    const patch = [
      { op: 'replace', path: '/entries/0/content', value: 42 },
    ] as unknown as Operation[]

    const next = expectSameAsBaseline(document, patch)
    expect(next.entries[0].content as unknown as number).toBe(42)
  })

  it('discards the whole batch when a later op fails', () => {
    const a = entry('a')
    const b = entry('b')
    const document = conversation([a, b])
    const before = JSON.stringify(document)

    const result = applyConversationPatch(document, [
      { op: 'replace', path: '/entries/0/content', value: 'patched' },
      { op: 'remove', path: '/entries/1' },
    ])

    expect(result.ok).toBe(false)
    expect(JSON.stringify(document)).toBe(before)
    expect(document.entries[0]).toBe(a)
    expect(document.entries[1]).toBe(b)
  })

  it('never throws and never mutates the document for malformed operations', () => {
    const document = conversation([entry('a')])
    const before = JSON.stringify(document)
    const malformed = [
      { op: 'weird', path: '/entries/0' },
      { op: 'add', path: '/entries/0', value: { id: 'x' } },
      { op: 'replace' },
      null,
      { op: 'replace', path: '/entries/0/content', value: undefined },
    ] as unknown as Operation[]

    for (const operation of malformed) {
      expect(() => applyConversationPatch(document, [operation])).not.toThrow()
    }
    expect(JSON.stringify(document)).toBe(before)
  })
})

describe('conversation patch dev/test freezing (§3.4 / §7-D5)', () => {
  it('runs with freezing enabled under vitest', () => {
    expect(DEV_FREEZE_ENABLED).toBe(true)
  })

  it('freezes the adopted entry, the parent chain and the entries array', () => {
    const a = entry('a')
    const document = conversation([a])
    const inserted = entry('b', 'b', { action: 'other', status: 'pending' })

    const result = applyConversationPatch(document, [
      { op: 'add', path: '/entries/1', value: inserted },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')

    expect(Object.isFrozen(result.conversation)).toBe(true)
    expect(Object.isFrozen(result.conversation.entries)).toBe(true)
    expect(Object.isFrozen(inserted)).toBe(true)
    expect(Object.isFrozen(inserted.metadata)).toBe(true)
    expect(() => {
      (result.conversation.entries[1] as { content: string }).content = 'mutated'
    }).toThrow(TypeError)
    expect(() => {
      (result.conversation.entries as NormalizedEntry[]).push(entry('c'))
    }).toThrow(TypeError)
  })

  it('freezes snapshots entering the store so shared entries stay read-only', () => {
    const snapshot = conversation([entry('a')])
    const frozen = freezeConversationInDev(snapshot)

    expect(frozen).toBe(snapshot)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.entries[0])).toBe(true)
    expect(() => {
      snapshot.entries[0].content = 'mutated'
    }).toThrow(TypeError)
  })

  it('keeps replace /entries shell-only, independent of the document size (§3.4)', () => {
    // Regression for the review finding: the root-array replace used to call
    // recursive `deepFreeze` on the value, so dev/test walked every entry and
    // subtree — O(document) on the long-history reconcile path. It must now cost
    // exactly two shallow freezes (new document wrapper + new entries array) no
    // matter how large the document is.
    for (const count of [1_000, 10_000]) {
      const entries = Array.from({ length: count }, (_, index) => entry(`e${index}`))
      const document = conversation(entries)
      const freezeSpy = vi.spyOn(Object, 'freeze')

      try {
        const result = applyConversationPatch(document, [
          { op: 'replace', path: '/entries', value: entries },
        ])
        expect(result.ok, `${count} entries`).toBe(true)
        if (!result.ok) throw new Error('unreachable')

        const frozen = freezeSpy.mock.calls.map(([value]) => value as unknown)
        expect(frozen, `${count} entries`).toHaveLength(2)
        // Inner call first: the new entries array, then the document wrapper.
        expect(frozen[0]).toBe(result.conversation.entries)
        expect(frozen[1]).toBe(result.conversation)
        expect(Object.isFrozen(result.conversation)).toBe(true)
        expect(Object.isFrozen(result.conversation.entries)).toBe(true)
        // Elements are adopted by reference and never walked (§3.4 exception).
        expect(result.conversation.entries[0]).toBe(entries[0])
        expect(result.conversation.entries[count - 1]).toBe(entries[count - 1])
      } finally {
        freezeSpy.mockRestore()
      }
    }
  })

  it('disables freezing when the build is neither dev nor test', async () => {
    vi.stubEnv('DEV', false)
    vi.stubEnv('MODE', 'production')
    vi.resetModules()

    try {
      const production = await import('../conversation-patch')
      expect(production.DEV_FREEZE_ENABLED).toBe(false)

      const document = conversation([entry('a')])
      const result = production.applyConversationPatch(document, [
        { op: 'add', path: '/entries/1', value: entry('b') },
      ])
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('unreachable')
      expect(Object.isFrozen(result.conversation)).toBe(false)
      expect(Object.isFrozen(result.conversation.entries)).toBe(false)
      expect(Object.isFrozen(production.freezeConversationInDev(document))).toBe(false)
      expect(Object.isFrozen(production.freezeConversationWrapperInDev(document))).toBe(false)
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })
})
