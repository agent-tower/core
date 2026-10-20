import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getEventBus, getTranslationService } from '../../core/container.js';
import { AccessAuthService } from '../../services/access-auth.service.js';
import { ClientEvents, ServerEvents } from '../events.js';
import { SocketGateway } from '../socket-gateway.js';
import type { AuthenticatedSocket } from '../middleware/index.js';
import { RuntimeType } from '@agent-tower/shared';
import { WorkspaceBackgroundProcessManager } from '../../services/workspace-background-process-manager.js';

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
  request = { headers: {} as Record<string, string> };
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

  it('broadcasts permission and authoritative runtime state transitions', () => {
    const { namespace, eventBus, gateway } = buildGateway();
    const socket = makeSocket(namespace, 'socket-runtime');
    gateway.register(socket);
    const permission = {
      requestId: 'permission-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' as const }],
      createdAt: '2026-07-23T00:00:00.000Z',
    };
    const state = {
      sessionId: 'session-1',
      runtimeType: RuntimeType.ACP,
      turnState: 'AWAITING_PERMISSION' as const,
      turnId: 'turn-1',
      capabilities: {
        loadSession: true,
        terminalInput: false,
        terminalResize: false,
        permissions: true,
      },
      pendingPermissions: [permission],
    };

    eventBus.emit('session:permission_requested', { sessionId: 'session-1', permission });
    eventBus.emit('session:runtime_state_changed', { sessionId: 'session-1', state });
    eventBus.emit('session:permission_invalidated', {
      sessionId: 'session-1',
      turnId: 'turn-1',
      requestId: 'permission-1',
    });

    expect(socket.emitted).toEqual(expect.arrayContaining([
      { event: ServerEvents.SESSION_PERMISSION_REQUESTED, payload: { sessionId: 'session-1', permission } },
      { event: ServerEvents.SESSION_RUNTIME_STATE_CHANGED, payload: { sessionId: 'session-1', state } },
      {
        event: ServerEvents.SESSION_PERMISSION_INVALIDATED,
        payload: { sessionId: 'session-1', turnId: 'turn-1', requestId: 'permission-1' },
      },
    ]));

    gateway.destroy();
  });

  it('does not stop a real workspace service when a socket disconnects', async () => {
    const manager = new WorkspaceBackgroundProcessManager({
      resolveCommand: async () => process.execPath,
    });
    const { namespace, gateway, terminalManager } = buildGateway();
    const socket = makeSocket(namespace, 'socket-disconnect');
    gateway.register(socket);

    try {
      const started = await manager.start('service-socket', 'runtime-socket', {
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: process.cwd(),
      }, vi.fn());
      socket.receive('disconnect');

      expect(terminalManager.cleanupBySocket).toHaveBeenCalledWith('socket-disconnect');
      expect(manager.has('service-socket', started.runtimeInstanceId)).toBe(true);
    } finally {
      gateway.destroy();
      await manager.stopAll().catch(() => undefined);
    }
  }, 15_000);
  it.each(['translation:invalidated', 'message-delivery:invalidated'] as const)('subscribes and unsubscribes overlay notifications through the public gateway with current owner permissions', async event => {
    const service = getTranslationService();
    const readable = vi.spyOn(service, 'assertReadableSession').mockResolvedValue(undefined);
    const { namespace, gateway, eventBus } = buildGateway();
    const owner = makeSocket(namespace, 'owner');
    const other = makeSocket(namespace, 'other');
    const all = makeSocket(namespace, 'all');
    const agent = makeSocket(namespace, 'agent'); agent.request.headers['x-agent-tower-agent-credential'] = 'agent';
    const internal = makeSocket(namespace, 'internal'); internal.request.headers['x-agent-tower-internal-token'] = 'internal';
    const stale = makeSocket(namespace, 'stale'); stale.accessAuthSessionSecretGeneration = -1;
    for (const socket of [owner, other, all, agent, internal, stale]) gateway.register(socket);
    const subscribe = (socket: typeof owner, id?: string) => new Promise<unknown>(resolve => socket.receive(ClientEvents.SUBSCRIBE, { topic: 'session', id }, resolve));
    const payload = event === 'translation:invalidated' ? { sessionId: 's', sourceId: 'source', sourceRevision: 1, overlayRevision: 2 } : { sessionId: 's', operationId: 'operation', deliveryRevision: 2 };
    const settle = () => new Promise(resolve => setImmediate(resolve));
    const notifications = (socket: typeof owner) => socket.emitted.filter(e => e.event === event);
    try {
      expect(await subscribe(owner, 's')).toEqual({ success: true });
      expect(namespace.adapter.rooms.get('session:s')?.has(owner.id)).toBe(true);
      await subscribe(other, 'other');
      for (const [socket, id] of [[all, 'all'], [agent, 's'], [internal, 's'], [stale, 's']] as const) {
        expect(await subscribe(socket, id)).toMatchObject({ success: false });
      }
      expect(await subscribe(all)).toMatchObject({ success: false });
      eventBus.emit(event, payload as never); await settle();
      expect(notifications(owner)).toEqual([{ event: event, payload }]);
      for (const socket of [other, all, agent, internal, stale]) expect(notifications(socket)).toEqual([]);
      await new Promise(resolve => owner.receive(ClientEvents.UNSUBSCRIBE, { topic: 'session', id: 's' }, resolve));
      expect(namespace.adapter.rooms.get('session:s')?.has(owner.id)).toBe(false);
      eventBus.emit(event, payload as never); await settle(); expect(notifications(owner)).toHaveLength(1);
      await subscribe(owner, 's');
      owner.request.headers['x-agent-tower-agent-credential'] = 'late-agent';
      eventBus.emit(event, payload as never); await settle(); expect(notifications(owner)).toHaveLength(1);
      delete owner.request.headers['x-agent-tower-agent-credential'];
      readable.mockRejectedValueOnce(new Error('scope deleted'));
      eventBus.emit(event, payload as never); await settle(); expect(notifications(owner)).toHaveLength(1);
      AccessAuthService.__test.notifySessionSecretRotated();
      eventBus.emit(event, payload as never); await settle(); expect(notifications(owner)).toHaveLength(1);
      gateway.destroy(); eventBus.emit(event, payload as never); await settle(); expect(notifications(owner)).toHaveLength(1);
    } finally { gateway.destroy(); readable.mockRestore(); }
  });

  it('sends pending creation IDs only to the current owner of a readable task subscription', async () => {
    const auth = vi.spyOn(AccessAuthService, 'prepareSessionTokenValidation').mockResolvedValue(() => true);
    const service = getTranslationService(); const readable = vi.spyOn(service, 'assertReadableTeamTask').mockResolvedValue(undefined);
    const { namespace, gateway, eventBus } = buildGateway(); const owner = makeSocket(namespace, 'owner-initial'); const agent = makeSocket(namespace, 'agent-initial'); agent.request.headers['x-agent-tower-agent-credential'] = 'agent';
    const other = makeSocket(namespace, 'other-initial'); for (const socket of [owner, agent, other]) gateway.register(socket);
    const subscribe = (socket: typeof owner, id: string) => new Promise(resolve => socket.receive(ClientEvents.SUBSCRIBE, { topic: 'task', id }, resolve));
    const payload = { taskId: 'pending-task', operationId: 'operation', deliveryRevision: 3 };
    const settle = () => new Promise(resolve => setImmediate(resolve)); const notices = () => owner.emitted.filter(e => e.event === ServerEvents.MESSAGE_DELIVERY_INVALIDATED);
    try {
      expect(await subscribe(owner, 'pending-task')).toEqual({ success: true }); expect(await subscribe(agent, 'pending-task')).toMatchObject({ success: false }); await subscribe(other, 'other');
      eventBus.emit('message-delivery:invalidated', payload); await settle(); expect(notices()).toEqual([{ event: ServerEvents.MESSAGE_DELIVERY_INVALIDATED, payload }]);
      expect(agent.emitted.filter(e => e.event === ServerEvents.MESSAGE_DELIVERY_INVALIDATED)).toEqual([]); expect(other.emitted.filter(e => e.event === ServerEvents.MESSAGE_DELIVERY_INVALIDATED)).toEqual([]);
      readable.mockRejectedValueOnce(new Error('deleted')); eventBus.emit('message-delivery:invalidated', payload); await settle(); expect(notices()).toHaveLength(1);
      await new Promise(resolve => owner.receive(ClientEvents.UNSUBSCRIBE, { topic: 'task', id: 'pending-task' }, resolve)); eventBus.emit('message-delivery:invalidated', payload); await settle(); expect(notices()).toHaveLength(1);
      expect(await subscribe(owner, 'all')).toMatchObject({ success: false });
    } finally { gateway.destroy(); readable.mockRestore(); auth.mockRestore(); }
  });

  it('does not join after a pending subscription was revoked or its authentication became stale', async () => {
    const service = getTranslationService();
    let finish: () => void = () => {};
    const readable = vi.spyOn(service, 'assertReadableSession').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const { namespace, gateway } = buildGateway(); const owner = makeSocket(namespace, 'pending'); gateway.register(owner);
    try {
      const firstAck = vi.fn();
      owner.receive(ClientEvents.SUBSCRIBE, { topic: 'session', id: 's' }, firstAck);
      owner.receive(ClientEvents.UNSUBSCRIBE, { topic: 'session', id: 's' });
      finish(); await new Promise(resolve => setImmediate(resolve));
      expect(firstAck).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
      expect(namespace.adapter.rooms.get('session:s')?.has(owner.id) ?? false).toBe(false);
      const staleAck = vi.fn();
      owner.receive(ClientEvents.SUBSCRIBE, { topic: 'session', id: 's' }, staleAck);
      AccessAuthService.__test.notifySessionSecretRotated(); finish(); await new Promise(resolve => setImmediate(resolve));
      expect(staleAck).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
      expect(namespace.adapter.rooms.get('session:s')?.has(owner.id) ?? false).toBe(false);
    } finally { gateway.destroy(); readable.mockRestore(); }
  });

});
