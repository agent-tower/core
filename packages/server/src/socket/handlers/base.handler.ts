import type { Namespace, Socket } from 'socket.io'

/**
 * Socket Handler 接口
 * 所有 handler 都需要实现这个接口
 */
export interface SocketHandler {
  /**
   * 注册事件监听器到 socket
   */
  register(nsp: Namespace, socket: Socket): void
}

/**
 * Handler 注册器类型
 */
export type HandlerFactory = () => SocketHandler
