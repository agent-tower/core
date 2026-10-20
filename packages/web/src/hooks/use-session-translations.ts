import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { SessionTranslationOverlay } from '@agent-tower/shared'
import { type LogEntry, LogType } from '@agent-tower/shared/log-adapter'
import { ClientEvents, ServerEvents, type TranslationInvalidatedPayload } from '@agent-tower/shared/socket'
import type { Socket } from 'socket.io-client'
import { apiClient } from '@/lib/api-client'
import { socketManager } from '@/lib/socket/manager'
import { queryKeys } from './query-keys'

type Page = { items: SessionTranslationOverlay[]; nextCursor: string | null }
type Owner = { refresh: () => void; permission: (denied: boolean) => void }
type Subscription = { owners: Set<Owner>; epoch: number; denied: boolean; dispose: () => void }
const subscriptions = new WeakMap<Socket, Map<string, Subscription>>()

// Multiple task panels can display the same Session. The last consumer owns
// unsubscribe; reconnect and invalidation have one listener per Session room.
function acquireSession(socket: Socket, sessionId: string, owner: Owner) {
  let sessions = subscriptions.get(socket)
  if (!sessions) { sessions = new Map(); subscriptions.set(socket, sessions) }
  let state = sessions.get(sessionId)
  if (!state) {
    const owners = new Set<Owner>()
    let generation = 0
    const refresh = () => { state!.epoch++; for (const item of owners) item.refresh() }
    const subscribe = () => {
      const token = ++generation
      socket.emit(ClientEvents.SUBSCRIBE, { topic: 'session', id: sessionId }, (ack: { success: boolean }) => {
        if (token !== generation || sessions!.get(sessionId) !== state) return
        state!.denied = !ack.success
        for (const item of owners) item.permission(!ack.success)
        refresh()
      })
      refresh()
    }
    const invalidated = (payload: TranslationInvalidatedPayload) => { if (payload.sessionId === sessionId) refresh() }
    state = { owners, epoch: 0, denied: false, dispose: () => {
      generation++
      socket.off('connect', subscribe)
      socket.off(ServerEvents.TRANSLATION_INVALIDATED, invalidated)
      socket.emit(ClientEvents.UNSUBSCRIBE, { topic: 'session', id: sessionId })
    } }
    sessions.set(sessionId, state)
    socket.on('connect', subscribe)
    socket.on(ServerEvents.TRANSLATION_INVALIDATED, invalidated)
    owners.add(owner)
    if (socket.connected) subscribe()
  } else { state.owners.add(owner); owner.permission(state.denied) }
  return () => {
    state!.owners.delete(owner)
    if (!state!.owners.size) { state!.dispose(); sessions!.delete(sessionId) }
  }
}

function epoch(socket: Socket, sessionId: string) { return subscriptions.get(socket)?.get(sessionId)?.epoch ?? 0 }

export function isTranslationCandidate(log: LogEntry) {
  return log.type === LogType.Assistant && log.title !== 'Thinking' && !log.content.startsWith('Thinking:')
    && log.textBlock?.semanticType === 'assistant_message'
}

export function matchingTranslation(sessionId: string, log: LogEntry, overlays: SessionTranslationOverlay[]) {
  const block = log.textBlock
  if (!isTranslationCandidate(log) || block?.state !== 'SEALED') return undefined
  return overlays.find(item => item.sessionId === sessionId && item.turnId === block.turnId && item.blockId === block.blockId
    && item.sourceRevision === block.sourceRevision && item.originalText === log.content)
}

export function mergeTranslationSnapshot(previous: SessionTranslationOverlay[] | undefined, next: SessionTranslationOverlay[]) {
  const old = new Map(previous?.map(item => [item.sourceId, item]))
  // Missing records are authoritative removals. Only present records can keep
  // a higher revision; old results are never resurrected by an append-only merge.
  return next.map(item => {
    const existing = old.get(item.sourceId)
    return existing && existing.overlayRevision > item.overlayRevision ? existing : item
  })
}

export async function readSessionTranslations(sessionId: string, blockIds: string[], signal: AbortSignal): Promise<SessionTranslationOverlay[]> {
  const items: SessionTranslationOverlay[] = []
  for (let offset = 0; offset < blockIds.length; offset += 100) {
    let cursor: string | null = null
    const visited = new Set<string>()
    do {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const page: Page = await apiClient.get<Page>(`/sessions/${encodeURIComponent(sessionId)}/translations`, {
        signal, params: { blockIds: blockIds.slice(offset, offset + 100).join(','), ...(cursor ? { cursor } : {}) },
      })
      items.push(...page.items)
      cursor = page.nextCursor
      // Bound a corrupt or continually growing pagination stream. An incomplete
      // read is never installed as an authoritative snapshot.
      if (cursor && (visited.has(cursor) || visited.size >= 1000)) throw new Error('Translation pagination did not finish')
      if (cursor) visited.add(cursor)
    } while (cursor !== null)
  }
  return items
}

export function useSessionTranslations(sessionId: string, logs: LogEntry[]) {
  const client = useQueryClient()
  const [denied, setDenied] = useState(false)
  const candidates = useMemo(() => logs.filter(log => isTranslationCandidate(log) && log.textBlock!.state === 'SEALED'), [logs])
  const blockIds = useMemo(() => [...new Set(candidates.map(log => log.textBlock!.blockId))].sort(), [candidates])
  // Include original bytes and lifecycle version in the key. A changed body
  // immediately leaves the old query, even when a provider reuses a block id.
  const versions = useMemo(() => candidates.map(log => [log.textBlock!.turnId,
    log.textBlock!.blockId, log.textBlock!.sourceRevision, log.textBlock!.state, log.content]), [candidates])
  const query = useQuery({
    queryKey: [...queryKeys.sessionTranslations.blocks(sessionId, blockIds), versions],
    enabled: blockIds.length > 0,
    queryFn: async ({ signal }) => {
      const socket = socketManager.getSocket()
      for (let attempt = 0; attempt < 3; attempt++) {
        const started = epoch(socket, sessionId)
        const result = await readSessionTranslations(sessionId, blockIds, signal)
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
        // Invalidating a first in-flight Query does not necessarily cancel it.
        // Re-read when an event/reconnect arrived during the request.
        if (epoch(socket, sessionId) === started) return result
      }
      throw new Error('Translation snapshot changed while reading')
    },
    structuralSharing: (oldData, newData) => mergeTranslationSnapshot(oldData as SessionTranslationOverlay[] | undefined, newData as SessionTranslationOverlay[]),
    placeholderData: (previous, query) => query?.queryKey[1] === sessionId && query.state.status === 'success' ? previous : undefined,
    refetchOnMount: 'always',
    refetchInterval: 5000,
    retry: false,
    gcTime: 60_000,
  })
  useEffect(() => {
    const socket = socketManager.connect()
    const refresh = () => { void client.invalidateQueries({ queryKey: queryKeys.sessionTranslations.session(sessionId) }) }
    return acquireSession(socket, sessionId, { refresh, permission: setDenied })
  }, [client, sessionId])
  return { ...query, overlays: !denied && !query.isError && (query.isFetchedAfterMount || query.isPlaceholderData) ? query.data ?? [] : [] }
}
