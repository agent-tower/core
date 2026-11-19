import { createHash } from 'node:crypto';
import type { AuthenticatedSocket } from '../socket/middleware/auth.js';

/**
 * Bind the shared, unbound conflict observation to the same owner identity as
 * the HTTP git-status route. The gateway validates owner access before this
 * call and again after it; this function only authorizes the observed token.
 */
export async function authorizeWorkspaceGitConflictToken(token: string, socket: AuthenticatedSocket): Promise<string> {
  const [{ AccessAuthService }, { authorizeConflictResolutionContext }, { prisma }] = await Promise.all([
    import('../services/access-auth.service.js'),
    import('../services/conflict-resolution-context.js'),
    import('../utils/index.js'),
  ]);
  const cookie = AccessAuthService.extractCookieFromHeader(socket.request.headers.cookie);
  const actor = cookie && await AccessAuthService.validateBrowserSessionToken(cookie)
    ? `browser:${createHash('sha256').update(cookie).digest('hex')}`
    : 'owner';
  return authorizeConflictResolutionContext(token, actor, prisma);
}
