import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { Tunnel } from 'cloudflared';
import { AccessAuthService } from './access-auth.service.js';
import type { NormalizedPreviewTarget } from './preview.service.js';
import { ACCESS_AUTH_COOKIE_NAME } from './access-auth.service.js';
import { TUNNEL_SESSION_COOKIE_NAME } from '../utils/tunnel-cookie.js';

export const PREVIEW_GATEWAY_TOKEN_PARAM = '__agent_tower_preview_token';
export const PREVIEW_BRIDGE_PATH = '/__agent_tower_preview_bridge.js';
export const PREVIEW_HEARTBEAT_PATH = '/__agent_tower_preview_heartbeat';

const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_LEASE_TTL_MS = 3 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 30 * 1000;
const TUNNEL_STARTUP_TIMEOUT_MS = 30 * 1000;
const PREVIEW_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const QUICK_TUNNEL_OPTIONS = { '--no-autoupdate': true } as const;
const INTERNAL_COOKIE_NAMES = new Set([
  ACCESS_AUTH_COOKIE_NAME,
  TUNNEL_SESSION_COOKIE_NAME,
]);

type ProxyRequestOptions = http.RequestOptions & { rejectUnauthorized?: boolean };
type PreviewMode = 'local' | 'remote';

interface PreviewTunnel {
  stop(): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  once(event: 'url', listener: (url: string) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  off(event: 'url', listener: (url: string) => void): this;
  off(event: 'error', listener: (error: Error) => void): this;
  off(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

interface PreviewLease {
  id: string;
  mode: PreviewMode;
  localHostname: string;
  expiresAtMs: number;
}

interface PreviewRuntime {
  workspaceId: string;
  target: NormalizedPreviewTarget;
  server: http.Server;
  port: number;
  cookieName: string;
  accessSecret: string;
  accessGeneration: number;
  leases: Map<string, PreviewLease>;
  lastActivityAtMs: number;
  tunnelLastActivityAtMs: number;
  activeConnections: number;
  activeRemoteConnections: number;
  sockets: Set<Duplex>;
  tunnel: PreviewTunnel | null;
  tunnelUrl: string | null;
  tunnelStartPromise: Promise<string> | null;
  stopped: boolean;
}

export interface PreviewGatewaySession {
  id: string;
  workspaceId: string;
  target: string;
  mode: PreviewMode;
  viewBaseUrl: string;
  expiresAt: string;
}

export interface PreviewRuntimeManagerOptions {
  idleTtlMs?: number;
  leaseTtlMs?: number;
  sweepIntervalMs?: number;
  listenHost?: string;
  now?: () => number;
  createTunnel?: (targetUrl: string) => PreviewTunnel;
}

const PREVIEW_BRIDGE_SCRIPT = `(() => {
  const previewSource = 'agent-tower-preview';
  const hostSource = 'agent-tower-preview-host';
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);
  const post = (message) => {
    if (window.parent !== window) window.parent.postMessage({ source: previewSource, ...message }, '*');
  };
  const sendLocation = () => post({ type: 'location', href: window.location.href, title: document.title });
  const scheduleLocation = () => window.setTimeout(sendLocation, 0);

  const nativePushState = History.prototype.pushState;
  const nativeReplaceState = History.prototype.replaceState;
  History.prototype.pushState = function(...args) {
    const result = nativePushState.apply(this, args);
    scheduleLocation();
    return result;
  };
  History.prototype.replaceState = function(...args) {
    const result = nativeReplaceState.apply(this, args);
    scheduleLocation();
    return result;
  };

  window.addEventListener('popstate', scheduleLocation);
  window.addEventListener('hashchange', scheduleLocation);
  window.addEventListener('pageshow', scheduleLocation);
  document.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!anchor || anchor.hasAttribute('download')) return;
    let url;
    try { url = new URL(anchor.href, window.location.href); } catch { return; }
    if (!loopbackHosts.has(url.hostname.toLowerCase()) || url.origin === window.location.origin) return;
    event.preventDefault();
    post({ type: 'navigate-loopback', href: url.toString(), newTab: anchor.target === '_blank' });
  }, true);

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.source !== hostSource) return;
    if (message.action === 'back') window.history.back();
    else if (message.action === 'forward') window.history.forward();
    else if (message.action === 'reload') window.location.reload();
    else if (message.action === 'stop') window.stop();
  });

  const heartbeat = () => fetch(${JSON.stringify(PREVIEW_HEARTBEAT_PATH)}, {
    credentials: 'include',
    cache: 'no-store',
  }).catch(() => {});
  window.setInterval(heartbeat, 30000);
  heartbeat();
  sendLocation();
})();`;

function nowIso(value: number): string {
  return new Date(value).toISOString();
}

function cookieNameForWorkspace(workspaceId: string): string {
  const suffix = createHash('sha256').update(workspaceId).digest('hex').slice(0, 16);
  return `agent-tower-preview-${suffix}`;
}

function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseCookies(header?: string): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;

  for (const part of header.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (!rawName) continue;
    try {
      cookies.set(rawName, decodeURIComponent(rawValue.join('=')));
    } catch {
      cookies.set(rawName, rawValue.join('='));
    }
  }
  return cookies;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requestProtocol(headers: IncomingHttpHeaders): 'http' | 'https' {
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

function isRemoteGatewayRequest(headers: IncomingHttpHeaders): boolean {
  return Boolean(headers['cf-connecting-ip'] || headers['cf-ray'])
    || requestProtocol(headers) === 'https';
}

function requestOrigin(headers: IncomingHttpHeaders): string {
  const host = firstHeaderValue(headers.host)
    || firstHeaderValue(headers['x-forwarded-host'])?.split(',')[0]?.trim()
    || 'localhost';
  return `${requestProtocol(headers)}://${host}`;
}

function serializeGatewayCookie(runtime: PreviewRuntime, headers: IncomingHttpHeaders): string {
  const secure = requestProtocol(headers) === 'https';
  const parts = [
    `${runtime.cookieName}=${encodeURIComponent(runtime.accessSecret)}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${PREVIEW_COOKIE_MAX_AGE_SECONDS}`,
  ];
  if (secure) {
    parts.push('Secure', 'SameSite=None', 'Partitioned');
  } else {
    parts.push('SameSite=Lax');
  }
  return parts.join('; ');
}

function removeQueryParameter(rawUrl: string, parameter: string): string {
  const url = new URL(rawUrl, 'http://preview.local');
  url.searchParams.delete(parameter);
  return `${url.pathname}${url.search}${url.hash}`;
}

function scopedTargetCookieName(runtimeCookieName: string, targetCookieName: string): string {
  return `${runtimeCookieName}-target-${Buffer.from(targetCookieName).toString('base64url')}`;
}

function unscopedTargetCookieName(runtimeCookieName: string, cookieName: string): string | null {
  for (const internalName of INTERNAL_COOKIE_NAMES) {
    if (cookieName === scopedTargetCookieName(runtimeCookieName, internalName)) return internalName;
  }
  return null;
}

function filterCookieHeader(cookieHeader: string | undefined, runtimeCookieName: string): string | undefined {
  if (!cookieHeader) return undefined;

  const cookies: string[] = [];
  for (const rawPart of cookieHeader.split(';')) {
    const part = rawPart.trim();
    if (!part) continue;
    const separator = part.indexOf('=');
    const name = separator === -1 ? part : part.slice(0, separator);
    if (!name || name === runtimeCookieName) continue;

    const targetName = unscopedTargetCookieName(runtimeCookieName, name);
    if (targetName) {
      cookies.push(`${targetName}${separator === -1 ? '' : part.slice(separator)}`);
      continue;
    }
    if (INTERNAL_COOKIE_NAMES.has(name)) continue;
    cookies.push(part);
  }
  return cookies.length > 0 ? cookies.join('; ') : undefined;
}

function joinTargetPath(target: NormalizedPreviewTarget, requestUrl: string): string {
  const parsed = new URL(requestUrl, 'http://preview.local');
  const suffix = parsed.pathname.startsWith('/') ? parsed.pathname : `/${parsed.pathname}`;
  const path = `${target.basePath}${suffix}`.replace(/\/{2,}/g, '/') || '/';
  return `${path}${parsed.search}`;
}

function rewriteRequestHeaders(
  headers: IncomingHttpHeaders,
  runtime: PreviewRuntime,
  targetPath: string,
): http.OutgoingHttpHeaders {
  const targetUrl = new URL(runtime.target.origin);
  const next: http.OutgoingHttpHeaders = { ...headers };
  delete next.connection;
  delete next.host;
  delete next.upgrade;
  delete next['proxy-authorization'];
  delete next['accept-encoding'];
  delete next.forwarded;
  delete next['x-forwarded-for'];
  delete next['x-real-ip'];
  for (const key of Object.keys(next)) {
    if (key.toLowerCase().startsWith('cf-')) delete next[key];
  }

  const cookie = filterCookieHeader(headers.cookie, runtime.cookieName);
  if (cookie) next.cookie = cookie;
  else delete next.cookie;

  next.host = targetUrl.host;
  next['accept-encoding'] = 'identity';
  next['x-forwarded-host'] = headers.host || firstHeaderValue(headers['x-forwarded-host']) || targetUrl.host;
  next['x-forwarded-proto'] = requestProtocol(headers);

  if (headers.origin) next.origin = targetUrl.origin;
  if (headers.referer) next.referer = new URL(targetPath, targetUrl).toString();
  return next;
}

function rewriteLocation(
  value: string,
  runtime: PreviewRuntime,
  requestHeaders: IncomingHttpHeaders,
): string {
  try {
    const location = new URL(value, runtime.target.origin);
    if (location.origin !== runtime.target.origin) return value;
    if (!/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value)) return value;

    let pathname = location.pathname;
    if (
      runtime.target.basePath
      && (pathname === runtime.target.basePath || pathname.startsWith(`${runtime.target.basePath}/`))
    ) {
      pathname = pathname.slice(runtime.target.basePath.length) || '/';
    }
    return `${requestOrigin(requestHeaders)}${pathname}${location.search}${location.hash}`;
  } catch {
    return value;
  }
}

export function rewriteTargetCookie(
  value: string,
  target: NormalizedPreviewTarget,
  runtimeCookieName: string,
  secureGateway: boolean,
): string {
  let next = value.replace(/;\s*domain=[^;]*/gi, '');
  const separator = next.indexOf('=');
  if (separator > 0) {
    const cookieName = next.slice(0, separator).trim();
    if (INTERNAL_COOKIE_NAMES.has(cookieName)) {
      next = `${scopedTargetCookieName(runtimeCookieName, cookieName)}${next.slice(separator)}`;
    }
  }
  if (target.basePath && /;\s*path=/i.test(next)) {
    next = next.replace(/;\s*path=([^;]*)/i, (_match, rawPath: string) => {
      const path = rawPath.trim();
      if (path === target.basePath) return '; Path=/';
      if (path.startsWith(`${target.basePath}/`)) {
        return `; Path=${path.slice(target.basePath.length) || '/'}`;
      }
      return `; Path=${path || '/'}`;
    });
  }
  if (secureGateway) {
    next = next
      .replace(/;\s*secure(?=;|$)/gi, '')
      .replace(/;\s*samesite=[^;]*/gi, '')
      .replace(/;\s*partitioned(?=;|$)/gi, '');
    return `${next}; Secure; SameSite=None; Partitioned`;
  }

  next = next
    .replace(/;\s*secure(?=;|$)/gi, '')
    .replace(/;\s*partitioned(?=;|$)/gi, '');
  if (/;\s*samesite=none(?=;|$)/i.test(next)) {
    next = next.replace(/;\s*samesite=none(?=;|$)/i, '; SameSite=Lax');
  }
  return next;
}

function rewriteResponseHeaders(
  headers: IncomingHttpHeaders,
  runtime: PreviewRuntime,
  requestHeaders: IncomingHttpHeaders,
  injectBridge: boolean,
): http.OutgoingHttpHeaders {
  const next: http.OutgoingHttpHeaders = {};

  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (
      lower === 'connection'
      || lower === 'transfer-encoding'
      || lower === 'x-frame-options'
      || lower === 'content-security-policy'
      || lower === 'content-security-policy-report-only'
      || (injectBridge && lower === 'content-length')
    ) {
      continue;
    }
    if (lower === 'location' && typeof value === 'string') {
      next[key] = rewriteLocation(value, runtime, requestHeaders);
      continue;
    }
    if (lower === 'set-cookie') {
      const cookies = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
      const secureGateway = requestProtocol(requestHeaders) === 'https';
      next[key] = cookies.map((cookie) => rewriteTargetCookie(
        cookie,
        runtime.target,
        runtime.cookieName,
        secureGateway,
      ));
      continue;
    }
    if (value !== undefined) next[key] = value;
  }
  return next;
}

function isHtmlResponse(headers: IncomingHttpHeaders): boolean {
  const contentType = firstHeaderValue(headers['content-type'])?.toLowerCase() ?? '';
  return contentType.includes('text/html');
}

function injectBridgeScript(body: string): string {
  if (body.includes('data-agent-tower-preview-bridge')) return body;
  const script = `<script data-agent-tower-preview-bridge src="${PREVIEW_BRIDGE_PATH}"></script>`;
  const head = /<head(?:\s[^>]*)?>/i;
  if (head.test(body)) return body.replace(head, (match) => `${match}${script}`);
  return `${script}${body}`;
}

function writeUnauthorized(response: ServerResponse): void {
  response.writeHead(401, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end('Preview access expired. Reopen the preview from Agent Tower.');
}

function writeUpgradeError(socket: Duplex, statusCode: number, message: string): void {
  if (socket.destroyed) return;
  socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function listen(server: http.Server, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, host);
  });
}

function closeServer(runtime: PreviewRuntime): Promise<void> {
  runtime.stopped = true;
  for (const socket of runtime.sockets) socket.destroy();
  runtime.sockets.clear();
  return new Promise((resolve) => {
    if (!runtime.server.listening) {
      resolve();
      return;
    }
    runtime.server.close(() => resolve());
    runtime.server.closeAllConnections?.();
  });
}

function formatHostname(hostname: string): string {
  const normalized = hostname.trim().replace(/^\[|\]$/g, '');
  return normalized.includes(':') ? `[${normalized}]` : normalized;
}

export function addPreviewAccessToken(viewBaseUrl: string, token: string, suffix = '/'): string {
  const url = new URL(suffix, viewBaseUrl.endsWith('/') ? viewBaseUrl : `${viewBaseUrl}/`);
  url.searchParams.set(PREVIEW_GATEWAY_TOKEN_PARAM, token);
  return url.toString();
}

export class PreviewRuntimeManager {
  private readonly runtimes = new Map<string, PreviewRuntime>();
  private readonly idleTtlMs: number;
  private readonly leaseTtlMs: number;
  private readonly listenHost: string;
  private readonly now: () => number;
  private readonly createTunnel: (targetUrl: string) => PreviewTunnel;
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(options: PreviewRuntimeManagerOptions = {}) {
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.listenHost = options.listenHost ?? process.env.AGENT_TOWER_HOST ?? '0.0.0.0';
    this.now = options.now ?? (() => Date.now());
    this.createTunnel = options.createTunnel
      ?? ((targetUrl) => Tunnel.quick(targetUrl, QUICK_TUNNEL_OPTIONS));
    this.sweepTimer = setInterval(() => {
      void this.sweep();
    }, options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  async acquire(
    workspaceId: string,
    target: NormalizedPreviewTarget,
    mode: PreviewMode,
    localHostname: string,
  ): Promise<PreviewGatewaySession> {
    const runtime = await this.ensureRuntime(workspaceId, target);
    const now = this.now();
    const lease: PreviewLease = {
      id: randomBytes(16).toString('base64url'),
      mode,
      localHostname,
      expiresAtMs: now + this.leaseTtlMs,
    };
    runtime.leases.set(lease.id, lease);
    runtime.lastActivityAtMs = now;
    if (mode === 'remote') runtime.tunnelLastActivityAtMs = now;

    const viewBaseUrl = mode === 'remote'
      ? await this.ensureTunnel(runtime)
      : `http://${formatHostname(localHostname)}:${runtime.port}`;
    return this.toSession(runtime, lease, viewBaseUrl);
  }

  async heartbeat(workspaceId: string, leaseId: string): Promise<PreviewGatewaySession | null> {
    const runtime = this.runtimes.get(workspaceId);
    const lease = runtime?.leases.get(leaseId);
    if (!runtime || !lease || runtime.stopped) return null;

    const now = this.now();
    lease.expiresAtMs = now + this.leaseTtlMs;
    runtime.lastActivityAtMs = now;
    if (lease.mode === 'remote') runtime.tunnelLastActivityAtMs = now;
    const viewBaseUrl = lease.mode === 'remote'
      ? await this.ensureTunnel(runtime)
      : `http://${formatHostname(lease.localHostname)}:${runtime.port}`;
    return this.toSession(runtime, lease, viewBaseUrl);
  }

  release(workspaceId: string, leaseId: string): void {
    this.runtimes.get(workspaceId)?.leases.delete(leaseId);
  }

  async invalidate(workspaceId: string): Promise<void> {
    const runtime = this.runtimes.get(workspaceId);
    if (!runtime) return;
    this.runtimes.delete(workspaceId);
    await this.stopRuntime(runtime);
  }

  async stopAll(): Promise<void> {
    clearInterval(this.sweepTimer);
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.all(runtimes.map((runtime) => this.stopRuntime(runtime)));
  }

  private toSession(
    runtime: PreviewRuntime,
    lease: PreviewLease,
    viewBaseUrl: string,
  ): PreviewGatewaySession {
    return {
      id: lease.id,
      workspaceId: runtime.workspaceId,
      target: runtime.target.target,
      mode: lease.mode,
      viewBaseUrl,
      expiresAt: nowIso(lease.expiresAtMs),
    };
  }

  private async ensureRuntime(
    workspaceId: string,
    target: NormalizedPreviewTarget,
  ): Promise<PreviewRuntime> {
    const existing = this.runtimes.get(workspaceId);
    if (existing && existing.target.target === target.target && !existing.stopped) return existing;
    if (existing) await this.invalidate(workspaceId);

    const runtime = {} as PreviewRuntime;
    const server = http.createServer((request, response) => {
      void this.handleHttpRequest(runtime, request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500);
        response.end('Preview gateway request failed');
      });
    });
    Object.assign(runtime, {
      workspaceId,
      target,
      server,
      port: 0,
      cookieName: cookieNameForWorkspace(workspaceId),
      accessSecret: newSecret(),
      accessGeneration: AccessAuthService.getSessionSecretGeneration(),
      leases: new Map<string, PreviewLease>(),
      lastActivityAtMs: this.now(),
      tunnelLastActivityAtMs: this.now(),
      activeConnections: 0,
      activeRemoteConnections: 0,
      sockets: new Set<Duplex>(),
      tunnel: null,
      tunnelUrl: null,
      tunnelStartPromise: null,
      stopped: false,
    } satisfies PreviewRuntime);

    server.on('connection', (socket) => {
      runtime.sockets.add(socket);
      socket.once('close', () => runtime.sockets.delete(socket));
    });
    server.on('upgrade', (request, socket, head) => {
      void this.handleWebSocketUpgrade(runtime, request, socket, head).catch(() => {
        writeUpgradeError(socket, 500, 'Preview Gateway Error');
      });
    });
    runtime.port = await listen(server, this.listenHost);
    this.runtimes.set(workspaceId, runtime);
    return runtime;
  }

