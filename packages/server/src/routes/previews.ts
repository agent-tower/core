import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import http from 'node:http';
import https from 'node:https';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { OpenPreviewSessionInput, PreviewSession } from '@agent-tower/shared';
import { PreviewService } from '../services/preview.service.js';
import type { NormalizedPreviewTarget } from '../services/preview.service.js';
import { ServiceError } from '../errors.js';
import { TunnelService } from '../services/tunnel.service.js';
import {
  TUNNEL_SESSION_COOKIE_NAME,
  extractTunnelSessionTokenFromCookieHeader,
} from '../utils/tunnel-cookie.js';
import { AccessAuthService } from '../services/access-auth.service.js';
import {
  INTERNAL_API_TOKEN_HEADER,
  validateInternalApiToken,
} from '../utils/internal-api-token.js';
import {
  buildPreviewPathPrefix,
  parsePreviewPath,
  PREVIEW_PREFIX,
} from '../utils/preview-path.js';
import {
  addPreviewAccessToken,
  PreviewRuntimeManager,
  type PreviewGatewaySession,
} from '../services/preview-runtime-manager.js';
import { isTunnelRequest } from '../middleware/tunnel-auth.js';

export const PREVIEW_SANDBOX_CSP = [
  'sandbox',
  'allow-scripts',
  'allow-same-origin',
  'allow-forms',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
  'allow-modals',
  'allow-downloads',
  'allow-pointer-lock',
  'allow-presentation',
  'allow-top-navigation-by-user-activation',
].join(' ');
const PREVIEW_CORS_ALLOW_METHODS = 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS';
const PREVIEW_CORS_DEFAULT_ALLOW_HEADERS = 'Content-Type, Accept, Authorization, X-Requested-With';
const INTERNAL_COOKIE_NAMES = new Set([
  TUNNEL_SESSION_COOKIE_NAME,
  AccessAuthService.cookieName,
]);

type ProxyRequestOptions = http.RequestOptions & { rejectUnauthorized?: boolean };

const configSchema = z.object({
  target: z.string().nullable(),
});

