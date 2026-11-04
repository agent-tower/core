import http from 'node:http';
import https from 'node:https';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { NormalizedPreviewTarget } from './preview.service.js';
import {
  buildPreviewBootstrapPage,
  buildPreviewBridgeScript,
  buildPreviewServiceWorkerScript,
  injectPreviewBridge,
  PREVIEW_BASE_PATH_HEADER,
  PREVIEW_BOOT_PARAM,
  PREVIEW_DESTINATION_HEADER,
  PREVIEW_INTERNAL_QUERY_PARAMS,
  PREVIEW_MODE_PARAM,
  PREVIEW_SERVICE_WORKER_HEADER,
  PREVIEW_SERVICE_WORKER_SEGMENT,
  PREVIEW_TARGET_HEADER,
} from './preview-bridge.js';
import {
  filterTargetCookieHeader,
  PREVIEW_CONTEXT_COOKIE_NAME,
  previewCookieScopeName,
  rewriteTargetCookie,
} from './preview-cookies.js';
import { buildPreviewPathPrefix, parsePreviewPath, PREVIEW_PREFIX } from '../utils/preview-path.js';

/**
 * Same-origin workspace preview proxy mounted at `/view/:workspaceId/`.
 *
 * The browser only ever talks to Agent Tower's own origin, so the preview is
 * reachable from exactly the places Agent Tower itself is reachable from:
 * localhost, the LAN, a Cloudflare tunnel, a reverse proxy, or Docker.
 */

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
].join(' ');

const PREVIEW_CONTEXT_COOKIE_MAX_AGE_SECONDS = 24 * 60 * 60;
const EMBEDDED_DESTINATIONS = new Set(['iframe', 'frame', 'embed', 'object']);
const DOCUMENT_DESTINATIONS = new Set(['document', ...EMBEDDED_DESTINATIONS]);
const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'upgrade',
  'content-length',
  'accept-encoding',
  'proxy-authorization',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user',
  PREVIEW_SERVICE_WORKER_HEADER,
  PREVIEW_DESTINATION_HEADER,
]);

type ProxyRequestOptions = http.RequestOptions & { rejectUnauthorized?: boolean };

export interface PreviewProxyScope {
  workspaceId: string;
  target: NormalizedPreviewTarget;
  previewToken: string | null;
}

export interface PreviewRequestContext {
  /** The request was issued by the preview service worker. */
  serviceWorker: boolean;
  /** A navigation: top-level tab or embedded frame document. */
  document: boolean;
  /** The navigation is rendered inside a frame (iframe/embed/object). */
  embedded: boolean;
  /** The browser requested the plain (no service worker) proxy mode. */
  plainMode: boolean;
  /** Set after the bootstrap page registered the worker and re-navigated. */
  bootstrapped: boolean;
}

export function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function requestProtocol(headers: IncomingHttpHeaders): 'http' | 'https' {
  const forwarded = firstHeaderValue(headers['x-forwarded-proto']);
  if (forwarded?.split(',')[0]?.trim().toLowerCase() === 'https') return 'https';

  const cfVisitor = firstHeaderValue(headers['cf-visitor']);
  if (cfVisitor) {
    try {
      if ((JSON.parse(cfVisitor) as { scheme?: unknown }).scheme === 'https') return 'https';
    } catch {
      // Ignore malformed Cloudflare metadata.
    }
  }
  return 'http';
}

function isHtmlAcceptHeader(accept: string | undefined): boolean {
  return typeof accept === 'string' && accept.toLowerCase().includes('text/html');
}

export function classifyPreviewRequest(method: string, headers: IncomingHttpHeaders, search: string): PreviewRequestContext {
  const params = new URLSearchParams(search);
  const swHeader = firstHeaderValue(headers[PREVIEW_SERVICE_WORKER_HEADER]);
  const serviceWorker = Boolean(swHeader);
  const upperMethod = method.toUpperCase();
  const navigationMethod = upperMethod === 'GET' || upperMethod === 'HEAD' || upperMethod === 'POST';

  if (serviceWorker) {
    const destination = firstHeaderValue(headers[PREVIEW_DESTINATION_HEADER]) ?? '';
    const document = swHeader === 'navigate';
    return {
      serviceWorker: true,
      document,
      embedded: document && EMBEDDED_DESTINATIONS.has(destination),
      plainMode: false,
      bootstrapped: params.get(PREVIEW_BOOT_PARAM) === '1',
    };
  }

  const destination = firstHeaderValue(headers['sec-fetch-dest']);
  const document = navigationMethod && (
    destination
      ? DOCUMENT_DESTINATIONS.has(destination)
      : isHtmlAcceptHeader(firstHeaderValue(headers.accept))
  );
  return {
    serviceWorker: false,
    document,
    embedded: document && (destination ? EMBEDDED_DESTINATIONS.has(destination) : false),
    plainMode: params.get(PREVIEW_MODE_PARAM) === 'plain',
    bootstrapped: params.get(PREVIEW_BOOT_PARAM) === '1',
  };
}

