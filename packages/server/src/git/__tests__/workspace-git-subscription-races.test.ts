/** Registry races use the real socket transport with a controlled state service. */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Server, type Socket } from 'socket.io';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  ClientEvents, ServerEvents,
  type WorkspaceGitStatePayload, type WorkspaceGitSubscriptionEndedPayload, type WorkspaceGitSubscribeAck,
} from '@agent-tower/shared/socket';
import { EventBus } from '../../core/event-bus.js';
import type { AuthenticatedSocket } from '../../socket/middleware/index.js';
import type { invalidateWorkspaceGitState, registerWorkspaceGitState } from '../state/git-state-facade.js';
import type { GitStateSnapshot } from '../state/git-state-types.js';
import { WorkspaceGitSubscriptions, type WorkspaceGitSubscriptionInput } from '../workspace-git-subscriptions.js';

interface ClientSocket {
  id?: string;
  connected: boolean;
  on(event: typeof ServerEvents.WORKSPACE_GIT_SUBSCRIPTION_ENDED, listener: (payload: WorkspaceGitSubscriptionEndedPayload) => void): void;
  on(event: string, listener: (payload: WorkspaceGitStatePayload) => void): void;
  once(event: string, listener: (error?: Error) => void): void;
  emit(event: string, payload: { workspaceId: string }): void;
  timeout(ms: number): { emitWithAck(event: string, payload: { workspaceId: string }): Promise<WorkspaceGitSubscribeAck> };
  disconnect(): void;
}
const { io: connect } = createRequire(path.resolve('packages/web/package.json'))('socket.io-client') as {
  io(url: string, options: { transports: string[]; reconnection: boolean }): ClientSocket;
};
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const worktreePath = path.resolve('.tmp-step3a/socket-race-fixture');
const input: WorkspaceGitSubscriptionInput = { worktreePath, repositoryPath: worktreePath, baseBranch: 'main' };
function state(epoch = 'initial', version = 1): GitStateSnapshot {
  return {
    worktreePath, baseBranch: 'main', available: true, operation: 'idle',
    head: { oid: 'a'.repeat(40), branch: 'topic' }, uncommitted: [], committed: [],
    uncommittedCount: 0, untrackedCount: 0, unmergedPaths: [], ahead: 0, behind: 0,
    degraded: [], epoch, version, computedAt: Date.now(),
  };
}

let server: Server;
let registry: WorkspaceGitSubscriptions;
let bus: EventBus;
let port: number;
let latest: GitStateSnapshot;
let registerState: ReturnType<typeof vi.fn<typeof registerWorkspaceGitState>>;
let unregisterState: ReturnType<typeof vi.fn<(directory: string) => void>>;
let invalidateState: ReturnType<typeof vi.fn<typeof invalidateWorkspaceGitState>>;
/** While set, socket validations wait for it, like a slow authorization read. */
let validationGate: Promise<void> | undefined;
let validations = 0;
let loadWorkspace: ReturnType<typeof vi.fn<(workspaceId: string) => Promise<WorkspaceGitSubscriptionInput>>>;
let observeConflict: ReturnType<typeof vi.fn<(workspaceId: string) => Promise<string | undefined>>>;
let authorizeConflict: ReturnType<typeof vi.fn<(token: string, socket: AuthenticatedSocket) => Promise<string>>>;
let beforeRegister: ((socket: Socket) => void) | undefined;
const changes = new Set<(snapshot: GitStateSnapshot) => void>();
const placements = new Set<() => void>();
const unsubscribed = new Set<string>();
const deniedSockets = new Set<string>();
const clients: ClientSocket[] = [];
const pushes = new Map<ClientSocket, WorkspaceGitStatePayload[]>();

