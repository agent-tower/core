import type { Socket } from 'socket.io'
import { TunnelService } from '../../services/tunnel.service.js'
import { extractTunnelSessionTokenFromCookieHeader } from '../../utils/tunnel-cookie.js'

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
  const cookieToken = extractTunnelSessionTokenFromCookieHeader(socket.request.headers.cookie)

  if (isTunnel && TunnelService.isRunning()) {
    if (!cookieToken || !TunnelService.validateToken(cookieToken)) {
      return next(new Error('Unauthorized: valid tunnel session cookie required'))
    }
  }

  // 设置用户标识
  if (cookieToken) {
    socket.userId = cookieToken
    socket.username = `User-${cookieToken.slice(0, 6)}`
  } else {
    socket.userId = `anonymous-${socket.id.slice(0, 8)}`
    socket.username = 'Anonymous'
  }

  next()
}
