import type { PreviewEntryKind } from '@agent-tower/shared'

export type PreviewNavigation =
  | { kind: 'proxy'; url: string }
  | { kind: 'target'; target: string; path: string | null }

/** Where the preview iframe loads from: a dedicated gateway origin or the same-origin `/view/:id/` proxy. */
export interface PreviewEntry {
  kind: PreviewEntryKind
  viewUrl: string
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])
const PRIVATE_IPV4_PATTERN = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|127\.)/
const PRIVATE_SUFFIX_PATTERN = /\.(local|internal|lan|home|home\.arpa|localhost)$/

function withDefaultScheme(value: string): string {
  if (/^\d+$/.test(value)) return `http://127.0.0.1:${value}`
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value)) return value
  return `http://${value}`
}

function parsePreviewTarget(value: string): URL | null {
  try {
    return new URL(withDefaultScheme(value.trim()))
  } catch {
    return null
  }
}

function normalizedHost(url: URL): string {
  return LOOPBACK_HOSTS.has(url.hostname.toLowerCase()) ? 'loopback' : url.hostname.toLowerCase()
}

function effectivePort(url: URL): string {
  if (url.port) return url.port
  return url.protocol === 'https:' ? '443' : '80'
}

function hasSameEndpoint(left: URL, right: URL): boolean {
  return left.protocol === right.protocol
    && normalizedHost(left) === normalizedHost(right)
    && effectivePort(left) === effectivePort(right)
}

function normalizePath(pathname: string): string {
  if (!pathname || pathname === '/') return ''
  return pathname.endsWith('/') ? pathname.slice(0, -1) : pathname
}

function isSameOrChildPath(pathname: string, basePath: string): boolean {
  if (!basePath) return true
  return pathname === basePath || pathname.startsWith(`${basePath}/`)
}

function targetNavigation(value: string, requested: URL | null): PreviewNavigation {
  if (!requested) return { kind: 'target', target: value, path: null }
  return {
    kind: 'target',
    target: requested.origin,
    path: `${requested.pathname}${requested.search}${requested.hash}`,
  }
}

function normalizeSuffix(suffix: string): string {
  return suffix.startsWith('/') ? suffix : `/${suffix}`
}

export function buildPreviewProxyUrl(entry: PreviewEntry, suffix: string): string {
  const requested = new URL(normalizeSuffix(suffix), 'http://preview.local')

  if (entry.kind === 'gateway') {
    try {
      const base = new URL(entry.viewUrl)
      const bootstrapToken = base.searchParams.get('__agent_tower_preview_token')
      base.pathname = requested.pathname
      base.search = requested.search
      base.hash = requested.hash
      if (bootstrapToken) base.searchParams.set('__agent_tower_preview_token', bootstrapToken)
      return base.toString()
    } catch {
      // Fall through to prefix joining for malformed gateway URLs.
    }
  }

  const base = entry.viewUrl.endsWith('/') ? entry.viewUrl.slice(0, -1) : entry.viewUrl
  return `${base}${requested.pathname}${requested.search}${requested.hash}`
}

export function resolvePreviewNavigation(
  input: string,
  currentTarget: string | null,
  entry: PreviewEntry | null,
): PreviewNavigation | null {
  const value = input.trim()
  if (!value) return null

  if (value.startsWith('/')) {
    return entry ? { kind: 'proxy', url: buildPreviewProxyUrl(entry, value) } : null
  }

  const requested = parsePreviewTarget(value)
  if (!requested) return targetNavigation(value, null)
  if (!currentTarget || !entry) return targetNavigation(value, requested)

  const current = parsePreviewTarget(currentTarget)
  if (!current || !hasSameEndpoint(requested, current)) {
    return targetNavigation(value, requested)
  }

  const basePath = normalizePath(current.pathname)
  if (!isSameOrChildPath(requested.pathname, basePath)) {
    return targetNavigation(value, requested)
  }

  const suffixPath = requested.pathname.slice(basePath.length) || '/'
  return {
    kind: 'proxy',
    url: buildPreviewProxyUrl(entry, `${suffixPath}${requested.search}${requested.hash}`),
  }
}

/**
 * Convert the target-relative path reported by the preview bridge
 * (`/settings?tab=team#members`) into the full target URL shown in the address bar.
 */
export function previewLocationToTarget(target: string | null, path: string): string | null {
  if (!target) return null
  const targetUrl = parsePreviewTarget(target)
  if (!targetUrl) return null

  try {
    const requested = new URL(normalizeSuffix(path), 'http://preview.local')
    const basePath = normalizePath(targetUrl.pathname)
    targetUrl.pathname = `${basePath}${requested.pathname}`.replace(/\/{2,}/g, '/') || '/'
    targetUrl.search = requested.search
    targetUrl.hash = requested.hash
    return targetUrl.toString()
  } catch {
    return null
  }
}

/**
 * Addresses that only make sense from the Agent Tower server's point of view:
 * loopback, private networks, single-label hosts (Docker services) and local
 * TLDs. Links like these open inside the workspace preview instead of the
 * viewer's own browser, which may be on another machine entirely.
 */
export function isServerReachablePreviewUrl(value: string): boolean {
  const url = parsePreviewTarget(value)
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return false
  const hostname = url.hostname.toLowerCase()
  if (LOOPBACK_HOSTS.has(hostname)) return true
  const bare = hostname.replace(/^\[|\]$/g, '')
  if (PRIVATE_IPV4_PATTERN.test(bare)) return true
  if (bare.includes(':')) return /^(fc|fd|fe[89ab])/i.test(bare)
  if (!bare.includes('.')) return true
  return PRIVATE_SUFFIX_PATTERN.test(bare)
}
