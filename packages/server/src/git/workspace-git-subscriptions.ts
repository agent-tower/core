/** Socket ownership stays in the server; the active state service owns watches and computation. */
import path from 'node:path';
import type { Namespace } from 'socket.io';
import {
  ClientEvents, ServerEvents,
  type WorkspaceGitSubscribeAck, type WorkspaceGitSubscriptionEndedPayload, type WorkspaceGitStatePayload, type WorkspaceGitSubscriptionPayload,
} from '@agent-tower/shared/socket';
import type { EventBus } from '../core/event-bus.js';
import type { AuthenticatedSocket } from '../socket/middleware/index.js';
import { countGitStatePushes } from '../runtime/runtime-metrics.js';
import {
  registerWorkspaceGitState, unregisterWorkspaceGitState, invalidateWorkspaceGitState,
  onWorkspaceGitStateChange, onGitStatePlacementChange,
  type WorkspaceGitStateInput,
} from './state/git-state-facade.js';
import type { GitStateSnapshot, GitStateTrigger } from './state/git-state-types.js';
import { mainDirectoryGitStatus, toGitChangesResponse, toGitOperationStatus } from './state/git-state-views.js';
import { authorizeWorkspaceGitConflictToken } from './workspace-git-conflict-token.js';

const UNSUBSCRIBE_GRACE_MS = 10_000;
const REFRESH_INTERVAL_MS = 1_000;
const REGISTRATION_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const DELIVERY_RETRY_MIN_MS = 250;
const DELIVERY_RETRY_MAX_MS = 5_000;

export interface WorkspaceGitSubscriptionInput extends WorkspaceGitStateInput {
  mainDirectory?: boolean;
}
interface DirectoryRegistration {
  input: WorkspaceGitStateInput;
  owners: Set<Subscription>;
  snapshot?: GitStateSnapshot;
  pending?: Promise<void>;
  controller?: AbortController;
  generation: number;
  registrationRetry?: ReturnType<typeof setTimeout>;
}

type ValidateSocket = (socket: AuthenticatedSocket) => Promise<() => boolean>;
interface Subscriber {
  socket: AuthenticatedSocket;
  intent: symbol;
  acknowledged: boolean;
  ended?: WorkspaceGitSubscriptionEndedPayload;
  delivered?: { epoch: string; version: number };
}
interface Subscription {
  workspaceId: string;
  ended?: boolean;
  input?: WorkspaceGitSubscriptionInput;
  directory?: DirectoryRegistration;
  subscribers: Map<string, Subscriber>;
  snapshot?: GitStateSnapshot;
  registration?: Promise<void>;
  generation: number;
  registrationRetry?: ReturnType<typeof setTimeout>;
  grace?: ReturnType<typeof setTimeout>;
  publishing: Promise<void>;
  retry?: ReturnType<typeof setTimeout>;
  retryAttempts: number;
}

export interface WorkspaceGitSubscriptionsOptions {
  graceMs?: number;
  registrationRetryDelaysMs?: readonly number[];
  loadWorkspace?: (workspaceId: string) => Promise<WorkspaceGitSubscriptionInput>;
  deliveryRetryMinMs?: number;
  deliveryRetryMaxMs?: number;
  observeConflict?: (workspaceId: string) => Promise<string | undefined>;
  authorizeConflict?: (token: string, socket: AuthenticatedSocket) => Promise<string>;
  state?: {
    register: typeof registerWorkspaceGitState;
    unregister: typeof unregisterWorkspaceGitState;
    invalidate: typeof invalidateWorkspaceGitState;
    onChange: typeof onWorkspaceGitStateChange;
    onPlacementChange: typeof onGitStatePlacementChange;
  };
}

