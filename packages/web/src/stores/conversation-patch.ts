/**
 * P0-2 — client-side conversation patch application with structural sharing.
 *
 * Replaces the browser-side `applyPatch(doc, patch, true, false)` call, which
 * deep-clones the whole conversation (`JSON.parse(JSON.stringify(doc))`) before
 * every patch and therefore scales with the *total* number of entries instead
 * of with the patched entry.
 *
 * Behaviour contract: `docs/perf-p0-2-conversation-patch-contract.md`.
 *  - §1/§2  only the six `(op, path)` pairs the server actually emits are
 *           supported, applied in array order with `fast-json-patch@3.1.1`
 *           semantics as the equivalence baseline;
 *  - §3     every object on the patched path is re-created, untouched siblings
 *           keep their reference;
 *  - §4     anything else (unknown op/path, `remove`, `move`/`copy`/`test`,
 *           array `-`, out-of-range, non-canonical, non-representable or
 *           int32-wrapping indices) makes the **whole batch** fail so the caller
 *           falls back to the authoritative snapshot;
 *  - §7     D1–D9 rulings; deviations from `fast-json-patch` are deliberate and
 *           listed in the tests.
 *
 * The module never mutates its input and never throws for malformed input: a
 * malformed patch is a normal failure result. It does not touch Zustand state
 * either — committing the result is the caller's job, which is what keeps the
 * "whole batch or nothing" guarantee.
 */
import type { AddOperation, Operation, ReplaceOperation } from 'fast-json-patch'
import type { NormalizedEntry, ToolStatus } from '@agent-tower/shared/log-adapter'

/**
 * `add`/`replace` are the only ops whose value this module reads. The value is
 * typed `unknown` on purpose: like the baseline, the module adopts whatever the
 * patch carries instead of validating a shape the contract does not define.
 */
type ValueOperation = AddOperation<unknown> | ReplaceOperation<unknown>

export interface NormalizedConversation {
  sessionId?: string
  entries: NormalizedEntry[]
  /** Last applied patch seq. Used to dedupe out-of-window patches. */
  seq?: number
  /** True when this cache only contains a suffix of the server snapshot. */
  isTruncated?: boolean
}

/**
 * `unsupported` covers everything contract §4 routes to the documented
 * degradation path (unknown op/path, deliberately unimplemented ops, indices
 * out of range). `failed` covers a supported op that cannot be applied to the
 * current document (missing parent path) — the same situations in which
 * `fast-json-patch` throws and today's code logs and reloads.
 */
export type ConversationPatchFailureKind = 'unsupported' | 'failed'

export type ConversationPatchResult =
  | { ok: true; conversation: NormalizedConversation }
  | { ok: false; kind: ConversationPatchFailureKind; reason: string }

/**
 * Canonical JSON-Pointer array index — the only index form P0-2 accepts, for
 * both `add` and `replace` (contract §2.1 / §5.1).
 *
 * `replace` addresses an *existing* property: the baseline walks the raw
 * pointer, so `/entries/00` looks up the property `"00"` (absent) and throws
 * `OPERATION_PATH_UNRESOLVABLE`. Accepting `00` would let an illegal path
 * overwrite real entries.
 *
 * `add` is validated with `isInteger` and then coerced with `~~key` (ToInt32),
 * so the baseline *does* accept `/entries/00` (→ 0) and silently wraps
 * everything outside int32 (`2147483648`→-2147483648, `4294967296`→0,
 * `9007199254740991`→-1). Both classes are **explicit divergences** (§5.1):
 * P0-2 rejects them and degrades the whole batch to the authoritative snapshot
 * rather than writing an entry at a silently wrong position.
 */
const CANONICAL_ARRAY_INDEX = /^(0|[1-9]\d*)$/

/**
 * Largest index whose `~~` (ToInt32) coercion is the identity. One past it
 * (`2147483648`) wraps to `-2147483648`, which `splice` clamps to the head — a
 * silent position change rather than an "index too large" failure.
 */