beforeEach(async () => {
  latest = state();
  deniedSockets.clear();
  beforeRegister = undefined;
  validationGate = undefined;
  validations = 0;
  invalidateState = vi.fn<typeof invalidateWorkspaceGitState>();
  registerState = vi.fn<typeof registerWorkspaceGitState>(async () => structuredClone(latest));
  unregisterState = vi.fn<(directory: string) => void>();
  loadWorkspace = vi.fn(async (workspaceId: string) => ({ ...input, mainDirectory: workspaceId.startsWith('main-') }));
  observeConflict = vi.fn<(workspaceId: string) => Promise<string | undefined>>(async () => 'conflict-token');
  authorizeConflict = vi.fn<(token: string, socket: AuthenticatedSocket) => Promise<string>>(async (token) => token);
  const http = createServer();
  server = new Server(http);
  const namespace = server.of('/events');
  bus = new EventBus();
  registry = new WorkspaceGitSubscriptions(namespace, bus, async (socket) => {
    validations += 1;
    await validationGate;
    return () => !deniedSockets.has(socket.id);
  }, {
    graceMs: 30, registrationRetryDelaysMs: [40, 60], deliveryRetryMinMs: 30, deliveryRetryMaxMs: 60,
    loadWorkspace, observeConflict, authorizeConflict,
    state: {
      register: registerState, unregister: unregisterState, invalidate: invalidateState,
      onChange: (listener) => { changes.add(listener); return () => { changes.delete(listener); }; },
      onPlacementChange: (listener) => { placements.add(listener); return () => { placements.delete(listener); }; },
    },
  });
  namespace.on('connection', (socket) => {
    beforeRegister?.(socket);
    registry.register(socket as AuthenticatedSocket);
    socket.on(ClientEvents.WORKSPACE_GIT_UNSUBSCRIBE, () => unsubscribed.add(socket.id));
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  port = (http.address() as { port: number }).port;
});

afterEach(async () => {
  registry.destroy();
  for (const socket of clients.splice(0)) socket.disconnect();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  changes.clear(); placements.clear(); unsubscribed.clear(); pushes.clear();
});

async function client(): Promise<ClientSocket> {
  const socket = connect(`http://127.0.0.1:${port}/events`, { transports: ['websocket'], reconnection: false });
  clients.push(socket); pushes.set(socket, []);
  socket.on(ServerEvents.WORKSPACE_GIT_STATE, (payload) => pushes.get(socket)!.push(payload));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve()); socket.once('connect_error', reject);
  });
  return socket;
}
function subscribe(socket: ClientSocket, workspaceId = 'ws') {
  return socket.timeout(3_000).emitWithAck(ClientEvents.WORKSPACE_GIT_SUBSCRIBE, { workspaceId });
}
function placementChanged() { for (const listener of placements) listener(); }
function changed(snapshot: GitStateSnapshot) { latest = snapshot; for (const listener of changes) listener(snapshot); }

it.each(['base-event', 'directory-metadata'] as const)('reloads initial subscription metadata changed during its lookup (%s)', async (trigger) => {
  const lookup = deferred<WorkspaceGitSubscriptionInput>();
  loadWorkspace.mockImplementationOnce(() => lookup.promise);
  loadWorkspace.mockImplementation(async () => ({ ...input, mainDirectory: true, baseBranch: 'next' }));
  const socket = await client();
  const acknowledgement = subscribe(socket, 'main-a');
  await expect.poll(() => loadWorkspace.mock.calls.length).toBe(1);
  latest = { ...state(), baseBranch: 'next' };
  if (trigger === 'base-event') bus.emit('workspace:git_changed', { workspaceId: 'main-a', taskId: 'task', projectId: 'project', workingDir: worktreePath, reason: 'base-branch' });
  else registry.refreshPath(worktreePath, false);
  lookup.resolve({ ...input, mainDirectory: true });
  expect(await acknowledgement).toMatchObject({ ok: true, state: { baseBranch: 'next' } });
  expect(loadWorkspace).toHaveBeenCalledTimes(2);
  expect(registerState).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ baseBranch: 'next' }), expect.anything());
});

it('reloads shared-directory metadata and releases a removed alias without unregistering its other owner', async () => {
  const socket = await client();
  await subscribe(socket, 'main-a');
  await subscribe(socket, 'main-b');
  expect(registerState).toHaveBeenCalledTimes(1);
  loadWorkspace.mockImplementation(async (workspaceId) => {
    if (workspaceId === 'main-a') throw Object.assign(new Error('Workspace no longer has a directory'), { code: 'WORKSPACE_GIT_UNAVAILABLE' });
    return { ...input, mainDirectory: true, baseBranch: 'next' };
  });
  latest = { ...state('initial', 2), baseBranch: 'next' };
  registry.refreshPath(worktreePath, false);
  await expect.poll(() => pushes.get(socket)?.length).toBe(1);
  expect(pushes.get(socket)?.[0]).toMatchObject({ workspaceId: 'main-b', state: { baseBranch: 'next' } });
  await pause(80);
  expect(registerState).toHaveBeenCalledTimes(2);
  expect(unregisterState).not.toHaveBeenCalled();
  expect(registry.hasSubscribers()).toBe(true);
});