function denied(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

async function loadWorkspace(workspaceId: string): Promise<WorkspaceGitSubscriptionInput> {
  const { prisma } = await import('../utils/index.js');
  const { isMainDirectoryWorkspace, getWorkspaceWorkingDir } = await import('../services/workspace-kind.js');
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { worktreePath: true, workingDir: true, workspaceKind: true, baseBranch: true, task: { select: { project: { select: { repoPath: true, mainBranch: true } } } } },
  });
  if (!workspace) throw denied('NOT_FOUND', 'Workspace not found');
  const mainDirectory = isMainDirectoryWorkspace(workspace);
  const workingDir = mainDirectory ? getWorkspaceWorkingDir(workspace) : workspace.worktreePath;
  if (!workingDir) throw denied('WORKSPACE_GIT_UNAVAILABLE', 'Workspace git state is unavailable');
  if (mainDirectory) {
    const { hasGitMetadata } = await import('../services/project-guards.js');
    if (!hasGitMetadata(workspace.task.project.repoPath)) throw denied('WORKSPACE_GIT_UNAVAILABLE', 'Project is not a Git repository');
    const { resolveWorkspaceGitTarget } = await import('./workspace-git-target.js');
    // GET /git/changes selects the most recently updated workspace for a
    // directory. Main-directory aliases must use that same comparison target.
    const target = await resolveWorkspaceGitTarget(workingDir);
    return { worktreePath: path.resolve(workingDir), repositoryPath: target?.repositoryPath ?? workspace.task.project.repoPath, baseBranch: target?.baseBranch ?? 'main', mainDirectory: true };
  }
  return {
    worktreePath: path.resolve(workspace.worktreePath),
    repositoryPath: workspace.task.project.repoPath,
    baseBranch: workspace.baseBranch || workspace.task.project.mainBranch,
  };
}

async function observeConflict(workspaceId: string): Promise<string | undefined> {
  const [{ prisma }, { observeLiveConflict }] = await Promise.all([
    import('../utils/index.js'), import('../services/conflict-resolution-context.js'),
  ]);
  return observeLiveConflict(prisma, workspaceId);
}

export class WorkspaceGitSubscriptions {
  private readonly entries = new Map<string, Subscription>();
  private readonly directories = new Map<string, DirectoryRegistration>();
  private readonly intents = new WeakMap<AuthenticatedSocket, Map<string, symbol>>();
  private readonly refreshes = new WeakMap<AuthenticatedSocket, Map<string, number>>();
  private readonly cleanups: Array<() => void> = [];
  private readonly state: NonNullable<WorkspaceGitSubscriptionsOptions['state']>;
  private destroyed = false;
  private metadataRevision = 0;

  constructor(
    private readonly nsp: Namespace,
    eventBus: EventBus,
    private readonly validate: ValidateSocket,
    private readonly options: WorkspaceGitSubscriptionsOptions = {},
  ) {
    this.state = options.state ?? {
      register: registerWorkspaceGitState, unregister: unregisterWorkspaceGitState,
      invalidate: invalidateWorkspaceGitState, onChange: onWorkspaceGitStateChange,
      onPlacementChange: onGitStatePlacementChange,
    };
    this.cleanups.push(this.state.onChange((snapshot) => {
      const directory = this.directories.get(snapshot.worktreePath);
      if (directory?.input.baseBranch === snapshot.baseBranch) this.acceptSnapshot(directory, snapshot);
    }));
    this.cleanups.push(this.state.onPlacementChange(() => {
      for (const directory of this.directories.values()) this.registerDirectory(directory);
    }));
    const changed = ({ workspaceId, reason, workingDir }: { workspaceId: string; reason: string; workingDir: string }) => {
      if (reason === 'base-branch' || reason === 'worktree') this.metadataRevision += 1;
      const directory = workingDir ? this.directories.get(path.resolve(workingDir)) : undefined;
      const direct = this.entries.get(workspaceId);
      const entry = direct?.subscribers.size ? direct : (directory && [...directory.owners].find((owner) => owner.input?.mainDirectory && owner.subscribers.size));
      if (!entry) return;
      if (reason === 'base-branch' || reason === 'worktree') this.beginRegistration(entry, undefined, reason === 'worktree');
      else this.invalidateWorkspace(entry.workspaceId, 'operation');
    };
    eventBus.on('workspace:git_changed', changed);
    this.cleanups.push(() => eventBus.off('workspace:git_changed', changed));
  }