  private rotateAccessSecretIfNeeded(runtime: PreviewRuntime): void {
    const generation = AccessAuthService.getSessionSecretGeneration();
    if (runtime.accessGeneration === generation) return;
    runtime.accessGeneration = generation;
    runtime.accessSecret = newSecret();
  }

  private hasGatewayCookie(runtime: PreviewRuntime, request: IncomingMessage): boolean {
    this.rotateAccessSecretIfNeeded(runtime);
    const candidate = parseCookies(request.headers.cookie).get(runtime.cookieName);
    return Boolean(candidate && safeEqual(candidate, runtime.accessSecret));
  }

  private touchRuntime(runtime: PreviewRuntime, headers: IncomingHttpHeaders): void {
    const now = this.now();
    runtime.lastActivityAtMs = now;
    if (isRemoteGatewayRequest(headers)) runtime.tunnelLastActivityAtMs = now;
  }

  private async authorizeBootstrap(
    runtime: PreviewRuntime,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    const parsed = new URL(request.url ?? '/', 'http://preview.local');
    const token = parsed.searchParams.get(PREVIEW_GATEWAY_TOKEN_PARAM);
    if (!token || !await AccessAuthService.validatePreviewAccessToken(token, runtime.workspaceId)) {
      return false;
    }

    this.rotateAccessSecretIfNeeded(runtime);
    this.touchRuntime(runtime, request.headers);
    response.setHeader('set-cookie', serializeGatewayCookie(runtime, request.headers));
    if (request.method === 'GET' || request.method === 'HEAD') {
      response.writeHead(302, {
        location: removeQueryParameter(request.url ?? '/', PREVIEW_GATEWAY_TOKEN_PARAM),
        'cache-control': 'no-store',
      });
      response.end();
      return true;
    }
    return false;
  }