it('does no metadata work when the final subscriber has left', async () => {
  const left = deferred<void>();
  beforeRegister = (socket) => { socket.on(ClientEvents.WORKSPACE_GIT_UNSUBSCRIBE, () => left.resolve()); };
  const socket = await client();
  await subscribe(socket, 'main-a');
  socket.emit(ClientEvents.WORKSPACE_GIT_UNSUBSCRIBE, { workspaceId: 'main-a' });
  await left.promise;
  expect(registry.hasSubscribers()).toBe(false);
  const before = loadWorkspace.mock.calls.length;
  registry.refreshPath(worktreePath, false);
  bus.emit('workspace:git_changed', { workspaceId: 'main-a', taskId: 'task', projectId: 'project', workingDir: worktreePath, reason: 'base-branch' });
  await pause(80);
  expect(loadWorkspace).toHaveBeenCalledTimes(before);
  expect(registerState).toHaveBeenCalledTimes(1);
  expect(unregisterState).toHaveBeenCalledTimes(1);
});

it('waits for a pending directory placement before acknowledging another subscriber', async () => {
  const first = await client();
  expect(await subscribe(first)).toMatchObject({ ok: true, epoch: 'initial' });
  const migration = deferred<GitStateSnapshot>();
  registerState.mockImplementationOnce(() => migration.promise);
  placementChanged();
  expect(registerState).toHaveBeenCalledTimes(2);
  const second = await client();
  let acknowledged = false;
  const acknowledgement = subscribe(second).then((result) => { acknowledged = true; return result; });
  try {
    await expect.poll(() => loadWorkspace.mock.calls.length).toBe(2);
    await pause(80);
    expect(acknowledged).toBe(false);
    migration.resolve(state('replacement'));
    expect(await acknowledgement).toMatchObject({ ok: true, epoch: 'replacement', version: 1 });
    await expect.poll(() => pushes.get(first)?.length).toBe(1);
    expect(pushes.get(first)![0]!.epoch).toBe('replacement');
    expect(pushes.get(second)).toEqual([]);
  } finally {
    migration.resolve(state('replacement'));
  }
});

it('removes a delayed room join after unsubscribe revoked the subscription intent', async () => {
  let releaseJoin: (() => void) | undefined;
  beforeRegister = (socket) => {
    const join = socket.join.bind(socket);
    socket.join = (rooms) => {
      if (rooms !== 'workspace-git:ws') return join(rooms);
      return new Promise<void>((resolve, reject) => {
        releaseJoin = () => { Promise.resolve(join(rooms)).then(resolve, reject); };
      });
    };
  };
  const socket = await client();
  const acknowledgement = subscribe(socket);
  try {
    await expect.poll(() => !!releaseJoin).toBe(true);
    socket.emit(ClientEvents.WORKSPACE_GIT_UNSUBSCRIBE, { workspaceId: 'ws' });
    await expect.poll(() => unsubscribed.has(socket.id!)).toBe(true);
    releaseJoin!();
    releaseJoin = undefined;
    expect(await acknowledgement).toMatchObject({ ok: false, code: 'WORKSPACE_GIT_SUBSCRIPTION_DENIED' });
    expect(server.of('/events').adapter.rooms.get('workspace-git:ws')?.has(socket.id!)).not.toBe(true);
    await expect.poll(() => unregisterState.mock.calls.length).toBe(1);
    changed(state('initial', 2));
    await pause(40);
    expect(pushes.get(socket)).toEqual([]);
  } finally {
    releaseJoin?.();
  }
});

