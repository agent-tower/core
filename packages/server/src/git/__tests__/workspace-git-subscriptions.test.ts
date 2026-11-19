/** Real git repositories + a real Socket.IO transport, in both service placements. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { recycleFixture, reportRssCommand } from '../../runtime/command-helper/__tests__/recycle-fixture.js';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { Server } from 'socket.io';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientEvents, ServerEvents, type WorkspaceGitSubscribeAck, type WorkspaceGitStatePayload } from '@agent-tower/shared/socket';
import { EventBus } from '../../core/event-bus.js';
import type { AuthenticatedSocket } from '../../socket/middleware/index.js';
import { readRuntimeCounters } from '../../runtime/runtime-metrics.js';
import { getRunningCommandHelper, startCommandHelper, stopCommandHelper } from '../../runtime/command-helper/client.js';
import { runOwnedCommand } from '../../utils/owned-child-process.js';
import { WorkspaceGitStateService } from '../state/git-state-service.js';
import { getWorkspaceGitState, resetLocalGitStateService, type WorkspaceGitStateInput } from '../state/git-state-facade.js';
import * as stateFacade from '../state/git-state-facade.js';
import { mainDirectoryGitStatus } from '../state/git-state-views.js';
import { WorkspaceGitSubscriptions } from '../workspace-git-subscriptions.js';
import { WorkspaceGitSignals } from '../workspace-git-signals.js';
import { notifyWorkspaceGitOperation } from '../git-operation-events.js';
import { commitAll, git, gitMayFail, initRepo, isolateGitConfiguration, settle, write } from '../state/__tests__/git-fixtures.js';

// Resolve the existing monorepo client through its package boundary. Importing
// its declaration by a symlink-relative path loses its transitive types in pnpm.
interface ClientSocket {
  connected: boolean;
  on(event: string, listener: (payload: WorkspaceGitStatePayload) => void): void;
  once(event: string, listener: (error?: Error) => void): void;
  emit(event: string, payload: { workspaceId: string }): void;
  timeout(ms: number): { emitWithAck(event: string, payload: { workspaceId: string }): Promise<WorkspaceGitSubscribeAck> };
  disconnect(): void;
}
const { io: connect } = createRequire(path.resolve('packages/web/package.json'))('socket.io-client') as {
  io(url: string, options: { transports: string[]; reconnection: boolean }): ClientSocket;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-git-socket-'));
isolateGitConfiguration(root);
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let counter = 0;
let repo: string, worktree: string, input: WorkspaceGitStateInput;
let server: Server, registry: WorkspaceGitSubscriptions, signals: WorkspaceGitSignals, bus: EventBus;
let port: number;
let authorized = true;
let baseBranch = 'main';
let conflictFailures = 0;
let observeConflict: ReturnType<typeof vi.fn<() => Promise<string>>>;
let registerState: ReturnType<typeof vi.fn<typeof stateFacade.registerWorkspaceGitState>>;
let unregisterState: ReturnType<typeof vi.fn<typeof stateFacade.unregisterWorkspaceGitState>>;
let resolveSession: ReturnType<typeof vi.fn<(sessionId: string) => Promise<string | null>>>;
const clients: ClientSocket[] = [];
const pushes = new Map<ClientSocket, WorkspaceGitStatePayload[]>();

beforeAll(() => { fs.mkdirSync(root, { recursive: true }); });
beforeEach(async () => {
  const testRoot = path.join(root, String(++counter));
  repo = path.join(testRoot, 'repo'); worktree = path.join(testRoot, 'worktree');
  initRepo(repo); write(path.join(repo, 'a.txt'), 'base\n'); commitAll(repo, 'base');
  git(repo, 'worktree', 'add', '-q', '-b', 'topic', worktree, 'main');
  input = { worktreePath: worktree, repositoryPath: repo, baseBranch: 'main' };
  baseBranch = 'main'; authorized = true; bus = new EventBus();
  conflictFailures = 0;
  observeConflict = vi.fn(async () => {
    if (conflictFailures-- > 0) throw new Error('temporary conflict observation failure');
    return 'server-issued-conflict-token';
  });
  registerState = vi.fn(stateFacade.registerWorkspaceGitState);
  unregisterState = vi.fn(stateFacade.unregisterWorkspaceGitState);
  const http = createServer(); server = new Server(http); const nsp = server.of('/events');
  registry = new WorkspaceGitSubscriptions(nsp, bus, async () => () => authorized, {
    graceMs: 100,
    observeConflict, authorizeConflict: async (token) => token, deliveryRetryMinMs: 40, deliveryRetryMaxMs: 80,
    state: {
      register: registerState, unregister: unregisterState,
      invalidate: stateFacade.invalidateWorkspaceGitState,
      onChange: stateFacade.onWorkspaceGitStateChange,
      onPlacementChange: stateFacade.onGitStatePlacementChange,
    },
    loadWorkspace: async (id) => {
      if (id === 'missing') throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' });
      if (id === 'main-no-git') throw Object.assign(new Error('not git'), { code: 'WORKSPACE_GIT_UNAVAILABLE' });
      if (id === 'main-directory' || id === 'main-alias') return { ...input, worktreePath: repo, baseBranch, mainDirectory: true };
      if (id === 'not-git') return { ...input, worktreePath: path.join(root, 'not-git') };
      if (id === 'ws2') return { ...input, worktreePath: `${worktree}-second` };
      return { ...input, baseBranch };
    },
  });
  resolveSession = vi.fn(async () => 'ws');
  signals = new WorkspaceGitSignals(bus, registry, { resolveSessionWorkspace: resolveSession });
  nsp.on('connection', (socket) => registry.register(socket as AuthenticatedSocket));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  port = (http.address() as { port: number }).port;
});
afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  signals.destroy(); registry.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  resetLocalGitStateService(); pushes.clear();
});
afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

async function client(): Promise<ClientSocket> {
  const socket = connect(`http://127.0.0.1:${port}/events`, { transports: ['websocket'], reconnection: false });
  clients.push(socket); pushes.set(socket, []);
  socket.on(ServerEvents.WORKSPACE_GIT_STATE, (payload) => pushes.get(socket)!.push(payload));
  await new Promise<void>((resolve, reject) => { socket.once('connect', () => resolve()); socket.once('connect_error', reject); });
  return socket;
}
function subscribe(socket: ClientSocket, workspaceId = 'ws'): Promise<WorkspaceGitSubscribeAck> {
  return socket.timeout(8_000).emitWithAck(ClientEvents.WORKSPACE_GIT_SUBSCRIBE, { workspaceId });
}
async function expectPush(socket: ClientSocket, count = 1, timeout = 3_000): Promise<WorkspaceGitStatePayload> {
  await vi.waitFor(() => expect(pushes.get(socket)).toHaveLength(count), { timeout, interval: 20 });
  return pushes.get(socket)![count - 1]!;
}
function agentTool(status = 'success', index = 0): void {
  bus.emit('session:patch', { sessionId: 'session', seq: index + 1, patch: [
    { op: 'add', path: `/entries/${index}`, value: { id: `tool-${index}`, entryType: 'tool_use', metadata: { status } } },
  ] });
}

it('acknowledges current REST-shaped state and clean registered reads never run git, even beyond 1 s', async () => {
  const socket = await client(); const ack = await subscribe(socket);
  expect(ack).toMatchObject({ ok: true, workspaceId: 'ws', version: 1, state: {
    changes: { uncommitted: [], committed: [] }, headOid: git(worktree, 'rev-parse', 'HEAD'), baseBranch: 'main',
    status: { operation: 'idle', conflictedFiles: [], conflictOp: null, ahead: 0, behind: 0, hasUncommittedChanges: false, uncommittedCount: 0, untrackedCount: 0 },
  } });
  await pause(1_100);
  const before = readRuntimeCounters(); await getWorkspaceGitState(input);
  expect(readRuntimeCounters().gitStateGitProcesses).toBe(before.gitStateGitProcesses);
  expect(pushes.get(socket)).toEqual([]);
});

describe('Tower signals push only changed state', () => {
  const triggers = [
    ['finished tool', () => agentTool()],
    ['turn completed', () => bus.emit('session:turn-completed', { sessionId: 'session' })],
    ['session completed', () => bus.emit('session:completed', { sessionId: 'session', status: 'COMPLETED' })],
    ['session exit', () => bus.emit('session:exit', { sessionId: 'session', exitCode: 0 })],
    ['terminal output after input', () => { bus.emit('terminal:input', { terminalId: 't', cwd: worktree }); bus.emit('terminal:stdout', { terminalId: 't', data: 'done' }); }],
    ['background service output', () => bus.emit('workspace-service:output', { serviceId: 'svc', workspaceId: 'ws', runtimeInstanceId: 'run' })],
    ['background service exit', () => bus.emit('workspace-service:exit', { serviceId: 'svc', workspaceId: 'ws', runtimeInstanceId: 'run' })],
    ['git operation', () => notifyWorkspaceGitOperation([worktree])],
  ] as const;
  it.each(triggers)('%s', async (_name, trigger) => {
    const socket = await client(); await subscribe(socket);
    const bystander = await client();
    // Settled at once: a file still inside the racy window would change its token (racy -> settled)
    // in a later computation, which is a real state change and pushes.
    write(path.join(worktree, 'new.txt'), 'new\n'); settle(path.join(worktree, 'new.txt'));
    const started = Date.now(); trigger();
    const state = await expectPush(socket);
    expect(Date.now() - started).toBeLessThan(2_200); // Terminal/service first require 1 s quiet, then 300 ms debounce.
    expect(state.state.changes.uncommitted).toContainEqual({ status: 'A', path: 'new.txt', token: expect.any(String) });
    await pause(1_050);
    if (_name === 'finished tool') agentTool('success', 1); else trigger();
    await pause(1_450);
    expect(pushes.get(socket)).toHaveLength(1); expect(pushes.get(bystander)).toHaveLength(0);
  }, 12_000);
});

it('ignores streamed text and unsolicited terminal output, caches session lookup, and ignores non-worktree terminal paths', async () => {
  const socket = await client(); await subscribe(socket);
  write(path.join(worktree, 'new.txt'), 'new\n'); settle(path.join(worktree, 'new.txt'));
  bus.emit('session:patch', { sessionId: 'session', seq: 1, patch: [{ op: 'replace', path: '/entries/0/content', value: 'streaming' }] });
  bus.emit('terminal:stdout', { terminalId: 't', data: 'prompt' });
  bus.emit('terminal:input', { terminalId: 'outside', cwd: `${worktree}-other` });
  bus.emit('terminal:stdout', { terminalId: 'outside', data: 'done' });
  await pause(1_500); expect(pushes.get(socket)).toEqual([]); expect(resolveSession).not.toHaveBeenCalled();
  agentTool(); await expectPush(socket);
  for (let index = 1; index <= 20; index++) agentTool('success', index);
  await pause(1_200); expect(resolveSession).toHaveBeenCalledTimes(1); expect(pushes.get(socket)).toHaveLength(1);
});

it('observes a plain git commit through watches and sends only one push', async () => {
  const socket = await client(); await subscribe(socket);
  write(path.join(worktree, 'committed.txt'), 'committed\n'); commitAll(worktree, 'outside Tower');
  const state = await expectPush(socket);
  expect(state.state.headOid).toBe(git(worktree, 'rev-parse', 'HEAD'));
  expect(state.state.changes.committed).toContainEqual({ status: 'A', path: 'committed.txt', additions: 1, deletions: 0, token: expect.any(String) });
  await pause(1_300); expect(pushes.get(socket)).toHaveLength(1);
});

it('refresh is limited to once per socket and workspace per second', async () => {
  const socket = await client(); await subscribe(socket);
  const before = readRuntimeCounters().gitStateComputationsRefresh;
  write(path.join(worktree, 'a.txt'), 'edited\n');
  for (let index = 0; index < 20; index++) socket.emit(ClientEvents.WORKSPACE_GIT_REFRESH, { workspaceId: 'ws' });
  await expectPush(socket); await pause(500);
  expect(readRuntimeCounters().gitStateComputationsRefresh - before).toBe(1);
  socket.emit(ClientEvents.WORKSPACE_GIT_REFRESH, { workspaceId: 'ws' }); await pause(1_200);
  expect(readRuntimeCounters().gitStateComputationsRefresh - before).toBe(2);
  expect(pushes.get(socket)).toHaveLength(1);
});

it('rejects malformed, missing, non-Git and unauthorized subscriptions', async () => {
  const socket = await client();
  expect(await subscribe(socket, '')).toMatchObject({ ok: false, code: 'INVALID_PAYLOAD' });
  expect(await subscribe(socket, 'missing')).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  expect(await subscribe(socket, 'main-no-git')).toMatchObject({ ok: false, code: 'WORKSPACE_GIT_UNAVAILABLE' });
  fs.mkdirSync(path.join(root, 'not-git'), { recursive: true });
  expect(await subscribe(socket, 'not-git')).toMatchObject({ ok: false, code: 'WORKSPACE_GIT_UNAVAILABLE' });
  authorized = false;
  expect(await subscribe(socket)).toMatchObject({ ok: false, code: 'WORKSPACE_GIT_SUBSCRIPTION_DENIED' });
});

it('unsubscribe and disconnect unregister after grace; no subscriber means no signal work', async () => {
  const first = await client(); const second = await client(); await subscribe(first); await subscribe(second);
  first.emit(ClientEvents.WORKSPACE_GIT_UNSUBSCRIBE, { workspaceId: 'ws' }); await pause(150);
  expect(registry.hasSubscribers()).toBe(true);
  second.disconnect(); await pause(200);
  expect(registry.hasSubscribers()).toBe(false);
  expect(readRuntimeCounters().gitStateRegisteredWorktrees).toBe(0);
  const before = readRuntimeCounters().gitStateComputations;
  agentTool(); notifyWorkspaceGitOperation([worktree]);
  await pause(1_100);
  expect(resolveSession).not.toHaveBeenCalled(); expect(readRuntimeCounters().gitStateComputations).toBe(before);
});

it('reregisters a changed base branch and pushes its new comparison', async () => {
  git(repo, 'branch', 'alternate');
  const socket = await client(); await subscribe(socket);
  baseBranch = 'alternate';
  bus.emit('workspace:git_changed', { workspaceId: 'ws', taskId: 'task', projectId: 'project', workingDir: worktree, reason: 'base-branch' });
  expect((await expectPush(socket)).state.baseBranch).toBe('alternate');
  await pause(1_200); expect(pushes.get(socket)).toHaveLength(1);
});

it('revokes authorization before a changed state is emitted', async () => {
  const socket = await client(); await subscribe(socket);
  authorized = false;
  write(path.join(worktree, 'new.txt'), 'new\n'); notifyWorkspaceGitOperation([worktree]);
  await vi.waitFor(() => expect(socket.connected).toBe(false), { timeout: 3_000 });
  expect(pushes.get(socket)).toEqual([]);
});

it('a moved base ref refreshes two separately subscribed worktrees', async () => {
  git(repo, 'worktree', 'add', '-q', '-b', 'second', `${worktree}-second`, 'main');
  const first = await client(); const second = await client();
  await subscribe(first); await subscribe(second, 'ws2');
  write(path.join(repo, 'base-change.txt'), 'base moved\n'); commitAll(repo, 'base change');
  expect((await expectPush(first)).state.status.behind).toBe(1);
  expect((await expectPush(second)).state.status.behind).toBe(1);
  await pause(1_100);
  expect(pushes.get(first)).toHaveLength(1); expect(pushes.get(second)).toHaveLength(1);
});

it('safety catches a ref-only change with a shortened interval when watches fail, and shutdown closes every watch', async () => {
  signals.destroy(); registry.destroy();
  const listeners = new Set<(snapshot: import('../state/git-state-types.js').GitStateSnapshot) => void>();
  const service = new WorkspaceGitStateService({ run: runOwnedCommand, safetyIntervalMs: 250, minComputationIntervalMs: 80,
    watch: () => { throw new Error('unavailable'); }, log: () => undefined,
    onChange: (snapshot) => { for (const listener of listeners) listener(snapshot); },
  });
  registry = new WorkspaceGitSubscriptions(server.of('/events'), bus, async () => () => authorized, {
    loadWorkspace: async () => input,
    state: {
      register: async (request, options) => (await service.register(request, options)).snapshot,
      unregister: (dir) => service.unregister(dir), invalidate: (dir, trigger) => service.invalidate(dir, trigger),
      onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      onPlacementChange: () => () => undefined,
    },
  });
  try {
    git(worktree, 'commit', '-q', '--allow-empty', '-m', 'empty');
    const socket = await client(); await subscribe(socket);
    git(worktree, 'update-ref', 'refs/heads/topic', 'HEAD~1');
    expect((await expectPush(socket)).state.headOid).toBe(git(worktree, 'rev-parse', 'HEAD'));
    const before = service.readCounters();
    // A safety check counts when it starts, its git process when that process starts: wait for
    // both, then check one process per idle check (another check may start every 250 ms).
    await vi.waitFor(() => {
      const now = service.readCounters();
      expect(now.computationsSafety).toBeGreaterThan(before.computationsSafety);
      expect(now.gitProcesses).toBeGreaterThan(before.gitProcesses);
    }, { timeout: 10_000 });
    const after = service.readCounters();
    expect(after.gitProcesses - before.gitProcesses).toBeLessThanOrEqual(after.computationsSafety - before.computationsSafety);
    expect(pushes.get(socket)).toHaveLength(1);
  } finally { registry.destroy(); service.dispose(); }
  expect(service.registeredCount).toBe(0); expect(service.watchCount).toBe(0);
}, 15_000);

it('reregisters subscribed worktrees and pushes a new epoch on each placement switch', async (context) => {
  // The helper-config suite already owns its helper; this test owns a full start/stop cycle.
  if (getRunningCommandHelper()) { context.skip(); return; }
  const socket = await client(); const ack = await subscribe(socket);
  expect(ack.ok).toBe(true); if (!ack.ok) return;
  try {
    expect(await startCommandHelper({ mode: 'on' })).toBe(true);
    const inHelper = await expectPush(socket, 1, 8_000);
    expect(inHelper.epoch).not.toBe(ack.epoch);
    expect(inHelper.state).toEqual(ack.state);
    await stopCommandHelper();
    const inServer = await expectPush(socket, 2, 8_000);
    expect(inServer.epoch).not.toBe(inHelper.epoch);
    expect(inServer.epoch).not.toBe(ack.epoch);
    expect(inServer.state).toEqual(ack.state);
  } finally { await stopCommandHelper(); }
}, 25_000);

it('delivers one new epoch on recycle while reads and a diff finish in the draining helper', async (context) => {
  if (getRunningCommandHelper() || process.platform === 'win32') { context.skip(); return; }
  const fixture = recycleFixture(path.dirname(repo));
  const gitGate = path.join(path.dirname(repo), 'release-git');
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const gitBin = path.join(path.dirname(repo), 'bin');
  fs.mkdirSync(gitBin);
  // Only the two requests with this PATH wait. The replacement can register immediately.
  fs.writeFileSync(path.join(gitBin, 'git'), '#!/bin/sh\nwhile test ! -f "$GIT_TEST_GATE"; do sleep 0.05; done\nexec "$GIT_TEST_REAL" "$@"\n', { mode: 0o755 });
  const env = { ...process.env, PATH: gitBin + path.delimiter + process.env.PATH, GIT_TEST_GATE: gitGate, GIT_TEST_REAL: realGit };
  try {
    expect(await startCommandHelper({ mode: 'on', entry: fixture.entry, recycleRssMb: 4000, recycleReports: 1 })).toBe(true);
    write(path.join(worktree, 'a.txt'), 'old working edit\n');
    settle(path.join(worktree, 'a.txt'));
    const socket = await client();
    const ack = await subscribe(socket);
    expect(ack.ok).toBe(true); if (!ack.ok) return;
    const old = getRunningCommandHelper()!;
    fs.writeFileSync(fixture.gate, '');
    await runOwnedCommand(...reportRssCommand(5000));
    await vi.waitFor(() => expect(fs.existsSync(fixture.candidate)).toBe(true), { timeout: 10_000 });
    const reads = Promise.all([
      old.requestGitState({ ...input, worktreePath: repo, env }),
      old.requestGitDiff({ ...input, env, kind: 'uncommitted', path: 'a.txt' }),
    ]);
    void reads.catch(() => undefined);
    expect(old.status().pendingCommands).toBe(2);
    fs.unlinkSync(fixture.gate);
    const fresh = await expectPush(socket, 1, 8_000);
    expect(fresh.epoch).not.toBe(ack.epoch);
    expect(fresh.state).toEqual(ack.state);
    fs.writeFileSync(gitGate, '');
    const [state, diff] = await reads;
    expect(state.snapshot).toMatchObject({ epoch: ack.epoch, available: true });
    expect(diff).toMatchObject({ epoch: ack.epoch, diff: { kind: 'text', diff: expect.stringContaining('+old working edit') } });
    write(path.join(worktree, 'a.txt'), 'subsequent edit\nsecond line\n');
    settle(path.join(worktree, 'a.txt'));
    socket.emit(ClientEvents.WORKSPACE_GIT_REFRESH, { workspaceId: 'ws' });
    const later = await expectPush(socket, 2, 8_000);
    expect(later.epoch).toBe(fresh.epoch);
    expect(later.version).toBeGreaterThan(fresh.version);
    expect(later.state.changes.uncommitted[0]?.additions).toBe(2);
    expect(registerState).toHaveBeenCalledTimes(2);
  } finally {
    fs.writeFileSync(gitGate, '');
    await stopCommandHelper();
  }
}, 30_000);

it('shares one main-directory registration across workspace IDs and preserves its REST status', async () => {
  write(path.join(repo, 'a.txt'), 'tracked edit\n');
  const first = await client(); const second = await client();
  const one = await subscribe(first, 'main-directory');
  const two = await subscribe(second, 'main-alias');
  expect(one.ok).toBe(true); expect(two.ok).toBe(true);
  if (!one.ok || !two.ok) return;
  expect(one.state.status).toEqual(mainDirectoryGitStatus());
  expect(one.state.changes.uncommitted).toContainEqual({ status: 'M', path: 'a.txt', additions: 1, deletions: 1, token: expect.any(String) });
  expect(two.state).toEqual(one.state);
  expect(registerState).toHaveBeenCalledTimes(1);
  expect(readRuntimeCounters().gitStateRegisteredWorktrees).toBe(1);
  first.emit(ClientEvents.WORKSPACE_GIT_UNSUBSCRIBE, { workspaceId: 'main-directory' });
  await pause(200);
  expect(unregisterState).not.toHaveBeenCalled();
  write(path.join(repo, 'new.txt'), 'new\n'); registry.invalidatePath(repo, 'operation');
  const pushed = await expectPush(second);
  expect(pushed.state.status).toEqual(mainDirectoryGitStatus());
  expect(pushed.state.changes.uncommitted).toContainEqual({ status: 'A', path: 'new.txt', token: expect.any(String) });
  expect(pushes.get(first)).toEqual([]);
  second.disconnect(); await pause(200);
  expect(unregisterState).toHaveBeenCalledExactlyOnceWith(repo);
  expect(readRuntimeCounters().gitStateRegisteredWorktrees).toBe(0);
});

function makeConflict(): void {
  write(path.join(repo, 'a.txt'), 'main change\n'); commitAll(repo, 'main change');
  write(path.join(worktree, 'a.txt'), 'topic change\n'); commitAll(worktree, 'topic change');
  gitMayFail(worktree, 'merge', 'main');
}

it('retries a changed conflict state with bounded backoff until its token can be read', async () => {
  const socket = await client(); await subscribe(socket);
  conflictFailures = 4;
  makeConflict();
  await vi.waitFor(() => expect(observeConflict).toHaveBeenCalled(), { timeout: 3_000 });
  const computations = readRuntimeCounters().gitStateComputations;
  const pushed = await expectPush(socket);
  expect(observeConflict).toHaveBeenCalledTimes(5);
  expect(pushed.state.status).toMatchObject({ operation: 'merge', conflictedFiles: ['a.txt'], resolutionContextToken: 'server-issued-conflict-token' });
  expect(readRuntimeCounters().gitStateComputations).toBe(computations);
  await pause(400); expect(pushes.get(socket)).toHaveLength(1); expect(observeConflict).toHaveBeenCalledTimes(5);
});

it('supersedes an undelivered version and cancels its retries when subscribers leave', async () => {
  const socket = await client(); await subscribe(socket);
  conflictFailures = Infinity; makeConflict();
  await vi.waitFor(() => expect(observeConflict.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 3_000 });
  expect(pushes.get(socket)).toEqual([]);
  git(worktree, 'merge', '--abort');
  const pushed = await expectPush(socket);
  expect(pushed.state.status.operation).toBe('idle');
  expect(pushed.state.status.resolutionContextToken).toBeUndefined();
  const attempts = observeConflict.mock.calls.length;
  await pause(250); expect(observeConflict).toHaveBeenCalledTimes(attempts);
  gitMayFail(worktree, 'merge', 'main');
  await vi.waitFor(() => expect(observeConflict.mock.calls.length).toBeGreaterThan(attempts), { timeout: 3_000 });
  socket.emit(ClientEvents.WORKSPACE_GIT_UNSUBSCRIBE, { workspaceId: 'ws' });
  await pause(50); const afterLeave = observeConflict.mock.calls.length;
  await pause(250); expect(observeConflict).toHaveBeenCalledTimes(afterLeave);
  expect(pushes.get(socket)).toHaveLength(1);
});

it('reloads a shared main-directory target when a newly created alias changes its metadata', async () => {
  git(repo, 'branch', 'alternate');
  const socket = await client(); await subscribe(socket, 'main-directory');
  baseBranch = 'alternate';
  bus.emit('workspace:git_changed', { workspaceId: 'new-alias', taskId: 'new-task', projectId: 'project', workingDir: repo, reason: 'base-branch' });
  expect((await expectPush(socket)).state.baseBranch).toBe('alternate');
  expect(readRuntimeCounters().gitStateRegisteredWorktrees).toBe(1);
  expect(unregisterState).not.toHaveBeenCalled();
});
