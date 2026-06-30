const DEFAULT_API_BASE_URL = '/api'

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '[::1]'
    || normalized.startsWith('127.')
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function shouldUseDevSameOriginProxy(value: string | undefined): boolean {
  if (!import.meta.env.DEV || !value) return false

  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && isLoopbackHostname(url.hostname)
  } catch {
    return false
  }
}

export function getApiBaseUrl(): string {
  const configured = import.meta.env.VITE_API_URL
  if (shouldUseDevSameOriginProxy(configured)) {
    return DEFAULT_API_BASE_URL
  }
  return normalizeBaseUrl(configured || DEFAULT_API_BASE_URL)
}

export function getSocketBaseUrl(): string {
  const configured = import.meta.env.VITE_SOCKET_URL
  if (shouldUseDevSameOriginProxy(configured)) {
    return ''
  }
  return normalizeBaseUrl(configured || '')
}
