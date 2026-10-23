import type { NormalizedEntry } from '../../output/index.js';

const STABLE_ACP_ENTRY_PREFIXES = [
  'acp-message-',
  'acp-thought-',
  'acp-tool-',
  'acp-diagnostic-',
];
const STABLE_ACP_ENTRY_IDS = new Set(['acp-plan', 'acp-usage']);

interface AcpHistoryReconcileOptions {
  historyBoundaryEntryId?: string;
}

/**
 * Reconcile history replayed by session/load with the locally persisted log.
 * Stable ACP identities update in place. Text entries also use ordered semantic
 * matching because agents may assign different IDs or chunk boundaries on load.
 */
export function reconcileAcpHistoryEntries(
  localEntries: NormalizedEntry[],
  replayedEntries: NormalizedEntry[],
  options: AcpHistoryReconcileOptions = {},
): NormalizedEntry[] | undefined {
  const boundaryIndex = options.historyBoundaryEntryId
    ? localEntries.findIndex((entry) => entry.id === options.historyBoundaryEntryId)
    : -1;
  const localHistory = boundaryIndex >= 0 ? localEntries.slice(0, boundaryIndex) : localEntries;
  const protectedSuffix = boundaryIndex >= 0 ? localEntries.slice(boundaryIndex) : [];
  const merged: NormalizedEntry[] = [];
  const stableIndexes = new Map<string, number>();
  let changed = false;

  for (const entry of localHistory) {
    if (hasStableAcpIdentity(entry.id)) {
      if (stableIndexes.has(entry.id)) {
        changed = true;
        continue;
      }
      stableIndexes.set(entry.id, merged.length);
    }
    merged.push(entry);
  }

  const anonymousIndexes = new Map<string, number[]>();
  for (let index = 0; index < merged.length; index += 1) {
    const entry = merged[index];
    if (hasStableAcpIdentity(entry.id)
      || entry.entryType === 'user_message'
      || entry.entryType === 'assistant_message'
      || entry.entryType === 'thinking') continue;
    const fingerprint = entryFingerprint(entry);
    const indexes = anonymousIndexes.get(fingerprint) ?? [];
    indexes.push(index);
    anonymousIndexes.set(fingerprint, indexes);
  }
  const anonymousMatches = new Map<string, number>();
  const assistantIndexes = merged.flatMap((entry, index) => (
    entry.entryType === 'assistant_message' ? [index] : []
  ));
  const assistantCursors = new Map<string, number>();
  const localStableIds = new Set(merged
    .filter((entry) => hasStableAcpIdentity(entry.id))
    .map((entry) => entry.id));
  const protocolIndexes = new Map<string, number[]>();
  for (let index = 0; index < merged.length; index++) {
    const identity = protocolIdentityKey(merged[index]);
    if (!identity) continue;
    const indexes = protocolIndexes.get(identity) ?? [];
    indexes.push(index);
    protocolIndexes.set(identity, indexes);
  }
  const protocolOccurrences = new Map<string, number>();
  const exactMatches = new Map<number, number>();
  // Reserve the whole replay's exact identities before any content fallback.
  // Otherwise a newly recovered earlier message can consume a later exact block.
  const claimedLocalIndexes = new Set<number>();
  for (let replayedIndex = 0; replayedIndex < replayedEntries.length; replayedIndex += 1) {
    const replayed = replayedEntries[replayedIndex];
    if (replayed.entryType === 'user_message') continue;
    let index: number | undefined;
    const identity = protocolIdentityKey(replayed);
    if (identity) {
      const occurrence = protocolOccurrences.get(identity) ?? 0;
      protocolOccurrences.set(identity, occurrence + 1);
      const native = replayed.metadata!.acpTextIdentity!;
      const legacyId = native.streamId === 'main'
        ? `acp-${replayed.entryType === 'assistant_message' ? 'message' : 'thought'}-${Buffer.from(native.messageId).toString('base64url').slice(0, 96)}`
        : undefined;
      const legacyIndex = legacyId === undefined ? undefined : stableIndexes.get(legacyId);
      index = protocolIndexes.get(identity)?.[occurrence]
        ?? (legacyIndex !== undefined && !merged[legacyIndex].metadata?.acpTextIdentity ? legacyIndex : undefined);
    }
    index ??= hasStableAcpIdentity(replayed.id) ? stableIndexes.get(replayed.id) : undefined;
    if (index !== undefined && !claimedLocalIndexes.has(index)) {
      exactMatches.set(replayedIndex, index);
      claimedLocalIndexes.add(index);
    }
  }
  const matchedThinkingReplayIndexes = matchReplayedThinkingEntries(
    merged,
    replayedEntries,
    localStableIds,
    claimedLocalIndexes,
    exactMatches,
  );

  for (let replayedIndex = 0; replayedIndex < replayedEntries.length; replayedIndex += 1) {
    const replayed = replayedEntries[replayedIndex];
    if (replayed.entryType === 'user_message') continue;
    const existingIndex = exactMatches.get(replayedIndex)
      ?? (hasStableAcpIdentity(replayed.id) ? stableIndexes.get(replayed.id) : undefined);
    if (existingIndex !== undefined) {
      claimedLocalIndexes.add(existingIndex);
      // Exact anchors may appear out of local order after missing history was
      // appended. Only semantic matches advance the fallback cursor.
      const existing = merged[existingIndex];
      const replacement = preserveOriginalBlock(existing, replayed);
      if (!entriesEqual(existing, replacement)) {
        merged[existingIndex] = replacement;
        changed = true;
      }
      continue;
    }

    if (replayed.entryType === 'assistant_message') {
      const scope = protocolScopeKey(replayed);
      const match = findAssistantMatch(
        merged,
        replayed,
        assistantIndexes,
        assistantCursors.get(scope) ?? 0,
        claimedLocalIndexes,
      );
      if (match) {
        claimedLocalIndexes.add(match.index);
        assistantCursors.set(scope, match.position + 1);
        if (match.replayIsMoreComplete) {
          const existing = merged[match.index];
          const replacement = preserveOriginalBlock(existing, replayed);
          if (!entriesEqual(existing, replacement)) {
            merged[match.index] = replacement;
            changed = true;
          }
        }
        continue;
      }
    }

    if (replayed.entryType === 'thinking' && matchedThinkingReplayIndexes.has(replayedIndex)) continue;

    if (hasStableAcpIdentity(replayed.id)) {
      stableIndexes.set(replayed.id, merged.length);
      merged.push(replayed);
      changed = true;
      continue;
    }

    const fingerprint = entryFingerprint(replayed);
    const matchOffset = anonymousMatches.get(fingerprint) ?? 0;
    const matchingIndexes = anonymousIndexes.get(fingerprint) ?? [];
    if (matchOffset < matchingIndexes.length) {
      anonymousMatches.set(fingerprint, matchOffset + 1);
      continue;
    }

    merged.push(replayed);
    changed = true;
  }

  return changed ? [...merged, ...protectedSuffix] : undefined;
}

