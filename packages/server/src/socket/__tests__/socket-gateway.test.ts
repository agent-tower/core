import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getEventBus } from '../../core/container.js';
import { AccessAuthService } from '../../services/access-auth.service.js';
import { ClientEvents, ServerEvents } from '../events.js';
import { SocketGateway } from '../socket-gateway.js';
import type { AuthenticatedSocket } from '../middleware/index.js';

class FakeAdapter {
  rooms = new Map<string, Set<string>>();
}

class FakeNamespace {
  sockets = new Map<string, FakeSocket>();
  adapter = new FakeAdapter();

  addSocket(socket: FakeSocket) {
    this.sockets.set(socket.id, socket);
  }
}

class FakeSocket {
  id: string;
  accessAuthSessionSecretGeneration = AccessAuthService.getSessionSecretGeneration();
  emitted: Array<{ event: string; payload: unknown }> = [];
  disconnected = false;
  private handlers = new Map<string, (...args: any[]) => void>();

  constructor(
    id: string,
    private readonly namespace: FakeNamespace,
  ) {
    this.id = id;
    this.namespace.addSocket(this);
  }

  on(event: string, handler: (...args: any[]) => void) {
    this.handlers.set(event, handler);
    return this;
  }

  emit(event: string, payload?: unknown) {
    this.emitted.push({ event, payload });
    return true;
  }

  join(room: string) {
    const sockets = this.namespace.adapter.rooms.get(room) ?? new Set<string>();
    sockets.add(this.id);
    this.namespace.adapter.rooms.set(room, sockets);
  }

  leave(room: string) {
    this.namespace.adapter.rooms.get(room)?.delete(this.id);
  }

  disconnect() {
    this.disconnected = true;
  }

  receive(event: string, payload?: unknown, ack?: (response: unknown) => void) {
    this.handlers.get(event)?.(payload, ack);
  }
}

function buildGateway() {
  const namespace = new FakeNamespace();
  const eventBus = getEventBus();
  const sessionManager = {
    writeInput: vi.fn(),
    resize: vi.fn(),
  };
  const terminalManager = {
    write: vi.fn(),
    resize: vi.fn(),
    cleanupBySocket: vi.fn(),
  };
  const gateway = new SocketGateway(
    namespace as any,
    eventBus,
    sessionManager as any,
    terminalManager as any,
  );

  return { namespace, eventBus, gateway, sessionManager, terminalManager };
}

function makeSocket(namespace: FakeNamespace, id: string) {
  return new FakeSocket(id, namespace) as unknown as FakeSocket & AuthenticatedSocket;
}

describe('SocketGateway access auth session revocation', () => {
  beforeEach(() => {
    AccessAuthService.__test.resetSessionSecretGeneration();
  });

  it('disconnects old sockets and does not broadcast session output after session secret rotation', () => {
    const { namespace, eventBus, gateway } = buildGateway();
    const oldSocket = makeSocket(namespace, 'socket-old');
    gateway.register(oldSocket);

    AccessAuthService.__test.notifySessionSecretRotated();

    expect(oldSocket.disconnected).toBe(true);

    eventBus.emit('session:stdout', { sessionId: 'session-1', data: 'secret output' });
    expect(oldSocket.emitted).not.toContainEqual({
      event: ServerEvents.SESSION_STDOUT,
      payload: { sessionId: 'session-1', data: 'secret output' },
    });

    gateway.destroy();
  });

  it('ignores sensitive input and resize events from stale sockets', () => {
    const { namespace, gateway, sessionManager, terminalManager } = buildGateway();
    const socket = makeSocket(namespace, 'socket-stale');
    gateway.register(socket);

    AccessAuthService.__test.notifySessionSecretRotated();
    socket.disconnected = false;

    socket.receive(ClientEvents.INPUT, { sessionId: 'session-1', data: 'whoami\n' });
    socket.receive(ClientEvents.RESIZE, { sessionId: 'session-1', cols: 120, rows: 30 });
    socket.receive(ClientEvents.TERMINAL_INPUT, { terminalId: 'terminal-1', data: 'date\n' });
    socket.receive(ClientEvents.TERMINAL_RESIZE, { terminalId: 'terminal-1', cols: 100, rows: 24 });

    expect(sessionManager.writeInput).not.toHaveBeenCalled();
    expect(sessionManager.resize).not.toHaveBeenCalled();
    expect(terminalManager.write).not.toHaveBeenCalled();
    expect(terminalManager.resize).not.toHaveBeenCalled();
    expect(socket.disconnected).toBe(true);

    gateway.destroy();
  });

  it('continues to serve sockets connected after session secret rotation', () => {
    const { namespace, eventBus, gateway, sessionManager } = buildGateway();
    AccessAuthService.__test.notifySessionSecretRotated();

    const currentSocket = makeSocket(namespace, 'socket-current');
    gateway.register(currentSocket);

    currentSocket.receive(ClientEvents.INPUT, { sessionId: 'session-1', data: 'pwd\n' });
    eventBus.emit('session:stdout', { sessionId: 'session-1', data: 'current output' });

    expect(sessionManager.writeInput).toHaveBeenCalledWith('session-1', 'pwd\n');
    expect(currentSocket.disconnected).toBe(false);
    expect(currentSocket.emitted).toContainEqual({
      event: ServerEvents.SESSION_STDOUT,
      payload: { sessionId: 'session-1', data: 'current output' },
    });

    gateway.destroy();
  });
});