  private async handleHttpRequest(
    runtime: PreviewRuntime,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (runtime.stopped) {
      response.writeHead(503).end();
      return;
    }

    const parsed = new URL(request.url ?? '/', 'http://preview.local');
    if (parsed.searchParams.has(PREVIEW_GATEWAY_TOKEN_PARAM)) {
      if (await this.authorizeBootstrap(runtime, request, response)) return;
      writeUnauthorized(response);
      return;
    }
    if (!this.hasGatewayCookie(runtime, request)) {
      writeUnauthorized(response);
      return;
    }

    this.touchRuntime(runtime, request.headers);
    if (parsed.pathname === PREVIEW_BRIDGE_PATH) {
      response.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(PREVIEW_BRIDGE_SCRIPT);
      return;
    }
    if (parsed.pathname === PREVIEW_HEARTBEAT_PATH) {
      response.writeHead(204, { 'cache-control': 'no-store' });
      response.end();
      return;
    }

    await this.proxyHttpRequest(runtime, request, response);
  }

  private async proxyHttpRequest(
    runtime: PreviewRuntime,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const targetUrl = new URL(runtime.target.origin);
    const targetPath = joinTargetPath(runtime.target, request.url ?? '/');
    const options: ProxyRequestOptions = {
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port,
      method: request.method,
      path: targetPath,
      headers: rewriteRequestHeaders(request.headers, runtime, targetPath),
      rejectUnauthorized: false,
    };
    const transport = targetUrl.protocol === 'https:' ? https : http;

    await new Promise<void>((resolve) => {
      const proxyRequest = transport.request(options, (proxyResponse) => {
        const injectBridge = request.method !== 'HEAD'
          && proxyResponse.statusCode !== 204
          && proxyResponse.statusCode !== 304
          && isHtmlResponse(proxyResponse.headers);
        const headers = rewriteResponseHeaders(
          proxyResponse.headers,
          runtime,
          request.headers,
          injectBridge,
        );
        response.statusCode = proxyResponse.statusCode ?? 502;
        for (const [key, value] of Object.entries(headers)) {
          if (value !== undefined) response.setHeader(key, value);
        }

        if (!injectBridge) {
          proxyResponse.pipe(response);
          proxyResponse.once('end', resolve);
          proxyResponse.once('error', () => {
            response.destroy();
            resolve();
          });
          return;
        }

        const chunks: Buffer[] = [];
        proxyResponse.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        proxyResponse.once('end', () => {
          response.end(injectBridgeScript(Buffer.concat(chunks).toString('utf8')));
          resolve();
        });
        proxyResponse.once('error', () => {
          response.destroy();
          resolve();
        });
      });

      proxyRequest.once('error', (error) => {
        if (!response.headersSent) {
          response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        }
        response.end(`Preview target unavailable: ${error.message}`);
        resolve();
      });
      request.pipe(proxyRequest);
    });
  }

