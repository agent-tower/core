import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TunnelService } from '../../../services/tunnel.service.js';
import {
  INTERNAL_API_TOKEN_ENV,
  INTERNAL_API_TOKEN_HEADER,
} from '../../../utils/internal-api-token.js';
import { authMiddleware, type AuthenticatedSocket } from '../auth.js';

const accessAuthMock = vi.hoisted(() => ({
  extractCookieFromHeader: vi.fn(() => null as string | null),
  validateSessionTokenWithGeneration: vi.fn(async () => ({ valid: true, generation: 0 })),
  getSessionSecretGeneration: vi.fn(() => 0),
}));

vi.mock('../../../services/access-auth.service.js', () => ({
  AccessAuthService: {
    cookieName: 'agent-tower-access',
    extractCookieFromHeader: accessAuthMock.extractCookieFromHeader,
    validateSessionTokenWithGeneration: accessAuthMock.validateSessionTokenWithGeneration,
    getSessionSecretGeneration: accessAuthMock.getSessionSecretGeneration,
  },
}));

function makeSocket({
  headers,
  auth,
}: {
  headers?: Record<string, string>;
  auth?: Record<string, string>;
}): AuthenticatedSocket {
  return {
    id: 'socket-12345678',
    request: {
      headers: headers ?? {},
    },
    handshake: {
      auth: auth ?? {},
      query: {},
    },
  } as AuthenticatedSocket;
}

describe('socket authMiddleware', () => {
  beforeEach(() => {
    delete process.env[INTERNAL_API_TOKEN_ENV];
    accessAuthMock.extractCookieFromHeader.mockReset();
    accessAuthMock.validateSessionTokenWithGeneration.mockReset();
    accessAuthMock.getSessionSecretGeneration.mockReset();
    vi.spyOn(TunnelService, 'isRunning').mockReturnValue(true);
    vi.spyOn(TunnelService, 'validateToken').mockImplementation((token) => token === 'good-token');
    accessAuthMock.extractCookieFromHeader.mockReturnValue(null);
    accessAuthMock.validateSessionTokenWithGeneration.mockResolvedValue({ valid: true, generation: 0 });
    accessAuthMock.getSessionSecretGeneration.mockReturnValue(0);
  });

  afterEach(() => {
    delete process.env[INTERNAL_API_TOKEN_ENV];
    vi.restoreAllMocks();
  });

  it('accepts tunnel websocket connections with a valid tunnel session cookie', async () => {
    const socket = makeSocket({
      headers: {
        'cf-ray': 'abc123',
        cookie: '__Host-agent-tower-tunnel=good-token',
      },
    });

    const next = vi.fn();
    authMiddleware(socket, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalled());

    expect(next).toHaveBeenCalledWith();
    expect(socket.userId).toBe('good-token');
    expect(socket.accessAuthSessionSecretGeneration).toBe(0);
  });

  it('rejects tunnel websocket connections that only send auth.token', async () => {
    const socket = makeSocket({
      headers: {
        'cf-ray': 'abc123',
      },
      auth: {
        token: 'good-token',
      },
    });

    const next = vi.fn();
    authMiddleware(socket, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalled());

    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it('rejects websocket connections without an access auth session when enabled', async () => {
    accessAuthMock.validateSessionTokenWithGeneration.mockResolvedValueOnce({ valid: false, generation: 0 });
    const socket = makeSocket({
      headers: {},
    });

    const next = vi.fn();
    authMiddleware(socket, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalled());

    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(String(next.mock.calls[0][0].message)).toContain('access password');
  });

  it('accepts websocket connections with a valid internal token', async () => {
    process.env[INTERNAL_API_TOKEN_ENV] = 'expected-internal-token';
    accessAuthMock.getSessionSecretGeneration.mockReturnValueOnce(3);
    accessAuthMock.validateSessionTokenWithGeneration.mockResolvedValueOnce({ valid: false, generation: 0 });
    const socket = makeSocket({
      headers: {
        [INTERNAL_API_TOKEN_HEADER]: 'expected-internal-token',
      },
    });

    const next = vi.fn();
    authMiddleware(socket, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalled());

    expect(next).toHaveBeenCalledWith();
    expect(accessAuthMock.validateSessionTokenWithGeneration).not.toHaveBeenCalled();
    expect(socket.accessAuthSessionSecretGeneration).toBe(3);
  });

  it('rejects invalid internal token even when an access auth session cookie is valid', async () => {
    process.env[INTERNAL_API_TOKEN_ENV] = 'expected-internal-token';
    accessAuthMock.extractCookieFromHeader.mockReturnValueOnce('valid-access-token');
    accessAuthMock.validateSessionTokenWithGeneration.mockResolvedValueOnce({ valid: true, generation: 2 });
    const socket = makeSocket({
      headers: {
        [INTERNAL_API_TOKEN_HEADER]: 'wrong-internal-token',
        cookie: 'agent-tower-access=valid-access-token',
      },
    });

    const next = vi.fn();
    authMiddleware(socket, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalled());

    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(String(next.mock.calls[0][0].message)).toContain('invalid internal token');
    expect(accessAuthMock.validateSessionTokenWithGeneration).not.toHaveBeenCalled();
    expect(socket.accessAuthSessionSecretGeneration).toBeUndefined();
  });

  it('uses access auth session cookie when internal token is missing', async () => {
    accessAuthMock.extractCookieFromHeader.mockReturnValueOnce('valid-access-token');
    accessAuthMock.validateSessionTokenWithGeneration.mockResolvedValueOnce({ valid: true, generation: 2 });
    const socket = makeSocket({
      headers: {
        cookie: 'agent-tower-access=valid-access-token',
      },
    });

    const next = vi.fn();
    authMiddleware(socket, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalled());

    expect(next).toHaveBeenCalledWith();
    expect(accessAuthMock.validateSessionTokenWithGeneration).toHaveBeenCalledWith('valid-access-token');
    expect(socket.accessAuthSessionSecretGeneration).toBe(2);
  });

  it('rejects websocket connections when access auth generation changes during validation', async () => {
    accessAuthMock.extractCookieFromHeader.mockReturnValueOnce('old-token');
    accessAuthMock.validateSessionTokenWithGeneration.mockResolvedValueOnce({ valid: false, generation: 1 });
    const socket = makeSocket({
      headers: {
        cookie: 'agent-tower-access=old-token',
      },
    });

    const next = vi.fn();
    authMiddleware(socket, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalled());

    expect(accessAuthMock.validateSessionTokenWithGeneration).toHaveBeenCalledWith('old-token');
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(socket.accessAuthSessionSecretGeneration).toBeUndefined();
  });
});
