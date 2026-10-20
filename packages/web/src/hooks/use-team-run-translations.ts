import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useIsMutating, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { RoomMessage, TeamRunTranslationOverlay, TeamRunTranslationOverlaySummary } from '@agent-tower/shared'
import { ClientEvents, ServerEvents, type TranslationInvalidatedPayload } from '@agent-tower/shared/socket'
import type { Socket } from 'socket.io-client'
import { ApiError, apiClient } from '@/lib/api-client'
import { socketManager } from '@/lib/socket/manager'
import { queryKeys } from './query-keys'
import { roomTranslationAccessGeneration } from './room-translation-access'
import { useTranslationReveals } from './translation-reveals'

type Summary = TeamRunTranslationOverlaySummary
type Snapshot = { items: Summary[]; generations: Record<string, number> }
type Owner = { client: QueryClient; candidates: () => Set<string>; withdraw: (id: string) => void; refresh: () => void; permission: (denied: boolean) => void }
type Subscription = { owners: Set<Owner>; epoch: number; itemGenerations: Map<string, number>; denied: boolean; dispose: () => void }
const subscriptions = new WeakMap<Socket, Map<string, Subscription>>()
const aborted = () => new DOMException('Aborted', 'AbortError')
const forbidden = (error: unknown) => error instanceof ApiError && [401, 403, 404].includes(error.status)

function acquire(socket: Socket, id: string, owner: Owner) {
  let rooms = subscriptions.get(socket)
  if (!rooms) { rooms = new Map(); subscriptions.set(socket, rooms) }
  let state = rooms.get(id)
  if (!state) {
    const owners = new Set<Owner>()
    let token = 0
    let queued = false
    const refresh = () => {
      state!.epoch++
      if (queued) return
      queued = true
      queueMicrotask(() => {
        queued = false
        if (rooms!.get(id) === state) for (const item of owners) item.refresh()
      })
    }
    const subscribe = () => {
      const current = ++token
      socket.emit(ClientEvents.SUBSCRIBE, { topic: 'team-run', id }, (ack: { success: boolean }) => {
        if (current !== token || rooms!.get(id) !== state) return
        state!.denied = !ack.success
        for (const item of owners) item.permission(!ack.success)
        refresh()
      })
      refresh()
    }
    const invalidated = (event: TranslationInvalidatedPayload) => {
      if (event.teamRunId !== id) return
      refresh()
    }
    const disconnected = (reason: string) => {
      if (reason !== 'io server disconnect') return
      token++
      state!.denied = true
      state!.epoch++
      for (const item of owners) item.permission(true)
    }
    state = { owners, epoch: 0, itemGenerations: new Map(), denied: false, dispose: () => {
      token++
      socket.off('connect', subscribe)
      socket.off('disconnect', disconnected)
      socket.off(ServerEvents.TRANSLATION_INVALIDATED, invalidated)
      socket.emit(ClientEvents.UNSUBSCRIBE, { topic: 'team-run', id })
    } }
    rooms.set(id, state)
    socket.on('connect', subscribe)
    socket.on('disconnect', disconnected)
    socket.on(ServerEvents.TRANSLATION_INVALIDATED, invalidated)
    owners.add(owner)
    if (socket.connected) subscribe()
  } else { state.owners.add(owner); owner.permission(state.denied) }
  return () => {
    state!.owners.delete(owner)
    if (!state!.owners.size) { state!.dispose(); rooms!.delete(id) }
  }
}
function epoch(socket: Socket, id: string) { return subscriptions.get(socket)?.get(id)?.epoch ?? 0 }
function itemGeneration(socket: Socket, id: string, messageId: string) { return subscriptions.get(socket)?.get(id)?.itemGenerations.get(messageId) ?? 0 }
export function mergeRoomTranslationSnapshot(previous: Summary[] | undefined, next: Summary[]) {
  const old = new Map(previous?.map(row => [row.sourceId, row]))
  return next.map(row => {
    const saved = old.get(row.sourceId)
    return saved && (saved.sourceRevision > row.sourceRevision || saved.sourceRevision === row.sourceRevision && saved.overlayRevision > row.overlayRevision) ? saved : row
  })
}
export async function readTeamRunTranslations(id: string, ids: string[], signal: AbortSignal): Promise<Summary[]> {
  const items: Summary[] = []
  for (let offset = 0; offset < ids.length; offset += 100) {
    if (signal.aborted) throw aborted()
    const page = await apiClient.get<{ items: Summary[] }>(`/team-runs/${encodeURIComponent(id)}/translations`, { signal, params: { messageIds: ids.slice(offset, offset + 100).join(',') } })
    items.push(...page.items)
  }
  return items
}

