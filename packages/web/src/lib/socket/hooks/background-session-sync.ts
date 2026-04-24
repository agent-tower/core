import type { Operation } from 'fast-json-patch'
import { socketManager } from '../manager.js'
import {
  ClientEvents,
  ServerEvents,
  type SessionPatchPayload,
  type SessionExitPayload,
} from '@agent-tower/shared/socket'
import { useSessionLogStore } from '@/stores/session-log-store.js'

interface SyncHandler {
  patch: (payload: SessionPatchPayload) => void
  exit: (payload: SessionExitPayload) => void
}

/**
 * Manages background WebSocket subscriptions for RUNNING sessions
 * that are no longer actively viewed. Keeps their cache in the Zustand
 * store up-to-date by applying incoming PATCH events.
 */
class BackgroundSessionSync {
  private handlers = new Map<string, SyncHandler>()
  private reconnectBound: (() => void) | null = null

  startSync(sessionId: string): void {
    if (this.handlers.has(sessionId)) return

    const socket = socketManager.getSocket()

    const patchHandler = (payload: SessionPatchPayload) => {
      if (payload.sessionId !== sessionId) return
      const store = useSessionLogStore.getState()
      const ok = store.applyPatch(sessionId, payload.patch as Operation[], payload.seq)
      if (!ok) {
        this.stopSync(sessionId)
      }
    }

    const exitHandler = (payload: SessionExitPayload) => {
      if (payload.sessionId !== sessionId) return
      const store = useSessionLogStore.getState()
      store.truncateSession(sessionId)
      this.stopSync(sessionId)
    }

    socket.on(ServerEvents.SESSION_PATCH, patchHandler)
    socket.on(ServerEvents.SESSION_EXIT, exitHandler)
    this.handlers.set(sessionId, { patch: patchHandler, exit: exitHandler })

    this.ensureReconnectHandler()
  }

  /**
   * Stop background syncing.
   * @param keepRoom - true when the foreground useNormalizedLogs is taking over
   */
  stopSync(sessionId: string, keepRoom = false): void {
    const h = this.handlers.get(sessionId)
    if (!h) return

    const socket = socketManager.getSocket()
    socket.off(ServerEvents.SESSION_PATCH, h.patch)
    socket.off(ServerEvents.SESSION_EXIT, h.exit)

    if (!keepRoom) {
      socket.emit(ClientEvents.UNSUBSCRIBE, { topic: 'session', id: sessionId })
    }
    this.handlers.delete(sessionId)
  }

  isSyncing(sessionId: string): boolean {
    return this.handlers.has(sessionId)
  }

  stopAll(): void {
    for (const id of [...this.handlers.keys()]) {
      this.stopSync(id)
    }
  }

  private ensureReconnectHandler(): void {
    if (this.reconnectBound) return
    this.reconnectBound = () => {
      const socket = socketManager.getSocket()
      for (const sessionId of this.handlers.keys()) {
        socket.emit(
          ClientEvents.SUBSCRIBE,
          { topic: 'session', id: sessionId },
          () => { /* best effort */ },
        )
      }
    }
    socketManager.getSocket().on('connect', this.reconnectBound)
  }
}

export const backgroundSync = new BackgroundSessionSync()
