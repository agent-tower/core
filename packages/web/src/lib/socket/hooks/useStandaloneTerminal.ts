import { useEffect, useRef, useCallback, useState } from 'react'
import { socketManager } from '../manager.js'
import { apiClient } from '@/lib/api-client'
import {
  ClientEvents,
  ServerEvents,
  type TerminalStdoutPayload,
  type TerminalExitPayload,
  type AckResponse,
} from '@agent-tower/shared/socket'

// ============================================================
// Types
// ============================================================

interface UseStandaloneTerminalOptions {
  /** Working directory for the terminal */
  cwd?: string
  /** Initial terminal size */
  cols?: number
  rows?: number
  /** Called when PTY writes to stdout */
  onOutput?: (data: string) => void
  /** Called when the PTY process exits */
  onExit?: (exitCode: number) => void
}

export interface UseStandaloneTerminalReturn {
  /** The terminal ID (null if not yet created) */
  terminalId: string | null
  /** Whether the socket is connected */
  isConnected: boolean
  /** Whether we're subscribed to this terminal's events */
  isAttached: boolean
  /** Whether the terminal is being created */
  isCreating: boolean
  /** Whether the terminal needs to be recreated after a reconnect */
  needsRecreate: boolean
  /** Create a new terminal and subscribe to its events */
  create: () => Promise<string | null>
  /** Destroy the terminal */
  destroy: () => Promise<void>
  /** Send input to the terminal */
  sendInput: (data: string) => void
  /** Resize the terminal */
  resize: (cols: number, rows: number) => void
}

// ============================================================
// useStandaloneTerminal
// ============================================================

/**
 * Hook for managing a standalone interactive terminal.
 * Handles creation, socket subscription, I/O, and cleanup.
 */
export function useStandaloneTerminal(
  options: UseStandaloneTerminalOptions = {}
): UseStandaloneTerminalReturn {
  const { cwd, cols, rows, onOutput, onExit } = options

  const [terminalId, setTerminalId] = useState<string | null>(null)
  const [isConnected, setIsConnected] = useState(() => socketManager.isConnected())
  const [isAttached, setIsAttached] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [needsRecreate, setNeedsRecreate] = useState(false)

  // Stable refs for callbacks
  const callbacksRef = useRef({ onOutput, onExit })
  callbacksRef.current = { onOutput, onExit }

  // Ref to track the current terminal ID for cleanup
  const terminalIdRef = useRef<string | null>(null)
  terminalIdRef.current = terminalId

  // --------------------------------------------------------
  // Socket event listeners
  // --------------------------------------------------------
  useEffect(() => {
    if (!terminalId) return

    const socket = socketManager.getSocket()

    const handleConnect = () => {
      setIsConnected(true)
      // After a reconnect the server has already destroyed our terminal
      // (cleanupBySocket runs on disconnect). Signal that a new terminal
      // needs to be created instead of removing the tab via onExit.
      setIsAttached(false)
      setTerminalId(null)
      setNeedsRecreate(true)
    }
    const handleDisconnect = () => {
      setIsConnected(false)
      setIsAttached(false)
    }

    const handleOutput = (payload: TerminalStdoutPayload) => {
      if (payload.terminalId === terminalId) {
        callbacksRef.current.onOutput?.(payload.data)
      }
    }

    const handleExit = (payload: TerminalExitPayload) => {
      if (payload.terminalId === terminalId) {
        setIsAttached(false)
        callbacksRef.current.onExit?.(payload.exitCode)
        setTerminalId(null)
      }
    }

    const handleSubscribed = (payload: { terminalId: string }) => {
      if (payload.terminalId === terminalId) {
        setIsAttached(true)
      }
    }

    const handleUnsubscribed = (payload: { terminalId: string }) => {
      if (payload.terminalId === terminalId) {
        setIsAttached(false)
      }
    }

    socket.on('connect', handleConnect)
    socket.on('disconnect', handleDisconnect)
    socket.on(ServerEvents.TERMINAL_STDOUT, handleOutput)
    socket.on(ServerEvents.TERMINAL_EXIT, handleExit)
    socket.on(ServerEvents.TERMINAL_SUBSCRIBED, handleSubscribed)
    socket.on(ServerEvents.TERMINAL_UNSUBSCRIBED, handleUnsubscribed)

    setIsConnected(socket.connected)

    // Auto-subscribe to the terminal room
    if (socket.connected) {
      socket.emit(
        ClientEvents.SUBSCRIBE,
        { topic: 'terminal', id: terminalId },
        (response: AckResponse) => {
          if (response.success) setIsAttached(true)
        }
      )
    }

    return () => {
      socket.off('connect', handleConnect)
      socket.off('disconnect', handleDisconnect)
      socket.off(ServerEvents.TERMINAL_STDOUT, handleOutput)
      socket.off(ServerEvents.TERMINAL_EXIT, handleExit)
      socket.off(ServerEvents.TERMINAL_SUBSCRIBED, handleSubscribed)
      socket.off(ServerEvents.TERMINAL_UNSUBSCRIBED, handleUnsubscribed)

      // Unsubscribe from the room
      socket.emit(ClientEvents.UNSUBSCRIBE, { topic: 'terminal', id: terminalId })
    }
  }, [terminalId])

  // --------------------------------------------------------
  // Create terminal
  // --------------------------------------------------------
  const create = useCallback(async (): Promise<string | null> => {
    const socket = socketManager.getSocket()
    if (!socket.connected) return null

    setIsCreating(true)
    try {
      const result = await apiClient.post<{ terminalId: string; pid: number; cwd: string }>(
        '/terminals',
        {
          socketId: socket.id,
          cwd,
          cols,
          rows,
        }
      )
      setTerminalId(result.terminalId)
      setNeedsRecreate(false)
      return result.terminalId
    } catch (error) {
      console.error('[useStandaloneTerminal] Failed to create terminal:', error)
      return null
    } finally {
      setIsCreating(false)
    }
  }, [cwd, cols, rows])

  // --------------------------------------------------------
  // Destroy terminal
  // --------------------------------------------------------
  const destroy = useCallback(async (): Promise<void> => {
    const id = terminalIdRef.current
    if (!id) return

    try {
      await apiClient.delete(`/terminals/${id}`)
    } catch (error) {
      console.error('[useStandaloneTerminal] Failed to destroy terminal:', error)
    }
    setTerminalId(null)
    setIsAttached(false)
  }, [])

  // --------------------------------------------------------
  // I/O
  // --------------------------------------------------------
  const sendInput = useCallback((data: string) => {
    const id = terminalIdRef.current
    if (!id) return
    const socket = socketManager.getSocket()
    socket.emit(ClientEvents.TERMINAL_INPUT, { terminalId: id, data })
  }, [])

  const resize = useCallback((newCols: number, newRows: number) => {
    const id = terminalIdRef.current
    if (!id) return
    const socket = socketManager.getSocket()
    socket.emit(ClientEvents.TERMINAL_RESIZE, { terminalId: id, cols: newCols, rows: newRows })
  }, [])

  // --------------------------------------------------------
  // Cleanup on unmount — destroy the terminal
  // --------------------------------------------------------
  useEffect(() => {
    return () => {
      const id = terminalIdRef.current
      if (id) {
        apiClient.delete(`/terminals/${id}`).catch(() => {
          // Best-effort cleanup; server will also cleanup on socket disconnect
        })
      }
    }
  }, [])

  return {
    terminalId,
    isConnected,
    isAttached,
    isCreating,
    needsRecreate,
    create,
    destroy,
    sendInput,
    resize,
  }
}