  register(socket: AuthenticatedSocket): void {
    socket.on(ClientEvents.WORKSPACE_GIT_SUBSCRIBE, (payload: WorkspaceGitSubscriptionPayload, ack?: (value: WorkspaceGitSubscribeAck) => void) => {
      void this.subscribe(socket, payload, typeof ack === 'function' ? ack : undefined);
    });
    socket.on(ClientEvents.WORKSPACE_GIT_UNSUBSCRIBE, (payload: WorkspaceGitSubscriptionPayload) => {
      // Revoking intent is synchronous, so an older asynchronous subscribe cannot join later.
      if (typeof payload?.workspaceId === 'string') this.unsubscribe(socket, payload.workspaceId);
    });
    socket.on(ClientEvents.WORKSPACE_GIT_REFRESH, (payload: WorkspaceGitSubscriptionPayload) => {
      void this.refresh(socket, payload).catch(() => undefined);
    });
    socket.on('disconnect', () => {
      for (const workspaceId of this.intents.get(socket)?.keys() ?? []) this.unsubscribe(socket, workspaceId);
      this.refreshes.delete(socket);
    });
  }

  hasSubscribers(): boolean {
    for (const entry of this.entries.values()) if (entry.subscribers.size > 0) return true;
    return false;
  }

  invalidateWorkspace(workspaceId: string, trigger: GitStateTrigger): void {
    const entry = this.entries.get(workspaceId);
    if (entry?.subscribers.size && entry.input) this.state.invalidate(entry.input.worktreePath, trigger);
  }

