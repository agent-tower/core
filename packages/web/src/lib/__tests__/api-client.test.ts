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
        credentials: 'same-origin',
        headers: {},
      }),
    )
  })

  it('passes the abort signal of a query to fetch', async () => {
    const controller = new AbortController()
    await apiClient.get('/git/diff', { params: { path: 'a.txt' }, signal: controller.signal })

    expect(fetch).toHaveBeenCalledWith('/api/git/diff?path=a.txt', expect.objectContaining({ signal: controller.signal }))
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