  private async handleWebSocketUpgrade(
    runtime: PreviewRuntime,
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    if (runtime.stopped || !this.hasGatewayCookie(runtime, request)) {
      writeUpgradeError(socket, 401, 'Unauthorized');
      return;
    }

    this.touchRuntime(runtime, request.headers);
    const remoteConnection = isRemoteGatewayRequest(request.headers);
    const targetUrl = new URL(runtime.target.origin);
    const targetPath = joinTargetPath(runtime.target, request.url ?? '/');
    const headers = rewriteRequestHeaders(request.headers, runtime, targetPath);
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
      runtime.activeConnections += 1;
      if (remoteConnection) runtime.activeRemoteConnections += 1;
      runtime.sockets.add(proxySocket);
      const close = () => {
        runtime.activeConnections = Math.max(0, runtime.activeConnections - 1);
        if (remoteConnection) {
          runtime.activeRemoteConnections = Math.max(0, runtime.activeRemoteConnections - 1);
        }
        runtime.sockets.delete(proxySocket);
        this.touchRuntime(runtime, request.headers);
      };
      proxySocket.once('close', close);
      proxySocket.on('data', () => {
        this.touchRuntime(runtime, request.headers);
      });
      socket.on('data', () => {
        this.touchRuntime(runtime, request.headers);
      });

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
    proxyRequest.once('error', () => writeUpgradeError(socket, 502, 'Bad Gateway'));
    proxyRequest.end();
  }

