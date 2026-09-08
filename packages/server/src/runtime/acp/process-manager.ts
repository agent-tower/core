import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Readable, Transform, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { AgentRuntimeError } from '../errors.js';
import { markPreChildProcessFailure } from '../../executors/start-error.js';
import type { AcpStdoutFrameTransform } from './agents/types.js';
import {
  createUnixProcessIdentityAdapter,
  type UnixProcessGroupIdentity,
  type UnixProcessIdentity,
  type UnixProcessIdentityAdapter,
} from '../../utils/unix-process-identity.js';
import { acpLaunchCleanupRegistry } from './launch-cleanup-registry.js';

const MAX_STDOUT_LINE_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 8 * 1024;
const DEFAULT_KILL_GRACE_MS = 2_000;

export interface AcpProcessExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderrExcerpt: string;
}

export interface AcpProcessStreams {
  pid: number;
  processGroupId: string;
  birthMarker: string;
  ownershipToken: string;
  input: WritableStream<Uint8Array>;
  output: ReadableStream<Uint8Array>;
}

export interface WindowsProcessIdentity {
  pid: number;
  parentPid: number;
  birthMarker: string;
}

export interface WindowsProcessTreeAdapter {
  captureProcess(pid: number): Promise<WindowsProcessIdentity | null>;
  captureDescendants(rootPid: number): Promise<WindowsProcessIdentity[]>;
  isProcessAlive(identity: WindowsProcessIdentity): Promise<boolean>;
  terminateTree(pid: number): Promise<void>;
}

export interface PersistedAcpProcessIdentity {
  pid: number;
  launchClaimNumber?: number | null;
  processGroupId?: string | null;
  birthMarker?: string | null;
  ownershipToken: string;
}

export class AcpProcessManager {
  private child?: ChildProcessWithoutNullStreams;
  private exitPromise?: Promise<AcpProcessExit>;
  private resolveExit?: (exit: AcpProcessExit) => void;
  private settled?: AcpProcessExit;
  private stopPromise?: Promise<AcpProcessExit | undefined>;
  private stderr = '';
  private readonly platform: NodeJS.Platform;
  private readonly unixProcessAdapter: UnixProcessIdentityAdapter;
  private readonly windowsProcessAdapter: WindowsProcessTreeAdapter;
  private readonly ownershipToken = randomUUID();
  private rootIdentity?: UnixProcessIdentity;
  private rootWindowsIdentity?: WindowsProcessIdentity;
  private readonly ownedWindowsProcesses = new Map<number, WindowsProcessIdentity>();
  private readonly exitListeners = new Set<(exit: AcpProcessExit) => void>();
  private cleanupOwnerId?: string;
  private cleanupRetryPromise?: Promise<void>;

  constructor(
    private readonly launch: {
      command: string;
      args: string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
      maxStdoutFrameBytes?: number;
      transformStdoutFrame?: AcpStdoutFrameTransform;
    },
    options: {
      platform?: NodeJS.Platform;
      unixProcessAdapter?: UnixProcessIdentityAdapter;
      windowsProcessAdapter?: WindowsProcessTreeAdapter;
    } = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.unixProcessAdapter = options.unixProcessAdapter
      ?? createUnixProcessIdentityAdapter(this.platform);
    this.windowsProcessAdapter = options.windowsProcessAdapter
      ?? createWindowsProcessTreeAdapter();
  }

  async start(): Promise<AcpProcessStreams> {
    if (this.child) {
      throw new AgentRuntimeError('spawn_failed', 'spawn', 'ACP adapter is already running', false);
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.launch.command, this.launch.args, {
        cwd: this.launch.cwd,
        env: {
          ...this.launch.env,
          AGENT_TOWER_PROCESS_IDENTITY: this.ownershipToken,
          AGENT_TOWER_PROCESS_BIRTH_MARKER: this.ownershipToken,
        },
        detached: this.platform !== 'win32',
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw markPreChildProcessFailure(
        new AgentRuntimeError('spawn_failed', 'spawn', 'Could not start the ACP adapter', true, { cause: error }),
      );
    }
    this.child = child;
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderr = appendBounded(this.stderr, sanitizeDiagnostic(chunk), MAX_STDERR_BYTES);
    });

