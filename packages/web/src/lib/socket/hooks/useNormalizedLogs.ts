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
const SNAPSHOT_RETRY_DELAYS_MS = [250, 1000, 3000] as const
const SNAPSHOT_BACKGROUND_RETRY_MS = 10_000

interface SnapshotRequest {
  controller: AbortController
  epoch: number
  promise: Promise<boolean>
  reloadRequested: boolean
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function isRetryableSnapshotError(error: unknown): boolean {
  if (isAbortError(error)) return false
  const status = typeof error === 'object' && error !== null && 'status' in error
    ? (error as { status?: unknown }).status
    : undefined
  if (typeof status !== 'number') return true
  return status === 408 || status === 429 || status >= 500
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false)
      return
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', handleAbort)
      resolve(true)
    }, delayMs)
    const handleAbort = () => {
      window.clearTimeout(timer)
      resolve(false)
    }
    signal.addEventListener('abort', handleAbort, { once: true })
  })
}

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
  const loadSnapshotRef = useRef<(() => Promise<boolean>) | null>(null)
  const snapshotRequestsRef = useRef<Map<string, SnapshotRequest>>(new Map())
  const snapshotRetryTimersRef = useRef<Map<string, number>>(new Map())
  const connectionEpochRef = useRef(0)
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
    const pendingPatches = pendingPatchesRef.current
    const snapshotRequests = snapshotRequestsRef.current
    const snapshotRetryTimers = snapshotRetryTimersRef.current
    setIsConnected(socket.connected)

    // Capture whether this session is active at effect creation time.
    // Updated by handleExit so cleanup knows the correct state.
    let isActive = !isTerminalStatus(sessionStatus)

    const handleConnect = () => {
      connectionEpochRef.current += 1
      setIsConnected(true)
      // Patches emitted while the socket was disconnected cannot be replayed.
      // Reconcile with the server before accepting the new live stream.
      void loadSnapshotRef.current?.()
    }
    const handleDisconnect = () => {
      connectionEpochRef.current += 1
      setIsConnected(false)
      setIsAttached(false)
      snapshotLoadedRef.current = false
      pendingPatches[sessionId] = []
      snapshotRequests.get(sessionId)?.controller.abort()
      const retryTimer = snapshotRetryTimers.get(sessionId)
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer)
        snapshotRetryTimers.delete(sessionId)
      }
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
        pendingPatches[sessionId] = [
          ...(pendingPatches[sessionId] ?? []),
          payload,
        ]
        void loadSnapshotRef.current?.()
        return
      }

      const store = useSessionLogStore.getState()
      const ok = store.applyPatch(sessionId, payload.patch as Operation[], payload.seq)
      if (!ok) {
        // Patch apply failed — store drifted from server. Reset snapshot
        // state and refetch authoritative state. Buffer subsequent patches
        // until reload completes.
        snapshotLoadedRef.current = false
        pendingPatches[sessionId] = []
        void loadSnapshotRef.current?.()
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

      connectionEpochRef.current += 1
      snapshotRequests.get(sessionId)?.controller.abort()
      const retryTimer = snapshotRetryTimers.get(sessionId)
      if (retryTimer !== undefined) {
        window.clearTimeout(retryTimer)
        snapshotRetryTimers.delete(sessionId)
      }
      snapshotLoadedRef.current = false
      pendingPatches[sessionId] = []
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
  const loadSnapshot = useCallback((): Promise<boolean> => {
    if (!sessionId) return Promise.resolve(false)
    const requestSessionId = sessionId
    const requestEpoch = connectionEpochRef.current
    const isCurrentSession = () => currentSessionIdRef.current === requestSessionId
    const existing = snapshotRequestsRef.current.get(requestSessionId)

    if (existing) {
      // A reconnect invalidates a request started for the previous connection.
      // Ordinary concurrent attach() calls share the same request unchanged.
      if (existing.epoch !== requestEpoch) {
        existing.reloadRequested = true
        existing.controller.abort()
      }
      return existing.promise
    }

    const scheduledRetry = snapshotRetryTimersRef.current.get(requestSessionId)
    if (scheduledRetry !== undefined) {
      window.clearTimeout(scheduledRetry)
      snapshotRetryTimersRef.current.delete(requestSessionId)
    }

    const controller = new AbortController()
    const request: SnapshotRequest = {
      controller,
      epoch: requestEpoch,
      promise: Promise.resolve(false),
      reloadRequested: false,
    }

    const run = async (): Promise<boolean> => {
      const store = useSessionLogStore.getState()
      const cached = store.conversations[requestSessionId]

      if (DEBUG_LOGS) {
        console.log(`[useNormalizedLogs:loadSnapshot] t=${Date.now()} sessionId=${requestSessionId} start epoch=${request.epoch}`)
      }

      if (cached && cached.entries.length > 0) {
        if (DEBUG_LOGS) {
          console.log(`[useNormalizedLogs:loadSnapshot] using cached session, entries=${cached.entries.length} seq=${conversationSeq(cached)} truncated=${cached.isTruncated === true}`)
        }
        store.touchAccess(requestSessionId)
        if (isCurrentSession()) {
          setIsLoading(shouldShowOutputCursor(sessionStatusRef.current))
        }
      }

      if (isCurrentSession()) {
        snapshotLoadedRef.current = false
        setIsAttached(false)
      }

      const hasStaleData = cached && cached.entries.length > 0
      if (!hasStaleData && isCurrentSession()) {
        setIsLoadingSnapshot(true)
      }

      for (let attempt = 0; attempt <= SNAPSHOT_RETRY_DELAYS_MS.length; attempt += 1) {
        const socket = socketManager.getSocket()
        if (
          controller.signal.aborted ||
          !socket.connected ||
          !isCurrentSession() ||
          request.epoch !== connectionEpochRef.current
        ) {
          return false
        }

        // The next authoritative snapshot includes every patch received before
        // this request. Only patches racing with this request need buffering.
        pendingPatchesRef.current[requestSessionId] = []

        try {
          const serverSnapshot = normalizeServerConversation(
            await apiClient.get<NormalizedConversation>(
              `/sessions/${requestSessionId}/logs`,
              { cache: 'no-store', signal: controller.signal },
            ),
          )

          if (
            controller.signal.aborted ||
            !socket.connected ||
            !isCurrentSession() ||
            request.epoch !== connectionEpochRef.current
          ) {
            request.reloadRequested = socket.connected && isCurrentSession()
            return false
          }

          if (DEBUG_LOGS) {
            console.log(
              `[useNormalizedLogs:loadSnapshot] t=${Date.now()} sessionId=${requestSessionId} fetched entries=${serverSnapshot.entries.length} seq=${conversationSeq(serverSnapshot)} epoch=${request.epoch}`,
            )
          }

          const buffered = pendingPatchesRef.current[requestSessionId] ?? []
          pendingPatchesRef.current[requestSessionId] = []
          let state: NormalizedConversation = serverSnapshot
          const snapshotSeq = conversationSeq(serverSnapshot)
          let highestSeq = snapshotSeq

          for (const p of buffered) {
            if (typeof p.seq === 'number') {
              if (p.seq <= highestSeq) continue
              if (p.seq !== highestSeq + 1) {
                throw new Error(
                  `Buffered patch sequence gap: expected ${highestSeq + 1}, received ${p.seq}`,
                )
              }
            }
            const patched = applyPatch(
              state,
              p.patch as Operation[],
              true,
              false,
            )
            state = patched.newDocument
            if (typeof p.seq === 'number' && p.seq > highestSeq) highestSeq = p.seq
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
            snapshotLoadedRef.current = true
            setIsAttached(true)
            const latest = useSessionLogStore.getState().getConversation(requestSessionId)
            if (latest && latest.entries.length > 0) {
              setIsLoading(shouldShowOutputCursor(sessionStatusRef.current))
            }
          }
          return true
        } catch (error) {
          if (controller.signal.aborted || isAbortError(error)) return false
          if (
            !isCurrentSession() ||
            request.epoch !== connectionEpochRef.current ||
            !socket.connected
          ) {
            request.reloadRequested = socket.connected && isCurrentSession()
            return false
          }

          console.error('[useNormalizedLogs:loadSnapshot] Failed to reconcile snapshot:', error)
          pendingPatchesRef.current[requestSessionId] = []
          snapshotLoadedRef.current = false
          setIsAttached(false)
          setIsLoading(false)

          if (!isRetryableSnapshotError(error)) return false
          const retryDelay = SNAPSHOT_RETRY_DELAYS_MS[attempt]
          if (retryDelay === undefined) {
            const retryEpoch = request.epoch
            const timer = window.setTimeout(() => {
              snapshotRetryTimersRef.current.delete(requestSessionId)
              if (
                currentSessionIdRef.current === requestSessionId &&
                connectionEpochRef.current === retryEpoch &&
                socketManager.getSocket().connected
              ) {
                void loadSnapshotRef.current?.()
              }
            }, SNAPSHOT_BACKGROUND_RETRY_MS)
            snapshotRetryTimersRef.current.set(requestSessionId, timer)
            return false
          }

          const shouldRetry = await waitForRetry(retryDelay, controller.signal)
          if (!shouldRetry) return false
        }
      }

      return false
    }

    const promise = run().finally(() => {
      if (snapshotRequestsRef.current.get(requestSessionId) === request) {
        snapshotRequestsRef.current.delete(requestSessionId)
      }
      if (
        request.reloadRequested &&
        currentSessionIdRef.current === requestSessionId &&
        socketManager.getSocket().connected
      ) {
        queueMicrotask(() => {
          void loadSnapshotRef.current?.()
        })
      }
      if (currentSessionIdRef.current === requestSessionId) {
        setIsLoadingSnapshot(false)
      }
    })
    request.promise = promise
    snapshotRequestsRef.current.set(requestSessionId, request)
    return promise
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

      loadSnapshot().then(resolve)
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