/** Should the request be answered with the service worker bootstrap page instead of the target document? */
export function shouldServeBootstrap(context: PreviewRequestContext, method: string): boolean {
  if (method.toUpperCase() !== 'GET') return false;
  return context.document && !context.serviceWorker && !context.plainMode && !context.bootstrapped;
}

export function stripInternalQueryParams(search: string): string {
  if (!search) return '';
  const params = new URLSearchParams(search);
  for (const name of PREVIEW_INTERNAL_QUERY_PARAMS) params.delete(name);
  const next = params.toString();
  return next ? `?${next}` : '';
}

export function joinTargetPath(target: NormalizedPreviewTarget, suffix: string, search: string): string {
  const normalizedSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
  const base = target.basePath || '';
  const path = `${base}${normalizedSuffix}`.replace(/\/{2,}/g, '/');
  return `${path || '/'}${search}`;
}

function getPathname(value: string): string {
  const end = value.search(/[?#]/);
  return end === -1 ? value : value.slice(0, end);
}

function isSameOrChildPath(pathname: string, basePath: string): boolean {
  return pathname === basePath || pathname.startsWith(`${basePath}/`);
}

/** Map a browser URL on the Agent Tower origin back to the target URL it represents. */
function browserUrlToTargetUrl(value: string, scope: PreviewProxyScope): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const parsed = parsePreviewPath(`${url.pathname}${url.search}`);
  const targetUrl = new URL(scope.target.origin);
  if (parsed && parsed.workspaceId === scope.workspaceId) {
    targetUrl.pathname = getPathname(joinTargetPath(scope.target, parsed.suffix, ''));
    targetUrl.search = stripInternalQueryParams(parsed.search);
  } else {
    // Virtualized documents report target-relative paths directly.
    targetUrl.pathname = getPathname(joinTargetPath(scope.target, url.pathname, ''));
    targetUrl.search = stripInternalQueryParams(url.search);
  }
  targetUrl.hash = '';
  return targetUrl.toString();
}

export function proxyRequestHeaders(
  headers: IncomingHttpHeaders,
  scope: PreviewProxyScope,
  targetPath: string,
): http.OutgoingHttpHeaders {
  const targetUrl = new URL(scope.target.origin);
  const next: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (STRIPPED_REQUEST_HEADERS.has(lower) || lower.startsWith('cf-')) continue;
    if (value !== undefined) next[lower] = value;
  }

  const cookie = filterTargetCookieHeader(firstHeaderValue(headers.cookie), previewCookieScopeName(scope.workspaceId));
  if (cookie) next.cookie = cookie;
  else delete next.cookie;

  next.host = targetUrl.host;
  next['accept-encoding'] = 'identity';
  next['x-forwarded-host'] = firstHeaderValue(headers.host) ?? targetUrl.host;
  next['x-forwarded-proto'] = requestProtocol(headers);

  if (headers.origin) next.origin = targetUrl.origin;
  const referer = firstHeaderValue(headers.referer);
  if (referer) {
    next.referer = browserUrlToTargetUrl(referer, scope) ?? new URL(targetPath, targetUrl).toString();
  }

  return next;
}