    await new Promise<void>((resolve, reject) => {
      let spawned = false;
      child.once('spawn', () => {
        spawned = true;
        resolve();
      });
      child.once('error', (error) => {
        this.settle({ exitCode: null, signal: null, stderrExcerpt: this.stderr });
        if (!spawned) {
          reject(markPreChildProcessFailure(
            new AgentRuntimeError('spawn_failed', 'spawn', 'Could not start the ACP adapter', true, { cause: error }),
          ));
        }
      });
      child.once('close', (exitCode, signal) => {
        this.settle({ exitCode, signal, stderrExcerpt: this.stderr });
      });
    });

    if (!child.pid) {
      return this.failAfterSpawn(new AgentRuntimeError(
        'spawn_failed',
        'spawn',
        'ACP adapter did not report a process id',
        true,
      ));
    }
    // Attach the stdout validator before the identity probe. A short-lived
    // adapter may exit while its launch identity is being sampled; attaching
    // later would miss already-buffered protocol frames.
    let output: ReadableStream<Uint8Array>;
    try {
      const validatedOutput = createValidatedOutput(child.stdout, {
        maxInputFrameBytes: this.launch.maxStdoutFrameBytes ?? MAX_STDOUT_LINE_BYTES,
        transformFrame: this.launch.transformStdoutFrame,
      });
      output = Readable.toWeb(validatedOutput) as ReadableStream<Uint8Array>;
      if (this.platform === 'win32') {
        this.rootWindowsIdentity = await this.captureRootWindowsIdentity(child.pid);
        if (this.rootWindowsIdentity) {
          this.ownedWindowsProcesses.set(this.rootWindowsIdentity.pid, this.rootWindowsIdentity);
        } else if (!this.settled) {
          return this.failAfterSpawn(new AgentRuntimeError(
            'spawn_failed',
            'spawn',
            'ACP adapter process identity could not be verified',
            true,
          ));
        } else {
          // The exact ChildProcess handle is settled. Only accept a missing
          // root when the adapter can also prove that no descendant remains.
          await this.captureWindowsDescendants();
        }
      } else {
        this.rootIdentity = await this.captureRootIdentity(child.pid);
        if (!this.rootIdentity && !this.settled) {
          return this.failAfterSpawn(new AgentRuntimeError(
            'spawn_failed',
            'spawn',
            'ACP adapter process identity could not be verified',
            true,
          ));
        }
      }
    } catch (error) {
      return this.failAfterSpawn(error);
    }
    // A short-lived adapter can settle before the OS identity probe observes
    // it. The ChildProcess exit event is authoritative for that exact handle;
    // persist a generation-unique marker without signalling any PID. A live
    // child without a verifiable OS identity remains an unresolved launch.
    const birthMarker = this.rootIdentity?.birthIdentity
      ?? this.rootWindowsIdentity?.birthMarker
      ?? (this.settled ? `settled:${this.ownershipToken}` : undefined);
    if (!birthMarker) {
      return this.failAfterSpawn(new AgentRuntimeError(
        'process_identity_mismatch',
        'spawn',
        'ACP adapter launched without a durable birth identity',
        true,
      ));
    }
    return {
      pid: child.pid,
      processGroupId: this.rootIdentity ? String(this.rootIdentity.pgid) : String(child.pid),
      birthMarker,
      ownershipToken: this.ownershipToken,
      input: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      output,
    };
  }

  onExit(listener: (exit: AcpProcessExit) => void): () => void {
    this.exitListeners.add(listener);
    if (this.settled) listener(this.settled);
    return () => this.exitListeners.delete(listener);
  }

  /** Exposes the retry owner for startup/recovery diagnostics and tests. */
  getPostSpawnCleanupOwnerId(): string | undefined {
    return this.cleanupOwnerId;
  }

  async stop(): Promise<AcpProcessExit | undefined> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.stopOnce().catch((error) => {
      this.stopPromise = undefined;
      // A caller may lose the manager after an initialization failure. Keep a
      // registry owner reachable even when this stop attempt is the first
      // post-spawn failure observed by the driver.
      void this.retryCleanupOwner().catch(() => undefined);
      throw error;
    });
    return this.stopPromise;
  }

  private async stopOnce(): Promise<AcpProcessExit | undefined> {
    if (!this.child || !this.exitPromise) return undefined;
    const settled = this.settled;
    if (!this.child.pid) {
      if (settled) return settled;
      await this.terminateChildHandle('SIGTERM');
      const graceful = await within(this.exitPromise, DEFAULT_KILL_GRACE_MS);
      if (graceful) return graceful;
      await this.terminateChildHandle('SIGKILL');
      const forced = await within(this.exitPromise, DEFAULT_KILL_GRACE_MS);
      if (forced) return forced;
      throw processTreeTimeout();
    }
    let groups = this.platform === 'win32' ? [] : await this.captureOwnedGroups();
    if (this.platform === 'win32') {
      await this.captureWindowsDescendants();
      await this.signal('SIGTERM', groups);
    } else {
      await this.signal('SIGTERM', groups);
    }
    const graceful = settled ?? await within(this.exitPromise, DEFAULT_KILL_GRACE_MS);
    const treeGraceMs = graceful ? Math.min(DEFAULT_KILL_GRACE_MS, 500) : DEFAULT_KILL_GRACE_MS;
    if (graceful && await this.waitForOwnedTreeExit(groups, treeGraceMs)) return graceful;
    if (this.platform !== 'win32') {
      // The ownership marker is launch-scoped. Once the root exits, descendants
      // may have moved to a new session/process group; filtering by the root
      // PGID would permanently hide those escaped groups from cleanup.
      groups = mergeUnixGroups(groups, await this.captureOwnedGroups());
    }
    await this.signal('SIGKILL', groups);
    const forced = await within(this.exitPromise, DEFAULT_KILL_GRACE_MS);
    if (forced && await this.waitForOwnedTreeExit(groups, DEFAULT_KILL_GRACE_MS)) return forced;
    throw new AgentRuntimeError(
      'process_exit_timeout',
      'close',
      'ACP adapter did not confirm termination before the shutdown deadline',
      true,
    );
  }

  private async signal(signal: NodeJS.Signals, groups: UnixProcessGroupIdentity[]): Promise<void> {
    const child = this.child;
    if (!child?.pid) return;
    if (this.platform === 'win32') {
      await this.captureWindowsDescendants();
      const candidates = [...this.ownedWindowsProcesses.values()]
        .sort((left, right) => right.pid - left.pid);
      for (const identity of candidates) {
        if (!await this.windowsProcessAdapter.isProcessAlive(identity)) continue;
        await this.windowsProcessAdapter.terminateTree(identity.pid);
      }
      return;
    }
    await Promise.all(groups.map((group) => this.unixProcessAdapter.signalProcessGroup(group, signal)));
    if (this.rootIdentity) {
      await this.unixProcessAdapter.signalProcess(this.rootIdentity, signal);
    }
  }

  private async waitForOwnedTreeExit(initialGroups: UnixProcessGroupIdentity[], timeoutMs: number): Promise<boolean> {
    let groups = initialGroups;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!await this.isOwnedTreeAlive(groups)) {
        if (this.platform === 'win32') {
          await this.captureWindowsDescendants();
        } else {
          groups = mergeUnixGroups(groups, await this.captureOwnedGroups());
        }
        if (!await this.isOwnedTreeAlive(groups)) return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (this.platform === 'win32') {
      await this.captureWindowsDescendants();
    } else {
      groups = mergeUnixGroups(groups, await this.captureOwnedGroups());
    }
    return !await this.isOwnedTreeAlive(groups);
  }

  private async isOwnedTreeAlive(groups: UnixProcessGroupIdentity[]): Promise<boolean> {
    const pid = this.child?.pid;
    if (!pid) return false;
    if (this.platform === 'win32') {
      for (const identity of this.ownedWindowsProcesses.values()) {
        if (await this.windowsProcessAdapter.isProcessAlive(identity)) return true;
      }
      return false;
    }
    if (!this.settled && this.rootIdentity && await this.unixProcessAdapter.isProcessAlive(this.rootIdentity)) return true;
    const liveGroups = groups
      .map((group) => this.settled
        ? { ...group, members: group.members.filter((member) => member.pid !== pid) }
        : group)
      .filter((group) => group.members.length > 0);
    return (await Promise.all(liveGroups.map((group) => this.unixProcessAdapter.isProcessGroupAlive(group)))).some(Boolean);
  }

  private async captureRootIdentity(pid: number): Promise<UnixProcessIdentity | undefined> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const identity = await this.unixProcessAdapter.captureProcess(pid, this.ownershipToken);
      if (identity) return identity;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return undefined;
  }

  private async captureRootWindowsIdentity(pid: number): Promise<WindowsProcessIdentity | undefined> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const identity = await this.windowsProcessAdapter.captureProcess(pid);
      if (identity) return identity;
      if (this.settled) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return undefined;
  }

  private async captureOwnedGroups(processGroupId?: number): Promise<UnixProcessGroupIdentity[]> {
    if (this.platform === 'win32') return [];
    const groups = this.unixProcessAdapter.captureOwnedGroups
      ? processGroupId === undefined
        ? await this.unixProcessAdapter.captureOwnedGroups(this.ownershipToken)
        : await this.unixProcessAdapter.captureOwnedGroups(this.ownershipToken, processGroupId)
      : this.rootIdentity
      ? await this.unixProcessAdapter.captureDescendantGroups(this.rootIdentity)
      : [];
    if (!this.settled || !this.child?.pid) return groups;
    return groups
      .map((group) => ({ ...group, members: group.members.filter((member) => member.pid !== this.child!.pid) }))
      .filter((group) => group.members.length > 0);
  }

  private async captureWindowsDescendants(): Promise<void> {
    const rootPid = this.child?.pid;
    if (!rootPid) return;
    const currentRoot = await this.windowsProcessAdapter.captureProcess(rootPid);
    // Once the root disappears, a fresh parent/child snapshot cannot prove
    // ownership: the PID may already have been reused. Only descendants that
    // were captured while the root identity was still observable remain safe.
    if (!currentRoot) {
      if (this.settled) {
        const descendants = await this.windowsProcessAdapter.captureDescendants(rootPid);
        for (const identity of descendants) {
          const existing = this.ownedWindowsProcesses.get(identity.pid);
          if (!existing || existing.birthMarker === identity.birthMarker) {
            this.ownedWindowsProcesses.set(identity.pid, identity);
          }
        }
        if (descendants.length > 0) {
          throw processOwnershipUnverifiable();
        }
        if (![...this.ownedWindowsProcesses].some(([pid]) => pid !== rootPid)) {
          return;
        }
      }
      if (![...this.ownedWindowsProcesses].some(([pid]) => pid !== rootPid)) {
        throw processOwnershipUnverifiable();
      }
      return;
    }
    if (
      !this.rootWindowsIdentity
      || currentRoot.birthMarker !== this.rootWindowsIdentity.birthMarker
    ) {
      if (![...this.ownedWindowsProcesses].some(([pid]) => pid !== rootPid)) {
        throw processOwnershipUnverifiable();
      }
      return;
    }
    const descendants = await this.windowsProcessAdapter.captureDescendants(rootPid);
    for (const identity of descendants) {
      const existing = this.ownedWindowsProcesses.get(identity.pid);
      if (!existing || existing.birthMarker === identity.birthMarker) {
        this.ownedWindowsProcesses.set(identity.pid, identity);
      }
    }
  }

  private settle(exit: AcpProcessExit): void {
    if (this.settled) return;
    this.settled = { ...exit, stderrExcerpt: this.stderr };
    this.resolveExit?.(this.settled);
    for (const listener of [...this.exitListeners]) listener(this.settled);
  }

  /**
   * Keep a post-spawn manager reachable even when `start()` rejects before a
   * DriverSession exists.  The shared registry retries tree cleanup and is
   * drained with the application runtime.
   */
  private async failAfterSpawn(error: unknown): Promise<never> {
    const ownerId = this.ensureCleanupOwner();
    try {
      await this.stop();
    } catch {
      // Continue to the registry retries even when the first stop fails.
    }
    try {
      await this.retryCleanupOwner(ownerId);
    } catch {
      // The registry retains the owner and schedules bounded retries.
    }
    throw error;
  }

  private ensureCleanupOwner(): string {
    return this.cleanupOwnerId ??= acpLaunchCleanupRegistry.register(
      () => this.stop().then(() => undefined),
      `acp-process:${this.launch.command}`,
    );
  }

  private retryCleanupOwner(ownerId = this.ensureCleanupOwner()): Promise<void> {
    if (!this.cleanupRetryPromise) {
      const retry = acpLaunchCleanupRegistry.runWithImmediateRetries(ownerId);
      let tracked!: Promise<void>;
      tracked = retry.finally(() => {
        if (this.cleanupRetryPromise === tracked) this.cleanupRetryPromise = undefined;
        if (!acpLaunchCleanupRegistry.getState(ownerId)) this.cleanupOwnerId = undefined;
      });
      this.cleanupRetryPromise = tracked;
    }
    return this.cleanupRetryPromise;
  }

  private async terminateChildHandle(signal: NodeJS.Signals): Promise<void> {
    try {
      this.child?.kill(signal);
    } catch {
      // The child may have exited between the handle check and kill.
    }
  }
}