const MAX_INT32_INDEX = 0x7fffffff

/**
 * Dev/test-only freezing (contract §3.4 / §7-D5).
 *
 * Vite statically replaces `import.meta.env.DEV` and `import.meta.env.MODE`, so
 * a production build folds this to `false` and drops every freeze branch below:
 * `Object.freeze` moves V8 onto a slow property path, and the shipped bundle
 * must not pay for a dev-only safety net.
 */
export const DEV_FREEZE_ENABLED: boolean =
  import.meta.env.DEV || import.meta.env.MODE === 'test'

function freezeNode<T>(value: T): T {
  return DEV_FREEZE_ENABLED ? Object.freeze(value) : value
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Object.keys(value)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
  return value
}

/**
 * Freeze a node the document adopts (`add`/`replace /entries/{i}` values, the
 * new `metadata`/entry wrapper of a scalar replace) in dev/test.
 *
 * Contract §3.3: patch values are owned by the document once applied, and
 * §7-D5 asks for a recursive freeze so a future in-place write turns into an
 * explicit error instead of silently corrupting objects that are already
 * rendered and memoized. This is per adopted node, so its cost is O(node) —
 * never O(document).
 */
export function freezeAdoptedInDev<T>(value: T): T {
  return DEV_FREEZE_ENABLED ? deepFreeze(value) : value
}

/**
 * Freeze a whole document that is entering the store (snapshot load).
 *
 * A snapshot holds the entry objects that later patches share between document
 * versions, so freezing it once at ingest completes the dev/test invariant
 * "every object reachable from the stored document is frozen" without walking
 * O(document) on every patch — the exact cost P0-2 removes. Snapshot ingest is
 * inherently O(document) and happens once per `session/load`; it is not part of
 * the per-patch cost. See contract §3.4 for the full freeze policy.
 */
export function freezeConversationInDev(
  conversation: NormalizedConversation,
): NormalizedConversation {
  return DEV_FREEZE_ENABLED ? deepFreeze(conversation) : conversation
}

/**
 * Freeze one stored document version in dev/test: the wrapper object plus its
 * `entries` array — shallow shells only.
 *
 * Both are new on every patch/truncate, and the nodes they point at are frozen
 * when they are created/adopted or when the snapshot enters the store. Shallow
 * freezes are therefore enough to keep `Object.isFrozen(getConversation())`
 * true without an O(document) walk per patch, including for `replace /entries`
 * (whose elements are adopted by reference, §3.4).
 */
export function freezeConversationWrapperInDev(
  conversation: NormalizedConversation,
): NormalizedConversation {
  if (!DEV_FREEZE_ENABLED) return conversation
  return freezeNode({
    ...conversation,
    entries: freezeNode(conversation.entries),
  })
}

/**
 * Apply a JSON Patch batch to a conversation, returning a new document that
 * shares every untouched subtree with the input (contract §3.1).
 */
export function applyConversationPatch(
  conversation: NormalizedConversation,
  patch: readonly Operation[],
): ConversationPatchResult {
  if (!Array.isArray(patch)) {
    return failed('patch sequence must be an array')
  }

  let next = conversation
  for (const operation of patch) {
    const result = applySingleOperation(next, operation)
    if (!result.ok) {
      // Contract §4: any failing op discards the whole batch. Nothing was
      // mutated on the way, so the caller still holds the authoritative state.
      return result
    }
    next = result.conversation
  }
  return { ok: true, conversation: next }
}

function applySingleOperation(
  conversation: NormalizedConversation,
  operation: Operation,
): ConversationPatchResult {
  // `fast-json-patch` validates this first ("Operation is not an object").
  if (!isRecord(operation)) return failed('operation is not an object')

  const segments = parsePointer(operation.path)
  if (!segments) return unsupported(operation)

  if (operation.op === 'add') return applyAdd(conversation, segments, operation)
  if (operation.op === 'replace') return applyReplace(conversation, segments, operation)

  // `remove` (§7-D2), `move`/`copy`/`test` (§7-D3) and any unknown op are
  // **deliberately** not implemented: the server emits none of them today, and
  // guessing RFC semantics here would surface as client/server state drift.
  return unsupported(operation)
}

