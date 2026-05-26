import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import http from 'node:http';
import https from 'node:https';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { PreviewService } from '../services/preview.service.js';
import type { NormalizedPreviewTarget } from '../services/preview.service.js';
import { ServiceError } from '../errors.js';
import { TunnelService } from '../services/tunnel.service.js';
import {
  TUNNEL_SESSION_COOKIE_NAME,
  extractTunnelSessionTokenFromCookieHeader,
} from '../utils/tunnel-cookie.js';

const PREVIEW_PREFIX = '/view';
const INTERNAL_COOKIE_NAMES = new Set([
  TUNNEL_SESSION_COOKIE_NAME,
]);

type ProxyRequestOptions = http.RequestOptions & { rejectUnauthorized?: boolean };

const configSchema = z.object({
  target: z.string().nullable(),
});

function errorResponse(error: unknown, reply: FastifyReply) {
  if (error instanceof ServiceError) {
    return reply.code(error.statusCode).send({ error: error.message, code: error.code });
  }

  if (error instanceof z.ZodError) {
    return reply.code(400).send({ error: error.message, code: 'VALIDATION_ERROR' });
  }

  reply.log.error(error);
  return reply.code(500).send({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
}

function parsePreviewPath(url: string): { workspaceId: string; suffix: string; search: string } | null {
  const parsed = new URL(url, 'http://agent-tower.local');
  const prefix = `${PREVIEW_PREFIX}/`;
  if (!parsed.pathname.startsWith(prefix)) return null;

  const rest = parsed.pathname.slice(prefix.length);
  const slashIndex = rest.indexOf('/');
  const encodedWorkspaceId = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
  if (!encodedWorkspaceId) return null;

  const workspaceId = decodeURIComponent(encodedWorkspaceId);
  const suffix = slashIndex === -1 ? '/' : rest.slice(slashIndex) || '/';
  return { workspaceId, suffix, search: parsed.search };
}

function joinTargetPath(target: NormalizedPreviewTarget, suffix: string, search: string): string {
  const normalizedSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
  const base = target.basePath || '';
  const path = `${base}${normalizedSuffix}`.replace(/\/{2,}/g, '/');
  return `${path || '/'}${search}`;
}

function filterCookieHeader(cookieHeader?: string): string | undefined {
  if (!cookieHeader) return undefined;

  const cookies = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      const [name] = part.split('=');
      return name && !INTERNAL_COOKIE_NAMES.has(name);
    });

  return cookies.length > 0 ? cookies.join('; ') : undefined;
}

function proxyRequestHeaders(headers: IncomingHttpHeaders, targetUrl: URL): http.OutgoingHttpHeaders {
  const next: http.OutgoingHttpHeaders = { ...headers };
  delete next.host;
  delete next.connection;
  delete next['content-length'];
  delete next['accept-encoding'];

  const cookie = filterCookieHeader(headers.cookie);
  if (cookie) next.cookie = cookie;
  else delete next.cookie;

  next.host = targetUrl.host;
  next['accept-encoding'] = 'identity';
  next['x-forwarded-host'] = headers.host;
  next['x-forwarded-proto'] = 'http';
  return next;
}

export function rewriteLocationHeader(value: string, workspaceId: string, target: NormalizedPreviewTarget): string {
  const prefix = `${PREVIEW_PREFIX}/${encodeURIComponent(workspaceId)}`;

  try {
    const location = new URL(value, target.origin);
    if (location.origin !== target.origin) return value;
    if (isSameOrChildPath(location.pathname, prefix)) {
      return `${location.pathname}${location.search}${location.hash}`;
    }

    const basePath = target.basePath;
    const isUnderBasePath = basePath
      ? location.pathname === basePath || location.pathname.startsWith(`${basePath}/`)
      : true;
    const path = isUnderBasePath
      ? location.pathname.slice(target.basePath.length || 0) || '/'
      : location.pathname;
    return `${prefix}${path}${location.search}${location.hash}`;
  } catch {
    if (isSameOrChildPath(getPathname(value), prefix)) return value;
    if (value.startsWith('/')) return `${prefix}${value}`;
    return value;
  }
}