export async function cleanupPersistedAcpProcessTree(
  identity: PersistedAcpProcessIdentity,
  options: {
    platform?: NodeJS.Platform;
    unixProcessAdapter?: UnixProcessIdentityAdapter;
    windowsProcessAdapter?: WindowsProcessTreeAdapter;
    graceMs?: number;
  } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const graceMs = options.graceMs ?? DEFAULT_KILL_GRACE_MS;
  if (platform === 'win32') {
    const adapter = options.windowsProcessAdapter ?? createWindowsProcessTreeAdapter();
    if (!identity.birthMarker) {
      throw processOwnershipUnverifiable();
    }
    const root = { pid: identity.pid, parentPid: 0, birthMarker: identity.birthMarker };
    const currentRoot = await adapter.captureProcess(identity.pid);
    // A missing root is not evidence that its descendants belong to the old
    // launch. Without a platform-level persisted ownership primitive, refuse
    // recovery rather than risking taskkill against a reused PID tree.
    if (!currentRoot || currentRoot.birthMarker !== root.birthMarker) {
      throw processOwnershipUnverifiable();
    }
    const owned = new Map<number, WindowsProcessIdentity>();
    owned.set(root.pid, root);
    for (const descendant of await adapter.captureDescendants(identity.pid)) {
      owned.set(descendant.pid, descendant);
    }
    for (const processIdentity of [...owned.values()].sort((left, right) => right.pid - left.pid)) {
      if (await adapter.isProcessAlive(processIdentity)) {
        await adapter.terminateTree(processIdentity.pid);
      }
    }
    if (!await waitForWindowsTreeExit(adapter, owned, graceMs)) {
      throw processTreeTimeout();
    }
    return;
  }

  const adapter = options.unixProcessAdapter ?? createUnixProcessIdentityAdapter(platform);
  if (!adapter.captureOwnedGroups || !identity.processGroupId || !identity.birthMarker) {
    throw processOwnershipUnverifiable();
  }
  const pgid = Number(identity.processGroupId);
  const root = Number.isInteger(pgid) && pgid > 0
    ? {
      pid: identity.pid,
      pgid,
      birthIdentity: identity.birthMarker,
      ownershipToken: identity.ownershipToken,
    }
    : undefined;
  const captureGroups = async () => adapter.captureOwnedGroups!(identity.ownershipToken);
  let groups = await captureGroups();
  if (root && await adapter.isProcessAlive(root)) {
    const descendants = await adapter.captureDescendantGroups(root);
    groups = mergeUnixGroups(groups, descendants);
  }
  await Promise.all(groups.map((group) => adapter.signalProcessGroup(group, 'SIGTERM')));
  if (root) await adapter.signalProcess(root, 'SIGTERM');
  if (await waitForUnixTreeExit(adapter, root, groups, graceMs, captureGroups)) return;
  groups = mergeUnixGroups(groups, await captureGroups());
  await Promise.all(groups.map((group) => adapter.signalProcessGroup(group, 'SIGKILL')));
  if (root) await adapter.signalProcess(root, 'SIGKILL');
  if (!await waitForUnixTreeExit(adapter, root, groups, graceMs, captureGroups)) {
    throw processTreeTimeout();
  }
}

