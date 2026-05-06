import { useEffect, useRef, useCallback, useState, useMemo } from 'react'
import { applyPatch, type Operation } from 'fast-json-patch'
import { socketManager } from '../manager.js'
import {
  ClientEvents,
  ServerEvents,
  type SessionPatchPayload,
  type SessionIdPayload,
  type SessionExitPayload,
  type SessionErrorPayload,
} from '@agent-tower/shared/socket'
import { SessionStatus } from '@agent-tower/shared'
import {
  type NormalizedEntry,
  type LogEntry,
  normalizedEntriesToLogEntries,
  createCursorEntry,
} from '@agent-tower/shared/log-adapter'
import { apiClient } from '../../api-client.js'
import {
  useSessionLogStore,
  EMPTY_CONVERSATION,
  normalizeServerConversation,
  shouldReplaceConversationWithSnapshot,
  type NormalizedConversation,
} from '@/stores/session-log-store.js'

const DEBUG_LOGS = import.meta.env.VITE_DEBUG_LOGS === 'true'
const TERMINAL_REVALIDATE_DELAY_MS = 1500

function isTerminalStatus(status?: SessionStatus | string): boolean {
  return status === SessionStatus.COMPLETED
    || status === SessionStatus.FAILED
    || status === SessionStatus.CANCELLED
}

function conversationSeq(conversation?: NormalizedConversation): number {
  return typeof conversation?.seq === 'number' ? conversation.seq : 0
}

function shouldShowOutputCursor(status?: SessionStatus | string): boolean {
  return !isTerminalStatus(status)
}

interface UseNormalizedLogsOptions {
  sessionId: string
  sessionStatus?: SessionStatus | string
  onAgentSessionId?: (agentSessionId: string) => void
  onExit?: (exitCode: number) => void
  onError?: (message: string) => void
}

interface UseNormalizedLogsReturn {
  isConnected: boolean
  isAttached: boolean
  isLoadingSnapshot: boolean
  logs: LogEntry[]
  entries: NormalizedEntry[]
  agentSessionId: string | null
  attach: () => Promise<boolean>
  sendInput: (data: string) => void
  clearLogs: () => void
}

/**
 * Normalized log stream hook.
 *
 * Manages WebSocket subscription for a session and stores conversation
 * data in the global Zustand sessionLogStore so it persists across
 * task switches. All SESSION_* events are now broadcast to the entire
 * namespace (no room filtering), so the hook filters by sessionId.
 */
