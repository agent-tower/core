import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bootstrapTunnelSession } from '../tunnel-session'

describe('bootstrapTunnelSession', () => {
  const replaceState = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }))
    vi.stubGlobal('window', {
      location: {
        href: 'https://demo.trycloudflare.com/settings/general?token=good-token&tab=advanced',
      },
      history: {
        replaceState,
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    replaceState.mockReset()
  })

  it('exchanges the URL token for a server-side tunnel session and cleans the URL', async () => {
    await bootstrapTunnelSession()

    expect(fetch).toHaveBeenCalledWith(
      '/api/tunnel/bootstrap?token=good-token',
      {
        method: 'POST',
        credentials: 'same-origin',
      },
    )
    expect(replaceState).toHaveBeenCalledWith(
      {},
      '',
      'https://demo.trycloudflare.com/settings/general?tab=advanced',
    )
  })

  it('does nothing when the URL has no tunnel token', async () => {
    vi.stubGlobal('window', {
      location: {
        href: 'https://demo.trycloudflare.com/settings/general?tab=advanced',
      },
      history: {
        replaceState,
      },
    })

    await bootstrapTunnelSession()

    expect(fetch).not.toHaveBeenCalled()
    expect(replaceState).not.toHaveBeenCalled()
  })
})
