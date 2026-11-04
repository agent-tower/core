import type { FastifyReply, FastifyRequest } from 'fastify';
import { PREVIEW_CONTEXT_COOKIE_NAME, parseCookieHeader } from '../services/preview-cookies.js';
import { buildPreviewPathPrefix, parsePreviewPath, PREVIEW_PREFIX } from '../utils/preview-path.js';

/**
 * Last line of defence for same-origin previews.
 *
 * Preview documents normally stay inside `/view/:workspaceId/` thanks to the
 * service worker and the bridge script, but a request can still escape:
 * a stylesheet loaded before the worker took over, an app that calls
 * `location.reload()` from a virtualized address, or a plain-mode page whose
 * markup used absolute paths at runtime. Those requests carry a Referer under
 * the preview prefix or arrive as an embedded navigation from a document that
 * set the preview context cookie, so they are redirected back into the proxy
 * instead of hitting Agent Tower's own routes.
 */

const EMBEDDED_DESTINATIONS = new Set(['iframe', 'frame', 'embed', 'object']);
const AGENT_TOWER_OWN_PATHS = ['/api', '/socket.io', '/assets', '/__agent-tower'];
const AGENT_TOWER_OWN_FILES = new Set(['/vite.svg', '/favicon.ico', '/robots.txt', '/manifest.json']);

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function splitUrl(url: string): { pathname: string; search: string } {
  const end = url.search(/[?#]/);
  if (end === -1) return { pathname: url, search: '' };
  const rest = url.slice(end);
  const hash = rest.indexOf('#');
  return { pathname: url.slice(0, end), search: hash === -1 ? rest : rest.slice(0, hash) };
}

function isPreviewPath(pathname: string): boolean {
  return pathname === PREVIEW_PREFIX || pathname.startsWith(`${PREVIEW_PREFIX}/`);
}

function isAgentTowerOwnPath(pathname: string): boolean {
  if (AGENT_TOWER_OWN_FILES.has(pathname)) return true;
  return AGENT_TOWER_OWN_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function sameHost(request: FastifyRequest, url: URL): boolean {
  const host = firstHeaderValue(request.headers.host);
  return Boolean(host) && url.host.toLowerCase() === host!.toLowerCase();
}

function previewPrefixFromReferer(request: FastifyRequest): string | null {
  const referer = firstHeaderValue(request.headers.referer);
  if (!referer) return null;

  let url: URL;
  try {
    url = new URL(referer);
  } catch {
    return null;
  }
  if (!sameHost(request, url)) return null;

  const parsed = parsePreviewPath(`${url.pathname}${url.search}`);
  if (!parsed) return null;
  return buildPreviewPathPrefix(parsed.workspaceId, parsed.previewToken);
}

function previewPrefixFromContext(request: FastifyRequest, pathname: string): string | null {
  const destination = firstHeaderValue(request.headers['sec-fetch-dest']);
  if (!destination || !EMBEDDED_DESTINATIONS.has(destination)) return null;
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return null;
  if (isAgentTowerOwnPath(pathname)) return null;

  const workspaceId = parseCookieHeader(firstHeaderValue(request.headers.cookie)).get(PREVIEW_CONTEXT_COOKIE_NAME);
  if (!workspaceId) return null;
  return buildPreviewPathPrefix(workspaceId, null);
}

/** Resolve the proxied URL a stray preview request should be redirected to, or null. */
export function resolvePreviewFallbackRedirect(request: FastifyRequest): string | null {
  const rawUrl = request.raw.url ?? request.url;
  const { pathname, search } = splitUrl(rawUrl);
  if (isPreviewPath(pathname)) return null;

  const prefix = previewPrefixFromReferer(request) ?? previewPrefixFromContext(request, pathname);
  if (!prefix) return null;
  return `${prefix}${pathname.startsWith('/') ? pathname : `/${pathname}`}${search}`;
}

export async function previewFallbackHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const redirect = resolvePreviewFallbackRedirect(request);
  if (!redirect) return;
  reply.header('cache-control', 'no-store');
  await reply.redirect(redirect, 307);
}
