import type { FastifyRequest, FastifyReply } from 'fastify';
import { TunnelService } from '../services/tunnel.service.js';

/**
 * 判断请求是否来自 Cloudflare 隧道
 * cloudflared 代理请求时，Cloudflare 边缘会注入 CF-Connecting-IP / CF-Ray 等头
 */
function isTunnelRequest(request: FastifyRequest): boolean {
  return !!(request.headers['cf-connecting-ip'] || request.headers['cf-ray']);
}

/**
 * 从请求中提取 token
 * 支持 Authorization: Bearer <token> 和 ?token=<token> 两种方式
 */
function extractToken(request: FastifyRequest): string | null {
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  const query = request.query as Record<string, string>;
  return query?.token ?? null;
}

/**
 * Fastify onRequest 钩子：隧道请求必须携带有效 token
 * 本地直连请求（无 CF 头）自动放行
 */
export async function tunnelAuthHook(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!TunnelService.isRunning()) return;
  if (!isTunnelRequest(request)) return;

  const token = extractToken(request);
  if (!token || !TunnelService.validateToken(token)) {
    reply.code(401).send({
      error: 'Unauthorized',
      message: 'Valid tunnel token required',
    });
  }
}

export { isTunnelRequest };
