import { io, Socket } from 'socket.io-client'
import { NAMESPACES } from '@agent-tower/shared/socket'

type NamespaceKey = keyof typeof NAMESPACES

/**
 * Socket 连接管理器
 * 单例模式，管理所有命名空间的连接
 */
class SocketManager {
  private sockets: Map<string, Socket> = new Map()
  private baseUrl: string

  constructor() {
    this.baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:3000'
  }

  /**
   * 获取或创建指定命名空间的 socket 连接
   */
  getSocket(namespace: NamespaceKey): Socket {
    const nsp = NAMESPACES[namespace]

    if (!this.sockets.has(nsp)) {
      const socket = io(`${this.baseUrl}${nsp}`, {
        autoConnect: false,
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
      })

      // 连接事件日志
      socket.on('connect', () => {
        console.log(`[Socket] Connected to ${nsp}`)
      })

      socket.on('disconnect', (reason) => {
        console.log(`[Socket] Disconnected from ${nsp}:`, reason)
      })

      socket.on('connect_error', (error) => {
        console.error(`[Socket] Connection error on ${nsp}:`, error.message)
      })

      this.sockets.set(nsp, socket)
    }

    return this.sockets.get(nsp)!
  }

  /**
   * 连接到指定命名空间
   */
  connect(namespace: NamespaceKey): Socket {
    const socket = this.getSocket(namespace)
    if (!socket.connected) {
      socket.connect()
    }
    return socket
  }

  /**
   * 断开指定命名空间的连接
   */
  disconnect(namespace: NamespaceKey): void {
    const nsp = NAMESPACES[namespace]
    const socket = this.sockets.get(nsp)
    if (socket?.connected) {
      socket.disconnect()
    }
  }

  /**
   * 断开所有连接
   */
  disconnectAll(): void {
    for (const socket of this.sockets.values()) {
      if (socket.connected) {
        socket.disconnect()
      }
    }
  }

  /**
   * 检查指定命名空间是否已连接
   */
  isConnected(namespace: NamespaceKey): boolean {
    const nsp = NAMESPACES[namespace]
    const socket = this.sockets.get(nsp)
    return socket?.connected ?? false
  }
}

// 单例导出
export const socketManager = new SocketManager()
