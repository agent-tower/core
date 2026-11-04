// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreviewSession } from '@agent-tower/shared'

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    post: vi.fn(),
    delete: vi.fn(),
  },
}))

vi.mock('@/lib/api-client', () => ({
  apiClient: apiMock,
  ApiError: class ApiError extends Error {
    constructor(public status: number, message: string) {
      super(message)
    }
  },
}))

import { openPreviewSession, probeGatewayReachability, resetGatewayProbeCache } from '../use-previews'

const gatewaySession: PreviewSession = {
  id: 'lease-1',
  target: 'http://127.0.0.1:3000',
  mode: 'local',
  kind: 'gateway',
  viewUrl: 'http://localhost:41000/?__agent_tower_preview_token=secret',
  expiresAt: '2030-01-01T00:00:00.000Z',
}

const sameOriginSession: PreviewSession = {
  id: 'same-origin',
  target: 'http://127.0.0.1:3000',
  mode: 'remote',
  kind: 'same-origin',
  viewUrl: '/view/workspace-1/',
  expiresAt: '2030-01-01T00:00:00.000Z',
}

describe('preview session entry selection', () => {
  beforeEach(() => {
    resetGatewayProbeCache()
    apiMock.post.mockReset()
    apiMock.delete.mockReset()
    apiMock.delete.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps the dedicated gateway when the browser can reach it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    apiMock.post.mockResolvedValueOnce(gatewaySession)

    const session = await openPreviewSession('workspace-1')

    expect(session.kind).toBe('gateway')
    expect(apiMock.post).toHaveBeenCalledTimes(1)
    expect(apiMock.post.mock.calls[0][1]).toMatchObject({ mode: 'local' })
    expect(apiMock.delete).not.toHaveBeenCalled()
  })

  it('falls back to the same-origin proxy when the gateway port is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }))
    apiMock.post
      .mockResolvedValueOnce(gatewaySession)
      .mockResolvedValueOnce(sameOriginSession)

    const session = await openPreviewSession('workspace-1')

    expect(session.kind).toBe('same-origin')
    expect(session.viewUrl).toBe('/view/workspace-1/')
    expect(apiMock.post).toHaveBeenCalledTimes(2)
    expect(apiMock.post.mock.calls[1][1]).toMatchObject({ mode: 'remote' })
    expect(apiMock.delete).toHaveBeenCalledWith('/previews/workspace-1/sessions/lease-1')
  })

  it('treats any HTTP answer from the gateway as reachable and remembers failures briefly', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    let now = 0
    expect(await probeGatewayReachability('http://localhost:41000/?x=1', fetchMock, () => now)).toBe(false)
    expect(await probeGatewayReachability('http://localhost:41000/other', fetchMock, () => now)).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:41000/__agent_tower_preview_heartbeat')

    now = 120_000
    const okFetch = vi.fn(async () => new Response(null, { status: 401 }))
    expect(await probeGatewayReachability('http://localhost:41000/', okFetch, () => now)).toBe(true)
    expect(okFetch).toHaveBeenCalledTimes(1)
  })
})