  invalidatePath(cwd: string, trigger: GitStateTrigger): void {
    if (!this.hasSubscribers()) return;
    const absolute = path.resolve(cwd);
    for (const directory of this.directories.values()) {
      if (![...directory.owners].some((entry) => entry.subscribers.size)) continue;
      const relative = path.relative(directory.input.worktreePath, absolute);
      if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
        this.state.invalidate(directory.input.worktreePath, trigger);
      }
    }
  }

  refreshPath(worktreePath: string, recreated = true): void {
    this.metadataRevision += 1;
    const directory = this.directories.get(path.resolve(worktreePath));
    const owners = directory ? [...directory.owners].filter((entry) => entry.subscribers.size) : [];
    // Metadata changes can remove the alias that previously selected the base.
    // Reload every live owner; their directory registration still coalesces.
    for (const owner of recreated ? owners.slice(0, 1) : owners) this.beginRegistration(owner, undefined, recreated);
  }

  destroy(): void {
    this.destroyed = true;
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.length = 0;
    for (const entry of this.entries.values()) {
      if (entry.grace) clearTimeout(entry.grace);
      this.clearRetry(entry);
      this.clearRegistrationRetry(entry);
      entry.generation += 1;
    }
    this.entries.clear();
    for (const directory of this.directories.values()) {
      this.clearRegistrationRetry(directory);
      directory.generation += 1;
      directory.controller?.abort();
      this.state.unregister(directory.input.worktreePath);
    }
    this.directories.clear();
  }

  private current(socket: AuthenticatedSocket, workspaceId: string, intent: symbol): boolean {
    return !this.destroyed && !socket.disconnected && this.intents.get(socket)?.get(workspaceId) === intent;
  }

  private async subscribe(socket: AuthenticatedSocket, payload: WorkspaceGitSubscriptionPayload, ack?: (value: WorkspaceGitSubscribeAck) => void): Promise<void> {
    const workspaceId = payload?.workspaceId;
    if (typeof workspaceId !== 'string' || !workspaceId.trim() || workspaceId === 'all') {
      ack?.({ ok: false, code: 'INVALID_PAYLOAD', message: 'A workspaceId is required' }); return;
    }
    let intents = this.intents.get(socket);
    if (!intents) { intents = new Map(); this.intents.set(socket, intents); }
    const intent = Symbol(); intents.set(workspaceId, intent);
    let subscriber: Subscriber | undefined;
    try {
      const valid = await this.validate(socket);
      if (!valid() || !this.current(socket, workspaceId, intent)) throw denied('WORKSPACE_GIT_SUBSCRIPTION_DENIED', 'Socket authorization or subscription is no longer current');
      // Revalidate existence and workspace kind on each subscribe, even when a
      // previous viewer keeps a cached state alive.
      let input: WorkspaceGitSubscriptionInput;
      for (;;) {
        const revision = this.metadataRevision;
        input = await (this.options.loadWorkspace ?? loadWorkspace)(workspaceId);
        if (!valid() || !this.current(socket, workspaceId, intent)) throw denied('WORKSPACE_GIT_SUBSCRIPTION_DENIED', 'Socket authorization or subscription is no longer current');
        // Metadata can change before the first subscriber has a directory
        // registration for its event to find. Re-read that interrupted lookup.
        if (revision === this.metadataRevision) break;
      }
      input.worktreePath = path.resolve(input.worktreePath);
      if (!valid() || !this.current(socket, workspaceId, intent)) throw denied('WORKSPACE_GIT_SUBSCRIPTION_DENIED', 'Socket authorization or subscription is no longer current');
      let entry = this.entries.get(workspaceId);
      if (entry?.ended) {
        this.dropEntry(entry);
        entry = undefined;
      }
      if (!entry) {
        entry = { workspaceId, subscribers: new Map(), generation: 0, publishing: Promise.resolve(), retryAttempts: 0 };
        this.entries.set(workspaceId, entry);
      }
      if (entry.grace) { clearTimeout(entry.grace); entry.grace = undefined; }
      subscriber = { socket, intent, acknowledged: false };
      entry.subscribers.set(socket.id, subscriber);
      if ((!entry.registration && !entry.snapshot) || (entry.input && (
        entry.input.worktreePath !== input.worktreePath || entry.input.repositoryPath !== input.repositoryPath || entry.input.baseBranch !== input.baseBranch
      ))) this.beginRegistration(entry, input);
      await this.awaitRegistration(entry);
      if (!valid() || !this.current(socket, workspaceId, intent)) throw denied('WORKSPACE_GIT_SUBSCRIPTION_DENIED', 'Socket authorization or subscription is no longer current');
      await socket.join(`workspace-git:${workspaceId}`);
      // Snapshot formatting can observe a live conflict; recheck both identity and content afterwards.
      for (;;) {
        await this.awaitRegistration(entry);
        if (entry.directory) await this.awaitDirectory(entry.directory);
        const snapshot = entry.snapshot;
        if (!snapshot?.available) throw denied('WORKSPACE_GIT_UNAVAILABLE', 'Workspace git state is unavailable');
        const response = await this.authorizePayload(await this.payload(entry, snapshot), socket);
        if (!valid() || !this.current(socket, workspaceId, intent)) throw denied('WORKSPACE_GIT_SUBSCRIPTION_DENIED', 'Socket authorization or subscription is no longer current');
        if (entry.snapshot !== snapshot || entry.registration || entry.directory?.pending) continue;
        subscriber.acknowledged = !!ack;
        subscriber.delivered = { epoch: response.epoch, version: response.version };
        ack?.({ ok: true, ...response });
        return;
      }
    } catch (error) {
      if (intents.get(workspaceId) === intent) this.unsubscribe(socket, workspaceId);
      else if (!intents.has(workspaceId)) void Promise.resolve(socket.leave(`workspace-git:${workspaceId}`)).catch(() => undefined);
      const code = subscriber?.ended?.code ?? (error as { code?: string })?.code;
      ack?.({ ok: false, code: code === 'NOT_FOUND' || code === 'WORKSPACE_GIT_UNAVAILABLE' || code === 'WORKSPACE_GIT_SUBSCRIPTION_DENIED' ? code : 'WORKSPACE_GIT_UNAVAILABLE', message: code === 'NOT_FOUND' ? 'Workspace not found' : 'Workspace git subscription is unavailable' });
    }
  }

  private unsubscribe(socket: AuthenticatedSocket, workspaceId: string): void {
    this.intents.get(socket)?.delete(workspaceId);
    void Promise.resolve(socket.leave(`workspace-git:${workspaceId}`)).catch(() => undefined);
    const entry = this.entries.get(workspaceId);
    if (!entry) return;
    entry.subscribers.delete(socket.id);
    this.scheduleRelease(entry);
  }

  private scheduleRelease(entry: Subscription): void {
    if (entry.subscribers.size || entry.grace) return;
    this.clearRetry(entry);
    this.clearRegistrationRetry(entry);
    if (entry.directory && !this.hasLiveOwner(entry.directory)) this.clearRegistrationRetry(entry.directory);
    entry.grace = setTimeout(() => {
      if (this.entries.get(entry.workspaceId) === entry && !entry.subscribers.size) this.dropEntry(entry);
    }, this.options.graceMs ?? UNSUBSCRIBE_GRACE_MS);
    entry.grace.unref?.();
  }

  private async refresh(socket: AuthenticatedSocket, payload: WorkspaceGitSubscriptionPayload): Promise<void> {
    const workspaceId = payload?.workspaceId;
    if (typeof workspaceId !== 'string') return;
    const intent = this.intents.get(socket)?.get(workspaceId);
    if (!intent) return;
    const valid = await this.validate(socket);
    // Only lost authorization ends the connection; a disconnect also destroys the socket's
    // terminals and every other subscription. An unsubscribe or a new subscribe that arrived
    // during validation merely makes this refresh obsolete.
    if (!valid()) { socket.disconnect(true); return; }
    if (!this.current(socket, workspaceId, intent)) return;
    let times = this.refreshes.get(socket);
    if (!times) { times = new Map(); this.refreshes.set(socket, times); }
    const now = Date.now();
    // Keep the same socket/workspace budget across unsubscribe/resubscribe,
    // while retaining only timestamps still inside the rate-limit window.
    for (const [id, at] of times) if (now - at >= REFRESH_INTERVAL_MS) times.delete(id);
    if (now - (times.get(workspaceId) ?? -Infinity) < REFRESH_INTERVAL_MS) return;
    times.set(workspaceId, now);
    this.invalidateWorkspace(workspaceId, 'refresh');
  }

  private beginRegistration(entry: Subscription, knownInput?: WorkspaceGitSubscriptionInput, recreated = false, attempt = 0): void {
    this.clearRegistrationRetry(entry);
    // The previous directory cannot publish or end this workspace while its new
    // path and comparison target are being resolved.
    entry.input = undefined;
    entry.snapshot = undefined;
    this.clearRetry(entry);
    const generation = ++entry.generation;
    const current = () => !this.destroyed && this.entries.get(entry.workspaceId) === entry && entry.generation === generation;
    const registration = (async () => {
      let input: WorkspaceGitSubscriptionInput;
      try {
        input = knownInput ?? await (this.options.loadWorkspace ?? loadWorkspace)(entry.workspaceId);
        input.worktreePath = path.resolve(input.worktreePath);
      } catch (error) {
        if (current() && entry.subscribers.size) {
          const code = (error as { code?: string })?.code;
          if (code === 'NOT_FOUND' || code === 'WORKSPACE_GIT_UNAVAILABLE') this.end(entry, code);
          else if (!this.retryRegistration(entry, attempt, () => this.beginRegistration(entry, undefined, recreated, attempt + 1))) {
            this.end(entry, 'WORKSPACE_GIT_UNAVAILABLE');
          }
        }
        throw error;
      }
      if (!current()) return;
      if (entry.directory?.input.worktreePath !== input.worktreePath) this.releaseDirectory(entry);
      entry.input = input;
      let directory = this.directories.get(input.worktreePath);
      const first = !directory;
      if (!directory) {
        directory = { input, owners: new Set(), generation: 0 };
        this.directories.set(input.worktreePath, directory);
      }
      directory.owners.add(entry);
      entry.directory = directory;
      const changed = directory.input.baseBranch !== input.baseBranch || directory.input.repositoryPath !== input.repositoryPath;
      if (first || changed || recreated || (!directory.pending && !directory.snapshot && !directory.registrationRetry)) {
        directory.input = input;
        this.registerDirectory(directory, recreated);
      }
      await this.awaitDirectory(directory);
      if (!current() || entry.directory !== directory) return;
      entry.snapshot = directory.snapshot;
      this.publish(entry);
    })();
    entry.registration = registration;
    void registration.finally(() => {
      if (entry.registration === registration) entry.registration = undefined;
    }).catch(() => undefined);
  }

  private registerDirectory(directory: DirectoryRegistration, recreated = false, attempt = 0): void {
    this.clearRegistrationRetry(directory);
    const generation = ++directory.generation;
    directory.controller?.abort();
    const controller = new AbortController();
    directory.controller = controller;
    directory.snapshot = undefined;
    for (const entry of directory.owners) {
      entry.snapshot = undefined;
      this.clearRetry(entry);
    }
    if (recreated) {
      this.state.unregister(directory.input.worktreePath);
    }
    const pending = (async () => {
      const snapshot = await this.state.register(directory.input, { signal: controller.signal });
      if (this.destroyed || directory.generation !== generation || this.directories.get(directory.input.worktreePath) !== directory) return;
      this.acceptSnapshot(directory, snapshot);
    })();
    directory.pending = pending;
    void pending.catch(() => {
      // A watch or safety check may already have supplied a good snapshot even
      // if the register reply failed. Pending subscribes still get their own ack.
      if (directory.generation !== generation || directory.snapshot || !this.hasLiveOwner(directory)) return;
      if (!this.retryRegistration(directory, attempt, () => this.registerDirectory(directory, false, attempt + 1))) {
        this.endDirectory(directory);
      }
    }).finally(() => {
      if (directory.pending === pending) directory.pending = undefined;
    });
  }

  private async awaitDirectory(directory: DirectoryRegistration): Promise<void> {
    while (directory.pending) {
      const pending = directory.pending;
      const generation = directory.generation;
      try { await pending; }
      catch (error) { if (directory.generation === generation) throw error; }
    }
  }

  private acceptSnapshot(directory: DirectoryRegistration, snapshot: GitStateSnapshot): void {
    if (directory.snapshot?.epoch === snapshot.epoch && directory.snapshot.version > snapshot.version) return;
    this.clearRegistrationRetry(directory);
    if (!snapshot.available) {
      directory.snapshot = undefined;
      this.endDirectory(directory);
      return;
    }
    directory.snapshot = snapshot;
    for (const entry of directory.owners) {
      if (!entry.input || entry.ended || entry.directory !== directory) continue;
      if (entry.snapshot?.epoch !== snapshot.epoch || entry.snapshot.version !== snapshot.version) {
        this.clearRetry(entry);
        entry.retryAttempts = 0;
      }
      entry.snapshot = snapshot;
      this.publish(entry);
    }
  }

  private releaseDirectory(entry: Subscription): void {
    const directory = entry.directory;
    entry.directory = undefined;
    if (!directory) return;
    directory.owners.delete(entry);
    if (directory.owners.size) return;
    this.clearRegistrationRetry(directory);
    this.directories.delete(directory.input.worktreePath);
    directory.generation += 1;
    directory.controller?.abort();
    this.state.unregister(directory.input.worktreePath);
  }

  private async awaitRegistration(entry: Subscription): Promise<void> {
    while (entry.registration) {
      const registration = entry.registration;
      const generation = entry.generation;
      try { await registration; }
      catch (error) { if (entry.generation === generation) throw error; }
    }
  }

  private hasLiveOwner(directory: DirectoryRegistration): boolean {
    return [...directory.owners].some(entry => entry.subscribers.size > 0);
  }

  private clearRegistrationRetry(target: Subscription | DirectoryRegistration): void {
    if (target.registrationRetry) clearTimeout(target.registrationRetry);
    target.registrationRetry = undefined;
  }

  private retryRegistration(target: Subscription | DirectoryRegistration, attempt: number, retry: () => void): boolean {
    const delay = (this.options.registrationRetryDelaysMs ?? REGISTRATION_RETRY_DELAYS_MS)[attempt];
    if (delay === undefined) return false;
    target.registrationRetry = setTimeout(() => {
      target.registrationRetry = undefined;
      retry();
    }, delay);
    target.registrationRetry.unref?.();
    return true;
  }

  private endDirectory(directory: DirectoryRegistration): void {
    for (const entry of [...directory.owners]) {
      if (entry.input) this.end(entry, 'WORKSPACE_GIT_UNAVAILABLE');
    }
  }

  private end(entry: Subscription, code: WorkspaceGitSubscriptionEndedPayload['code']): void {
    if (entry.ended) return;
    entry.ended = true;
    entry.generation += 1;
    entry.snapshot = undefined;
    const payload = { workspaceId: entry.workspaceId, code, message: code === 'NOT_FOUND' ? 'Workspace not found' : 'Workspace git subscription is unavailable' };
    for (const subscriber of [...entry.subscribers.values()]) {
      if (!this.current(subscriber.socket, entry.workspaceId, subscriber.intent)) {
        // A newer subscribe owns the intent and will join or leave the room itself.
        entry.subscribers.delete(subscriber.socket.id);
        continue;
      }
      subscriber.ended = payload;
      if (subscriber.acknowledged) subscriber.socket.emit(ServerEvents.WORKSPACE_GIT_SUBSCRIPTION_ENDED, payload);
      this.unsubscribe(subscriber.socket, entry.workspaceId);
    }
    this.scheduleRelease(entry);
  }

  private dropEntry(entry: Subscription): void {
    this.entries.delete(entry.workspaceId);
    entry.generation += 1;
    if (entry.grace) clearTimeout(entry.grace);
    this.clearRetry(entry);
    this.clearRegistrationRetry(entry);
    this.releaseDirectory(entry);
  }

  private async payload(entry: Subscription, snapshot: GitStateSnapshot): Promise<WorkspaceGitStatePayload> {
    const { workspaceId } = entry;
    const status = entry.input?.mainDirectory ? mainDirectoryGitStatus() : toGitOperationStatus(snapshot);
    if (status.conflictOp && status.conflictedFiles.length) status.resolutionContextToken = await (this.options.observeConflict ?? observeConflict)(workspaceId);
    return { workspaceId, epoch: snapshot.epoch, version: snapshot.version, state: {
      changes: toGitChangesResponse(snapshot), status, headOid: snapshot.head.oid, baseBranch: snapshot.baseBranch,
    } };
  }

  private clearRetry(entry: Subscription): void {
    if (entry.retry) clearTimeout(entry.retry);
    entry.retry = undefined;
  }

  private async authorizePayload(payload: WorkspaceGitStatePayload, socket: AuthenticatedSocket): Promise<WorkspaceGitStatePayload> {
    const token = payload.state.status.resolutionContextToken;
    if (!token) return payload;
    const authorized = await (this.options.authorizeConflict ?? authorizeWorkspaceGitConflictToken)(token, socket);
    return { ...payload, state: { ...payload.state, status: { ...payload.state.status, resolutionContextToken: authorized } } };
  }

  private scheduleDeliveryRetry(entry: Subscription, snapshot: GitStateSnapshot): void {
    if (this.destroyed || this.entries.get(entry.workspaceId) !== entry || entry.snapshot !== snapshot || !entry.subscribers.size || entry.retry) return;
    const minimum = this.options.deliveryRetryMinMs ?? DELIVERY_RETRY_MIN_MS;
    const maximum = this.options.deliveryRetryMaxMs ?? DELIVERY_RETRY_MAX_MS;
    const delay = Math.min(maximum, minimum * 2 ** Math.min(entry.retryAttempts++, 16));
    entry.retry = setTimeout(() => {
      entry.retry = undefined;
      this.publish(entry);
    }, delay);
    entry.retry.unref?.();
  }

  private publish(entry: Subscription): void {
    entry.publishing = entry.publishing.then(async () => {
      if (this.destroyed || this.entries.get(entry.workspaceId) !== entry || !entry.snapshot?.available) return;
      const snapshot = entry.snapshot;
      const generation = entry.generation;
      const recipients = [...entry.subscribers.values()].filter((subscriber) => subscriber.delivered && (subscriber.delivered.epoch !== snapshot.epoch || subscriber.delivered.version < snapshot.version));
      if (!recipients.length) { this.clearRetry(entry); return; }
      try {
        const response = await this.payload(entry, snapshot);
        let failed = false;
        for (const subscriber of recipients) {
          try {
            const valid = await this.validate(subscriber.socket);
            if (!valid()) { subscriber.socket.disconnect(true); continue; }
            const authorizedResponse = await this.authorizePayload(response, subscriber.socket);
            if (!valid()) { subscriber.socket.disconnect(true); continue; }
            if (!this.current(subscriber.socket, entry.workspaceId, subscriber.intent) || entry.generation !== generation || entry.snapshot !== snapshot) continue;
            if (!this.nsp.adapter.rooms.get(`workspace-git:${entry.workspaceId}`)?.has(subscriber.socket.id)) continue;
            subscriber.socket.emit(ServerEvents.WORKSPACE_GIT_STATE, authorizedResponse);
            subscriber.delivered = { epoch: response.epoch, version: response.version };
            countGitStatePushes();
          } catch { failed = true; }
        }
        if (failed) this.scheduleDeliveryRetry(entry, snapshot);
        else { this.clearRetry(entry); entry.retryAttempts = 0; }
      } catch {
        this.scheduleDeliveryRetry(entry, snapshot);
      }
    });
  }
}
