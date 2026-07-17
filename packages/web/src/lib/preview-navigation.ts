export type PreviewNavigation =
  | { kind: 'proxy'; url: string }
  | { kind: 'target'; target: string; path: string | null }

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0'])

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

export function buildPreviewProxyUrl(viewUrl: string, suffix: string): string {
  try {
    const base = new URL(viewUrl)
    const bootstrapToken = base.searchParams.get('__agent_tower_preview_token')
    const requested = new URL(suffix.startsWith('/') ? suffix : `/${suffix}`, 'http://preview.local')
    base.pathname = requested.pathname
    base.search = requested.search
    base.hash = requested.hash
    if (bootstrapToken) base.searchParams.set('__agent_tower_preview_token', bootstrapToken)
    return base.toString()
  } catch {
    // Legacy relative /view URLs remain supported during the migration.
  }

  const base = viewUrl.endsWith('/') ? viewUrl : `${viewUrl}/`
  const next = suffix.startsWith('/') ? suffix.slice(1) : suffix
  return `${base}${next}`
}

export function resolvePreviewNavigation(
  input: string,
  currentTarget: string | null,
  viewUrl: string | null,
): PreviewNavigation | null {
  const value = input.trim()
  if (!value) return null

  if (value.startsWith('/')) {
    return viewUrl ? { kind: 'proxy', url: buildPreviewProxyUrl(viewUrl, value) } : null
  }

  const requested = parsePreviewTarget(value)
  if (!requested) return targetNavigation(value, null)
  if (!currentTarget || !viewUrl) return targetNavigation(value, requested)

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
    url: buildPreviewProxyUrl(viewUrl, `${suffixPath}${requested.search}${requested.hash}`),
  }
}

export function previewLocationToTarget(
  target: string | null,
  viewUrl: string | null,
  locationHref: string,
  baseHref: string,
): string | null {
  if (!target || !viewUrl) return null

  try {
    const targetUrl = new URL(target)
    const proxyBase = new URL(viewUrl, baseHref)
    const location = new URL(locationHref, baseHref)
    const normalizedProxyPath = proxyBase.pathname === '/'
      ? ''
      : proxyBase.pathname.endsWith('/')
        ? proxyBase.pathname.slice(0, -1)
        : proxyBase.pathname

    if (location.origin !== proxyBase.origin) return location.toString()
    if (
      normalizedProxyPath
      && location.pathname !== normalizedProxyPath
      && !location.pathname.startsWith(`${normalizedProxyPath}/`)
    ) return location.toString()

    const suffix = location.pathname.slice(normalizedProxyPath.length) || '/'
    const basePath = normalizePath(targetUrl.pathname)
    targetUrl.pathname = `${basePath}${suffix}`.replace(/\/{2,}/g, '/') || '/'
    targetUrl.search = location.search
    targetUrl.hash = location.hash
    return targetUrl.toString()
  } catch {
    return null
  }
}

export function isLoopbackPreviewUrl(value: string): boolean {
  const url = parsePreviewTarget(value)
  return Boolean(url && LOOPBACK_HOSTS.has(url.hostname.toLowerCase()))
}