it('registers a shared main directory once per placement and pushes the new epoch to both aliases', async () => {
  const first = await client(); const second = await client();
  expect(await subscribe(first, 'main-one')).toMatchObject({ ok: true });
  expect(await subscribe(second, 'main-two')).toMatchObject({ ok: true });
  expect(registerState).toHaveBeenCalledTimes(1);
  latest = state('replacement');
  placementChanged();
  await expect.poll(() => pushes.get(first)?.length).toBe(1);
  await expect.poll(() => pushes.get(second)?.length).toBe(1);
  expect(registerState).toHaveBeenCalledTimes(2);
  expect(pushes.get(first)![0]).toMatchObject({ workspaceId: 'main-one', epoch: 'replacement' });
  expect(pushes.get(second)![0]).toMatchObject({ workspaceId: 'main-two', epoch: 'replacement' });
  first.emit(ClientEvents.WORKSPACE_GIT_UNSUBSCRIBE, { workspaceId: 'main-one' });
  await pause(80);
  expect(unregisterState).not.toHaveBeenCalled();
  second.emit(ClientEvents.WORKSPACE_GIT_UNSUBSCRIBE, { workspaceId: 'main-two' });
  await expect.poll(() => unregisterState.mock.calls.length).toBe(1);
});

it('cancels conflict delivery retries and removes state listeners on destroy', async () => {
  const socket = await client();
  await subscribe(socket);
  observeConflict.mockRejectedValue(new Error('temporary observation failure'));
  changed({ ...state('initial', 2), operation: 'merge', unmergedPaths: ['conflicted.txt'], uncommittedCount: 1 });
  await expect.poll(() => observeConflict.mock.calls.length).toBeGreaterThanOrEqual(2);
  registry.destroy();
  const attempts = observeConflict.mock.calls.length;
  expect(changes.size).toBe(0); expect(placements.size).toBe(0);
  expect(unregisterState).toHaveBeenCalledExactlyOnceWith(worktreePath);
  await pause(200);
  expect(observeConflict).toHaveBeenCalledTimes(attempts);
  expect(pushes.get(socket)).toEqual([]);
});

it('authorizes a shared conflict payload separately for each receiving socket', async () => {
  const first = await client(); const second = await client();
  await subscribe(first); await subscribe(second);
  authorizeConflict.mockImplementation(async (token, socket) => `${token}:${socket.id}`);
  changed({ ...state('initial', 2), operation: 'merge', unmergedPaths: ['conflicted.txt'], uncommittedCount: 1 });
  await expect.poll(() => pushes.get(first)?.length).toBe(1);
  await expect.poll(() => pushes.get(second)?.length).toBe(1);
  expect(pushes.get(first)![0]!.state.status.resolutionContextToken).toBe(`conflict-token:${first.id}`);
  expect(pushes.get(second)![0]!.state.status.resolutionContextToken).toBe(`conflict-token:${second.id}`);
  expect(authorizeConflict).toHaveBeenCalledTimes(2);
  expect(observeConflict).toHaveBeenCalledTimes(1);
});

it('rechecks socket authorization after awaiting conflict-token authorization', async () => {
  const socket = await client();
  await subscribe(socket);
  const authorization = deferred<string>();
  authorizeConflict.mockImplementation(() => authorization.promise);
  changed({ ...state('initial', 2), operation: 'merge', unmergedPaths: ['conflicted.txt'], uncommittedCount: 1 });
  try {
    await expect.poll(() => authorizeConflict.mock.calls.length).toBe(1);
    deniedSockets.add(socket.id!);
    authorization.resolve('authorized-token');
    await expect.poll(() => socket.connected).toBe(false);
    expect(pushes.get(socket)).toEqual([]);
  } finally {
    authorization.resolve('authorized-token');
  }
});

/** Holds every following socket validation until the returned function releases it. */
function holdValidations(): () => void {
  const gate = deferred<void>();
  validationGate = gate.promise;
  return () => { validationGate = undefined; gate.resolve(); };
}