  private async ensureTunnel(runtime: PreviewRuntime): Promise<string> {
    if (runtime.tunnel && runtime.tunnelUrl) return runtime.tunnelUrl;
    if (runtime.tunnelStartPromise) return runtime.tunnelStartPromise;

    const startPromise = new Promise<string>((resolve, reject) => {
      const tunnel = this.createTunnel(`http://127.0.0.1:${runtime.port}`);
      runtime.tunnel = tunnel;
      let settled = false;
      const timer = setTimeout(() => settle(reject, new Error('Preview tunnel startup timed out')), TUNNEL_STARTUP_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timer);
        tunnel.off('url', onUrl);
        tunnel.off('error', onError);
        tunnel.off('exit', onExitBeforeReady);
      };
      const settle = <T>(done: (value: T) => void, value: T) => {
        if (settled) return;
        settled = true;
        cleanup();
        done(value);
      };
      const onUrl = (url: string) => {
        runtime.tunnelUrl = url.replace(/\/$/, '');
        settle(resolve, runtime.tunnelUrl);
      };
      const onError = (error: Error) => settle(reject, error);
      const onExitBeforeReady = (code: number | null, signal: NodeJS.Signals | null) => {
        settle(reject, new Error(`Preview tunnel exited before ready (${code ?? signal ?? 'unknown'})`));
      };

      tunnel.once('url', onUrl);
      tunnel.once('error', onError);
      tunnel.once('exit', onExitBeforeReady);
      tunnel.on('error', () => {
        // The session heartbeat will recreate a failed tunnel when needed.
      });
      tunnel.on('exit', () => {
        if (runtime.tunnel !== tunnel) return;
        runtime.tunnel = null;
        runtime.tunnelUrl = null;
      });
    });
    runtime.tunnelStartPromise = startPromise;