export function createWindowsProcessTreeAdapter(runExecFileSync: typeof execFileSync = execFileSync): WindowsProcessTreeAdapter {
  const listProcesses = (): WindowsProcessIdentity[] => {
    const script = [
      'Get-CimInstance Win32_Process',
      'Select-Object ProcessId,ParentProcessId,CreationDate',
      'ConvertTo-Json -Compress',
    ].join(' | ');
    try {
      const output = runExecFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (!output) throw new Error('Windows process enumeration returned empty output');
      const parsed = JSON.parse(output) as Record<string, unknown> | Array<Record<string, unknown>>;
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      // CIM includes the System Idle Process (PID 0) without a creation date.
      // It cannot be our child and is not a malformed candidate identity.
      const identities = rows.filter((row) => row.ProcessId !== 0 && row.ProcessId !== '0').map((row): WindowsProcessIdentity | null => {
        const pid = Number(row.ProcessId);
        const parentPid = Number(row.ParentProcessId);
        const birthMarker = typeof row.CreationDate === 'string' ? row.CreationDate : '';
        return Number.isInteger(pid) && pid > 0 && Number.isInteger(parentPid) && parentPid >= 0 && birthMarker
          ? { pid, parentPid, birthMarker }
          : null;
      });
      if (identities.length === 0 || identities.some((identity) => identity === null)) {
        throw new Error('Windows process enumeration returned malformed output');
      }
      return identities as WindowsProcessIdentity[];
    } catch (error) {
      throw processEnumerationFailed(error);
    }
  };

  return {
    async captureProcess(pid) {
      return listProcesses().find((processIdentity) => processIdentity.pid === pid) ?? null;
    },
    async captureDescendants(rootPid) {
      const rows = listProcesses();
      const descendantIds = new Set<number>([rootPid]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of rows) {
          if (descendantIds.has(row.pid) || !descendantIds.has(row.parentPid)) continue;
          descendantIds.add(row.pid);
          changed = true;
        }
      }
      return rows.filter((row) => row.pid !== rootPid && descendantIds.has(row.pid));
    },
    async isProcessAlive(identity) {
      const current = listProcesses().find((row) => row.pid === identity.pid);
      return current?.birthMarker === identity.birthMarker;
    },
    async terminateTree(pid) {
      try {
        runExecFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {
        // The identity is rechecked before signalling; a concurrent exit is harmless.
      }
    },
  };
}