it.each(['unsubscribes', 'subscribes again'] as const)('drops a refresh without disconnecting when the client %s during its validation', async (change) => {
  const socket = await client();
  expect(await subscribe(socket)).toMatchObject({ ok: true });
  const release = holdValidations();
  try {
    const before = validations;
    socket.emit(ClientEvents.WORKSPACE_GIT_REFRESH, { workspaceId: 'ws' });
    await expect.poll(() => validations).toBe(before + 1);
    let again: Promise<WorkspaceGitSubscribeAck> | undefined;
    if (change === 'unsubscribes') {
      socket.emit(ClientEvents.WORKSPACE_GIT_UNSUBSCRIBE, { workspaceId: 'ws' });
      await expect.poll(() => unsubscribed.has(socket.id!)).toBe(true);
    } else {
      again = subscribe(socket);
      // The new subscribe replaces the intent before its own validation starts.
      await expect.poll(() => validations).toBe(before + 2);
    }
    release();
    if (again) expect(await again).toMatchObject({ ok: true });
    await pause(80);
    expect(socket.connected).toBe(true);
    expect(invalidateState).not.toHaveBeenCalled();

    // The socket and its (renewed) subscription keep working; the dropped refresh used no budget.
    if (change === 'unsubscribes') expect(await subscribe(socket)).toMatchObject({ ok: true });
    socket.emit(ClientEvents.WORKSPACE_GIT_REFRESH, { workspaceId: 'ws' });
    await expect.poll(() => invalidateState.mock.calls).toEqual([[worktreePath, 'refresh']]);
  } finally {
    release();
  }
});

it('still disconnects a refresh whose socket authorization is no longer valid', async () => {
  const socket = await client();
  await subscribe(socket);
  deniedSockets.add(socket.id!);
  socket.emit(ClientEvents.WORKSPACE_GIT_REFRESH, { workspaceId: 'ws' });
  await expect.poll(() => socket.connected).toBe(false);
  expect(invalidateState).not.toHaveBeenCalled();
});

function metadataChanged() {
  bus.emit('workspace:git_changed', { workspaceId: 'ws', taskId: 'task', projectId: 'project', workingDir: worktreePath, reason: 'base-branch' });
}

function endedEvents(socket: ClientSocket) {
  const events: WorkspaceGitSubscriptionEndedPayload[] = [];
  socket.on(ServerEvents.WORKSPACE_GIT_SUBSCRIPTION_ENDED, (payload) => events.push(payload));
  return events;
}

it('retries a failed workspace lookup and publishes the new comparison', async () => {
  const socket = await client();
  await subscribe(socket);
  const ended = endedEvents(socket);
  loadWorkspace.mockRejectedValueOnce(new Error('temporarily busy')).mockResolvedValue({ ...input, baseBranch: 'next' });
  latest = { ...state('initial', 2), baseBranch: 'next' };
  metadataChanged();
  await expect.poll(() => pushes.get(socket)).toMatchObject([{ state: { baseBranch: 'next' } }]);
  expect(loadWorkspace).toHaveBeenCalledTimes(3);
  expect(ended).toEqual([]);
});

it('retries one directory per placement even when two aliases share it', async () => {
  const socket = await client();
  await subscribe(socket, 'main-a');
  await subscribe(socket, 'main-b');
  const ended = endedEvents(socket);
  latest = state('replacement');
  registerState.mockRejectedValueOnce(Object.assign(new Error('service unavailable'), { code: 'WORKSPACE_GIT_UNAVAILABLE' }));
  placementChanged();
  await expect.poll(() => pushes.get(socket)).toMatchObject([
    { workspaceId: 'main-a', epoch: 'replacement' }, { workspaceId: 'main-b', epoch: 'replacement' },
  ]);
  expect(registerState).toHaveBeenCalledTimes(3);
  expect(ended).toEqual([]);
});

it.each(['metadata', 'placement'] as const)('ends every acknowledged subscription once after the last %s retry', async (failure) => {
  const first = await client();
  const second = await client();
  await subscribe(first);
  await subscribe(second);
  const ended = [endedEvents(first), endedEvents(second)];
  const failing = failure === 'metadata' ? loadWorkspace : registerState;
  const before = failing.mock.calls.length;
  failing.mockRejectedValue(new Error('temporary error'));
  if (failure === 'metadata') metadataChanged();
  else placementChanged();
  await expect.poll(() => ended.map(events => events.length)).toEqual([1, 1]);
  expect(failing.mock.calls.length - before).toBe(3);
  expect(ended[0]).toEqual([{ workspaceId: 'ws', code: 'WORKSPACE_GIT_UNAVAILABLE', message: expect.any(String) }]);
  expect(ended[1]).toEqual(ended[0]);
  expect(registry.hasSubscribers()).toBe(false);
  expect(server.of('/events').adapter.rooms.has('workspace-git:ws')).toBe(false);
  first.emit(ClientEvents.WORKSPACE_GIT_REFRESH, { workspaceId: 'ws' });
  await pause(60);
  expect(invalidateState).not.toHaveBeenCalled();
  expect(first.connected).toBe(true);
  expect(unregisterState).toHaveBeenCalledTimes(1);
  loadWorkspace.mockResolvedValue({ ...input });
  registerState.mockResolvedValue(state('recovered'));
  expect(await subscribe(first)).toMatchObject({ ok: true, epoch: 'recovered' });
});

