import type { Socket } from 'socket.io'
import { TunnelService } from '../../services/tunnel.service.js'
import { extractTunnelSessionTokenFromCookieHeader } from '../../utils/tunnel-cookie.js'
import { AccessAuthService } from '../../services/access-auth.service.js'
import {
  INTERNAL_API_TOKEN_HEADER,
  validateInternalApiToken,
} from '../../utils/internal-api-token.js'

type NextFunction = (err?: Error) => void

export interface AuthenticatedSocket extends Socket {
  userId?: string
  username?: string
  accessAuthSessionSecretGeneration?: number
}

/**
 * Socket 认证中间件
 * 隧道请求（带 CF 头）必须携带有效 token，本地请求放行
 */
export function authMiddleware(
  socket: AuthenticatedSocket,
  next: NextFunction
) {
  void authenticateSocket(socket, next)
}

async function authenticateSocket(
  socket: AuthenticatedSocket,
  next: NextFunction
): Promise<void> {
  const headers = socket.request.headers
  const isTunnel = !!(headers['cf-connecting-ip'] || headers['cf-ray'])
  const cookieToken = extractTunnelSessionTokenFromCookieHeader(headers.cookie)

  if (isTunnel && TunnelService.isRunning()) {
    if (!cookieToken || !TunnelService.validateToken(cookieToken)) {
      return next(new Error('Unauthorized: valid tunnel session cookie required'))
    }
  }

  const internalToken = headers[INTERNAL_API_TOKEN_HEADER]
  const normalizedInternalToken = Array.isArray(internalToken) ? internalToken[0] : internalToken
  if (internalToken !== undefined) {
    if (!validateInternalApiToken(normalizedInternalToken)) {
      return next(new Error('Unauthorized: invalid internal token'))
    }
    socket.accessAuthSessionSecretGeneration = AccessAuthService.getSessionSecretGeneration()
  } else {
    const accessToken = AccessAuthService.extractCookieFromHeader(headers.cookie)
    const accessAuthResult = await AccessAuthService.validateSessionTokenWithGeneration(accessToken)
    if (!accessAuthResult.valid) {
      return next(new Error('Unauthorized: access password required'))
    }
    socket.accessAuthSessionSecretGeneration = accessAuthResult.generation
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
