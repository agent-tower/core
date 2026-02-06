import { useEffect, useRef, useCallback, useState } from 'react'
import { applyPatch, type Operation } from 'fast-json-patch'
import { socketManager } from '../manager.js'
import {
  TerminalClientEvents,
  TerminalServerEvents,
  type TerminalPatchPayload,
  type TerminalSessionIdPayload,
  type TerminalExitPayload,
  type TerminalErrorPayload,
  type AckResponse,
} from '@agent-tower/shared/socket'
import {
  type NormalizedEntry,
  type LogEntry,
  normalizedEntriesToLogEntries,
  createCursorEntry,
} from '@agent-tower/shared/log-adapter'

// Debug 日志开关
const DEBUG_LOGS = true;

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

  const [isConnected, setIsConnected] = useState(false)
  const [isAttached, setIsAttached] = useState(false)
  const [conversation, setConversation] = useState<NormalizedConversation>({ entries: [] })
  const [agentSessionId, setAgentSessionId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  // 使用 ref 保存回调
  const callbacksRef = useRef({ onAgentSessionId, onExit, onError })
  callbacksRef.current = { onAgentSessionId, onExit, onError }

  // 连接和事件监听
  useEffect(() => {
    if (!sessionId) return

    const socket = socketManager.connect('TERMINAL')

    const handleConnect = () => setIsConnected(true)
    const handleDisconnect = () => {
      setIsConnected(false)
      setIsAttached(false)
    }

    // 处理 JSON Patch 更新
    let patchCount = 0;
    const handlePatch = (payload: TerminalPatchPayload) => {
      if (payload.sessionId !== sessionId) return

      patchCount++;
      const now = Date.now();
      if (DEBUG_LOGS) {
        console.log(`[useNormalizedLogs:handlePatch] t=${now} #${patchCount} sessionId=${sessionId} ops=${payload.patch.length}`);
      }

      setConversation(prev => {
        const startApply = Date.now();
        try {
          const patched = applyPatch(
            prev,
            payload.patch as Operation[],
            true, // validate
            false // mutate (false = immutable)
          )
          if (DEBUG_LOGS) {
            console.log(`[useNormalizedLogs:handlePatch] t=${Date.now()} applyTime=${Date.now() - startApply}ms entries=${patched.newDocument.entries.length}`);
          }
          return patched.newDocument
        } catch (error) {
          console.error('Failed to apply patch:', error, payload.patch)
          return prev
        }
      })
      setIsLoading(true)
    }

    // 处理 Agent 内部 session ID
    const handleSessionId = (payload: TerminalSessionIdPayload) => {
      if (payload.sessionId !== sessionId) return
      if (DEBUG_LOGS) {
        console.log(`[useNormalizedLogs:handleSessionId] t=${Date.now()} agentSessionId=${payload.agentSessionId}`);
      }
      setAgentSessionId(payload.agentSessionId)
      callbacksRef.current.onAgentSessionId?.(payload.agentSessionId)
    }

    const handleExit = (payload: TerminalExitPayload) => {
      if (payload.sessionId !== sessionId) return
      setIsAttached(false)
      setIsLoading(false)
      callbacksRef.current.onExit?.(payload.exitCode)
    }

    const handleError = (payload: TerminalErrorPayload) => {
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
    socket.on(TerminalServerEvents.PATCH, handlePatch)
    socket.on(TerminalServerEvents.SESSION_ID, handleSessionId)
    socket.on(TerminalServerEvents.EXIT, handleExit)
    socket.on(TerminalServerEvents.ERROR, handleError)
    socket.on(TerminalServerEvents.ATTACHED, handleAttached)
    socket.on(TerminalServerEvents.DETACHED, handleDetached)

    setIsConnected(socket.connected)

    return () => {
      socket.off('connect', handleConnect)
      socket.off('disconnect', handleDisconnect)
      socket.off(TerminalServerEvents.PATCH, handlePatch)
      socket.off(TerminalServerEvents.SESSION_ID, handleSessionId)
      socket.off(TerminalServerEvents.EXIT, handleExit)
      socket.off(TerminalServerEvents.ERROR, handleError)
      socket.off(TerminalServerEvents.ATTACHED, handleAttached)
      socket.off(TerminalServerEvents.DETACHED, handleDetached)

      if (isAttached) {
        socket.emit(TerminalClientEvents.DETACH, { sessionId })
      }
    }
  }, [sessionId])

  // Attach 到终端会话
  const attach = useCallback((): Promise<boolean> => {
    return new Promise((resolve) => {
      const socket = socketManager.getSocket('TERMINAL')

      if (DEBUG_LOGS) {
        console.log(`[useNormalizedLogs:attach] t=${Date.now()} sessionId=${sessionId} connected=${socket.connected}`);
      }

      if (!socket.connected) {
        resolve(false)
        return
      }

      const emitTime = Date.now();
      socket.emit(
        TerminalClientEvents.ATTACH,
        { sessionId },
        (response: AckResponse) => {
          if (DEBUG_LOGS) {
            console.log(`[useNormalizedLogs:attach] t=${Date.now()} ack received, roundtrip=${Date.now() - emitTime}ms success=${response.success}`);
          }
          resolve(response.success)
        }
      )
    })
  }, [sessionId])

  // Detach 从终端会话
  const detach = useCallback(() => {
    const socket = socketManager.getSocket('TERMINAL')
    socket.emit(TerminalClientEvents.DETACH, { sessionId })
  }, [sessionId])

  // 发送输入
  const sendInput = useCallback((data: string) => {
    const socket = socketManager.getSocket('TERMINAL')
    socket.emit(TerminalClientEvents.INPUT, { sessionId, data })
  }, [sessionId])

  // 清空日志
  const clearLogs = useCallback(() => {
    setConversation({ entries: [] })
    setAgentSessionId(null)
    setIsLoading(false)
  }, [])

  // 转换为 LogEntry 格式
  const logs = normalizedEntriesToLogEntries(conversation.entries)

  // 如果正在加载，添加 cursor
  if (isLoading && isAttached) {
    logs.push(createCursorEntry())
  }

  return {
    isConnected,
    isAttached,
    logs,
    entries: conversation.entries,
    agentSessionId,
    attach,
    detach,
    sendInput,
    clearLogs,
  }
}
