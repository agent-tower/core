import type { Namespace, Socket } from 'socket.io'
import type { SocketHandler } from './base.handler.js'
import { ProcessManager } from '../../process/process.manager.js'
import { sessionMsgStoreManager } from '../../output/index.js'
import {
  TerminalClientEvents,
  TerminalServerEvents,
  type TerminalAttachPayload,
  type TerminalInputPayload,
  type TerminalResizePayload,
  type AckResponse,
} from '../events.js'

// Debug 日志开关
const DEBUG_TERMINAL = process.env.DEBUG_TERMINAL === 'true' || true;

// 共享的 ProcessManager 实例
const processManager = new ProcessManager()

/**
 * 获取 ProcessManager 实例（供其他模块使用）
 */
export function getProcessManager(): ProcessManager {
  return processManager
}

/**
 * Terminal Handler
 * 处理终端 PTY 的 Socket.IO 事件
 */
export class TerminalHandler implements SocketHandler {
  // 跟踪 socket 订阅的 session（用于清理）
  private socketSessions = new Map<string, Set<string>>()
  // 跟踪 session 的 disposers（用于清理事件监听）
  private sessionDisposers = new Map<string, Map<string, () => void>>()

  register(nsp: Namespace, socket: Socket): void {
    // 初始化 socket 的 session 集合
    this.socketSessions.set(socket.id, new Set())
    this.sessionDisposers.set(socket.id, new Map())

    // 连接到终端会话
    socket.on(TerminalClientEvents.ATTACH, (payload: TerminalAttachPayload, ack?: (res: AckResponse) => void) => {
      this.handleAttach(nsp, socket, payload, ack)
    })

    // 断开终端会话
    socket.on(TerminalClientEvents.DETACH, (payload: TerminalAttachPayload, ack?: (res: AckResponse) => void) => {
      this.handleDetach(socket, payload, ack)
    })

    // 终端输入
    socket.on(TerminalClientEvents.INPUT, (payload: TerminalInputPayload) => {
      this.handleInput(payload)
    })

    // 终端调整大小
    socket.on(TerminalClientEvents.RESIZE, (payload: TerminalResizePayload) => {
      this.handleResize(payload)
    })

    // 断开连接时清理
    socket.on('disconnect', () => {
      this.handleDisconnect(socket)
    })
  }

