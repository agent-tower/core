import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiClient } from '../api-client'

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

  it('preserves structured error details for conflict responses', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        error: 'Merge conflict',
        code: 'MERGE_CONFLICT',
        conflictOp: 'MERGE',
        conflictedFiles: ['src/app.ts'],
      }),
    } as Response)

    await expect(apiClient.post('/workspaces/ws-1/merge')).rejects.toMatchObject({
      name: 'ApiError',
      status: 409,
      message: 'Merge conflict',
      details: {
        code: 'MERGE_CONFLICT',
        conflictOp: 'MERGE',
        conflictedFiles: ['src/app.ts'],
      },
    } satisfies Partial<ApiError>)
  })
})
