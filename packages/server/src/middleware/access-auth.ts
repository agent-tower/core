import type { FastifyReply, FastifyRequest } from 'fastify';
import { AccessAuthService } from '../services/access-auth.service.js';
import {
  INTERNAL_API_TOKEN_HEADER,
  validateInternalApiToken,
} from '../utils/internal-api-token.js';
import { parsePreviewPath } from '../utils/preview-path.js';

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isPublicAccessAuthEndpoint(request: FastifyRequest): boolean {
  const pathname = new URL(request.url, 'http://agent-tower.local').pathname;
  if (pathname === '/api/access-auth/status') return request.method === 'GET';
  if (pathname === '/api/access-auth/login') return request.method === 'POST';
  if (pathname === '/api/access-auth/logout') return request.method === 'POST';
  return false;
}

function isPublicEndpoint(request: FastifyRequest): boolean {
  const pathname = new URL(request.url, 'http://agent-tower.local').pathname;
  if (isPublicAccessAuthEndpoint(request)) return true;
  if (pathname === '/api/health') return true;
  if (pathname === '/api/tunnel/bootstrap') return true;
  if (pathname === '/api/tunnel/health') return true;
  return false;
}

function isProtectedEndpoint(request: FastifyRequest): boolean {
  const pathname = new URL(request.url, 'http://agent-tower.local').pathname;
  return pathname.startsWith('/api/') || pathname === '/api' || pathname.startsWith('/view/');
}

async function hasValidPreviewAccessToken(request: FastifyRequest): Promise<boolean> {
  const parsed = parsePreviewPath(request.url);
  if (!parsed?.previewToken) return false;
  return AccessAuthService.validatePreviewAccessToken(parsed.previewToken, parsed.workspaceId);
}

function requestOriginMatchesHost(request: FastifyRequest, value: string): boolean {
  let origin: URL;
  try {
    origin = new URL(value);
  } catch {
    return false;
  }

  const host = request.headers.host;
  if (!host) return false;
  return origin.host.toLowerCase() === host.toLowerCase();
}

function hasValidSameOriginSignal(request: FastifyRequest): boolean {
  const origin = firstHeaderValue(request.headers.origin);
  if (origin) return requestOriginMatchesHost(request, origin);

  const referer = firstHeaderValue(request.headers.referer);
  if (referer) return requestOriginMatchesHost(request, referer);

  return true;
}

function shouldCheckCsrf(request: FastifyRequest): boolean {
  const method = request.method.toUpperCase();
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

function sendUnauthorized(reply: FastifyReply): void {
  reply.code(401).send({
    error: 'Unauthorized',
    code: 'ACCESS_AUTH_REQUIRED',
    message: 'Access password required',
  });
}

function sendInvalidInternalToken(reply: FastifyReply): void {
  reply.code(401).send({
    error: 'Unauthorized',
    code: 'ACCESS_AUTH_INVALID_INTERNAL_TOKEN',
    message: 'Invalid internal token',
  });
}

function sendCsrfRejected(reply: FastifyReply): void {
  reply.code(403).send({
    error: 'Forbidden',
    code: 'ACCESS_AUTH_CSRF_REJECTED',
    message: 'Request origin is not allowed',
  });
}

export async function accessAuthHook(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!isProtectedEndpoint(request) || isPublicEndpoint(request)) return;

  const internalToken = firstHeaderValue(request.headers[INTERNAL_API_TOKEN_HEADER]);
  if (internalToken) {
    if (validateInternalApiToken(internalToken)) return;
    sendInvalidInternalToken(reply);
    return;
  }

  if (!await AccessAuthService.isEnabled()) return;

  if (await hasValidPreviewAccessToken(request)) return;

  const cookieToken = request.cookies[AccessAuthService.cookieName]
    ?? AccessAuthService.extractCookieFromHeader(request.headers.cookie);

  if (!await AccessAuthService.validateSessionToken(cookieToken)) {
    sendUnauthorized(reply);
    return;
  }

  if (shouldCheckCsrf(request) && !hasValidSameOriginSignal(request)) {
    sendCsrfRejected(reply);
  }
}
