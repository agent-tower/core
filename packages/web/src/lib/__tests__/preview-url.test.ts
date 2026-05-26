import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadPreviewUrl() {
  vi.resetModules()
  return import('../preview-url')
}

describe('resolvePreviewViewUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('keeps same-origin view URLs when VITE_API_URL is not configured', async () => {
    const { resolvePreviewViewUrl } = await loadPreviewUrl()

    expect(resolvePreviewViewUrl('/view/workspace-1/')).toBe('/view/workspace-1/')
  })

  it('resolves relative view URLs against an absolute API origin', async () => {
    vi.stubEnv('VITE_API_URL', 'http://localhost:18080/api')
    const { resolvePreviewViewUrl } = await loadPreviewUrl()

    expect(resolvePreviewViewUrl('/view/workspace-1/')).toBe('http://localhost:18080/view/workspace-1/')
  })

  it('keeps relative view URLs when VITE_API_URL is relative', async () => {
    vi.stubEnv('VITE_API_URL', '/api')
    const { resolvePreviewViewUrl } = await loadPreviewUrl()

    expect(resolvePreviewViewUrl('/view/workspace-1/')).toBe('/view/workspace-1/')
  })
})
