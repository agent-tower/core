import { randomBytes, timingSafeEqual } from 'node:crypto';
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { AccessAuthService } from './access-auth.service.js';
import type { NormalizedPreviewTarget } from './preview.service.js';
import { buildPreviewBridgeScript, injectPreviewBridge } from './preview-bridge.js';
import {
  filterTargetCookieHeader,
  parseCookieHeader,
  previewCookieScopeName,
  rewriteTargetCookie,
} from './preview-cookies.js';
import { classifyPreviewRequest, firstHeaderValue, requestProtocol } from './preview-proxy.js';
import { writeErrorLog } from '../utils/error-log.js';

export { rewriteTargetCookie } from './preview-cookies.js';

/**
 * Dedicated-origin preview gateways.
 *
 * Each workspace preview opened from a browser that can reach extra ports on
 * the Agent Tower host gets its own root-path HTTP server. The previewed app
 * then owns the whole URL space (`/login`, `/assets`, SPA history, cookies)
 * without any rewriting. Browsers that cannot reach those ports use the
 * same-origin `/view/:workspaceId/` proxy instead (see preview-proxy.ts).
 */

export const PREVIEW_GATEWAY_TOKEN_PARAM = '__agent_tower_preview_token';
export const PREVIEW_HEARTBEAT_PATH = '/__agent_tower_preview_heartbeat';

const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_LEASE_TTL_MS = 3 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 30 * 1000;
const PREVIEW_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

type ProxyRequestOptions = http.RequestOptions & { rejectUnauthorized?: boolean };

interface PreviewLease {
  id: string;
  localHostname: string;
  expiresAtMs: number;
}

interface PreviewRuntime {
  workspaceId: string;
  target: NormalizedPreviewTarget;
  server: http.Server;
  port: number;
  ready: Promise<number>;
  cookieName: string;
  accessSecret: string;
  accessGeneration: number;
  leases: Map<string, PreviewLease>;
  lastActivityAtMs: number;
  activeConnections: number;
  sockets: Set<Duplex>;
  stopped: boolean;
}

export interface PreviewGatewaySession {
  id: string;
  workspaceId: string;
  target: string;
  viewBaseUrl: string;
  expiresAt: string;
}

export interface PreviewRuntimeManagerOptions {
  idleTtlMs?: number;
  leaseTtlMs?: number;
  sweepIntervalMs?: number;
  listenHost?: string;
  now?: () => number;
}

function nowIso(value: number): string {
  return new Date(value).toISOString();
}

function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
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

  const cookie = filterTargetCookieHeader(headers.cookie, runtime.cookieName);
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