function mergeUnixGroups(
  left: UnixProcessGroupIdentity[],
  right: UnixProcessGroupIdentity[],
): UnixProcessGroupIdentity[] {
  const groups = new Map<number, UnixProcessIdentity[]>();
  for (const group of [...left, ...right]) {
    const members = groups.get(group.pgid) ?? [];
    const pids = new Set(members.map((member) => member.pid));
    for (const member of group.members) {
      if (!pids.has(member.pid)) {
        members.push(member);
        pids.add(member.pid);
      }
    }
    groups.set(group.pgid, members);
  }
  return [...groups].map(([pgid, members]) => ({ pgid, members }));
}

async function waitForUnixTreeExit(
  adapter: UnixProcessIdentityAdapter,
  root: UnixProcessIdentity | undefined,
  groups: UnixProcessGroupIdentity[],
  timeoutMs: number,
  captureGroups?: () => Promise<UnixProcessGroupIdentity[]>,
): Promise<boolean> {
  let knownGroups = groups;
  const deadline = Date.now() + timeoutMs;
  do {
    const rootAlive = root ? await adapter.isProcessAlive(root) : false;
    const groupAlive = (await Promise.all(knownGroups.map((group) => adapter.isProcessGroupAlive(group)))).some(Boolean);
    if (!rootAlive && !groupAlive) {
      if (captureGroups) {
        knownGroups = mergeUnixGroups(knownGroups, await captureGroups());
      }
      const refreshedGroupAlive = (await Promise.all(
        knownGroups.map((group) => adapter.isProcessGroupAlive(group)),
      )).some(Boolean);
      if (!refreshedGroupAlive) return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  if (captureGroups) {
    knownGroups = mergeUnixGroups(knownGroups, await captureGroups());
  }
  const rootAlive = root ? await adapter.isProcessAlive(root) : false;
  const groupAlive = (await Promise.all(
    knownGroups.map((group) => adapter.isProcessGroupAlive(group)),
  )).some(Boolean);
  return !rootAlive && !groupAlive;
}

async function waitForWindowsTreeExit(
  adapter: WindowsProcessTreeAdapter,
  owned: Map<number, WindowsProcessIdentity>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    const alive = (await Promise.all([...owned.values()].map((item) => adapter.isProcessAlive(item)))).some(Boolean);
    if (!alive) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  return false;
}

function processTreeTimeout(): AgentRuntimeError {
  return new AgentRuntimeError(
    'process_exit_timeout',
    'close',
    'ACP adapter did not confirm termination before the shutdown deadline',
    true,
  );
}

function processOwnershipUnverifiable(): AgentRuntimeError {
  return new AgentRuntimeError(
    'process_identity_mismatch',
    'close',
    'ACP adapter process ownership could not be verified safely',
    true,
  );
}

function processEnumerationFailed(cause?: unknown): AgentRuntimeError {
  return new AgentRuntimeError(
    'process_identity_mismatch',
    'close',
    'ACP adapter process enumeration failed; ownership could not be verified safely',
    true,
    cause === undefined ? undefined : { cause },
  );
}

function createValidatedOutput(
  input: Readable,
  options: {
    maxInputFrameBytes: number;
    transformFrame?: AcpStdoutFrameTransform;
  },
): Readable {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const validator = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        pending += decoder.write(chunk);
        let newlineIndex = pending.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = pending.slice(0, newlineIndex);
          pending = pending.slice(newlineIndex + 1);
          const frame = processFrame(line, options);
          if (frame) this.push(`${frame}\n`);
          newlineIndex = pending.indexOf('\n');
        }
        assertFrameSize(pending, options.maxInputFrameBytes);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
    flush(callback) {
      try {
        pending += decoder.end();
        const frame = processFrame(pending, options);
        if (frame) this.push(frame);
        callback();
      } catch (error) {
        callback(error as Error);
      }
    },
  });
  input.pipe(validator);
  return validator;
}