const previewSessionSchema = z.object({
  mode: z.enum(['local', 'remote']),
  localHostname: z.string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^(?:\[[0-9a-fA-F:]+\]|[0-9a-zA-Z.-]+)$/, 'Invalid preview hostname'),
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

export function proxyRequestHeaders(
  headers: IncomingHttpHeaders,
  targetUrl: URL,
  targetPath = '/',
): http.OutgoingHttpHeaders {
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
  next['x-forwarded-host'] = targetUrl.host;
  next['x-forwarded-proto'] = targetUrl.protocol.slice(0, -1);

  if (headers.origin) {
    next.origin = targetUrl.origin;
  }

  if (headers.referer) {
    next.referer = new URL(targetPath, targetUrl).toString();
  } else {
    delete next.referer;
  }

  return next;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeRequestedHeaders(value: string | undefined): string {
  if (!value) return PREVIEW_CORS_DEFAULT_ALLOW_HEADERS;
  const headers = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return headers.length > 0 ? headers.join(', ') : PREVIEW_CORS_DEFAULT_ALLOW_HEADERS;
}

export function previewCorsHeaders(requestHeaders?: IncomingHttpHeaders): http.OutgoingHttpHeaders {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': PREVIEW_CORS_ALLOW_METHODS,
    'access-control-allow-headers': normalizeRequestedHeaders(
      firstHeaderValue(requestHeaders?.['access-control-request-headers']),
    ),
    'access-control-max-age': '600',
    'vary': 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
  };
}

export function rewriteLocationHeader(
  value: string,
  workspaceId: string,
  target: NormalizedPreviewTarget,
  previewToken?: string | null,
): string {
  const prefix = buildPreviewPathPrefix(workspaceId, previewToken);

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

export function rewriteSetCookieHeader(
  value: string,
  workspaceId: string,
  previewToken?: string | null,
): string {
  const prefix = `${buildPreviewPathPrefix(workspaceId, previewToken)}/`;
  const withoutDomain = value.replace(/;\s*domain=[^;]*/gi, '');
  if (/;\s*path=/i.test(withoutDomain)) {
    return withoutDomain.replace(/;\s*path=([^;]*)/i, `; Path=${prefix}`);
  }
  return `${withoutDomain}; Path=${prefix}`;
}

export function proxyResponseHeaders(
  headers: IncomingHttpHeaders,
  workspaceId: string,
  target: NormalizedPreviewTarget,
  requestHeaders?: IncomingHttpHeaders,
  previewToken?: string | null,
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

    if (lower.startsWith('access-control-')) {
      continue;
    }

    if (lower === 'location' && typeof value === 'string') {
      next[key] = rewriteLocationHeader(value, workspaceId, target, previewToken);
      continue;
    }

    if (lower === 'set-cookie') {
      const cookies = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
      next[key] = cookies.map((cookie) => rewriteSetCookieHeader(cookie, workspaceId, previewToken));
      continue;
    }

    if (value !== undefined) next[key] = value;
  }

  next['content-security-policy'] = PREVIEW_SANDBOX_CSP;
  Object.assign(next, previewCorsHeaders(requestHeaders));
  next['cross-origin-resource-policy'] = 'cross-origin';

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

  if (
    isSameOrChildPath(pathname, '/api')
    || isSameOrChildPath(pathname, '/socket.io')
    || isSameOrChildPath(pathname, '/ws')
  ) {
    return true;
  }
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

function injectPreviewRuntimeBridge(
  body: string,
  prefix: string,
  target: NormalizedPreviewTarget,
): string {
  const script = `<script data-agent-tower-preview-bridge>(() => {
  const prefix = ${JSON.stringify(prefix)};
  const targetOrigin = ${JSON.stringify(target.origin)};
  const targetBasePath = ${JSON.stringify(target.basePath)};
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);
  const normalizeProtocol = (protocol) => protocol === 'ws:' ? 'http:' : protocol === 'wss:' ? 'https:' : protocol;
  const normalizeHost = (hostname) => loopbackHosts.has(hostname.toLowerCase()) ? 'loopback' : hostname.toLowerCase();
  const effectivePort = (url) => url.port || (normalizeProtocol(url.protocol) === 'https:' ? '443' : '80');
  const sameEndpoint = (left, right) => normalizeProtocol(left.protocol) === normalizeProtocol(right.protocol)
    && normalizeHost(left.hostname) === normalizeHost(right.hostname)
    && effectivePort(left) === effectivePort(right);
  const isPrefixed = (pathname) => pathname === prefix || pathname.startsWith(prefix + '/');
  const rewrite = (value) => {
    if (value === undefined || value === null) return value;
    const raw = value instanceof URL ? value.toString() : String(value);
    let url;
    try {
      url = new URL(raw, window.location.href);
    } catch {
      return value;
    }
    if (isPrefixed(url.pathname)) return raw;

    const browserUrl = new URL(window.location.href);
    const localTarget = new URL(targetOrigin);
    const isRootRelative = raw.startsWith('/') && !raw.startsWith('//');
    const isBrowserEndpoint = sameEndpoint(url, browserUrl);
    const isTargetEndpoint = sameEndpoint(url, localTarget);
    if (!isRootRelative && !isTargetEndpoint) return value;
    if (isBrowserEndpoint && !isRootRelative) return value;

    let pathname = url.pathname;
    if (isTargetEndpoint && targetBasePath) {
      const underBasePath = pathname === targetBasePath || pathname.startsWith(targetBasePath + '/');
      if (underBasePath) pathname = pathname.slice(targetBasePath.length) || '/';
    }
    const protocol = url.protocol === 'ws:' || url.protocol === 'wss:'
      ? (window.location.protocol === 'https:' ? 'wss:' : 'ws:')
      : window.location.protocol;
    return protocol + '//' + window.location.host + prefix + pathname + url.search + url.hash;
  };

  const nativePushState = History.prototype.pushState;
  const nativeReplaceState = History.prototype.replaceState;
  History.prototype.pushState = function(state, unused, url) {
    return nativePushState.call(this, state, unused, url == null ? url : rewrite(url));
  };
  History.prototype.replaceState = function(state, unused, url) {
    return nativeReplaceState.call(this, state, unused, url == null ? url : rewrite(url));
  };

  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    if (typeof input === 'string' || input instanceof URL) return nativeFetch(rewrite(input), init);
    if (input instanceof Request) return nativeFetch(new Request(rewrite(input.url), input), init);
    return nativeFetch(input, init);
  };

  const nativeXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    return nativeXhrOpen.call(this, method, rewrite(url), ...rest);
  };

  const NativeWebSocket = window.WebSocket;
  function PreviewWebSocket(url, protocols) {
    const nextUrl = rewrite(url);
    return protocols === undefined ? new NativeWebSocket(nextUrl) : new NativeWebSocket(nextUrl, protocols);
  }
  PreviewWebSocket.prototype = NativeWebSocket.prototype;
  Object.setPrototypeOf(PreviewWebSocket, NativeWebSocket);
  window.WebSocket = PreviewWebSocket;

  const NativeEventSource = window.EventSource;
  if (NativeEventSource) {
    function PreviewEventSource(url, options) {
      return new NativeEventSource(rewrite(url), options);
    }
    PreviewEventSource.prototype = NativeEventSource.prototype;
    Object.setPrototypeOf(PreviewEventSource, NativeEventSource);
    window.EventSource = PreviewEventSource;
  }
})();</script>`;

  const head = /<head(?:\s[^>]*)?>/i;
  if (head.test(body)) return body.replace(head, (match) => `${match}${script}`);
  return `${script}${body}`;
}

export function rewritePreviewBody(
  body: string,
  workspaceId: string,
  contentType?: string | string[],
  previewToken?: string | null,
  target?: NormalizedPreviewTarget,
): string {
  const prefix = buildPreviewPathPrefix(workspaceId, previewToken);
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

  if (lower.includes('text/html') && target) {
    next = injectPreviewRuntimeBridge(next, prefix, target);
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
  previewToken?: string | null,
): Promise<void> {
  const parsed = parsePreviewPath(request.raw.url ?? '');
  if (!parsed) {
    response.writeHead(404);
    response.end('Preview route not found');
    return;
  }

  const targetUrl = new URL(target.origin);
  const targetPath = joinTargetPath(target, parsed.suffix, parsed.search);
  const body = requestBodyBuffer(request);
  const headers = proxyRequestHeaders(request.headers, targetUrl, targetPath);
  if (body) headers['content-length'] = Buffer.byteLength(body);

  const options: ProxyRequestOptions = {
    protocol: targetUrl.protocol,
    hostname: targetUrl.hostname,
    port: targetUrl.port,
    method: request.method,
    path: targetPath,
    headers,
    rejectUnauthorized: false,
  };

  const transport = targetUrl.protocol === 'https:' ? https : http;

  await new Promise<void>((resolve) => {
    const proxyReq = transport.request(options, (proxyRes: IncomingMessage) => {
      const headers = proxyResponseHeaders(proxyRes.headers, workspaceId, target, request.headers, previewToken);
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
        response.end(rewritePreviewBody(text, workspaceId, proxyRes.headers['content-type'], previewToken, target));
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
  if (socket.destroyed) return;
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

  socket.on('error', () => {
    if (!socket.destroyed) socket.destroy();
  });

  const targetUrl = new URL(target.origin);
  const targetPath = joinTargetPath(target, parsed.suffix, parsed.search);
  const headers = proxyRequestHeaders(req.headers, targetUrl, targetPath);
  headers.connection = 'Upgrade';
  headers.upgrade = 'websocket';

  const options: ProxyRequestOptions = {
    protocol: targetUrl.protocol,
    hostname: targetUrl.hostname,
    port: targetUrl.port,
    method: 'GET',
    path: targetPath,
    headers,
    rejectUnauthorized: false,
  };

  const transport = targetUrl.protocol === 'https:' ? https : http;
  const proxyReq = transport.request(options);

  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    const closeClient = () => {
      if (!socket.destroyed) socket.destroy();
    };
    const closeTarget = () => {
      if (!proxySocket.destroyed) proxySocket.destroy();
    };
    socket.once('close', closeTarget);
    socket.once('error', closeTarget);
    proxySocket.once('close', closeClient);
    proxySocket.once('error', closeClient);

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
  app.server.on('upgrade', async (req, socket, head) => {
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

    const internalToken = req.headers[INTERNAL_API_TOKEN_HEADER];
    const normalizedInternalToken = Array.isArray(internalToken) ? internalToken[0] : internalToken;
    if (internalToken !== undefined) {
      if (!validateInternalApiToken(normalizedInternalToken)) {
        writeUpgradeError(socket, 401, 'Invalid Internal Token');
        return;
      }
    } else if (!parsed.previewToken || !await AccessAuthService.validatePreviewAccessToken(parsed.previewToken, parsed.workspaceId)) {
      const accessToken = AccessAuthService.extractCookieFromHeader(req.headers.cookie);
      if (!await AccessAuthService.validateSessionToken(accessToken)) {
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
  const previewRuntimeManager = new PreviewRuntimeManager();
  registerPreviewWebSocketProxy(app, previewService);

  const sessionResponse = async (session: PreviewGatewaySession): Promise<PreviewSession> => {
    const accessToken = await AccessAuthService.createPreviewAccessToken(session.workspaceId);
    return {
      id: session.id,
      target: session.target,
      mode: session.mode,
      viewUrl: addPreviewAccessToken(session.viewBaseUrl, accessToken),
      expiresAt: session.expiresAt,
    };
  };

  app.addHook('onClose', async () => {
    await previewRuntimeManager.stopAll();
  });

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
        await previewRuntimeManager.invalidate(request.params.workspaceId);
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

  app.post<{
    Params: { workspaceId: string };
    Body: OpenPreviewSessionInput;
  }>('/api/previews/:workspaceId/sessions', async (request, reply) => {
    try {
      const body = previewSessionSchema.parse(request.body);
      const target = await previewService.getTarget(request.params.workspaceId);
      if (!target) {
        return reply.code(404).send({
          error: 'Preview target is not configured',
          code: 'PREVIEW_NOT_CONFIGURED',
        });
      }

      const forceRemote = process.env.AGENT_TOWER_PREVIEW_FORCE_TUNNEL === 'true';
      const mode = isTunnelRequest(request) || forceRemote ? 'remote' : body.mode;
      const session = await previewRuntimeManager.acquire(
        request.params.workspaceId,
        target,
        mode,
        body.localHostname,
      );
      return sessionResponse(session);
    } catch (err) {
      return errorResponse(err, reply);
    }
  });

  app.post<{
    Params: { workspaceId: string; sessionId: string };
  }>('/api/previews/:workspaceId/sessions/:sessionId/heartbeat', async (request, reply) => {
    try {
      const session = await previewRuntimeManager.heartbeat(
        request.params.workspaceId,
        request.params.sessionId,
      );
      if (!session) {
        return reply.code(404).send({
          error: 'Preview session expired',
          code: 'PREVIEW_SESSION_EXPIRED',
        });
      }
      return sessionResponse(session);
    } catch (err) {
      return errorResponse(err, reply);
    }
  });

  app.delete<{
    Params: { workspaceId: string; sessionId: string };
  }>('/api/previews/:workspaceId/sessions/:sessionId', async (request, reply) => {
    previewRuntimeManager.release(request.params.workspaceId, request.params.sessionId);
    return reply.code(204).send();
  });

  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = parsePreviewPath(request.raw.url ?? '');
    if (!parsed) return reply.code(404).send({ error: 'Preview route not found', code: 'NOT_FOUND' });

    try {
      if (request.method.toUpperCase() === 'OPTIONS' && request.headers['access-control-request-method']) {
        return reply
          .code(204)
          .headers(previewCorsHeaders(request.headers))
          .send();
      }

      const target = await previewService.getTarget(parsed.workspaceId);
      if (!target) {
        return reply.code(404).send({ error: 'Preview target is not configured', code: 'PREVIEW_NOT_CONFIGURED' });
      }

      reply.hijack();
      await proxyHttpRequest(request, reply.raw, parsed.workspaceId, target, parsed.previewToken);
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
