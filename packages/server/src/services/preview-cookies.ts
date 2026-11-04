import { createHash } from 'node:crypto';
import type { NormalizedPreviewTarget } from './preview.service.js';
import { isAccessAuthCookieName } from './access-auth.service.js';
import { TUNNEL_SESSION_COOKIE_NAME } from '../utils/tunnel-cookie.js';

/**
 * Cookie that remembers which workspace preview an embedded document belongs to.
 * It lets the server route navigations that escaped the `/view/:workspaceId/`
 * prefix (for example `location.reload()` from a virtualized SPA) back into
 * the workspace proxy.
 */
export const PREVIEW_CONTEXT_COOKIE_NAME = 'agent-tower-preview-context';

export function previewCookieScopeName(workspaceId: string): string {
  const suffix = createHash('sha256').update(workspaceId).digest('hex').slice(0, 16);
  return `agent-tower-preview-${suffix}`;
}

export function isInternalCookieName(name: string): boolean {
  return name === TUNNEL_SESSION_COOKIE_NAME
    || name === PREVIEW_CONTEXT_COOKIE_NAME
    || isAccessAuthCookieName(name);
}

function scopedTargetCookieName(scopeName: string, targetCookieName: string): string {
  return `${scopeName}-target-${Buffer.from(targetCookieName).toString('base64url')}`;
}

function unscopedTargetCookieName(scopeName: string, cookieName: string): string | null {
  const prefix = `${scopeName}-target-`;
  if (!cookieName.startsWith(prefix)) return null;

  try {
    const targetCookieName = Buffer.from(cookieName.slice(prefix.length), 'base64url').toString('utf8');
    return isInternalCookieName(targetCookieName) ? targetCookieName : null;
  } catch {
    return null;
  }
}

/**
 * Build the Cookie header forwarded to the preview target: Agent Tower's own
 * cookies never leave the server, the gateway/scope cookie is dropped, and
 * target cookies that had to be renamed to avoid clashing with Agent Tower's
 * cookies are restored to their original names.
 */
export function filterTargetCookieHeader(
  cookieHeader: string | undefined,
  scopeName: string,
): string | undefined {
  if (!cookieHeader) return undefined;

  const cookies: string[] = [];
  for (const rawPart of cookieHeader.split(';')) {
    const part = rawPart.trim();
    if (!part) continue;
    const separator = part.indexOf('=');
    const name = separator === -1 ? part : part.slice(0, separator);
    if (!name || name === scopeName) continue;

    const targetName = unscopedTargetCookieName(scopeName, name);
    if (targetName) {
      cookies.push(`${targetName}${separator === -1 ? '' : part.slice(separator)}`);
      continue;
    }
    if (isInternalCookieName(name)) continue;
    cookies.push(part);
  }
  return cookies.length > 0 ? cookies.join('; ') : undefined;
}

export interface RewriteTargetCookieOptions {
  /** Force `Path=/` so the cookie follows the app through any proxy prefix. */
  forceRootPath?: boolean;
}

/**
 * Rewrite a Set-Cookie header coming from the preview target so the browser
 * stores it against the preview entry (gateway origin or Agent Tower origin).
 */
export function rewriteTargetCookie(
  value: string,
  target: NormalizedPreviewTarget,
  scopeName: string,
  secureEntry: boolean,
  options: RewriteTargetCookieOptions = {},
): string {
  let next = value.replace(/;\s*domain=[^;]*/gi, '');
  const separator = next.indexOf('=');
  if (separator > 0) {
    const cookieName = next.slice(0, separator).trim();
    if (isInternalCookieName(cookieName)) {
      next = `${scopedTargetCookieName(scopeName, cookieName)}${next.slice(separator)}`;
    }
  }

  if (options.forceRootPath) {
    next = /;\s*path=/i.test(next)
      ? next.replace(/;\s*path=([^;]*)/i, '; Path=/')
      : `${next}; Path=/`;
  } else if (target.basePath && /;\s*path=/i.test(next)) {
    next = next.replace(/;\s*path=([^;]*)/i, (_match, rawPath: string) => {
      const path = rawPath.trim();
      if (path === target.basePath) return '; Path=/';
      if (path.startsWith(`${target.basePath}/`)) {
        return `; Path=${path.slice(target.basePath.length) || '/'}`;
      }
      return `; Path=${path || '/'}`;
    });
  }

  if (secureEntry) {
    if (options.forceRootPath) {
      // Same-site proxy: keep the target's SameSite choice, only make sure a
      // `SameSite=None` cookie is still accepted by requiring Secure.
      if (/;\s*samesite=none(?=;|$)/i.test(next) && !/;\s*secure(?=;|$)/i.test(next)) {
        next = `${next}; Secure`;
      }
      return next;
    }
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

export function parseCookieHeader(header?: string): Map<string, string> {
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