function processFrame(
  line: string,
  options: {
    maxInputFrameBytes: number;
    transformFrame?: AcpStdoutFrameTransform;
  },
): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  assertFrameSize(trimmed, options.maxInputFrameBytes);
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    throw new AgentRuntimeError('protocol_violation', 'protocol', 'ACP stdout contained malformed JSON', false, { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentRuntimeError('protocol_violation', 'protocol', 'ACP stdout contained a non-object JSON value', false);
  }
  const normalized = options.transformFrame
    ? options.transformFrame(value as Record<string, unknown>)
    : value as Record<string, unknown>;
  const serialized = JSON.stringify(normalized);
  assertFrameSize(serialized, MAX_STDOUT_LINE_BYTES);
  return serialized;
}

function assertFrameSize(value: string, maxBytes: number): void {
  if (Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw new AgentRuntimeError('protocol_violation', 'protocol', 'ACP stdout line exceeded the size limit', false);
  }
}

function appendBounded(current: string, next: string, maxBytes: number): string {
  const combined = `${current}${next}`;
  const bytes = Buffer.from(combined, 'utf8');
  if (bytes.length <= maxBytes) return combined;
  return `[TRUNCATED]\n${bytes.subarray(bytes.length - maxBytes + 12).toString('utf8')}`;
}

function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/\b(?:sk|key|token|secret)-[A-Za-z0-9._-]{8,}\b/gi, '[REDACTED]')
    .replace(/(authorization\s*[:=]\s*)([^\s]+)/gi, '$1[REDACTED]');
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
