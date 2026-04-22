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
  type AckResponse,
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
  type NormalizedConversation,
} from '@/stores/session-log-store.js'
import { backgroundSync } from './background-session-sync.js'

const DEBUG_LOGS = import.meta.env.VITE_DEBUG_LOGS === 'true'

function isTerminalStatus(status?: SessionStatus | string): boolean {
  return status === SessionStatus.COMPLETED
    || status === SessionStatus.FAILED
    || status === SessionStatus.CANCELLED
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
  detach: () => void
  sendInput: (data: string) => void
  clearLogs: () => void
}

/**
 * Normalized log stream hook.
 *
 * Manages WebSocket subscription for a session and stores conversation
 * data in the global Zustand sessionLogStore so it persists across
 * task switches. For RUNNING sessions that are switched away from,
 * a BackgroundSessionSync keeps the store up-to-date via PATCH events.
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
  const pendingPatchesRef = useRef<SessionPatchPayload[]>([])
  const loadSnapshotRef = useRef<(() => Promise<void>) | null>(null)

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

    // If background sync is already keeping the store fresh, take over
    // BEFORE registering our own handlers — otherwise both handlers would
    // receive the same PATCH and double-apply it (store drift → eventual
    // applyPatch validation failure → silent freeze).
    if (backgroundSync.isSyncing(sessionId)) {
      backgroundSync.stopSync(sessionId, true)
      snapshotLoadedRef.current = true
    }

    const handleConnect = () => setIsConnected(true)
    const handleDisconnect = () => {
      setIsConnected(false)
      setIsAttached(false)
      snapshotLoadedRef.current = false
      pendingPatchesRef.current = []
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
        pendingPatchesRef.current.push(payload)
        return
      }

      const store = useSessionLogStore.getState()
      const ok = store.applyPatch(sessionId, payload.patch as Operation[])
      if (!ok) {
        // Patch apply failed — store drifted from server. Reset snapshot
        // state and refetch authoritative state. Buffer subsequent patches
        // until reload completes.
        snapshotLoadedRef.current = false
        pendingPatchesRef.current = []
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

    const handleAttached = (payload: { sessionId: string }) => {
      if (payload.sessionId !== sessionId) return
      setIsAttached(true)
    }

    const handleDetached = (payload: { sessionId: string }) => {
      if (payload.sessionId !== sessionId) return
      setIsAttached(false)
    }

    socket.on('connect', handleConnect)
    socket.on('disconnect', handleDisconnect)
    socket.on(ServerEvents.SESSION_PATCH, handlePatch)
    socket.on(ServerEvents.SESSION_ID, handleSessionId)
    socket.on(ServerEvents.SESSION_EXIT, handleExit)
    socket.on(ServerEvents.SESSION_ERROR, handleError)
    socket.on(ServerEvents.SESSION_SUBSCRIBED, handleAttached)
    socket.on(ServerEvents.SESSION_UNSUBSCRIBED, handleDetached)

    setIsConnected(socket.connected)

    return () => {
      socket.off('connect', handleConnect)
      socket.off('disconnect', handleDisconnect)
      socket.off(ServerEvents.SESSION_PATCH, handlePatch)
      socket.off(ServerEvents.SESSION_ID, handleSessionId)
      socket.off(ServerEvents.SESSION_EXIT, handleExit)
      socket.off(ServerEvents.SESSION_ERROR, handleError)
      socket.off(ServerEvents.SESSION_SUBSCRIBED, handleAttached)
      socket.off(ServerEvents.SESSION_UNSUBSCRIBED, handleDetached)

      snapshotLoadedRef.current = false
      pendingPatchesRef.current = []
      setAgentSessionId(null)
      setIsLoading(false)

      if (isActive) {
        // RUNNING session: hand off to background sync (keeps room subscription)
        backgroundSync.startSync(sessionId)
      } else {
        // Terminal session: truncate to save memory, unsubscribe from room
        useSessionLogStore.getState().truncateSession(sessionId)
        socket.emit(ClientEvents.UNSUBSCRIBE, { topic: 'session', id: sessionId })
      }
    }
  // sessionStatus intentionally excluded — captured via isActive flag inside the effect
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Load snapshot: check store/background-sync cache first, then fall back to HTTP
  const loadSnapshot = useCallback(async () => {
    if (!sessionId) return

    if (DEBUG_LOGS) {
      console.log(`[useNormalizedLogs:loadSnapshot] t=${Date.now()} sessionId=${sessionId} start`)
    }

    const store = useSessionLogStore.getState()

    // Case 1: Background sync was keeping store fresh — take over seamlessly.
    // Effect already called stopSync + set snapshotLoadedRef at mount, so
    // this branch only fires if attach() runs before the effect (rare) or
    // loadSnapshot is invoked manually. No pending buffer to replay — if
    // patches arrived before takeover they went to bg handler only.
    if (backgroundSync.isSyncing(sessionId)) {
      backgroundSync.stopSync(sessionId, true) // keep room, remove bg handler

      snapshotLoadedRef.current = true
      pendingPatchesRef.current = []

      if (DEBUG_LOGS) {
        console.log(`[useNormalizedLogs:loadSnapshot] took over from backgroundSync, entries=${store.conversations[sessionId]?.entries.length ?? 0}`)
      }

      if (store.conversations[sessionId]?.entries.length) {
        setIsLoading(true)
      }
      return
    }

    // Case 2: Store has data for a terminal session — cache is authoritative
    const cached = store.conversations[sessionId]
    if (cached && cached.entries.length > 0 && isTerminalStatus(sessionStatusRef.current)) {
      if (DEBUG_LOGS) {
        console.log(`[useNormalizedLogs:loadSnapshot] using cached terminal session, entries=${cached.entries.length}`)
      }
      store.touchAccess(sessionId)
      snapshotLoadedRef.current = true
      pendingPatchesRef.current = []
      setIsLoading(true)
      return
    }

    // Case 3: Fetch from server
    // Only show loading spinner if store has no data at all
    const hasStaleData = cached && cached.entries.length > 0
    if (!hasStaleData) {
      setIsLoadingSnapshot(true)
    }

    try {
      const snapshot = await apiClient.get<NormalizedConversation>(
        `/sessions/${sessionId}/logs`,
        { cache: 'no-store' },
      )

      if (DEBUG_LOGS) {
        console.log(`[useNormalizedLogs:loadSnapshot] t=${Date.now()} sessionId=${sessionId} fetched entries=${snapshot.entries.length}`)
      }

      const buffered = pendingPatchesRef.current
      pendingPatchesRef.current = []
      snapshotLoadedRef.current = true

      let state: NormalizedConversation = snapshot
      for (const p of buffered) {
        try {
          const patched = applyPatch(
            state,
            p.patch as Operation[],
            true,
            false,
          )
          state = patched.newDocument
        } catch (error) {
          console.error('Failed to replay buffered patch:', error)
        }
      }

      store.setConversation(sessionId, state)

      if (state.entries.length > 0) {
        setIsLoading(true)
      }
    } catch (error) {
      console.error('[useNormalizedLogs:loadSnapshot] Failed to load snapshot:', error)
      snapshotLoadedRef.current = true
      pendingPatchesRef.current = []
    } finally {
      setIsLoadingSnapshot(false)
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
        if (DEBUG_LOGS) {
          console.log(`[useNormalizedLogs:attach] skipping loadSnapshot — already have live state`)
        }
        socket.emit(
          ClientEvents.SUBSCRIBE,
          { topic: 'session', id: sessionId },
          (response: AckResponse) => {
            resolve(response.success)
          },
        )
        return
      }

      const emitTime = Date.now()
      socket.emit(
        ClientEvents.SUBSCRIBE,
        { topic: 'session', id: sessionId },
        (response: AckResponse) => {
          if (DEBUG_LOGS) {
            console.log(`[useNormalizedLogs:attach] t=${Date.now()} ack received, roundtrip=${Date.now() - emitTime}ms success=${response.success}`)
          }
          loadSnapshot()
          resolve(response.success)
        },
      )
    })
  }, [sessionId, loadSnapshot])

  const detach = useCallback(() => {
    const socket = socketManager.getSocket()
    socket.emit(ClientEvents.UNSUBSCRIBE, { topic: 'session', id: sessionId })
  }, [sessionId])

  const sendInput = useCallback((data: string) => {
    const socket = socketManager.getSocket()
    socket.emit(ClientEvents.INPUT, { sessionId, data })
  }, [sessionId])

  const clearLogs = useCallback(() => {
    useSessionLogStore.getState().removeSession(sessionId)
    setAgentSessionId(null)
    setIsLoading(false)
    snapshotLoadedRef.current = false
    pendingPatchesRef.current = []
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
    detach,
    sendInput,
    clearLogs,
  }
}