function applyAdd(
  conversation: NormalizedConversation,
  segments: string[],
  operation: ValueOperation,
): ConversationPatchResult {
  // `fast-json-patch` rejects add/replace without a value (OPERATION_VALUE_REQUIRED).
  if (operation.value === undefined) return failed('operation value is required')
  if (hasUndefined(operation.value)) {
    return failed('operation value cannot contain undefined')
  }

  // §2.5: root member upsert, not an array insert.
  if (segments.length === 1 && segments[0] === 'sessionId') {
    return ok(freezeNode({ ...conversation, sessionId: operation.value as string }))
  }
  if (segments[0] !== 'entries') return unsupported(operation)
  // `add /entries` and `add /entries/{i}/...` are outside §1's six pairs.
  if (segments.length !== 2) return unsupported(operation)

  const index = parseArrayIndex(segments[1])
  if (index === undefined) return unsupported(operation)
  if (!Array.isArray(conversation.entries)) return failed('entries is not an array')
  // §7-D4: `i > entries.length` is not a truncating append.
  if (index > conversation.entries.length) return unsupported(operation)

  const entries = conversation.entries.slice()
  entries.splice(index, 0, freezeAdoptedInDev(operation.value) as NormalizedEntry)
  return ok(withEntries(conversation, entries))
}

function applyReplace(
  conversation: NormalizedConversation,
  segments: string[],
  operation: ValueOperation,
): ConversationPatchResult {
  if (operation.value === undefined) return failed('operation value is required')
  if (hasUndefined(operation.value)) {
    return failed('operation value cannot contain undefined')
  }

  // §2.6: whole-array replacement. §7-D6: the array itself must be a new array
  // (so a later `push` cannot reach into the patch payload); the elements are
  // reused by reference.
  //
  // §3.4 root-replace exception: only the new array shell is frozen (inside
  // `withEntries`). Recursively deep-freezing `value` — or freezing every
  // element — would walk the whole document on the long-history reconcile path,
  // the exact dev/test cost P0-2 removes. Elements are adopted as read-only
  // nodes by ownership; nodes that already went through node adoption or
  // snapshot ingest stay frozen.
  if (segments.length === 1 && segments[0] === 'entries') {
    const value = operation.value
    const entries = Array.isArray(value) ? value.slice() : value
    return ok(withEntries(conversation, entries as NormalizedEntry[]))
  }
  if (segments[0] !== 'entries') return unsupported(operation)

  const index = parseArrayIndex(segments[1])
  if (index === undefined) return unsupported(operation)
  if (!Array.isArray(conversation.entries)) return failed('entries is not an array')

  const isWholeEntry = segments.length === 2
  const isContent = segments.length === 3 && segments[2] === 'content'
  const isStatus = segments.length === 4 && segments[2] === 'metadata' && segments[3] === 'status'
  // Classify the path shape *before* looking at the document: an unknown path
  // must report "unsupported" (structured warning) regardless of whether the
  // addressed entry happens to exist.
  if (!isWholeEntry && !isContent && !isStatus) return unsupported(operation)

  // §7-D1: out-of-range whole-entry replace degrades instead of creating holes.
  if (isWholeEntry) {
    if (index >= conversation.entries.length) return unsupported(operation)
    const entries = conversation.entries.slice()
    entries[index] = freezeAdoptedInDev(operation.value) as NormalizedEntry
    return ok(withEntries(conversation, entries))
  }

  const entry = conversation.entries[index]
  if (!isRecord(entry)) return failed('entry does not exist')

  // §2.3: the baseline requires the replaced member to exist.
  if (isContent) {
    if (entry.content === undefined) return failed('entry content does not exist')
    return ok(replaceEntryAt(conversation, index, freezeNode({
      ...entry,
      content: operation.value as string,
    })))
  }

  // §2.4 / §3.2: `metadata` is nested and read by reference downstream
  // (`use-todos`, `log-adapter`), so it must be copied along the parent chain.
  const metadata = entry.metadata
  if (!isRecord(metadata) || metadata.status === undefined) {
    return failed('entry metadata status does not exist')
  }
  const nextMetadata = freezeNode({ ...metadata, status: operation.value as ToolStatus })
  return ok(replaceEntryAt(conversation, index, freezeNode({
    ...entry,
    metadata: nextMetadata,
  })))
}

