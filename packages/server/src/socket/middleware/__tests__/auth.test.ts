import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TunnelService } from '../../../services/tunnel.service.js';
import { authMiddleware, type AuthenticatedSocket } from '../auth.js';

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
    vi.spyOn(TunnelService, 'isRunning').mockReturnValue(true);
    vi.spyOn(TunnelService, 'validateToken').mockImplementation((token) => token === 'good-token');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts tunnel websocket connections with a valid tunnel session cookie', () => {
    const socket = makeSocket({
      headers: {
        'cf-ray': 'abc123',
        cookie: '__Host-agent-tower-tunnel=good-token',
      },
    });

    const next = vi.fn();
    authMiddleware(socket, next);

    expect(next).toHaveBeenCalledWith();
    expect(socket.userId).toBe('good-token');
  });

  it('rejects tunnel websocket connections that only send auth.token', () => {
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

    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});
