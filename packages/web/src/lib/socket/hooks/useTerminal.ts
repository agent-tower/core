import { useEffect, useRef, useCallback, useState } from 'react'
import { socketManager } from '../manager.js'
import {
  ClientEvents,
  ServerEvents,
  type SessionStdoutPayload,
  type SessionExitPayload,
  type SessionErrorPayload,
  type AckResponse,
} from '@agent-tower/shared/socket'

// ============================================================
// Shared types
// ============================================================

interface UseTerminalOptions {
  sessionId: string
  onOutput?: (data: string) => void
  onExit?: (exitCode: number) => void
  onError?: (message: string) => void
}

export interface UseTerminalReturn {
  isConnected: boolean
  isAttached: boolean
  attach: () => Promise<boolean>
  detach: () => void
  sendInput: (data: string) => void
  resize: (cols: number, rows: number) => void
}

// ============================================================
// useTerminal — 连接单个终端实例
// ============================================================

/**
 * 终端 Socket 连接 Hook
 * 管理与特定终端会话的连接
 *
 * 统一 Socket 流上的 session 终端 hook。
 */
export function useTerminal(options: UseTerminalOptions): UseTerminalReturn {
  const { sessionId, onOutput, onExit, onError } = options

  const [isConnected, setIsConnected] = useState(() => socketManager.isConnected())
  const [isAttached, setIsAttached] = useState(false)

  // 使用 ref 保存回调，避免重复订阅
  const callbacksRef = useRef({ onOutput, onExit, onError })
  callbacksRef.current = { onOutput, onExit, onError }

  // 连接和事件监听
  useEffect(() => {
    const socket = socketManager.getSocket()
    // Sync initial connected state (socket may already be connected from App level)
    setIsConnected(socket.connected)

    // 连接状态
    const handleConnect = () => setIsConnected(true)
    const handleDisconnect = () => {
      setIsConnected(false)
      setIsAttached(false)
    }

    // 终端事件
    const handleOutput = (payload: SessionStdoutPayload) => {
      if (payload.sessionId === sessionId) {
        callbacksRef.current.onOutput?.(payload.data)
      }
    }

    const handleExit = (payload: SessionExitPayload) => {
      if (payload.sessionId === sessionId) {
        setIsAttached(false)
        callbacksRef.current.onExit?.(payload.exitCode)
      }
    }

    const handleError = (payload: SessionErrorPayload) => {
      if (payload.sessionId === sessionId) {
        callbacksRef.current.onError?.(payload.message)
      }
    }

    const handleAttached = (payload: { sessionId: string }) => {
      if (payload.sessionId === sessionId) {
        setIsAttached(true)
      }
    }

    const handleDetached = (payload: { sessionId: string }) => {
      if (payload.sessionId === sessionId) {
        setIsAttached(false)
      }
    }

    // 注册事件监听
    socket.on('connect', handleConnect)
    socket.on('disconnect', handleDisconnect)
    socket.on(ServerEvents.SESSION_STDOUT, handleOutput)
    socket.on(ServerEvents.SESSION_EXIT, handleExit)
    socket.on(ServerEvents.SESSION_ERROR, handleError)
    socket.on(ServerEvents.SESSION_SUBSCRIBED, handleAttached)
    socket.on(ServerEvents.SESSION_UNSUBSCRIBED, handleDetached)

    // 初始状态
    setIsConnected(socket.connected)

    // 清理
    return () => {
      socket.off('connect', handleConnect)
      socket.off('disconnect', handleDisconnect)
      socket.off(ServerEvents.SESSION_STDOUT, handleOutput)
      socket.off(ServerEvents.SESSION_EXIT, handleExit)
      socket.off(ServerEvents.SESSION_ERROR, handleError)
      socket.off(ServerEvents.SESSION_SUBSCRIBED, handleAttached)
      socket.off(ServerEvents.SESSION_UNSUBSCRIBED, handleDetached)

      socket.emit(ClientEvents.UNSUBSCRIBE, { topic: 'session', id: sessionId })
    }
  }, [sessionId])

  // Attach 到终端会话
  const attach = useCallback((): Promise<boolean> => {
    return new Promise((resolve) => {
      const socket = socketManager.getSocket()

      if (!socket.connected) {
        resolve(false)
        return
      }

      socket.emit(
        ClientEvents.SUBSCRIBE,
        { topic: 'session', id: sessionId },
        (response: AckResponse) => {
          resolve(response.success)
        }
      )
    })
  }, [sessionId])

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

  // 调整终端大小
  const resize = useCallback((cols: number, rows: number) => {
    const socket = socketManager.getSocket()
    socket.emit(ClientEvents.RESIZE, { sessionId, cols, rows })
  }, [sessionId])

  return {
    isConnected,
    isAttached,
    attach,
    detach,
    sendInput,
    resize,
  }
}
