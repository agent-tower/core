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
import {
  type NormalizedEntry,
  type LogEntry,
  normalizedEntriesToLogEntries,
  createCursorEntry,
} from '@agent-tower/shared/log-adapter'
import { apiClient } from '../../api-client.js'

// Debug 日志开关
const DEBUG_LOGS = import.meta.env.VITE_DEBUG_LOGS === 'true'

interface NormalizedConversation {
  sessionId?: string
  entries: NormalizedEntry[]
}

interface UseNormalizedLogsOptions {
  sessionId: string
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
 * 标准化日志 Hook
 * 订阅 PATCH 事件并维护标准化日志状态，自动转换为 LogEntry
 */
export function useNormalizedLogs(options: UseNormalizedLogsOptions): UseNormalizedLogsReturn {
  const { sessionId, onAgentSessionId, onExit, onError } = options

  const [isConnected, setIsConnected] = useState(() => socketManager.isConnected())
  const [isAttached, setIsAttached] = useState(false)
  const [isLoadingSnapshot, setIsLoadingSnapshot] = useState(false)
  const [conversation, setConversation] = useState<NormalizedConversation>({ entries: [] })
  const [agentSessionId, setAgentSessionId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  // Guard: true after snapshot is loaded; prevents PATCH from clobbering snapshot
  const snapshotLoadedRef = useRef(false)
  // Buffer: PATCH events received before snapshot completes are queued here
  const pendingPatchesRef = useRef<SessionPatchPayload[]>([])

  // 使用 ref 保存回调
  const callbacksRef = useRef({ onAgentSessionId, onExit, onError })
  callbacksRef.current = { onAgentSessionId, onExit, onError }

  // 连接和事件监听
  useEffect(() => {
    if (!sessionId) return

    const socket = socketManager.getSocket()
    // Sync initial connected state (socket may already be connected from App level)
    setIsConnected(socket.connected)

    const handleConnect = () => setIsConnected(true)
    const handleDisconnect = () => {
      setIsConnected(false)
      setIsAttached(false)
      // 断开后可能丢失 PATCH 事件，下次 re-attach 时需要重新加载 snapshot
      snapshotLoadedRef.current = false
      pendingPatchesRef.current = []
    }

    // 处理 JSON Patch 更新
    let patchCount = 0;
    const applyOnePatch = (prev: NormalizedConversation, patch: Operation[]): NormalizedConversation => {
      const startApply = Date.now();
      const prevCount = prev.entries.length;
      try {
        const patched = applyPatch(
          prev,
          patch,
          true, // validate
          false // mutate (false = immutable; keeps state updater pure)
        )
        const newCount = patched.newDocument.entries.length;
        if (DEBUG_LOGS) {
          console.log(`[useNormalizedLogs:applyPatch] t=${Date.now()} applyTime=${Date.now() - startApply}ms entries=${prevCount}->${newCount} delta=${newCount - prevCount}`);
        }
        return patched.newDocument
      } catch (error) {
        console.error('Failed to apply patch:', error, patch)
        return prev
      }
    }

    const handlePatch = (payload: SessionPatchPayload) => {
      if (payload.sessionId !== sessionId) return

      patchCount++;
      const now = Date.now();
      if (DEBUG_LOGS) {
        // Log each op's path+op to distinguish user_message add from content replace
        const opsSummary = (payload.patch as Array<{op: string; path: string}>)
          .map(o => `${o.op}:${o.path}`)
          .join(', ');
        console.log(`[useNormalizedLogs:handlePatch] t=${now} #${patchCount} sessionId=${sessionId} ops=${payload.patch.length} snapshotLoaded=${snapshotLoadedRef.current} [${opsSummary}]`);
      }

      // If snapshot hasn't loaded yet, buffer the patch
      if (!snapshotLoadedRef.current) {
        pendingPatchesRef.current.push(payload)
        return
      }

      setConversation(prev => applyOnePatch(prev, payload.patch as Operation[]))
      setIsLoading(true)
    }

    // 处理 Agent 内部 session ID
    const handleSessionId = (payload: SessionIdPayload) => {
      if (payload.sessionId !== sessionId) return
      if (DEBUG_LOGS) {
        console.log(`[useNormalizedLogs:handleSessionId] t=${Date.now()} agentSessionId=${payload.agentSessionId}`);
      }
      setAgentSessionId(payload.agentSessionId)
      callbacksRef.current.onAgentSessionId?.(payload.agentSessionId)
    }

    const handleExit = (payload: SessionExitPayload) => {
      if (payload.sessionId !== sessionId) return
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

    // 注册事件监听
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

      // Reset snapshot guard on session change
      snapshotLoadedRef.current = false
      pendingPatchesRef.current = []

      // 清空旧 session 的日志数据，避免切换任务时显示混乱
      setConversation({ entries: [] })
      setAgentSessionId(null)
      setIsLoading(false)

      // Always unsubscribe from the room when the effect is torn down.
      // This avoids leaking room membership when sessionId changes.
      socket.emit(ClientEvents.UNSUBSCRIBE, { topic: 'session', id: sessionId })
    }
  }, [sessionId])

  // Load snapshot from REST API
  const loadSnapshot = useCallback(async () => {
    if (!sessionId) return

    if (DEBUG_LOGS) {
      console.log(`[useNormalizedLogs:loadSnapshot] t=${Date.now()} sessionId=${sessionId} start`);
    }
    setIsLoadingSnapshot(true)

    try {
      // Always fetch latest snapshot; stale HTTP cache can desync patch indexes
      // after task switching and cause subsequent patches to fail applying.
      const snapshot = await apiClient.get<NormalizedConversation>(
        `/sessions/${sessionId}/logs`,
        { cache: 'no-store' }
      )

      if (DEBUG_LOGS) {
        console.log(`[useNormalizedLogs:loadSnapshot] t=${Date.now()} sessionId=${sessionId} entries=${snapshot.entries.length}`);
      }

      // Atomically capture pending buffer and flip the flag so that any
      // patches arriving from this point on go through handlePatch directly
      // instead of being buffered (and then lost).
      const bufferedPatches = pendingPatchesRef.current
      pendingPatchesRef.current = []
      snapshotLoadedRef.current = true

      // Apply snapshot as base state, then replay any buffered patches
      setConversation(() => {
        let state: NormalizedConversation = snapshot
        for (const buffered of bufferedPatches) {
          const startApply = Date.now();
          try {
            const patched = applyPatch(
              state,
              buffered.patch as Operation[],
              true,
              false // immutable replay to avoid mutating captured snapshot/state
            )
            if (DEBUG_LOGS) {
              console.log(`[useNormalizedLogs:loadSnapshot] replay buffered patch, applyTime=${Date.now() - startApply}ms entries=${patched.newDocument.entries.length}`);
            }
            state = patched.newDocument
          } catch (error) {
            console.error('Failed to replay buffered patch:', error)
          }
        }
        return state
      })

      if (snapshot.entries.length > 0) {
        setIsLoading(true)
      }
    } catch (error) {
      console.error('[useNormalizedLogs:loadSnapshot] Failed to load snapshot:', error)
      // On failure, still mark loaded so patches aren't buffered forever
      snapshotLoadedRef.current = true
      pendingPatchesRef.current = []
    } finally {
      setIsLoadingSnapshot(false)
    }
  }, [sessionId])

  // Attach 到终端会话
  const attach = useCallback((): Promise<boolean> => {
    return new Promise((resolve) => {
      const socket = socketManager.getSocket()

      if (DEBUG_LOGS) {
        console.log(`[useNormalizedLogs:attach] t=${Date.now()} sessionId=${sessionId} connected=${socket.connected} snapshotLoaded=${snapshotLoadedRef.current}`);
      }

      if (!socket.connected) {
        resolve(false)
        return
      }

      // 如果 snapshot 已经加载且仍有效，说明是 re-attach（如 reconnect），
      // 不需要重新加载 snapshot，PATCH 事件通过 EventEmitter 持续转发
      if (snapshotLoadedRef.current) {
        if (DEBUG_LOGS) {
          console.log(`[useNormalizedLogs:attach] skipping loadSnapshot — already have live state`);
        }
        // 仍然 emit ATTACH 以确保加入 room
        socket.emit(
          ClientEvents.SUBSCRIBE,
          { topic: 'session', id: sessionId },
          (response: AckResponse) => {
            resolve(response.success)
          }
        )
        return
      }

      const emitTime = Date.now();
      socket.emit(
        ClientEvents.SUBSCRIBE,
        { topic: 'session', id: sessionId },
        (response: AckResponse) => {
          if (DEBUG_LOGS) {
            console.log(`[useNormalizedLogs:attach] t=${Date.now()} ack received, roundtrip=${Date.now() - emitTime}ms success=${response.success}`);
          }

          // 无论 attach 成功或失败，都加载 snapshot
          // 成功：运行中 session，snapshot + 实时 PATCH
          // 失败：已结束 session，从 DB 加载持久化 snapshot
          loadSnapshot()
          resolve(response.success)
        }
      )
    })
  }, [sessionId, loadSnapshot])

  // Detach 从终端会话
  const detach = useCallback(() => {
    const socket = socketManager.getSocket()
    socket.emit(ClientEvents.UNSUBSCRIBE, { topic: 'session', id: sessionId })
  }, [sessionId])

  // 发送输入
  const sendInput = useCallback((data: string) => {
    const socket = socketManager.getSocket()
    socket.emit(ClientEvents.INPUT, { sessionId, data })
  }, [sessionId])

  // 清空日志
  const clearLogs = useCallback(() => {
    setConversation({ entries: [] })
    setAgentSessionId(null)
    setIsLoading(false)
    snapshotLoadedRef.current = false
    pendingPatchesRef.current = []
  }, [])

  // 转换为 LogEntry 格式（useMemo 避免每次 render 重算）
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