  private handleAttach(
    nsp: Namespace,
    socket: Socket,
    payload: TerminalAttachPayload,
    ack?: (res: AckResponse) => void
  ): void {
    const { sessionId } = payload
    const pty = processManager.get(sessionId)

    if (DEBUG_TERMINAL) {
      console.log(`[Terminal:attach] t=${Date.now()} sessionId=${sessionId} socketId=${socket.id} ptyExists=${!!pty}`);
    }

    if (!pty) {
      socket.emit(TerminalServerEvents.ERROR, {
        sessionId,
        message: 'Session not found',
      })
      ack?.({ success: false, error: { code: 'SESSION_NOT_FOUND', message: 'Session not found' } })
      return
    }

    // 记录 socket 订阅的 session
    this.socketSessions.get(socket.id)?.add(sessionId)

    // 加入 session 房间（支持多个 socket 观看同一个 session）
    socket.join(`terminal:${sessionId}`)

    // 设置 PTY 事件监听
    const disposers = this.sessionDisposers.get(socket.id)!

    // 避免重复订阅
    if (!disposers.has(sessionId)) {
      let ptyOutputCount = 0;
      const onData = pty.onData((data) => {
        ptyOutputCount++;
        if (DEBUG_TERMINAL) {
          console.log(`[Terminal:onData] t=${Date.now()} #${ptyOutputCount} sessionId=${sessionId} len=${data.length}`);
        }
        nsp.to(`terminal:${sessionId}`).emit(TerminalServerEvents.OUTPUT, {
          sessionId,
          data,
        })
      })

      const onExit = pty.onExit(({ exitCode }) => {
        if (DEBUG_TERMINAL) {
          console.log(`[Terminal:onExit] t=${Date.now()} sessionId=${sessionId} exitCode=${exitCode}`);
        }
        nsp.to(`terminal:${sessionId}`).emit(TerminalServerEvents.EXIT, {
          sessionId,
          exitCode,
        })
      })

      // 订阅标准化日志流
      const msgStore = sessionMsgStoreManager.get(sessionId)
      let patchStreamAborted = false
      let patchCount = 0;

      if (DEBUG_TERMINAL) {
        console.log(`[Terminal:attach] t=${Date.now()} sessionId=${sessionId} msgStoreExists=${!!msgStore}`);
      }

      if (msgStore) {
        // 启动异步流处理
        ;(async () => {
          if (DEBUG_TERMINAL) {
            console.log(`[Terminal:patchStream] t=${Date.now()} sessionId=${sessionId} starting stream`);
          }
          try {
            for await (const msg of msgStore.normalizedLogsStream()) {
              if (patchStreamAborted) break

              patchCount++;
              if (msg.type === 'patch') {
                if (DEBUG_TERMINAL) {
                  console.log(`[Terminal:patchStream] t=${Date.now()} #${patchCount} sessionId=${sessionId} emitting PATCH ops=${(msg.patch as unknown[]).length}`);
                }
                nsp.to(`terminal:${sessionId}`).emit(TerminalServerEvents.PATCH, {
                  sessionId,
                  patch: msg.patch,
                })
              } else if (msg.type === 'session_id') {
                if (DEBUG_TERMINAL) {
                  console.log(`[Terminal:patchStream] t=${Date.now()} #${patchCount} sessionId=${sessionId} emitting SESSION_ID=${msg.id}`);
                }
                nsp.to(`terminal:${sessionId}`).emit(TerminalServerEvents.SESSION_ID, {
                  sessionId,
                  agentSessionId: msg.id,
                })
              }
            }
          } catch (err) {
            if (!patchStreamAborted) {
              console.error(`[Terminal] Patch stream error for session ${sessionId}:`, err)
            }
          }
          if (DEBUG_TERMINAL) {
            console.log(`[Terminal:patchStream] t=${Date.now()} sessionId=${sessionId} stream ended, total patches=${patchCount}`);
          }
        })()
      }

      disposers.set(sessionId, () => {
        patchStreamAborted = true
        onData.dispose()
        onExit.dispose()
      })
    }

    socket.emit(TerminalServerEvents.ATTACHED, { sessionId })
    ack?.({ success: true })
  }

  private handleDetach(
    socket: Socket,
    payload: TerminalAttachPayload,
    ack?: (res: AckResponse) => void
  ): void {
    const { sessionId } = payload

    // 离开房间
    socket.leave(`terminal:${sessionId}`)

    // 清理订阅记录
    this.socketSessions.get(socket.id)?.delete(sessionId)

    // 清理事件监听
    const disposers = this.sessionDisposers.get(socket.id)
    const dispose = disposers?.get(sessionId)
    if (dispose) {
      dispose()
      disposers?.delete(sessionId)
    }

    socket.emit(TerminalServerEvents.DETACHED, { sessionId })
    ack?.({ success: true })
  }

  private handleInput(payload: TerminalInputPayload): void {
    const { sessionId, data } = payload
    const pty = processManager.get(sessionId)

    if (pty) {
      pty.write(data)
    }
  }

  private handleResize(payload: TerminalResizePayload): void {
    const { sessionId, cols, rows } = payload
    const pty = processManager.get(sessionId)

    if (pty) {
      pty.resize(cols, rows)
    }
  }

  private handleDisconnect(socket: Socket): void {
    // 清理所有订阅的 session
    const sessions = this.socketSessions.get(socket.id)
    const disposers = this.sessionDisposers.get(socket.id)

    if (disposers) {
      for (const dispose of disposers.values()) {
        dispose()
      }
    }

    this.socketSessions.delete(socket.id)
    this.sessionDisposers.delete(socket.id)

    console.log(`[Terminal] Socket disconnected: ${socket.id}, cleaned ${sessions?.size || 0} sessions`)
  }
}

/**
 * 创建 Terminal Handler 实例
 */
export function createTerminalHandler(): TerminalHandler {
  return new TerminalHandler()
}
