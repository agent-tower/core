import { useEffect, useRef, useCallback, useState } from 'react'
import { socketManager } from '../manager.js'
import {
  TerminalClientEvents,
  TerminalServerEvents,
  type TerminalOutputPayload,
  type TerminalExitPayload,
  type TerminalErrorPayload,
  type AckResponse,
} from '@agent-tower/shared/socket'

interface UseTerminalOptions {
  sessionId: string
  onOutput?: (data: string) => void
  onExit?: (exitCode: number) => void
  onError?: (message: string) => void
}

interface UseTerminalReturn {
  isConnected: boolean
  isAttached: boolean
  attach: () => Promise<boolean>
  detach: () => void
  sendInput: (data: string) => void
  resize: (cols: number, rows: number) => void
}

/**
 * 终端 Socket 连接 Hook
 * 管理与特定终端会话的连接
 */
export function useTerminal(options: UseTerminalOptions): UseTerminalReturn {
  const { sessionId, onOutput, onExit, onError } = options

  const [isConnected, setIsConnected] = useState(false)
  const [isAttached, setIsAttached] = useState(false)

  // 使用 ref 保存回调，避免重复订阅
  const callbacksRef = useRef({ onOutput, onExit, onError })
  callbacksRef.current = { onOutput, onExit, onError }

  // 连接和事件监听
  useEffect(() => {
    const socket = socketManager.connect('TERMINAL')

    // 连接状态
    const handleConnect = () => setIsConnected(true)
    const handleDisconnect = () => {
      setIsConnected(false)
      setIsAttached(false)
    }

    // 终端事件
    const handleOutput = (payload: TerminalOutputPayload) => {
      if (payload.sessionId === sessionId) {
        callbacksRef.current.onOutput?.(payload.data)
      }
    }

    const handleExit = (payload: TerminalExitPayload) => {
      if (payload.sessionId === sessionId) {
        setIsAttached(false)
        callbacksRef.current.onExit?.(payload.exitCode)
      }
    }

    const handleError = (payload: TerminalErrorPayload) => {
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
    socket.on(TerminalServerEvents.OUTPUT, handleOutput)
    socket.on(TerminalServerEvents.EXIT, handleExit)
    socket.on(TerminalServerEvents.ERROR, handleError)
    socket.on(TerminalServerEvents.ATTACHED, handleAttached)
    socket.on(TerminalServerEvents.DETACHED, handleDetached)

    // 初始状态
    setIsConnected(socket.connected)

    // 清理
    return () => {
      socket.off('connect', handleConnect)
      socket.off('disconnect', handleDisconnect)
      socket.off(TerminalServerEvents.OUTPUT, handleOutput)
      socket.off(TerminalServerEvents.EXIT, handleExit)
      socket.off(TerminalServerEvents.ERROR, handleError)
      socket.off(TerminalServerEvents.ATTACHED, handleAttached)
      socket.off(TerminalServerEvents.DETACHED, handleDetached)

      // 如果已 attach，自动 detach
      if (isAttached) {
        socket.emit(TerminalClientEvents.DETACH, { sessionId })
      }
    }
  }, [sessionId])

  // Attach 到终端会话
  const attach = useCallback((): Promise<boolean> => {
    return new Promise((resolve) => {
      const socket = socketManager.getSocket('TERMINAL')

      if (!socket.connected) {
        resolve(false)
        return
      }

      socket.emit(
        TerminalClientEvents.ATTACH,
        { sessionId },
        (response: AckResponse) => {
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

  // 调整终端大小
  const resize = useCallback((cols: number, rows: number) => {
    const socket = socketManager.getSocket('TERMINAL')
    socket.emit(TerminalClientEvents.RESIZE, { sessionId, cols, rows })
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