export function useTeamRunTranslations(teamRunId: string, messages: RoomMessage[]) {
  const client = useQueryClient()
  const changingIdentity = useIsMutating({ mutationKey: queryKeys.accessAuth.identityChange }) > 0
  const accessGeneration = roomTranslationAccessGeneration()
  const [denied, setDenied] = useState(false)
  const [, setWithdrawal] = useState(0)
  const candidates = useMemo(() => messages.filter(row => row.teamRunId === teamRunId && row.senderType === 'agent' && row.visibility === 'PUBLIC' && !row.id.startsWith('pending-')), [messages, teamRunId])
  const ids = useMemo(() => [...new Set(candidates.map(row => row.id))].sort(), [candidates])
  const versions = useMemo(() => candidates.map(row => [row.id, row.content, row.contentPreview, row.isTruncated, row.senderId, row.senderInvocationId]), [candidates])
  const scope = useMemo(() => ({ teamRunId, accessGeneration, active: true, allowed: false, generation: 0, summaries: new Map<string, Summary>() }), [teamRunId, accessGeneration])
  const currentCandidates = useRef(new Set(ids))
  const previousCandidates = useRef(new Set(ids))
  currentCandidates.current = new Set(ids)
  const clearScope = () => {
    void client.cancelQueries({ queryKey: queryKeys.roomTranslations.scope(teamRunId) })
    client.removeQueries({ queryKey: queryKeys.roomTranslations.scope(teamRunId) })
  }
  const revoke = () => {
    if (accessGeneration !== roomTranslationAccessGeneration()) return
    const shared = subscriptions.get(socketManager.getSocket())?.get(teamRunId)
    if (shared) {
      shared.denied = true
      for (const owner of shared.owners) owner.permission(true)
    } else { scope.allowed = false; scope.generation++; setDenied(true) }
    clearScope()
  }
  const query = useQuery({
    queryKey: [...queryKeys.roomTranslations.summaries(teamRunId), accessGeneration, ids, versions],
    enabled: ids.length > 0 && !denied && !changingIdentity,
    queryFn: async ({ signal }) => {
      const socket = socketManager.getSocket()
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const started = epoch(socket, teamRunId)
          const generations = Object.fromEntries(ids.map(id => [id, itemGeneration(socket, teamRunId, id)]))
          const rows = await readTeamRunTranslations(teamRunId, ids, signal)
          if (signal.aborted || subscriptions.get(socket)?.get(teamRunId)?.denied || accessGeneration !== roomTranslationAccessGeneration()) throw aborted()
          if (started === epoch(socket, teamRunId) && ids.every(id => generations[id] === itemGeneration(socket, teamRunId, id))) return { items: rows.filter(row => row.teamRunId === teamRunId && ids.includes(row.messageId)), generations }
        }
        throw new Error('Translation snapshot changed while reading')
      } catch (error) { if (forbidden(error)) revoke(); throw error }
    },
    structuralSharing: (old, next) => {
      const previous = old as Snapshot | undefined
      const snapshot = next as Snapshot
      return { ...snapshot, items: mergeRoomTranslationSnapshot(previous?.items.filter(row => previous.generations[row.messageId] === snapshot.generations[row.messageId]), snapshot.items) }
    },
    refetchOnMount: 'always', refetchOnWindowFocus: true, refetchInterval: 5000, retry: false, gcTime: 0,
  })
  scope.allowed = !denied && !changingIdentity && !query.isError && query.isFetchedAfterMount && accessGeneration === roomTranslationAccessGeneration()
  // Retain the read's generation in each action closure, including after a fresh
  // snapshot restores the same source/revision. Pre-withdrawal actions stay stale.
  const generations = query.data?.generations
  const overlays = useMemo(() => scope.allowed ? query.data?.items ?? [] : [], [scope.allowed, query.data])
  scope.summaries = new Map(overlays.filter(row => currentCandidates.current.has(row.messageId)
    && generations?.[row.messageId] === itemGeneration(socketManager.getSocket(), teamRunId, row.messageId)).map(row => [row.messageId, row]))
  useEffect(() => {
    scope.active = true
    const socket = socketManager.connect()
    const release = acquire(socket, teamRunId, {
      client,
      candidates: () => currentCandidates.current,
      withdraw: id => { scope.summaries.delete(id); setWithdrawal(value => value + 1) },
      refresh: () => { void client.invalidateQueries({ queryKey: queryKeys.roomTranslations.scope(teamRunId) }, { cancelRefetch: false }) },
      permission: value => {
        if (value) { scope.allowed = false; scope.generation++; scope.summaries.clear(); clearScope() }
        setDenied(value)
      },
    })
    return () => {
      scope.active = false; scope.allowed = false; scope.generation++; release()
      if (!subscriptions.get(socket)?.has(teamRunId)) clearScope()
    }
    // The scope object owns a single subscription lifetime; callbacks use refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, teamRunId, scope])
  useLayoutEffect(() => {
    const shared = subscriptions.get(socketManager.getSocket())?.get(teamRunId)
    const removed = [...previousCandidates.current].filter(id => !currentCandidates.current.has(id) && ![...(shared?.owners ?? [])].some(owner => owner.candidates().has(id)))
    previousCandidates.current = new Set(ids)
    for (const id of removed) {
      const key = [...queryKeys.roomTranslations.details(teamRunId), id]
      void client.cancelQueries({ queryKey: key })
      client.removeQueries({ queryKey: key })
    }
  }, [client, teamRunId, ids])
  useEffect(() => {
    if (!query.isSuccess || !query.isFetchedAfterMount) return
    const visible = new Set(overlays.map(row => row.messageId))
    const removed = client.getQueryCache().findAll({ queryKey: queryKeys.roomTranslations.details(teamRunId) }).filter(item => ids.includes(item.queryKey[3] as string) && !visible.has(item.queryKey[3] as string))
    for (const item of removed) { void client.cancelQueries({ queryKey: item.queryKey, exact: true }); client.removeQueries({ queryKey: item.queryKey, exact: true }) }
  }, [client, teamRunId, overlays, ids, query.isSuccess, query.isFetchedAfterMount])
  const isCurrent = (row: Summary) => {
    const live = scope.summaries.get(row.messageId)
    return scope.active && scope.allowed && accessGeneration === roomTranslationAccessGeneration() && currentCandidates.current.has(row.messageId)
      && generations?.[row.messageId] === itemGeneration(socketManager.getSocket(), teamRunId, row.messageId)
      && live?.sourceId === row.sourceId && live.sourceRevision === row.sourceRevision && live.overlayRevision === row.overlayRevision
  }
  const loadFull = async (row: Summary): Promise<TeamRunTranslationOverlay> => {
    if (!isCurrent(row)) throw aborted()
    const generation = scope.generation
    const itemVersion = itemGeneration(socketManager.getSocket(), teamRunId, row.messageId)
    const result = await client.fetchQuery({
      queryKey: queryKeys.roomTranslations.full(teamRunId, row.messageId, row.sourceId, row.sourceRevision, row.overlayRevision),
      staleTime: 0, gcTime: 0, retry: false,
      queryFn: async ({ signal }) => {
        try {
          for (let attempt = 0; attempt < 3; attempt++) {
            const started = epoch(socketManager.getSocket(), teamRunId)
            const full = await apiClient.get<TeamRunTranslationOverlay>(`/team-runs/${encodeURIComponent(teamRunId)}/messages/${encodeURIComponent(row.messageId)}/translation`, { signal })
            const shared = subscriptions.get(socketManager.getSocket())?.get(teamRunId)
            if (signal.aborted || accessGeneration !== roomTranslationAccessGeneration() || !shared || shared.denied || itemVersion !== itemGeneration(socketManager.getSocket(), teamRunId, row.messageId) || ![...shared.owners].some(owner => owner.candidates().has(row.messageId))) throw aborted()
            if (full.teamRunId !== teamRunId || full.messageId !== row.messageId || full.sourceId !== row.sourceId || full.sourceRevision !== row.sourceRevision) throw aborted()
            if (full.overlayRevision >= row.overlayRevision && started === epoch(socketManager.getSocket(), teamRunId)) return full
          }
          throw new Error('Translation detail changed while reading')
        } catch (error) { if (error instanceof ApiError && error.status === 404) removeDetail(row); else if (forbidden(error)) revoke(); throw error }
      },
    })
    if (generation !== scope.generation || !isCurrent(row)) throw aborted()
    return result
  }
  const removeDetail = (row: Summary) => {
    if (accessGeneration !== roomTranslationAccessGeneration()) return
    const shared = subscriptions.get(socketManager.getSocket())?.get(teamRunId)
    if (!shared) return
    // Revoke synchronously across owners before cancelling any await or rendering.
    shared.itemGenerations.set(row.messageId, (shared.itemGenerations.get(row.messageId) ?? 0) + 1)
    for (const owner of shared.owners) owner.withdraw(row.messageId)
    for (const target of new Set([client, ...[...shared.owners].map(owner => owner.client)])) {
      const key = [...queryKeys.roomTranslations.details(teamRunId), row.messageId]
      void target.cancelQueries({ queryKey: key })
      target.removeQueries({ queryKey: key })
      const summaries = queryKeys.roomTranslations.summaries(teamRunId)
      void target.cancelQueries({ queryKey: summaries })
      target.setQueriesData<Snapshot>({ queryKey: summaries }, snapshot => snapshot && ({ ...snapshot, items: snapshot.items.filter(item => item.messageId !== row.messageId) }))
      void target.invalidateQueries({ queryKey: summaries }, { cancelRefetch: false })
    }
  }
  const retry = async (row: Summary) => {
    if (!isCurrent(row)) throw aborted()
    try { await apiClient.post(`/team-runs/${encodeURIComponent(teamRunId)}/translations/${encodeURIComponent(row.sourceId)}/retry`, { expectedRevision: row.sourceRevision }) }
    catch (error) { if (error instanceof ApiError && error.status === 404) removeDetail(row); else if (forbidden(error)) revoke(); throw error }
    finally { void client.invalidateQueries({ queryKey: queryKeys.roomTranslations.summaries(teamRunId) }, { cancelRefetch: false }) }
  }
  const visible = [...scope.summaries.values()]
  const claimReveal = useTranslationReveals(`${teamRunId}:${accessGeneration}`,
    candidates.map(row => ({ id: row.id, revision: 0 })),
    visible.map(row => ({ id: row.messageId, version: `${row.sourceId}:${row.sourceRevision}`, state: row.state })), messages.length > 0)
  return { overlays: visible, loadFull, isCurrent, retry, claimReveal }
}
export type RoomTranslations = ReturnType<typeof useTeamRunTranslations>