export function useNormalizedLogs(options: UseNormalizedLogsOptions): UseNormalizedLogsReturn {
  const { sessionId, sessionStatus, onAgentSessionId, onExit, onError } = options

  const [isConnected, setIsConnected] = useState(() => socketManager.isConnected())
  const [isAttached, setIsAttached] = useState(false)
  const [isLoadingSnapshot, setIsLoadingSnapshot] = useState(false)
  const [agentSessionId, setAgentSessionId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  // Read conversation from Zustand store (replaces useState)
  const conversation = useSessionLogStore(
    useCallback(
      (s) => s.conversations[sessionId] ?? EMPTY_CONVERSATION,
      [sessionId],
    ),
  )

  const snapshotLoadedRef = useRef(false)
  const pendingPatchesRef = useRef<Record<string, SessionPatchPayload[]>>({})
  const loadSnapshotRef = useRef<(() => Promise<void>) | null>(null)
  const loadingSnapshotSessionsRef = useRef<Set<string>>(new Set())
  const currentSessionIdRef = useRef(sessionId)
  currentSessionIdRef.current = sessionId

  const callbacksRef = useRef({ onAgentSessionId, onExit, onError })
  callbacksRef.current = { onAgentSessionId, onExit, onError }

  // Keep latest sessionStatus accessible in effect closures
  const sessionStatusRef = useRef(sessionStatus)
  sessionStatusRef.current = sessionStatus

  // Socket event listeners & cleanup
  useEffect(() => {
    if (!sessionId) return

    const socket = socketManager.getSocket()
    setIsConnected(socket.connected)

    // Capture whether this session is active at effect creation time.
    // Updated by handleExit so cleanup knows the correct state.
    let isActive = !isTerminalStatus(sessionStatus)

    const handleConnect = () => setIsConnected(true)
    const handleDisconnect = () => {
      setIsConnected(false)
      setIsAttached(false)
      snapshotLoadedRef.current = false
      pendingPatchesRef.current[sessionId] = []
    }

    let patchCount = 0
    const handlePatch = (payload: SessionPatchPayload) => {
      if (payload.sessionId !== sessionId) return

      patchCount++
      if (DEBUG_LOGS) {
        const opsSummary = (payload.patch as Array<{ op: string; path: string }>)
          .map(o => `${o.op}:${o.path}`)
          .join(', ')
        console.log(
          `[useNormalizedLogs:handlePatch] t=${Date.now()} #${patchCount} sessionId=${sessionId} ops=${payload.patch.length} snapshotLoaded=${snapshotLoadedRef.current} [${opsSummary}]`,
        )
      }

      if (!snapshotLoadedRef.current) {
        pendingPatchesRef.current[sessionId] = [
          ...(pendingPatchesRef.current[sessionId] ?? []),
          payload,
        ]
        return
      }

      const store = useSessionLogStore.getState()
      const ok = store.applyPatch(sessionId, payload.patch as Operation[], payload.seq)
      if (!ok) {
        // Patch apply failed — store drifted from server. Reset snapshot
        // state and refetch authoritative state. Buffer subsequent patches
        // until reload completes.
        snapshotLoadedRef.current = false
        pendingPatchesRef.current[sessionId] = []
        loadSnapshotRef.current?.()
        return
      }
      setIsLoading(true)
    }

    const handleSessionId = (payload: SessionIdPayload) => {
      if (payload.sessionId !== sessionId) return
      if (DEBUG_LOGS) {
        console.log(`[useNormalizedLogs:handleSessionId] t=${Date.now()} agentSessionId=${payload.agentSessionId}`)
      }
      setAgentSessionId(payload.agentSessionId)
      callbacksRef.current.onAgentSessionId?.(payload.agentSessionId)
    }

    const handleExit = (payload: SessionExitPayload) => {
      if (payload.sessionId !== sessionId) return
      isActive = false
      setIsAttached(false)
      setIsLoading(false)
      callbacksRef.current.onExit?.(payload.exitCode)
    }

    const handleError = (payload: SessionErrorPayload) => {
      if (payload.sessionId !== sessionId) return
      callbacksRef.current.onError?.(payload.message)
    }

    socket.on('connect', handleConnect)
    socket.on('disconnect', handleDisconnect)
    socket.on(ServerEvents.SESSION_PATCH, handlePatch)
    socket.on(ServerEvents.SESSION_ID, handleSessionId)
    socket.on(ServerEvents.SESSION_EXIT, handleExit)
    socket.on(ServerEvents.SESSION_ERROR, handleError)

    setIsConnected(socket.connected)

    return () => {
      socket.off('connect', handleConnect)
      socket.off('disconnect', handleDisconnect)
      socket.off(ServerEvents.SESSION_PATCH, handlePatch)
      socket.off(ServerEvents.SESSION_ID, handleSessionId)
      socket.off(ServerEvents.SESSION_EXIT, handleExit)
      socket.off(ServerEvents.SESSION_ERROR, handleError)

      snapshotLoadedRef.current = false
      pendingPatchesRef.current[sessionId] = []
      setAgentSessionId(null)
      setIsLoading(false)
      setIsAttached(false)

      if (!isActive) {
        // Terminal session: truncate to save memory
        useSessionLogStore.getState().truncateSession(sessionId)
      }
    }
  // sessionStatus intentionally excluded — captured via isActive flag inside the effect
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Load snapshot: show cached data immediately, then reconcile with the server.
  const loadSnapshot = useCallback(async () => {
    if (!sessionId) return
    const requestSessionId = sessionId
    const isCurrentSession = () => currentSessionIdRef.current === requestSessionId
    if (loadingSnapshotSessionsRef.current.has(requestSessionId)) return

    if (DEBUG_LOGS) {
      console.log(`[useNormalizedLogs:loadSnapshot] t=${Date.now()} sessionId=${requestSessionId} start`)
    }

    const store = useSessionLogStore.getState()
    const cached = store.conversations[requestSessionId]

    if (cached && cached.entries.length > 0) {
      if (DEBUG_LOGS) {
        console.log(`[useNormalizedLogs:loadSnapshot] using cached session, entries=${cached.entries.length} seq=${conversationSeq(cached)} truncated=${cached.isTruncated === true}`)
      }
      store.touchAccess(requestSessionId)
      if (isCurrentSession()) {
        setIsAttached(true)
        setIsLoading(shouldShowOutputCursor(sessionStatusRef.current))
      }
    }

    // While reconciling, buffer patches instead of applying them to a cache
    // that may be stale or truncated.
    if (isCurrentSession()) {
      snapshotLoadedRef.current = false
    }

    // Only show loading spinner if store has no data at all
    const hasStaleData = cached && cached.entries.length > 0
    if (!hasStaleData && isCurrentSession()) {
      setIsLoadingSnapshot(true)
    }
    loadingSnapshotSessionsRef.current.add(requestSessionId)

    try {
      const serverSnapshot = normalizeServerConversation(
        await apiClient.get<NormalizedConversation>(
          `/sessions/${requestSessionId}/logs`,
          { cache: 'no-store' },
        ),
      )

      if (DEBUG_LOGS) {
        console.log(
          `[useNormalizedLogs:loadSnapshot] t=${Date.now()} sessionId=${requestSessionId} fetched entries=${serverSnapshot.entries.length} seq=${conversationSeq(serverSnapshot)}`,
        )
      }

      const buffered = pendingPatchesRef.current[requestSessionId] ?? []
      pendingPatchesRef.current[requestSessionId] = []
      if (isCurrentSession()) {
        snapshotLoadedRef.current = true
      }

      let state: NormalizedConversation = serverSnapshot
      const snapshotSeq = conversationSeq(serverSnapshot)
      let highestSeq = snapshotSeq
      for (const p of buffered) {
        // Dedupe: any patch already reflected in the snapshot must not be reapplied.
        // Without this, `add` ops (which are "insert" on arrays) duplicate entries.
        if (typeof p.seq === 'number' && p.seq <= snapshotSeq) continue
        try {
          const patched = applyPatch(
            state,
            p.patch as Operation[],
            true,
            false,
          )
          state = patched.newDocument
          if (typeof p.seq === 'number' && p.seq > highestSeq) highestSeq = p.seq
        } catch (error) {
          console.error('Failed to replay buffered patch:', error)
        }
      }

      state = {
        ...state,
        seq: highestSeq,
        isTruncated: false,
      }

      const latestCached = store.getConversation(requestSessionId)
      if (
        buffered.length > 0 ||
        shouldReplaceConversationWithSnapshot(latestCached, state)
      ) {
        store.setConversation(requestSessionId, state)
      } else {
        store.touchAccess(requestSessionId)
      }

      if (isCurrentSession()) {
        setIsAttached(true)
        const latest = useSessionLogStore.getState().getConversation(requestSessionId)
        if (latest && latest.entries.length > 0) {
          setIsLoading(shouldShowOutputCursor(sessionStatusRef.current))
        }
      }
    } catch (error) {
      console.error('[useNormalizedLogs:loadSnapshot] Failed to load snapshot:', error)
      if (isCurrentSession()) {
        snapshotLoadedRef.current = true
      }
      pendingPatchesRef.current[requestSessionId] = []
    } finally {
      loadingSnapshotSessionsRef.current.delete(requestSessionId)
      if (isCurrentSession()) {
        setIsLoadingSnapshot(false)
      }
    }
  }, [sessionId])

  loadSnapshotRef.current = loadSnapshot

  const attach = useCallback((): Promise<boolean> => {
    return new Promise((resolve) => {
      const socket = socketManager.getSocket()

      if (DEBUG_LOGS) {
        console.log(`[useNormalizedLogs:attach] t=${Date.now()} sessionId=${sessionId} connected=${socket.connected} snapshotLoaded=${snapshotLoadedRef.current}`)
      }

      if (!socket.connected) {
        resolve(false)
        return
      }

      if (snapshotLoadedRef.current) {
        const cached = useSessionLogStore.getState().getConversation(sessionId)
        const shouldRevalidate = isTerminalStatus(sessionStatusRef.current) || cached?.isTruncated === true
        if (!shouldRevalidate) {
          if (DEBUG_LOGS) {
            console.log(`[useNormalizedLogs:attach] skipping loadSnapshot — already have live state`)
          }
          resolve(true)
          return
        }
      }

      loadSnapshot().then(() => resolve(true))
    })
  }, [sessionId, loadSnapshot])

  useEffect(() => {
    if (!sessionId || !isTerminalStatus(sessionStatus)) return
    const timer = window.setTimeout(() => {
      loadSnapshotRef.current?.()
    }, TERMINAL_REVALIDATE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [sessionId, sessionStatus])

  const sendInput = useCallback((data: string) => {
    const socket = socketManager.getSocket()
    socket.emit(ClientEvents.INPUT, { sessionId, data })
  }, [sessionId])

  const clearLogs = useCallback(() => {
    useSessionLogStore.getState().removeSession(sessionId)
    setAgentSessionId(null)
    setIsLoading(false)
    setIsAttached(false)
    snapshotLoadedRef.current = false
    pendingPatchesRef.current[sessionId] = []
  }, [sessionId])

  const logs = useMemo(() => {
    const result = normalizedEntriesToLogEntries(conversation.entries)
    if (isLoading && isAttached) {
      result.push(createCursorEntry())
    }
    return result
  }, [conversation.entries, isLoading, isAttached])

  return {
    isConnected,
    isAttached,
    isLoadingSnapshot,
    logs,
    entries: conversation.entries,
    agentSessionId,
    attach,
    sendInput,
    clearLogs,
  }
}
