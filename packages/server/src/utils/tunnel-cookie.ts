export const TUNNEL_SESSION_COOKIE_NAME = '__Host-agent-tower-tunnel';

export function extractTunnelSessionTokenFromCookieHeader(
  cookieHeader?: string,
): string | null {
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (rawName === TUNNEL_SESSION_COOKIE_NAME) {
      return decodeURIComponent(rawValue.join('='));
    }
  }

  return null;
}

export const TUNNEL_SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
};