function replaceEntryAt(
  conversation: NormalizedConversation,
  index: number,
  entry: NormalizedEntry,
): NormalizedConversation {
  const entries = conversation.entries.slice()
  entries[index] = entry
  return withEntries(conversation, entries)
}

/**
 * New document + new `entries` array; both frozen in dev/test (§3.1/§3.4).
 *
 * Shell-only by design: the array is never walked, so the freeze work is O(1)
 * regardless of the document size. That also covers `replace /entries`, whose
 * elements are adopted by reference and deliberately not deep-frozen (§3.4).
 */
function withEntries(
  conversation: NormalizedConversation,
  entries: NormalizedEntry[],
): NormalizedConversation {
  return freezeNode({ ...conversation, entries: freezeNode(entries) })
}

function parsePointer(path: unknown): string[] | undefined {
  if (typeof path !== 'string' || !path.startsWith('/')) return undefined
  return path.slice(1).split('/')
}

/**
 * Parse an `/entries/{i}` index segment (`add` and `replace` share the rule).
 *
 * Canonical decimal (no leading zeros, no sign, no `-`, no fraction), exactly
 * representable as a `number` (`Number.isSafeInteger`) **and** inside int32:
 * above 2^53 the literal no longer identifies a unique index, and above
 * `0x7fffffff` the baseline's `~~key` coercion silently wraps it into some
 * other (often in-range) position. All of them are explicit divergences listed
 * in contract §5.1 / D9, and all of them are rejected here **unconditionally**:
 * the caller's bounds check (`add`: `i > entries.length`; `replace`:
 * `i >= entries.length`) cannot see the wrapping class — a document long enough
 * to reach the index satisfies that bound while the baseline still writes at
 * the wrapped position.
 */
function parseArrayIndex(segment: string): number | undefined {
  if (!CANONICAL_ARRAY_INDEX.test(segment)) return undefined
  const index = Number(segment)
  if (!Number.isSafeInteger(index)) return undefined
  // CANONICAL_ARRAY_INDEX excludes `-`, so `index >= 0` holds here and only the
  // upper int32 bound can wrap.
  return index <= MAX_INT32_INDEX ? index : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Mirror of `fast-json-patch`'s `hasUndefined` validator rule
 * (OPERATION_VALUE_CANNOT_CONTAIN_UNDEFINED): patch values come from JSON, so a
 * value carrying `undefined` means the producer is broken and the baseline
 * refuses it. Keeping the same refusal avoids silently accepting a patch the
 * two implementations would disagree about.
 */
function hasUndefined(value: unknown): boolean {
  if (value === undefined) return true
  if (Array.isArray(value)) return value.some(hasUndefined)
  if (isRecord(value)) {
    return Object.keys(value).some((key) => hasUndefined(value[key]))
  }
  return false
}

function ok(conversation: NormalizedConversation): ConversationPatchResult {
  return { ok: true, conversation }
}

function failed(reason: string): ConversationPatchResult {
  return { ok: false, kind: 'failed', reason }
}

function unsupported(operation: { op?: unknown; path?: unknown }): ConversationPatchResult {
  // Contract §4: structured, greppable warning; production must not throw here
  // because that would tear down the socket handler.
  console.warn('[sessionLogStore] unsupported conversation patch op/path', {
    op: operation.op,
    path: operation.path,
  })
  return {
    ok: false,
    kind: 'unsupported',
    reason: `unsupported op/path: ${String(operation.op)} ${String(operation.path)}`,
  }
}