function rewriteSetCookieHeader(value: string, workspaceId: string): string {
  const prefix = `${PREVIEW_PREFIX}/${encodeURIComponent(workspaceId)}/`;
  if (/;\s*path=/i.test(value)) {
    return value.replace(/;\s*path=([^;]*)/i, `; Path=${prefix}`);
  }
  return `${value}; Path=${prefix}`;
}

function proxyResponseHeaders(
  headers: IncomingHttpHeaders,
  workspaceId: string,
  target: NormalizedPreviewTarget,
): http.OutgoingHttpHeaders {
  const next: http.OutgoingHttpHeaders = {};

  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (
      lower === 'connection'
      || lower === 'content-length'
      || lower === 'content-encoding'
      || lower === 'transfer-encoding'
      || lower === 'x-frame-options'
    ) {
      continue;
    }

    if (lower === 'content-security-policy') {
      continue;
    }

    if (lower === 'location' && typeof value === 'string') {
      next[key] = rewriteLocationHeader(value, workspaceId, target);
      continue;
    }

    if (lower === 'set-cookie') {
      const cookies = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
      next[key] = cookies.map((cookie) => rewriteSetCookieHeader(cookie, workspaceId));
      continue;
    }

    if (value !== undefined) next[key] = value;
  }

  return next;
}

function isRewritableContent(contentType?: string | string[]): boolean {
  const value = Array.isArray(contentType) ? contentType.join(';') : contentType ?? '';
  const lower = value.toLowerCase();
  return lower.includes('text/html')
    || lower.includes('text/css')
    || lower.includes('javascript')
    || lower.includes('application/ecmascript');
}

function isSameOrChildPath(pathname: string, basePath: string): boolean {
  return pathname === basePath || pathname.startsWith(`${basePath}/`);
}