export function rewriteLocationHeader(value: string, scope: PreviewProxyScope): string {
  const prefix = buildPreviewPathPrefix(scope.workspaceId, scope.previewToken);
  const { target } = scope;

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

export function serializePreviewContextCookie(workspaceId: string, secure: boolean): string {
  const parts = [
    `${PREVIEW_CONTEXT_COOKIE_NAME}=${encodeURIComponent(workspaceId)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${PREVIEW_CONTEXT_COOKIE_MAX_AGE_SECONDS}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export interface ProxyResponseHeaderOptions {
  /** Response is an HTML navigation that will receive the bridge script. */
  document: boolean;
  /** The document is rendered inside a frame; adds the defensive sandbox CSP. */
  embedded: boolean;
  /** The body is buffered and modified, so the original length no longer applies. */
  rewritesBody?: boolean;
}

export function proxyResponseHeaders(
  headers: IncomingHttpHeaders,
  scope: PreviewProxyScope,
  requestHeaders: IncomingHttpHeaders,
  options: ProxyResponseHeaderOptions,
): http.OutgoingHttpHeaders {
  const next: http.OutgoingHttpHeaders = {};
  const secure = requestProtocol(requestHeaders) === 'https';

  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (
      lower === 'connection'
      || (lower === 'content-length' && (options.rewritesBody ?? options.document))
      || lower === 'content-encoding'
      || lower === 'transfer-encoding'
      || lower === 'keep-alive'
      || lower === 'x-frame-options'
      || lower === 'content-security-policy'
      || lower === 'content-security-policy-report-only'
    ) {
      continue;
    }

    if (lower === 'location' && typeof value === 'string') {
      next[key] = rewriteLocationHeader(value, scope);
      continue;
    }

    if (lower === 'set-cookie') {
      const cookies = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
      next[key] = cookies.map((cookie) => rewriteTargetCookie(
        cookie,
        scope.target,
        previewCookieScopeName(scope.workspaceId),
        secure,
        { forceRootPath: true },
      ));
      continue;
    }

    if (value !== undefined) next[key] = value;
  }

  if (options.document) {
    next[PREVIEW_TARGET_HEADER] = scope.target.origin;
    next[PREVIEW_BASE_PATH_HEADER] = scope.target.basePath;
    const existing = next['set-cookie'];
    const cookies = Array.isArray(existing) ? existing : typeof existing === 'string' ? [existing] : [];
    next['set-cookie'] = [...cookies, serializePreviewContextCookie(scope.workspaceId, secure)];
    if (options.embedded) next['content-security-policy'] = PREVIEW_SANDBOX_CSP;
    next['cache-control'] = 'no-store';
  }

  return next;
}

function isHtmlResponse(headers: IncomingHttpHeaders): boolean {
  const contentType = firstHeaderValue(headers['content-type'])?.toLowerCase() ?? '';
  return contentType.includes('text/html');
}

function isCssResponse(headers: IncomingHttpHeaders): boolean {
  const contentType = firstHeaderValue(headers['content-type'])?.toLowerCase() ?? '';
  return contentType.includes('text/css');
}

/**
 * Plain mode only (no service worker): rewrite static root-relative references
 * in HTML/CSS so the first paint works without a redirect round trip for every
 * asset. Service-worker documents are left untouched.
 */
export function rewritePlainModeBody(body: string, prefix: string, kind: 'html' | 'css'): string {
  let next = body;
  if (kind === 'html') {
    next = next
      .replace(/(\s(?:src|href|action|poster|data|formaction)=["'])\/(?!\/|view\/)([^"']*)/gi, `$1${prefix}/$2`)
      .replace(/(\s(?:srcset|imagesrcset)=["'])([^"']*)(["'])/gi, (_match, before: string, srcset: string, after: string) => {
        const rewritten = srcset.replace(/(^|,\s*)\/(?!\/|view\/)([^\s,]+)/g, `$1${prefix}/$2`);
        return `${before}${rewritten}${after}`;
      });
  }
  next = next.replace(/url\((['"]?)\/(?!\/|view\/)([^)'"]+)\1\)/g, `url($1${prefix}/$2$1)`);
  return next;
}

export function buildBridgeTag(scope: PreviewProxyScope, serviceWorker: boolean): string {
  return buildPreviewBridgeScript({
    mode: 'prefix',
    prefix: buildPreviewPathPrefix(scope.workspaceId, scope.previewToken),
    workspaceId: scope.workspaceId,
    targetOrigin: scope.target.origin,
    targetBasePath: scope.target.basePath,
    serviceWorker,
  });
}

export function previewServiceWorkerSegment(suffix: string): boolean {
  return suffix === `/${PREVIEW_SERVICE_WORKER_SEGMENT}`;
}

export function writeServiceWorkerScript(response: ServerResponse): void {
  response.writeHead(200, {
    'content-type': 'application/javascript; charset=utf-8',
    'cache-control': 'no-cache',
    'service-worker-allowed': `${PREVIEW_PREFIX}/`,
  });
  response.end(buildPreviewServiceWorkerScript());
}

export function writeBootstrapPage(response: ServerResponse, scope: PreviewProxyScope): void {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(buildPreviewBootstrapPage({
    scope: `${buildPreviewPathPrefix(scope.workspaceId, scope.previewToken)}/`,
  }));
}

function writeProxyError(response: ServerResponse, message: string): void {
  if (!response.headersSent) {
    response.writeHead(502, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
  }
  const escaped = message.replace(/[&<>"]/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char] ?? char
  ));
  response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Preview unavailable</title></head>`
    + `<body style="font:14px system-ui,sans-serif;color:#6b7280;padding:24px">`
    + `<p data-agent-tower-preview-error>Preview target unavailable: ${escaped}</p>`
    + `<p>Start the preview server, then refresh.</p></body></html>`);
}

export interface ProxyHttpRequestInput {
  request: IncomingMessage;
  response: ServerResponse;
  scope: PreviewProxyScope;
  suffix: string;
  search: string;
  context: PreviewRequestContext;
  body: Buffer | null;
}

export async function proxyPreviewHttpRequest(input: ProxyHttpRequestInput): Promise<void> {
  const { request, response, scope, context } = input;
  const targetUrl = new URL(scope.target.origin);
  const targetPath = joinTargetPath(scope.target, input.suffix, stripInternalQueryParams(input.search));
  const headers = proxyRequestHeaders(request.headers, scope, targetPath);
  if (input.body) headers['content-length'] = Buffer.byteLength(input.body);
  const prefix = buildPreviewPathPrefix(scope.workspaceId, scope.previewToken);

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
    const proxyRequest = transport.request(options, (proxyResponse) => {
      const statusCode = proxyResponse.statusCode ?? 502;
      const hasBody = request.method !== 'HEAD' && statusCode !== 204 && statusCode !== 304;
      const html = hasBody && isHtmlResponse(proxyResponse.headers);
      const documentResponse = context.document && html;
      const rewriteCss = hasBody && !context.serviceWorker && isCssResponse(proxyResponse.headers);
      const rewriteBody = documentResponse || rewriteCss;
      const responseHeaders = proxyResponseHeaders(proxyResponse.headers, scope, request.headers, {
        document: documentResponse,
        embedded: context.embedded,
        rewritesBody: rewriteBody,
      });
      response.statusCode = statusCode;
      for (const [key, value] of Object.entries(responseHeaders)) {
        if (value !== undefined) response.setHeader(key, value);
      }

      if (!rewriteBody) {
        proxyResponse.pipe(response);
        proxyResponse.once('end', resolve);
        proxyResponse.once('error', () => {
          response.destroy();
          resolve();
        });
        return;
      }

      const chunks: Buffer[] = [];
      proxyResponse.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      proxyResponse.once('end', () => {
        let payload: Buffer = Buffer.concat(chunks);
        if (documentResponse) {
          if (!context.serviceWorker) {
            payload = Buffer.from(rewritePlainModeBody(payload.toString('utf8'), prefix, 'html'), 'utf8');
          }
          payload = injectPreviewBridge(payload, buildBridgeTag(scope, context.serviceWorker));
        } else if (rewriteCss) {
          payload = Buffer.from(rewritePlainModeBody(payload.toString('utf8'), prefix, 'css'), 'utf8');
        }
        response.end(payload);
        resolve();
      });
      proxyResponse.once('error', () => {
        response.destroy();
        resolve();
      });
    });

    proxyRequest.once('error', (error) => {
      writeProxyError(response, error.message);
      resolve();
    });
    proxyRequest.end(input.body ?? undefined);
  });
}

export function writeUpgradeError(socket: Duplex, statusCode: number, message: string): void {
  if (socket.destroyed) return;
  socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

export function proxyPreviewWebSocket(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  scope: PreviewProxyScope,
  suffix: string,
  search: string,
): void {
  socket.on('error', () => {
    if (!socket.destroyed) socket.destroy();
  });

  const targetUrl = new URL(scope.target.origin);
  const targetPath = joinTargetPath(scope.target, suffix, stripInternalQueryParams(search));
  const headers = proxyRequestHeaders(request.headers, scope, targetPath);
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
  const proxyRequest = transport.request(options);

  proxyRequest.once('upgrade', (proxyResponse, proxySocket, proxyHead) => {
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
      `HTTP/1.1 ${proxyResponse.statusCode} ${proxyResponse.statusMessage}`,
      ...Object.entries(proxyResponse.headers).flatMap(([key, value]) => {
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

  proxyRequest.once('response', (proxyResponse) => {
    writeUpgradeError(socket, proxyResponse.statusCode ?? 502, proxyResponse.statusMessage ?? 'Bad Gateway');
  });
  proxyRequest.once('error', () => {
    writeUpgradeError(socket, 502, 'Bad Gateway');
  });
  proxyRequest.end();
}
