const TUNNEL_BOOTSTRAP_PATH = '/api/tunnel/bootstrap'

export async function bootstrapTunnelSession(): Promise<void> {
  const currentUrl = new URL(window.location.href)
  const token = currentUrl.searchParams.get('token')

  if (!token) return

  const response = await fetch(
    `${TUNNEL_BOOTSTRAP_PATH}?token=${encodeURIComponent(token)}`,
    {
      method: 'POST',
      credentials: 'same-origin',
    },
  )

  if (!response.ok) {
    throw new Error(`Tunnel bootstrap failed (${response.status})`)
  }

  currentUrl.searchParams.delete('token')
  window.history.replaceState({}, '', currentUrl.toString())
}
