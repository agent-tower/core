import { Server } from 'socket.io'
import type { FastifyInstance } from 'fastify'
import { authMiddleware } from './middleware/index.js'
import { SocketGateway } from './socket-gateway.js'
import { NAMESPACE, type AgentStatusPayload } from './events.js'
import { getEventBus, getSessionManager } from '../core/container.js'

let io: Server | null = null
let socketGateway: SocketGateway | null = null

/**
 * 获取 Socket.IO 实例
 */
export function getIO(): Server {
  if (!io) {
    throw new Error('Socket.IO not initialized')
  }
  return io
}

/**
 * 初始化 Socket.IO 服务
 */
export function initializeSocket(fastify: FastifyInstance): Server {
  io = new Server(fastify.server, {
    cors: {
      origin: process.env.CORS_ORIGIN || '*',
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  })

  const nsp = io.of(NAMESPACE)
  nsp.use(authMiddleware)

  socketGateway = new SocketGateway(nsp, getEventBus(), getSessionManager())
  nsp.on('connection', (socket) => {
    console.log(`[Socket] Connected: ${socket.id}`)
    socketGateway?.register(socket)
  })

  console.log('[Socket.IO] Initialized namespace:', NAMESPACE)

  return io
}

/**
 * 关闭 Socket.IO 服务
 */
export async function closeSocket(): Promise<void> {
  if (io) {
    socketGateway?.destroy()
    await new Promise<void>((resolve) => {
      io!.close(() => {
        console.log('[Socket.IO] Closed')
        resolve()
      })
    })
    socketGateway = null
    io = null
  }
}

// 导出类型和工具
export * from './events.js'
export * from './rooms.js'
export { type AuthenticatedSocket } from './middleware/index.js'

export function broadcastAgentStatus(payload: AgentStatusPayload): void {
  socketGateway?.broadcastAgentStatus(payload)
}
