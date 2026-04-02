import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from '../api-client'

describe('api-client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not attach a tunnel Authorization header', async () => {
    await apiClient.get('/projects')

    expect(fetch).toHaveBeenCalledWith(
      '/api/projects',
      expect.objectContaining({
        headers: {},
      }),
    )
  })
})
