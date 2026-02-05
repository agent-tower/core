import type { Socket } from 'socket.io'

type NextFunction = (err?: Error) => void

export interface AuthenticatedSocket extends Socket {
  userId?: string
  username?: string
}

/**
 * Socket 认证中间件
 * 验证连接时的 token 并附加用户信息到 socket
 */
export function authMiddleware(
  socket: AuthenticatedSocket,
  next: NextFunction
) {
  const token = socket.handshake.auth.token

  // TODO: 实现真实的 token 验证逻辑
  // 目前使用简单的 mock 实现
  if (!token) {
    // 允许匿名连接（开发阶段）
    socket.userId = `anonymous-${socket.id.slice(0, 8)}`
    socket.username = 'Anonymous'
    return next()
  }

  try {
    // TODO: 验证 JWT token
    // const decoded = verifyToken(token)
    // socket.userId = decoded.userId
    // socket.username = decoded.username

    // Mock: 从 token 中提取用户信息
    socket.userId = token
    socket.username = `User-${token.slice(0, 6)}`
    next()
  } catch {
    next(new Error('Authentication failed'))
  }
}
