import type { FastifyRequest, FastifyReply } from 'fastify';
import { TunnelService } from '../services/tunnel.service.js';
import {
  TUNNEL_SESSION_COOKIE_NAME,
  TUNNEL_SESSION_COOKIE_OPTIONS,
} from '../utils/tunnel-cookie.js';

/**
 * 判断请求是否来自 Cloudflare 隧道
 * cloudflared 代理请求时，Cloudflare 边缘会注入 CF-Connecting-IP / CF-Ray 等头
 */
function isTunnelRequest(request: FastifyRequest): boolean {
  return !!(request.headers['cf-connecting-ip'] || request.headers['cf-ray']);
}

/**
 * 从请求 query 中提取 bootstrap token
 */
function extractBootstrapToken(request: FastifyRequest): string | null {
  const query = request.query as Record<string, string>;
  return query?.token ?? null;
}

function isDocumentRequest(request: FastifyRequest): boolean {
  const accept = request.headers.accept;
  return request.method === 'GET'
    && (
      request.headers['sec-fetch-dest'] === 'document'
      || (typeof accept === 'string' && accept.includes('text/html'))
    );
}

function buildCleanUrl(request: FastifyRequest): string {
  const clean = new URL(request.url, 'http://localhost');
  clean.searchParams.delete('token');
  return `${clean.pathname}${clean.search}`;
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

  // 静态资源不需要认证（构建产物，不含敏感数据）
  const url = request.url;
  if (url.startsWith('/assets/') || url === '/vite.svg' || url === '/favicon.ico') return;

  const sessionToken = request.cookies[TUNNEL_SESSION_COOKIE_NAME];
  if (sessionToken && TunnelService.validateToken(sessionToken)) {
    return;
  }

  const bootstrapToken = extractBootstrapToken(request);
  if (bootstrapToken && TunnelService.validateToken(bootstrapToken)) {
    reply.setCookie(
      TUNNEL_SESSION_COOKIE_NAME,
      bootstrapToken,
      TUNNEL_SESSION_COOKIE_OPTIONS,
    );

    if (isDocumentRequest(request)) {
      reply.redirect(buildCleanUrl(request), 302);
    }
    return;
  }

  if (!sessionToken) {
    reply.code(401).send({
      error: 'Unauthorized',
      message: 'Valid tunnel token required',
    });
    return;
  }

  reply.code(401).send({
    error: 'Unauthorized',
    message: 'Valid tunnel token required',
  });
}

export { isTunnelRequest };