    try {
      return await startPromise;
    } catch (error) {
      const tunnel = runtime.tunnel;
      runtime.tunnel = null;
      runtime.tunnelUrl = null;
      tunnel?.stop();
      throw error;
    } finally {
      if (runtime.tunnelStartPromise === startPromise) runtime.tunnelStartPromise = null;
    }
  }

  private async sweep(): Promise<void> {
    const now = this.now();
    const expired: PreviewRuntime[] = [];
    for (const runtime of this.runtimes.values()) {
      for (const [leaseId, lease] of runtime.leases) {
        if (lease.expiresAtMs <= now) runtime.leases.delete(leaseId);
      }
      const hasRemoteLease = [...runtime.leases.values()].some((lease) => lease.mode === 'remote');
      if (
        runtime.tunnel
        && !hasRemoteLease
        && runtime.activeRemoteConnections === 0
        && now - runtime.tunnelLastActivityAtMs >= this.idleTtlMs
      ) {
        this.stopTunnel(runtime);
      }
      if (
        runtime.leases.size === 0
        && runtime.activeConnections === 0
        && now - runtime.lastActivityAtMs >= this.idleTtlMs
      ) {
        expired.push(runtime);
      }
    }

    await Promise.all(expired.map(async (runtime) => {
      if (this.runtimes.get(runtime.workspaceId) !== runtime) return;
      this.runtimes.delete(runtime.workspaceId);
      await this.stopRuntime(runtime);
    }));
  }

  private async stopRuntime(runtime: PreviewRuntime): Promise<void> {
    runtime.stopped = true;
    this.stopTunnel(runtime);
    await closeServer(runtime);
  }

  private stopTunnel(runtime: PreviewRuntime): void {
    const tunnel = runtime.tunnel;
    runtime.tunnel = null;
    runtime.tunnelUrl = null;
    runtime.tunnelStartPromise = null;
    tunnel?.stop();
  }
}