interface AssistantMatch {
  index: number;
  position: number;
  replayIsMoreComplete: boolean;
}

function findAssistantMatch(
  localEntries: NormalizedEntry[],
  replayed: NormalizedEntry,
  assistantIndexes: number[],
  startPosition: number,
  claimedIndexes: Set<number>,
): AssistantMatch | undefined {
  const replayedContent = normalizeMessageContent(replayed.content);
  if (!replayedContent) return undefined;

  for (let position = startPosition; position < assistantIndexes.length; position += 1) {
    const index = assistantIndexes[position];
    if (claimedIndexes.has(index) || !compatibleProtocolIdentity(localEntries[index], replayed)) continue;
    const localContent = normalizeMessageContent(localEntries[index].content);
    if (localContent === replayedContent) {
      return { index, position, replayIsMoreComplete: false };
    }
  }

  for (let position = startPosition; position < assistantIndexes.length; position += 1) {
    const index = assistantIndexes[position];
    if (claimedIndexes.has(index) || !compatibleProtocolIdentity(localEntries[index], replayed)) continue;
    const localContent = normalizeMessageContent(localEntries[index].content);
    if (!localContent) continue;
    if (replayedContent.startsWith(localContent)) {
      return { index, position, replayIsMoreComplete: true };
    }
    if (localContent.startsWith(replayedContent)) {
      return { index, position, replayIsMoreComplete: false };
    }
  }
  return undefined;
}

