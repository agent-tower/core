import { describe, expect, it } from 'vitest'
import {
  TUNNEL_SESSION_COOKIE_NAME,
  extractTunnelSessionTokenFromCookieHeader,
} from '../tunnel-cookie.js'

describe('tunnel-cookie', () => {
  it('extracts the tunnel session token from a cookie header', () => {
    expect(
      extractTunnelSessionTokenFromCookieHeader(
        `foo=1; ${TUNNEL_SESSION_COOKIE_NAME}=good-token; theme=dark`,
      ),
    ).toBe('good-token')
  })

  it('returns null when the tunnel session cookie is missing', () => {
    expect(extractTunnelSessionTokenFromCookieHeader('foo=1; theme=dark')).toBeNull()
  })
})