function gatewayBridgeTag(runtime: PreviewRuntime): string {
  return buildPreviewBridgeScript({
    mode: 'gateway',
    prefix: '',
    workspaceId: runtime.workspaceId,
    targetOrigin: runtime.target.origin,
    targetBasePath: runtime.target.basePath,
    serviceWorker: false,
    heartbeatPath: PREVIEW_HEARTBEAT_PATH,
  });
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

async function closeServer(runtime: PreviewRuntime): Promise<void> {
  runtime.stopped = true;
  await runtime.ready.catch(() => undefined);
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
  private stopped = false;
  private readonly idleTtlMs: number;
  private readonly leaseTtlMs: number;
  private readonly listenHost: string;
  private readonly now: () => number;
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(options: PreviewRuntimeManagerOptions = {}) {
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    this.listenHost = options.listenHost ?? process.env.AGENT_TOWER_HOST ?? '0.0.0.0';
    this.now = options.now ?? (() => Date.now());
    this.sweepTimer = setInterval(() => {
      void this.sweep().catch((error) => {
        writeErrorLog({ level: 'error', source: 'preview.cleanup', message: 'Failed to reclaim preview runtime', error });
      });
    }, options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  async acquire(
    workspaceId: string,
    target: NormalizedPreviewTarget,
    localHostname: string,
  ): Promise<PreviewGatewaySession> {
    const runtime = await this.ensureRuntime(workspaceId, target);
    this.assertRuntimeActive(runtime);
    const now = this.now();
    const lease: PreviewLease = {
      id: randomBytes(16).toString('base64url'),
      localHostname,
      expiresAtMs: now + this.leaseTtlMs,
    };
    runtime.leases.set(lease.id, lease);
    runtime.lastActivityAtMs = now;
    return this.toSession(runtime, lease);
  }

  async heartbeat(workspaceId: string, leaseId: string): Promise<PreviewGatewaySession | null> {
    const runtime = this.runtimes.get(workspaceId);
    const lease = runtime?.leases.get(leaseId);
    if (!runtime || !lease || runtime.stopped) return null;

    const now = this.now();
    lease.expiresAtMs = now + this.leaseTtlMs;
    runtime.lastActivityAtMs = now;
    this.assertRuntimeActive(runtime);
    return this.toSession(runtime, lease);
  }

  release(workspaceId: string, leaseId: string): void {
    this.runtimes.get(workspaceId)?.leases.delete(leaseId);
  }

  async invalidate(workspaceId: string): Promise<void> {
    const runtime = this.runtimes.get(workspaceId);
    if (!runtime) return;
    await closeServer(runtime);
    if (this.runtimes.get(workspaceId) === runtime) this.runtimes.delete(workspaceId);
  }

  async stopAll(): Promise<void> {
    this.stopped = true;
    clearInterval(this.sweepTimer);
    const results = await Promise.allSettled([...this.runtimes.keys()].map((workspaceId) => this.invalidate(workspaceId)));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  private toSession(runtime: PreviewRuntime, lease: PreviewLease): PreviewGatewaySession {
    return {
      id: lease.id,
      workspaceId: runtime.workspaceId,
      target: runtime.target.target,
      viewBaseUrl: `http://${formatHostname(lease.localHostname)}:${runtime.port}`,
      expiresAt: nowIso(lease.expiresAtMs),
    };
  }

  private async ensureRuntime(
    workspaceId: string,
    target: NormalizedPreviewTarget,
  ): Promise<PreviewRuntime> {
    if (this.stopped) throw new Error('Preview runtime manager is stopped');
    const existing = this.runtimes.get(workspaceId);
    if (existing && existing.target.target === target.target && !existing.stopped) {
      await existing.ready;
      this.assertRuntimeActive(existing);
      return existing;
    }
    if (existing) {
      await this.invalidate(workspaceId);
      return this.ensureRuntime(workspaceId, target);
    }

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
      ready: Promise.resolve(0),
      cookieName: previewCookieScopeName(workspaceId),
      accessSecret: newSecret(),
      accessGeneration: AccessAuthService.getSessionSecretGeneration(),
      leases: new Map<string, PreviewLease>(),
      lastActivityAtMs: this.now(),
      activeConnections: 0,
      sockets: new Set<Duplex>(),
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
    // Publish ownership before listen yields so concurrent opens share creation,
    // and invalidation can wait for and close even an unfinished listener.
    this.runtimes.set(workspaceId, runtime);
    runtime.ready = listen(server, this.listenHost);
    try {
      runtime.port = await runtime.ready;
      this.assertRuntimeActive(runtime);
      return runtime;
    } catch (error) {
      await closeServer(runtime);
      if (this.runtimes.get(workspaceId) === runtime) this.runtimes.delete(workspaceId);
      throw error;
    }
  }

  private rotateAccessSecretIfNeeded(runtime: PreviewRuntime): void {
    const generation = AccessAuthService.getSessionSecretGeneration();
    if (runtime.accessGeneration === generation) return;
    runtime.accessGeneration = generation;
    runtime.accessSecret = newSecret();
  }

  private hasGatewayCookie(runtime: PreviewRuntime, request: IncomingMessage): boolean {
    this.rotateAccessSecretIfNeeded(runtime);
    const candidate = parseCookieHeader(request.headers.cookie).get(runtime.cookieName);
    return Boolean(candidate && safeEqual(candidate, runtime.accessSecret));
  }

  private touchRuntime(runtime: PreviewRuntime): void {
    runtime.lastActivityAtMs = this.now();
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
    this.touchRuntime(runtime);
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

    this.touchRuntime(runtime);
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
    const context = classifyPreviewRequest(request.method ?? 'GET', request.headers, new URL(request.url ?? '/', 'http://preview.local').search);
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
          && context.document
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
          response.end(injectPreviewBridge(Buffer.concat(chunks), gatewayBridgeTag(runtime)));
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

    this.touchRuntime(runtime);
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
      runtime.sockets.add(proxySocket);
      const close = () => {
        runtime.activeConnections = Math.max(0, runtime.activeConnections - 1);
        runtime.sockets.delete(proxySocket);
        this.touchRuntime(runtime);
      };
      proxySocket.once('close', close);
      proxySocket.on('data', () => this.touchRuntime(runtime));
      socket.on('data', () => this.touchRuntime(runtime));

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

  private assertRuntimeActive(runtime: PreviewRuntime): void {
    if (this.stopped || runtime.stopped || this.runtimes.get(runtime.workspaceId) !== runtime) {
      throw new Error('Preview runtime was invalidated');
    }
  }

  private async sweep(): Promise<void> {
    const now = this.now();
    const expired: PreviewRuntime[] = [];
    for (const runtime of this.runtimes.values()) {
      for (const [leaseId, lease] of runtime.leases) {
        if (lease.expiresAtMs <= now) runtime.leases.delete(leaseId);
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
      await this.invalidate(runtime.workspaceId);
    }));
  }
}