function getPathname(value: string): string {
  const end = value.search(/[?#]/);
  return end === -1 ? value : value.slice(0, end);
}

function hasStaticFileExtension(pathname: string): boolean {
  const segment = pathname.split('/').pop() ?? '';
  return /\.(?:avif|bmp|css|eot|gif|html?|ico|jpe?g|js|json|map|mjs|png|svg|ttf|txt|wasm|webp|woff2?)$/i.test(segment);
}

function shouldRewriteJavaScriptPath(value: string, prefix: string): boolean {
  if (!value.startsWith('/') || value.startsWith('//') || value === '/') return false;

  const pathname = getPathname(value);
  if (isSameOrChildPath(pathname, prefix) || pathname.startsWith(`${PREVIEW_PREFIX}/`)) return false;

  if (isSameOrChildPath(pathname, '/api') || isSameOrChildPath(pathname, '/socket.io')) return true;
  if (isSameOrChildPath(pathname, '/assets')) return true;
  return hasStaticFileExtension(pathname);
}

function rewriteJavaScriptPathLiterals(body: string, prefix: string): string {
  return body.replace(/(["'`])\/(?!\/)([^"'`\r\n]*)\1/g, (match, quote: string, rest: string) => {
    const value = `/${rest}`;
    if (!shouldRewriteJavaScriptPath(value, prefix)) return match;
    return `${quote}${prefix}${value}${quote}`;
  });
}

function rewriteJavaScriptRouterBasenameDefaults(body: string, prefix: string): string {
  return body
    .replace(
      /(\bbasename\s*:\s*[A-Za-z_$][\w$]*\s*=\s*)(["'`])\/\2/g,
      (_match, before: string, quote: string) => `${before}${quote}${prefix}${quote}`,
    )
    .replace(
      /(\bbasename\s*=\s*)(["'`])\/\2/g,
      (_match, before: string, quote: string) => `${before}${quote}${prefix}${quote}`,
    )
    .replace(
      /(\bbasename\s*:\s*)(["'`])\/\2/g,
      (_match, before: string, quote: string) => `${before}${quote}${prefix}${quote}`,
    )
    .replace(
      /(\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?\.basename\s*\|\|\s*)(["'`])\/\2/g,
      (_match, before: string, quote: string) => `${before}${quote}${prefix}${quote}`,
    )
    .replace(
      /(\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?\.basename\s*\?\?\s*)(["'`])\/\2/g,
      (_match, before: string, quote: string) => `${before}${quote}${prefix}${quote}`,
    );
}

export function rewritePreviewBody(body: string, workspaceId: string, contentType?: string | string[]): string {
  const prefix = `${PREVIEW_PREFIX}/${encodeURIComponent(workspaceId)}`;
  const value = Array.isArray(contentType) ? contentType.join(';') : contentType ?? '';
  const lower = value.toLowerCase();

  let next = body;

  if (lower.includes('text/html')) {
    next = next
      .replace(/(\s(?:src|href|action|poster|data|content)=["'])\/(?!\/|view\/)([^"']*)/gi, `$1${prefix}/$2`)
      .replace(/(\s(?:srcset)=["'])([^"']*)(["'])/gi, (_match, before: string, srcset: string, after: string) => {
        const rewritten = srcset.replace(/(^|,\s*)\/(?!\/|view\/)([^\s,]+)/g, `$1${prefix}/$2`);
        return `${before}${rewritten}${after}`;
      });
  }

  if (lower.includes('text/css') || lower.includes('text/html')) {
    next = next.replace(/url\((['"]?)\/(?!\/|view\/)([^)'"]+)\1\)/g, `url($1${prefix}/$2$1)`);
  }

  if (lower.includes('javascript') || lower.includes('ecmascript') || lower.includes('text/html')) {
    next = rewriteJavaScriptRouterBasenameDefaults(next, prefix);
    next = rewriteJavaScriptPathLiterals(next, prefix);
  }

  return next;
}

function requestBodyBuffer(request: FastifyRequest): Buffer | null {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') return null;

  const body = request.body;
  if (body === undefined || body === null) return null;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body);
  return Buffer.from(JSON.stringify(body));
}

async function proxyHttpRequest(
  request: FastifyRequest,
  response: ServerResponse,
  workspaceId: string,
  target: NormalizedPreviewTarget,
): Promise<void> {
  const parsed = parsePreviewPath(request.raw.url ?? '');
  if (!parsed) {
    response.writeHead(404);
    response.end('Preview route not found');
    return;
  }

  const targetUrl = new URL(target.origin);
  const body = requestBodyBuffer(request);
  const headers = proxyRequestHeaders(request.headers, targetUrl);
  if (body) headers['content-length'] = Buffer.byteLength(body);

  const options: ProxyRequestOptions = {
    protocol: targetUrl.protocol,
    hostname: targetUrl.hostname,
    port: targetUrl.port,
    method: request.method,
    path: joinTargetPath(target, parsed.suffix, parsed.search),
    headers,
    rejectUnauthorized: false,
  };

  const transport = targetUrl.protocol === 'https:' ? https : http;

  await new Promise<void>((resolve) => {
    const proxyReq = transport.request(options, (proxyRes: IncomingMessage) => {
      const headers = proxyResponseHeaders(proxyRes.headers, workspaceId, target);
      response.statusCode = proxyRes.statusCode ?? 502;
      for (const [key, value] of Object.entries(headers)) {
        if (value !== undefined) response.setHeader(key, value);
      }

      if (!isRewritableContent(proxyRes.headers['content-type'])) {
        proxyRes.pipe(response);
        proxyRes.on('end', resolve);
        proxyRes.on('error', () => {
          if (!response.headersSent) response.writeHead(502);
          response.end('Preview proxy response failed');
          resolve();
        });
        return;
      }

      const chunks: Buffer[] = [];
      proxyRes.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      proxyRes.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        response.end(rewritePreviewBody(text, workspaceId, proxyRes.headers['content-type']));
        resolve();
      });
      proxyRes.on('error', () => {
        if (!response.headersSent) response.writeHead(502);
        response.end('Preview proxy response failed');
        resolve();
      });
    });

    proxyReq.on('error', (err) => {
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'application/json' });
      }
      response.end(JSON.stringify({ error: err.message, code: 'PREVIEW_PROXY_ERROR' }));
      resolve();
    });

    proxyReq.end(body ?? undefined);
  });
}

function writeUpgradeError(socket: Duplex, statusCode: number, message: string): void {
  socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function proxyWebSocketRequest(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  workspaceId: string,
  target: NormalizedPreviewTarget,
): void {
  const parsed = parsePreviewPath(req.url ?? '');
  if (!parsed) {
    writeUpgradeError(socket, 404, 'Not Found');
    return;
  }

  const targetUrl = new URL(target.origin);
  const headers = proxyRequestHeaders(req.headers, targetUrl);

  const options: ProxyRequestOptions = {
    protocol: targetUrl.protocol,
    hostname: targetUrl.hostname,
    port: targetUrl.port,
    method: 'GET',
    path: joinTargetPath(target, parsed.suffix, parsed.search),
    headers,
    rejectUnauthorized: false,
  };

  const transport = targetUrl.protocol === 'https:' ? https : http;
  const proxyReq = transport.request(options);

  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    const headerLines = [
      `HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}`,
      ...Object.entries(proxyRes.headers).flatMap(([key, value]) => {
        if (Array.isArray(value)) return value.map((item) => `${key}: ${item}`);
        return value === undefined ? [] : [`${key}: ${value}`];
      }),
      '',
      '',
    ];

    socket.write(headerLines.join('\r\n'));
    if (proxyHead.length > 0) socket.write(proxyHead);
    if (head.length > 0) proxySocket.write(head);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });

  proxyReq.on('response', (res) => {
    writeUpgradeError(socket, res.statusCode ?? 502, res.statusMessage ?? 'Bad Gateway');
  });

  proxyReq.on('error', () => {
    writeUpgradeError(socket, 502, 'Bad Gateway');
  });

  proxyReq.end();
}

function registerPreviewWebSocketProxy(app: FastifyInstance, previewService: PreviewService): void {
  app.server.on('upgrade', (req, socket, head) => {
    const parsed = parsePreviewPath(req.url ?? '');
    if (!parsed) return;

    const isTunnel = Boolean(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);
    if (isTunnel && TunnelService.isRunning()) {
      const token = extractTunnelSessionTokenFromCookieHeader(req.headers.cookie);
      if (!token || !TunnelService.validateToken(token)) {
        writeUpgradeError(socket, 401, 'Unauthorized');
        return;
      }
    }

    previewService.getTarget(parsed.workspaceId)
      .then((target) => {
        if (!target) {
          writeUpgradeError(socket, 404, 'Not Found');
          return;
        }
        proxyWebSocketRequest(req, socket, head, parsed.workspaceId, target);
      })
      .catch(() => {
        writeUpgradeError(socket, 502, 'Bad Gateway');
      });
  });
}

export async function previewRoutes(app: FastifyInstance) {
  const previewService = new PreviewService();
  registerPreviewWebSocketProxy(app, previewService);

  app.get<{ Params: { workspaceId: string } }>(
    '/api/previews/:workspaceId/status',
    async (request, reply) => {
      try {
        return await previewService.getStatus(request.params.workspaceId);
      } catch (err) {
        return errorResponse(err, reply);
      }
    },
  );

  app.put<{ Params: { workspaceId: string }; Body: { target: string | null } }>(
    '/api/previews/:workspaceId/config',
    async (request, reply) => {
      try {
        const body = configSchema.parse(request.body);
        const target = await previewService.setTarget(request.params.workspaceId, body.target);
        const status = await previewService.getStatus(request.params.workspaceId);
        return {
          ...status,
          target: target?.target ?? null,
        };
      } catch (err) {
        return errorResponse(err, reply);
      }
    },
  );

  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = parsePreviewPath(request.raw.url ?? '');
    if (!parsed) return reply.code(404).send({ error: 'Preview route not found', code: 'NOT_FOUND' });

    try {
      const target = await previewService.getTarget(parsed.workspaceId);
      if (!target) {
        return reply.code(404).send({ error: 'Preview target is not configured', code: 'PREVIEW_NOT_CONFIGURED' });
      }

      reply.hijack();
      await proxyHttpRequest(request, reply.raw, parsed.workspaceId, target);
    } catch (err) {
      if (!reply.sent) return errorResponse(err, reply);
      reply.raw.end();
    }
  };

  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    url: '/view/:workspaceId',
    handler,
  });

  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    url: '/view/:workspaceId/*',
    handler,
  });
}