function matchReplayedThinkingEntries(
  localEntries: NormalizedEntry[],
  replayedEntries: NormalizedEntry[],
  localStableIds: Set<string>,
  reservedIndexes: Set<number>,
  exactMatches: ReadonlyMap<number, number>,
): Set<number> {
  const matches = new Set<number>();
  const streams = new Map<string, string>();
  const cursors = new Map<string, number>();

  for (let index = 0; index < replayedEntries.length; index += 1) {
    const replayed = replayedEntries[index];
    // Protocol matches also have random canonical IDs. They must not consume
    // the unreserved content pool or advance its cursor before ID-drift replay.
    if (replayed.entryType !== 'thinking' || exactMatches.has(index) || localStableIds.has(replayed.id)) continue;
    const content = normalizeThinkingContent(replayed.content);
    if (!content) continue;
    // Keep ID-drift/chunk-boundary recovery within the same native child stream.
    const scope = protocolScopeKey(replayed);
    if (!streams.has(scope)) streams.set(scope, localEntries
      .filter((entry, index) => entry.entryType === 'thinking' && !reservedIndexes.has(index) && compatibleProtocolIdentity(entry, replayed))
      .map(entry => normalizeThinkingContent(entry.content)).join(''));
    const matchIndex = streams.get(scope)!.indexOf(content, cursors.get(scope) ?? 0);
    if (matchIndex < 0) continue;
    matches.add(index);
    cursors.set(scope, matchIndex + content.length);
  }
  return matches;
}

function normalizeMessageContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function compatibleProtocolIdentity(local: NormalizedEntry, replayed: NormalizedEntry): boolean {
  const localIdentity = local.metadata?.acpTextIdentity;
  const replayIdentity = replayed.metadata?.acpTextIdentity;
  return !localIdentity || !replayIdentity || local.entryType === replayed.entryType
    && localIdentity.sessionId === replayIdentity.sessionId && localIdentity.streamId === replayIdentity.streamId;
}

function protocolIdentityKey(entry: NormalizedEntry): string | undefined {
  const identity = entry.metadata?.acpTextIdentity;
  return identity && JSON.stringify([identity.sessionId, identity.streamId, entry.entryType, identity.messageId]);
}

function protocolScopeKey(entry: NormalizedEntry): string {
  const identity = entry.metadata?.acpTextIdentity;
  return identity ? JSON.stringify([identity.sessionId, identity.streamId]) : 'legacy';
}

function normalizeThinkingContent(content: string): string {
  return content.replace(/\s+/g, '');
}

function hasStableAcpIdentity(id: string): boolean {
  return STABLE_ACP_ENTRY_IDS.has(id)
    || STABLE_ACP_ENTRY_PREFIXES.some((prefix) => id.startsWith(prefix));
}

function entryFingerprint(entry: NormalizedEntry): string {
  return JSON.stringify([entry.entryType, entry.content, entry.metadata ?? null]);
}

function entriesEqual(left: NormalizedEntry, right: NormalizedEntry): boolean {
  return left.id === right.id
    && left.entryType === right.entryType
    && left.content === right.content
    && JSON.stringify(left.metadata ?? null) === JSON.stringify(right.metadata ?? null);
}

function preserveOriginalBlock(existing: NormalizedEntry, replayed: NormalizedEntry): NormalizedEntry {
  const block = existing.metadata?.textBlock;
  const { sealedReason: _reason, translationEpoch: _epoch, paragraphs: _paragraphs, ...revised } = block ?? {};
  const identity = replayed.metadata?.acpTextIdentity ?? existing.metadata?.acpTextIdentity;
  const metadata = { ...replayed.metadata, ...(identity ? { acpTextIdentity: identity } : {}) };
  return { ...replayed, id: existing.id, timestamp: existing.timestamp,
    ...(identity ? { metadata } : {}),
    ...(block ? { metadata: { ...metadata, textBlock: existing.content === replayed.content ? block : { ...revised, sourceRevision: block.sourceRevision + 1, state: 'OPEN' } as typeof block } } : {}),
  };
}
