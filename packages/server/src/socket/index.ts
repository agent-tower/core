import { Server } from 'socket.io'
import type { FastifyInstance } from 'fastify'
import { authMiddleware } from './middleware/index.js'
import { createTerminalHandler, createAgentHandler } from './handlers/index.js'
import { NAMESPACES } from './events.js'

let io: Server | null = null

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

  // ============ /terminal 命名空间 ============
  const terminalNsp = io.of(NAMESPACES.TERMINAL)
  terminalNsp.use(authMiddleware)

  const terminalHandler = createTerminalHandler()
  terminalNsp.on('connection', (socket) => {
    console.log(`[Terminal] Socket connected: ${socket.id}`)
    terminalHandler.register(terminalNsp, socket)
  })

  // ============ /agents 命名空间 ============
  const agentsNsp = io.of(NAMESPACES.AGENTS)
  agentsNsp.use(authMiddleware)

  const agentHandler = createAgentHandler()
  agentsNsp.on('connection', (socket) => {
    console.log(`[Agents] Socket connected: ${socket.id}`)
    agentHandler.register(agentsNsp, socket)
  })

  console.log('[Socket.IO] Initialized with namespaces:', Object.values(NAMESPACES))

  return io
}

/**
 * 关闭 Socket.IO 服务
 */
export async function closeSocket(): Promise<void> {
  if (io) {
    await new Promise<void>((resolve) => {
      io!.close(() => {
        console.log('[Socket.IO] Closed')
        resolve()
      })
    })
    io = null
  }
}

// 导出类型和工具
export * from './events.js'
export * from './rooms.js'
export { type AuthenticatedSocket } from './middleware/index.js'
export { broadcastAgentStatus } from './handlers/agent.handler.js'
export { getProcessManager } from './handlers/terminal.handler.js'
