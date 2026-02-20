const TOKEN_KEY = 'agent-tower-tunnel-token'

/**
 * 从 URL ?token=xxx 提取 token 并存入 sessionStorage，然后清理 URL
 * 应在应用入口处调用
 */
export function initTunnelToken(): void {
  const params = new URLSearchParams(window.location.search)
  const urlToken = params.get('token')

  if (urlToken) {
    sessionStorage.setItem(TOKEN_KEY, urlToken)
    // 从地址栏移除 token 参数
    const clean = new URL(window.location.href)
    clean.searchParams.delete('token')
    window.history.replaceState({}, '', clean.toString())
  }
}

export function getTunnelToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY)
}

export function setTunnelToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token)
}

export function clearTunnelToken(): void {
  sessionStorage.removeItem(TOKEN_KEY)
}

/**
 * 判断当前是否通过隧道访问（非 localhost）
 */
export function isTunnelAccess(): boolean {
  const host = window.location.hostname
  return host !== 'localhost' && host !== '127.0.0.1'
}
