import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadApiBaseUrl() {
  vi.resetModules()
  return import('../api-base-url')
}

describe('api base url helpers', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('uses same-origin /api by default', async () => {
    const { getApiBaseUrl, getSocketBaseUrl } = await loadApiBaseUrl()

    expect(getApiBaseUrl()).toBe('/api')
    expect(getSocketBaseUrl()).toBe('')
  })

  it('keeps dev API requests same-origin for local absolute API URLs', async () => {
    vi.stubEnv('VITE_API_URL', 'http://localhost:33952/api')
    const { getApiBaseUrl } = await loadApiBaseUrl()

    expect(getApiBaseUrl()).toBe('/api')
  })

  it('keeps dev socket requests same-origin for local absolute socket URLs', async () => {
    vi.stubEnv('VITE_SOCKET_URL', 'http://127.0.0.1:33952')
    const { getSocketBaseUrl } = await loadApiBaseUrl()

    expect(getSocketBaseUrl()).toBe('')
  })

  it('preserves non-local absolute API URLs', async () => {
    vi.stubEnv('VITE_API_URL', 'https://tower.example.com/api/')
    const { getApiBaseUrl } = await loadApiBaseUrl()

    expect(getApiBaseUrl()).toBe('https://tower.example.com/api')
  })

  it('preserves relative API URLs', async () => {
    vi.stubEnv('VITE_API_URL', '/custom-api/')
    const { getApiBaseUrl } = await loadApiBaseUrl()

    expect(getApiBaseUrl()).toBe('/custom-api')
  })
})