it.each(['NOT_FOUND', 'WORKSPACE_GIT_UNAVAILABLE'] as const)('ends a permanent workspace lookup failure immediately with %s', async (code) => {
  const socket = await client();
  await subscribe(socket);
  const ended = endedEvents(socket);
  loadWorkspace.mockRejectedValue(Object.assign(new Error('workspace removed'), { code }));
  metadataChanged();
  await expect.poll(() => ended).toMatchObject([{ workspaceId: 'ws', code }]);
  expect(loadWorkspace).toHaveBeenCalledTimes(2);
});

it('ends an unavailable state and fails a pending subscriber through its acknowledgement', async () => {
  const first = await client();
  await subscribe(first);
  const second = await client();
  const ended = endedEvents(first);
  const pendingEnded = endedEvents(second);
  const result = deferred<GitStateSnapshot>();
  registerState.mockImplementationOnce(() => result.promise);
  placementChanged();
  const ack = subscribe(second);
  await expect.poll(() => loadWorkspace.mock.calls.length).toBe(2);
  result.resolve({ ...state('replacement'), available: false });
  expect(await ack).toMatchObject({ ok: false, code: 'WORKSPACE_GIT_UNAVAILABLE' });
  await expect.poll(() => ended).toMatchObject([{ workspaceId: 'ws', code: 'WORKSPACE_GIT_UNAVAILABLE' }]);
  expect(pendingEnded).toEqual([]);
  expect(registerState).toHaveBeenCalledTimes(2);
});

it('accepts a recovering service notification and cancels the directory retry', async () => {
  const socket = await client();
  await subscribe(socket);
  registerState.mockRejectedValueOnce(new Error('reply lost'));
  placementChanged();
  await pause(0);
  changed(state('replacement'));
  await expect.poll(() => pushes.get(socket)).toMatchObject([{ epoch: 'replacement' }]);
  await pause(100);
  expect(registerState).toHaveBeenCalledTimes(2);
});

it.each(['metadata', 'placement'] as const)('cancels %s retry timers on supersession, release and destruction', async (failure) => {
  const socket = await client();
  const failing = failure === 'metadata' ? loadWorkspace : registerState;
  const trigger = failure === 'metadata' ? metadataChanged : placementChanged;
  for (const reason of ['superseded', 'released', 'destroyed']) {
    await subscribe(socket);
    const before = failing.mock.calls.length;
    failing.mockRejectedValueOnce(new Error('temporary'));
    trigger();
    await pause(0);
    if (reason === 'superseded') trigger();
    if (reason === 'released') socket.emit(ClientEvents.WORKSPACE_GIT_UNSUBSCRIBE, { workspaceId: 'ws' });
    if (reason === 'destroyed') registry.destroy();
    await pause(120);
    expect(failing.mock.calls.length - before).toBe(reason === 'superseded' ? 2 : 1);
  }
});

it('ignores a terminal state from the old directory during a workspace move', async () => {
  const socket = await client();
  await subscribe(socket);
  const ended = endedEvents(socket);
  const lookup = deferred<WorkspaceGitSubscriptionInput>();
  loadWorkspace.mockImplementationOnce(() => lookup.promise);
  metadataChanged();
  changed({ ...state('initial', 2), available: false });
  const moved = { ...input, worktreePath: worktreePath + '-moved' };
  latest = { ...state('moved'), worktreePath: moved.worktreePath };
  lookup.resolve(moved);
  await expect.poll(() => pushes.get(socket)).toMatchObject([{ epoch: 'moved' }]);
  expect(ended).toEqual([]);
});
