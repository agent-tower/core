import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedSocket } from '../socket/middleware/auth.js';
import { authorizeWorkspaceGitConflictToken } from './workspace-git-conflict-token.js';

const mocks = vi.hoisted(() => ({
  extractCookie: vi.fn(),
  validateBrowser: vi.fn(),
  authorize: vi.fn(),
  prisma: {},
}));
vi.mock('../services/access-auth.service.js', () => ({ AccessAuthService: {
  extractCookieFromHeader: mocks.extractCookie,
  validateBrowserSessionToken: mocks.validateBrowser,
} }));
vi.mock('../services/conflict-resolution-context.js', () => ({ authorizeConflictResolutionContext: mocks.authorize }));
vi.mock('../utils/index.js', () => ({ prisma: mocks.prisma }));

const socket = (cookie?: string) => Object.freeze({
  request: Object.freeze({ headers: Object.freeze({ cookie }) }),
}) as unknown as AuthenticatedSocket;

describe('authorizeWorkspaceGitConflictToken', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.extractCookie.mockReturnValue(null);
    mocks.validateBrowser.mockResolvedValue(false);
    mocks.authorize.mockResolvedValue('authorized-token');
  });

  it('uses the HTTP browser actor and leaves the shared token and socket untouched', async () => {
    const input = Object.freeze({ token: 'shared-unbound-token', socket: socket('access=browser-cookie; extra=value') });
    mocks.extractCookie.mockReturnValue('browser-cookie');
    mocks.validateBrowser.mockResolvedValue(true);
    expect(await authorizeWorkspaceGitConflictToken(input.token, input.socket)).toBe('authorized-token');
    expect(mocks.extractCookie).toHaveBeenCalledExactlyOnceWith('access=browser-cookie; extra=value');
    expect(mocks.validateBrowser).toHaveBeenCalledExactlyOnceWith('browser-cookie');
    expect(mocks.authorize).toHaveBeenCalledExactlyOnceWith(
      'shared-unbound-token', `browser:${createHash('sha256').update('browser-cookie').digest('hex')}`, mocks.prisma,
    );
    expect(input.token).toBe('shared-unbound-token');
    expect(input.socket.request.headers.cookie).toBe('access=browser-cookie; extra=value');
  });

  it('uses owner when the already-authorized socket has no browser cookie', async () => {
    await authorizeWorkspaceGitConflictToken('unbound-token', socket());
    expect(mocks.authorize).toHaveBeenCalledExactlyOnceWith('unbound-token', 'owner', mocks.prisma);
    expect(mocks.validateBrowser).not.toHaveBeenCalled();
  });

  it('uses owner for an invalid cookie on a password-disabled owner socket', async () => {
    mocks.extractCookie.mockReturnValue('expired-cookie');
    await authorizeWorkspaceGitConflictToken('unbound-token', socket('access=expired-cookie'));
    expect(mocks.validateBrowser).toHaveBeenCalledExactlyOnceWith('expired-cookie');
    expect(mocks.authorize).toHaveBeenCalledExactlyOnceWith('unbound-token', 'owner', mocks.prisma);
  });

  it('propagates authorization errors so delivery can retry without sending an unbound token', async () => {
    const error = new Error('conflict observation changed');
    mocks.authorize.mockRejectedValue(error);
    await expect(authorizeWorkspaceGitConflictToken('unbound-token', socket())).rejects.toBe(error);
  });

  it('propagates browser validation errors without attempting token authorization', async () => {
    const error = new Error('authentication lookup unavailable');
    mocks.extractCookie.mockReturnValue('browser-cookie');
    mocks.validateBrowser.mockRejectedValue(error);
    await expect(authorizeWorkspaceGitConflictToken('unbound-token', socket('access=browser-cookie'))).rejects.toBe(error);
    expect(mocks.authorize).not.toHaveBeenCalled();
  });
});
