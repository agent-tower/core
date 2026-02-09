import type { Namespace, Socket } from 'socket.io'
import type { SocketHandler } from './base.handler.js'
import { ProcessManager } from '../../process/process.manager.js'
import { sessionMsgStoreManager } from '../../output/index.js'
import type { LogMsg } from '../../output/index.js'
import {
  TerminalClientEvents,
  TerminalServerEvents,
  type TerminalAttachPayload,
  type TerminalInputPayload,
  type TerminalResizePayload,
  type TerminalCreatePayload,
  type TerminalDestroyPayload,
  type AckResponse,
} from '../events.js'
import { randomUUID } from 'node:crypto'

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
  // 跟踪 socket 创建的独立终端（断开时自动清理）
  private socketStandaloneTerminals = new Map<string, Set<string>>()

  register(nsp: Namespace, socket: Socket): void {
    // 初始化 socket 的 session 集合
    this.socketSessions.set(socket.id, new Set())
    this.sessionDisposers.set(socket.id, new Map())
    this.socketStandaloneTerminals.set(socket.id, new Set())

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

    // 创建独立终端
    socket.on(TerminalClientEvents.CREATE, (payload: TerminalCreatePayload, ack?: (res: AckResponse<{ terminalId: string }>) => void) => {
      this.handleCreate(nsp, socket, payload, ack)
    })

    // 销毁独立终端
    socket.on(TerminalClientEvents.DESTROY, (payload: TerminalDestroyPayload, ack?: (res: AckResponse) => void) => {
      this.handleDestroy(socket, payload, ack)
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
    const msgStore = sessionMsgStoreManager.get(sessionId)

    if (DEBUG_TERMINAL) {
      console.log(`[Terminal:attach] t=${Date.now()} sessionId=${sessionId} socketId=${socket.id} ptyExists=${!!pty} msgStoreExists=${!!msgStore}`);
    }

    // 允许 attach 即使 PTY 不存在（COMPLETED/CANCELLED session 仍有 MsgStore）
    // 前端会通过 REST 加载 snapshot，通过 EventEmitter 接收后续 PATCH

    // 记录 socket 订阅的 session
    this.socketSessions.get(socket.id)?.add(sessionId)

    // 加入 session 房间（支持多个 socket 观看同一个 session）
    socket.join(`terminal:${sessionId}`)

    // 设置事件监听
    const disposers = this.sessionDisposers.get(socket.id)!

    // 避免重复订阅
    if (!disposers.has(sessionId)) {
      const disposeFns: (() => void)[] = []

      // PTY 事件监听（如果 PTY 存在）
      if (pty) {
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

        disposeFns.push(() => {
          onData.dispose()
          onExit.dispose()
        })
      }

      // MsgStore EventEmitter 订阅 — 使用直接事件监听而非 async generator
      // 这样即使 PTY 退出后 MsgStore pushFinished()，监听器也不会断开，
      // 当 sendMessage spawn 新 PTY 时，新的 PATCH 事件能继续转发
      if (msgStore) {
        let patchCount = 0;
        const onMessage = (msg: LogMsg) => {
          if (msg.type === 'patch') {
            patchCount++;
            if (DEBUG_TERMINAL) {
              console.log(`[Terminal:onMessage] t=${Date.now()} #${patchCount} sessionId=${sessionId} emitting PATCH ops=${(msg.patch as unknown[]).length}`);
            }
            nsp.to(`terminal:${sessionId}`).emit(TerminalServerEvents.PATCH, {
              sessionId,
              patch: msg.patch,
            })
          } else if (msg.type === 'session_id') {
            if (DEBUG_TERMINAL) {
              console.log(`[Terminal:onMessage] t=${Date.now()} sessionId=${sessionId} emitting SESSION_ID=${msg.id}`);
            }
            nsp.to(`terminal:${sessionId}`).emit(TerminalServerEvents.SESSION_ID, {
              sessionId,
              agentSessionId: msg.id,
            })
          } else if (msg.type === 'finished') {
            // finished 事件也通过 EXIT 通知前端
            nsp.to(`terminal:${sessionId}`).emit(TerminalServerEvents.EXIT, {
              sessionId,
              exitCode: 0,
            })
          }
        }
        msgStore.on('message', onMessage)

        disposeFns.push(() => {
          msgStore.off('message', onMessage)
        })
      }

      disposers.set(sessionId, () => {
        for (const fn of disposeFns) fn()
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

  private handleCreate(
    nsp: Namespace,
    socket: Socket,
    payload: TerminalCreatePayload,
    ack?: (res: AckResponse<{ terminalId: string }>) => void
  ): void {
    const terminalId = payload.terminalId || randomUUID()
    const { workingDir } = payload

    if (DEBUG_TERMINAL) {
      console.log(`[Terminal:create] t=${Date.now()} terminalId=${terminalId} workingDir=${workingDir} socketId=${socket.id}`)
    }

    try {
      // 创建独立 PTY
      const ptyProcess = processManager.spawn(terminalId, workingDir)

      // 记录为该 socket 的独立终端
      this.socketStandaloneTerminals.get(socket.id)?.add(terminalId)

      // 自动 attach：加入 session 房间
      this.socketSessions.get(socket.id)?.add(terminalId)
      socket.join(`terminal:${terminalId}`)

      // 设置 PTY 事件监听
      const disposers = this.sessionDisposers.get(socket.id)!
      const onData = ptyProcess.onData((data) => {
        nsp.to(`terminal:${terminalId}`).emit(TerminalServerEvents.OUTPUT, {
          sessionId: terminalId,
          data,
        })
      })

      const onExit = ptyProcess.onExit(({ exitCode }) => {
        if (DEBUG_TERMINAL) {
          console.log(`[Terminal:exit] t=${Date.now()} terminalId=${terminalId} exitCode=${exitCode}`)
        }
        nsp.to(`terminal:${terminalId}`).emit(TerminalServerEvents.EXIT, {
          sessionId: terminalId,
          exitCode,
        })
        // 从独立终端集合中移除
        this.socketStandaloneTerminals.get(socket.id)?.delete(terminalId)
      })

      disposers.set(terminalId, () => {
        onData.dispose()
        onExit.dispose()
      })

      // 通知客户端创建成功
      socket.emit(TerminalServerEvents.CREATED, { terminalId })
      socket.emit(TerminalServerEvents.ATTACHED, { sessionId: terminalId })
      ack?.({ success: true, data: { terminalId } })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create terminal'
      console.error(`[Terminal:create] Error creating terminal ${terminalId}:`, err)
      socket.emit(TerminalServerEvents.ERROR, {
        sessionId: terminalId,
        message,
      })
      ack?.({ success: false, error: { code: 'CREATE_FAILED', message } })
    }
  }

  private handleDestroy(
    socket: Socket,
    payload: TerminalDestroyPayload,
    ack?: (res: AckResponse) => void
  ): void {
    const { terminalId } = payload

    if (DEBUG_TERMINAL) {
      console.log(`[Terminal:destroy] t=${Date.now()} terminalId=${terminalId} socketId=${socket.id}`)
    }

    // 清理事件监听
    const disposers = this.sessionDisposers.get(socket.id)
    const dispose = disposers?.get(terminalId)
    if (dispose) {
      dispose()
      disposers?.delete(terminalId)
    }

    // 离开房间
    socket.leave(`terminal:${terminalId}`)
    this.socketSessions.get(socket.id)?.delete(terminalId)
    this.socketStandaloneTerminals.get(socket.id)?.delete(terminalId)

    // 杀掉 PTY 进程
    processManager.kill(terminalId)

    ack?.({ success: true })
  }

  private handleDisconnect(socket: Socket): void {
    // 清理所有订阅的 session 监听
    const sessions = this.socketSessions.get(socket.id)
    const disposers = this.sessionDisposers.get(socket.id)

    if (disposers) {
      for (const dispose of disposers.values()) {
        dispose()
      }
    }

    // 清理所有独立终端 PTY 进程
    const standaloneTerminals = this.socketStandaloneTerminals.get(socket.id)
    if (standaloneTerminals) {
      for (const terminalId of standaloneTerminals) {
        if (DEBUG_TERMINAL) {
          console.log(`[Terminal:disconnect] Cleaning standalone terminal ${terminalId} for socket ${socket.id}`)
        }
        processManager.kill(terminalId)
      }
    }

    this.socketSessions.delete(socket.id)
    this.sessionDisposers.delete(socket.id)
    this.socketStandaloneTerminals.delete(socket.id)

    console.log(`[Terminal] Socket disconnected: ${socket.id}, cleaned ${sessions?.size || 0} sessions, ${standaloneTerminals?.size || 0} standalone terminals`)
  }
}

/**
 * 创建 Terminal Handler 实例
 */
export function createTerminalHandler(): TerminalHandler {
  return new TerminalHandler()
}
