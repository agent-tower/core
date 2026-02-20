import { io, Socket } from 'socket.io-client'
import { NAMESPACE, ServerEvents } from '@agent-tower/shared/socket'
import { getTunnelToken, isTunnelAccess } from '../tunnel-token'

// Debug 日志开关
const DEBUG_SOCKET = import.meta.env.DEV;

/**
 * Socket 连接管理器
 * 单例模式，管理所有命名空间的连接
 */
class SocketManager {
  private socket: Socket | null = null
  private baseUrl: string

  constructor() {
    // 开发环境使用相对路径，通过 Vite 代理；生产环境使用环境变量
    this.baseUrl = import.meta.env.VITE_SOCKET_URL || ''
  }

  /**
   * 获取或创建统一 socket 连接
   */
  getSocket(): Socket {
    if (!this.socket) {
      const auth: Record<string, string> = {}
      if (isTunnelAccess()) {
        const token = getTunnelToken()
        if (token) auth.token = token
      }

      this.socket = io(`${this.baseUrl}${NAMESPACE}`, {
        auth,
        autoConnect: false,
        transports: ['websocket'],  // 跳过 polling，直接用 WebSocket
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 10000,
      })

      // 连接事件日志
      this.socket.on('connect', () => {
        console.log(`[Socket] Connected to ${NAMESPACE} t=${Date.now()}`)
      })

      this.socket.on('disconnect', (reason) => {
        console.log(`[Socket] Disconnected from ${NAMESPACE}: t=${Date.now()}`, reason)
      })

      this.socket.on('connect_error', (error) => {
        console.error(`[Socket] Connection error on ${NAMESPACE}: t=${Date.now()}`, error.message)
      })

      // 添加原始事件监听用于调试
      if (DEBUG_SOCKET) {
        this.socket.onAny((event, ...args) => {
          if (event === ServerEvents.SESSION_PATCH) {
            const payload = args[0] as { sessionId: string; patch: unknown[] };
            console.log(`[Socket:raw] t=${Date.now()} event=${event} sessionId=${payload.sessionId} ops=${payload.patch?.length}`);
          } else if (event === ServerEvents.SESSION_STDOUT) {
            const payload = args[0] as { sessionId: string; data: string };
            console.log(`[Socket:raw] t=${Date.now()} event=${event} sessionId=${payload.sessionId} dataLen=${payload.data?.length}`);
          } else {
            console.log(`[Socket:raw] t=${Date.now()} event=${event}`);
          }
        });
      }
    }

    return this.socket
  }

  /**
   * 连接到指定命名空间
   */
  connect(): Socket {
    const socket = this.getSocket()
    if (!socket.connected) {
      socket.connect()
    }
    return socket
  }

  /**
   * 断开连接并清理 socket 引用
   */
  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect()
      this.socket = null
    }
  }

  /**
   * 检查指定命名空间是否已连接
   */
  isConnected(): boolean {
    return this.socket?.connected ?? false
  }
}

// 单例导出
export const socketManager = new SocketManager()
