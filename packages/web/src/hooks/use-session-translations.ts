import { useEffect, useMemo, useRef, useState } from 'react'
import { replaceEqualDeep, useQuery, useQueryClient } from '@tanstack/react-query'
import { getTranslationTextBlocks, type SessionTranslationOverlay } from '@agent-tower/shared'
import { type LogEntry, LogType } from '@agent-tower/shared/log-adapter'
import { ClientEvents, ServerEvents, type TranslationInvalidatedPayload } from '@agent-tower/shared/socket'
import type { Socket } from 'socket.io-client'
import { apiClient, ApiError } from '@/lib/api-client'
import { socketManager } from '@/lib/socket/manager'
import { queryKeys } from './query-keys'

type Page = { items: SessionTranslationOverlay[]; nextCursor: string | null }
type Owner = { refresh: () => void; permission: (denied: boolean) => void }
type Subscription = { owners: Set<Owner>; epoch: number; denied: boolean; dispose: () => void }
const subscriptions = new WeakMap<Socket, Map<string, Subscription>>()
const EMPTY_OVERLAYS: SessionTranslationOverlay[] = []

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
    const subscribe = (reconnect = true) => {
      const token = ++generation
      socket.emit(ClientEvents.SUBSCRIBE, { topic: 'session', id: sessionId }, (ack: { success: boolean }) => {
        if (token !== generation || sessions!.get(sessionId) !== state) return
        const wasDenied = state!.denied
        state!.denied = !ack.success
        for (const item of owners) item.permission(!ack.success)
        if (wasDenied && ack.success) refresh()
      })
      // Mount already revalidates through Query. Neither joining nor its ACK
      // changes the snapshot; only a reconnect needs another authoritative read.
      if (reconnect) refresh()
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
    if (socket.connected) subscribe(false)
  } else { state.owners.add(owner); owner.permission(state.denied) }
  return () => {
    state!.owners.delete(owner)
    if (!state!.owners.size) { state!.dispose(); sessions!.delete(sessionId) }
  }
}

function epoch(socket: Socket, sessionId: string) { return subscriptions.get(socket)?.get(sessionId)?.epoch ?? 0 }
function accessDenied(error: unknown) { return error instanceof ApiError && [401, 403, 404].includes(error.status) }

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

export function indexSessionTranslations(overlays: SessionTranslationOverlay[]) {
  return new Map(overlays.map(item => [JSON.stringify([item.sessionId, item.turnId, item.blockId]), item]))
}

export function sessionTranslationPresentation(sessionId: string, log: LogEntry, index: ReturnType<typeof indexSessionTranslations>) {
  const overlays: SessionTranslationOverlay[] = []
  let version: string | null = null
  if (!isTranslationCandidate(log) || !log.textBlock) return { content: log.content, overlays, version }
  const blocks = getTranslationTextBlocks(log.content, log.textBlock)
  const content = blocks.map(block => {
    const overlay = index.get(JSON.stringify([sessionId, block.turnId, block.blockId]))
    if (block.state !== 'SEALED' || !overlay || overlay.sourceRevision !== block.sourceRevision || overlay.originalText !== block.content) return block.content
    overlays.push(overlay)
    if (overlay.state !== 'SUCCESS' || overlay.translatedText === null) return block.content
    version = `${overlay.sourceId}:${overlay.sourceRevision}`
    return overlay.translatedText
  }).join('')
  return { content: blocks.length ? content : log.content, overlays, version }
}

export function mergeTranslationSnapshot(previous: SessionTranslationOverlay[] | undefined, next: SessionTranslationOverlay[]) {
  const old = new Map(previous?.map(item => [item.sourceId, item]))
  // Missing records are authoritative removals. Only present records can keep
  // a higher revision; old results are never resurrected by an append-only merge.
  return replaceEqualDeep(previous, next.map(item => {
    const existing = old.get(item.sourceId)
    return existing && existing.overlayRevision > item.overlayRevision ? existing : item
  }))
}

export async function readSessionTranslations(sessionId: string, blockIds: string[] | undefined, signal: AbortSignal): Promise<SessionTranslationOverlay[]> {
  const items: SessionTranslationOverlay[] = []
  for (let offset = 0; offset < (blockIds?.length ?? 1); offset += 100) {
    let cursor: string | null = null
    const visited = new Set<string>()
    do {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const page: Page = await apiClient.get<Page>(`/sessions/${encodeURIComponent(sessionId)}/translations`, {
        signal, params: { ...(blockIds ? { blockIds: blockIds.slice(offset, offset + 100).join(',') } : {}), ...(cursor ? { cursor } : {}) },
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
  const selection = useMemo(() => JSON.stringify(logs.filter(isTranslationCandidate).map(log => {
    const block = log.textBlock!
    return [block.turnId, block.blockId, block.sourceRevision, block.state, block.paragraphs?.length ?? 0]
  })), [logs])
  const previousSelection = useRef({ sessionId, selection })
  // One authoritative cache per Session survives task switches and truncated
  // log caches. Original bytes are checked at presentation, never hashed into keys.
  const query = useQuery({
    queryKey: queryKeys.sessionTranslations.session(sessionId),
    enabled: selection !== '[]',
    queryFn: async ({ signal }) => {
      const socket = socketManager.getSocket()
      for (let attempt = 0; attempt < 3; attempt++) {
        const started = epoch(socket, sessionId)
        let result: SessionTranslationOverlay[]
        try { result = await readSessionTranslations(sessionId, undefined, signal) }
        catch (error) {
          // A later network failure or remount must not resurrect a revoked cache.
          if (!signal.aborted && accessDenied(error)) client.setQueryData(queryKeys.sessionTranslations.session(sessionId), EMPTY_OVERLAYS)
          throw error
        }
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
        // Invalidating a first in-flight Query does not necessarily cancel it.
        // Re-read when an event/reconnect arrived during the request.
        if (epoch(socket, sessionId) === started) return result
      }
      throw new Error('Translation snapshot changed while reading')
    },
    structuralSharing: (oldData, newData) => mergeTranslationSnapshot(oldData as SessionTranslationOverlay[] | undefined, newData as SessionTranslationOverlay[]),
    refetchOnMount: 'always',
    refetchInterval: 5000,
    retry: false,
    gcTime: 30 * 60_000,
  })
  useEffect(() => {
    const socket = socketManager.connect()
    // Share an in-flight read across listeners/paragraph completions. The epoch
    // check above performs one fresh read if that request raced an invalidation.
    const refresh = () => { void client.invalidateQueries({ queryKey: queryKeys.sessionTranslations.session(sessionId) }, { cancelRefetch: false }) }
    return acquireSession(socket, sessionId, { refresh, permission: value => {
      setDenied(value)
      if (value) {
        void client.cancelQueries({ queryKey: queryKeys.sessionTranslations.session(sessionId) }, { revert: false })
        client.setQueryData(queryKeys.sessionTranslations.session(sessionId), EMPTY_OVERLAYS)
      }
    } })
  }, [client, sessionId])
  useEffect(() => {
    const previous = previousSelection.current
    previousSelection.current = { sessionId, selection }
    if (previous.sessionId === sessionId && previous.selection !== selection) {
      void client.invalidateQueries({ queryKey: queryKeys.sessionTranslations.session(sessionId) }, { cancelRefetch: false })
    }
  }, [client, sessionId, selection])
  const inaccessible = accessDenied(query.error)
  return { ...query, overlays: !denied && !inaccessible ? query.data ?? EMPTY_OVERLAYS : EMPTY_OVERLAYS }
}
