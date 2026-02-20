import type { Socket } from 'socket.io'
import { TunnelService } from '../../services/tunnel.service.js'

type NextFunction = (err?: Error) => void

export interface AuthenticatedSocket extends Socket {
  userId?: string
  username?: string
}

/**
 * Socket 认证中间件
 * 隧道请求（带 CF 头）必须携带有效 token，本地请求放行
 */
export function authMiddleware(
  socket: AuthenticatedSocket,
  next: NextFunction
) {
  // 检查是否为隧道请求
  const headers = socket.request.headers
  const isTunnel = !!(headers['cf-connecting-ip'] || headers['cf-ray'])

  if (isTunnel && TunnelService.isRunning()) {
    const token =
      socket.handshake.auth?.token ??
      (socket.handshake.query?.token as string | undefined)

    if (!token || !TunnelService.validateToken(token)) {
      return next(new Error('Unauthorized: valid tunnel token required'))
    }
  }

  // 设置用户标识
  const authToken = socket.handshake.auth?.token
  if (authToken) {
    socket.userId = authToken
    socket.username = `User-${authToken.slice(0, 6)}`
  } else {
    socket.userId = `anonymous-${socket.id.slice(0, 8)}`
    socket.username = 'Anonymous'
  }

  next()
}
