import { Server } from 'socket.io'
import type { FastifyInstance } from 'fastify'
import { authMiddleware } from './middleware/index.js'
import { SocketGateway } from './socket-gateway.js'
import { NAMESPACE } from './events.js'
import { getEventBus, getSessionManager, getTerminalManager, getNotificationService } from '../core/container.js'

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
export async function initializeSocket(fastify: FastifyInstance): Promise<Server> {
  const socketStartedAt = Date.now()
  const elapsed = () => `${Date.now() - socketStartedAt}ms`

  fastify.log.info(`[startup:socket] initializeSocket enter elapsed=${elapsed()}`)
  // Clean up previous instance to prevent listener accumulation during dev hot-reload
  socketGateway?.destroy()
  socketGateway = null
  fastify.log.info(`[startup:socket] previous gateway cleanup done elapsed=${elapsed()}`)

  io = new Server(fastify.server, {
    cors: {
      origin: process.env.CORS_ORIGIN || '*',
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout: 300000,
    pingInterval: 25000,
  })
  fastify.log.info(`[startup:socket] socket.io server created elapsed=${elapsed()}`)

  const nsp = io.of(NAMESPACE)
  nsp.use(authMiddleware)
  fastify.log.info(`[startup:socket] namespace middleware registered elapsed=${elapsed()}`)

  fastify.log.info(`[startup:socket] getTerminalManager start elapsed=${elapsed()}`)
  const tm = await getTerminalManager()
  fastify.log.info(`[startup:socket] getTerminalManager done elapsed=${elapsed()}`)
  fastify.log.info(`[startup:socket] getNotificationService start elapsed=${elapsed()}`)
  getNotificationService()
  fastify.log.info(`[startup:socket] getNotificationService done elapsed=${elapsed()}`)
  socketGateway = new SocketGateway(nsp, getEventBus(), getSessionManager(), tm)
  fastify.log.info(`[startup:socket] SocketGateway created elapsed=${elapsed()}`)
  nsp.on('connection', (socket) => {
    console.log(`[Socket] Connected: ${socket.id}`)
    socketGateway?.register(socket)
  })

  console.log('[Socket.IO] Initialized namespace:', NAMESPACE)
  fastify.log.info(`[startup:socket] initializeSocket complete elapsed=${elapsed()}`)

  return io
}

/**
 * 关闭 Socket.IO 服务
 */
export async function closeSocket(): Promise<void> {
  if (io) {
    socketGateway?.destroy()
    // Kill all active agent session pipelines on shutdown
    getSessionManager().destroyAll()
    // Kill all standalone terminals on shutdown
    try {
      const tm = await getTerminalManager()
      tm.destroyAll()
    } catch {
      // TerminalManager may not have been initialized; safe to ignore
    }
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
export { type AuthenticatedSocket } from './middleware/index.js'
