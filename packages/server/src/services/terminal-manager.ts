import * as pty from '@shitiandmw/node-pty';
import type { IPty } from '@shitiandmw/node-pty';
import type { EventBus } from '../core/event-bus.js';
import { randomUUID } from 'crypto';
import { getDefaultTerminalShell, type CommandInvocation } from '../utils/process-launch.js';
import { createUnixProcessIdentityAdapter, PROCESS_IDENTITY_ENV, type UnixProcessIdentity, type UnixProcessGroupIdentity, type UnixProcessIdentityAdapter } from '../utils/unix-process-identity.js';
import { writeErrorLog } from '../utils/error-log.js';
import { createWindowsProcessTreeAdapter, type WindowsProcessIdentity, type WindowsProcessTreeAdapter } from '../runtime/acp/process-manager.js';
import { assertApplicationProcessStartAllowed } from '../runtime/application-process-cleanup.js';

// ============================================================
// Constants
// ============================================================

const MAX_TERMINALS_PER_SOCKET = 50;
const TERMINAL_TTL_MS = 30 * 60 * 1000; // 30 minutes idle timeout
const TTL_CHECK_INTERVAL_MS = 60 * 1000; // check every 60 seconds

/** agent-tower 内部注入的环境变量，不应泄漏到用户终端 */
const INTERNAL_ENV_KEYS = [
  'AGENT_TOWER_DATABASE_URL',
  'AGENT_TOWER_DATA_DIR',
  'AGENT_TOWER_WEB_DIR',
  'AGENT_TOWER_NODE_RUNTIME',
  'AGENT_TOWER_DESKTOP_RUNTIME_MODE',
  'AGENT_TOWER_MCP_ENTRY',
  'AGENT_TOWER_INTERNAL_TOKEN',
  'ELECTRON_RUN_AS_NODE',
  'AGENT_TOWER_TREE_CLEANUP_CHANNEL',
  'AGENT_TOWER_TREE_CLEANUP_SECRET',
  'AGENT_TOWER_PROCESS_IDENTITY',
  'AGENT_TOWER_PTY_IDENTITY_SEED',
];

function cleanInternalEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleaned = { ...env };
  for (const key of INTERNAL_ENV_KEYS) {
    delete cleaned[key];
  }
  return cleaned;
}

// ============================================================
// Types
// ============================================================

interface ManagedTerminal {
  pty: IPty;
  socketId: string;
  lastActivity: number;
  cleanups: Array<{ dispose(): void }>;
  ownershipToken: string;
  rootIdentity: Promise<UnixProcessIdentity | null>;
  groups: UnixProcessGroupIdentity[];
  exited: boolean;
  exitCode: number;
  stopping: Promise<void> | null;
  stopRequested: boolean;
  windowsRoot: WindowsProcessIdentity | null;
  windowsMembers: Map<number, WindowsProcessIdentity>;
  windowsCapture: Promise<void> | null;
  windowsCaptureTimer: ReturnType<typeof setInterval> | null;
  groupsCaptureTimer: ReturnType<typeof setInterval> | null;
  groupsCapture: Promise<void> | null;
}

export interface TerminalManagerOptions {
  spawn?: typeof pty.spawn;
  shell?: CommandInvocation;
  platform?: NodeJS.Platform;
  unixProcessAdapter?: UnixProcessIdentityAdapter;
  windowsProcessAdapter?: WindowsProcessTreeAdapter;
  gracefulTimeoutMs?: number;
  forceTimeoutMs?: number;
}

export interface TerminalCreateOptions {
  cwd?: string;
  cols?: number;
  rows?: number;
}

export interface TerminalInfo {
  terminalId: string;
  pid: number;
  cwd: string;
}

// ============================================================
// TerminalManager
// ============================================================

/**
 * Manages standalone interactive shell terminals.
 * Each terminal is a raw PTY (zsh/cmd 等系统默认 shell) with no parser or MsgStore.
 * Terminals are owned by the socket that created them.
 */
export class TerminalManager {
  private terminals = new Map<string, ManagedTerminal>();
  private ownership = new Map<string, Set<string>>(); // socketId → Set<terminalId>
  private ttlTimer: ReturnType<typeof setInterval> | null = null;

  private stopped = false;
  private readonly platform: NodeJS.Platform;
  private readonly unixProcessAdapter: UnixProcessIdentityAdapter;
  private readonly windowsProcessAdapter: WindowsProcessTreeAdapter;
  private readonly spawnPty: typeof pty.spawn;
  private readonly shell: CommandInvocation;
  private readonly gracefulTimeoutMs: number;
  private readonly forceTimeoutMs: number;

  constructor(private readonly eventBus: EventBus, options: TerminalManagerOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.unixProcessAdapter = options.unixProcessAdapter ?? createUnixProcessIdentityAdapter(this.platform);
    this.windowsProcessAdapter = options.windowsProcessAdapter ?? createWindowsProcessTreeAdapter();
    this.spawnPty = options.spawn ?? pty.spawn;
    this.shell = options.shell ?? getDefaultTerminalShell();
    this.gracefulTimeoutMs = options.gracefulTimeoutMs ?? 1_000;
    this.forceTimeoutMs = options.forceTimeoutMs ?? 2_000;
    this.startTTLChecker();
  }

  // --------------------------------------------------------
  // Public API
  // --------------------------------------------------------

  /**
   * Create a new standalone terminal.
   * Returns terminal info including the generated ID.
   */
  create(socketId: string, options: TerminalCreateOptions = {}): TerminalInfo {
    assertApplicationProcessStartAllowed();
    if (this.stopped) throw new Error('Terminal manager is stopped');
    // Enforce per-socket limit
    const owned = this.ownership.get(socketId);
    if (owned && owned.size >= MAX_TERMINALS_PER_SOCKET) {
      throw new Error(`Terminal limit reached (max ${MAX_TERMINALS_PER_SOCKET} per connection)`);
    }

    const terminalId = `term-${randomUUID()}`;
    const cols = options.cols ?? 120;
    const rows = options.rows ?? 30;
    const cwd = options.cwd || process.cwd();

    const ownershipToken = randomUUID();
    let shell: IPty;
    try {
      shell = this.spawnPty(this.shell.command, this.shell.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: { ...cleanInternalEnv(process.env), [PROCESS_IDENTITY_ENV]: ownershipToken } as Record<string, string>,
      });
    } catch (error) {
      writeErrorLog({
        level: 'error',
        source: 'terminal.spawn',
        message: 'Failed to spawn standalone terminal',
        error,
        metadata: {
          terminalId,
          socketId,
          cwd,
          command: this.shell.command,
        },
      });
      throw error;
    }

    const managed: ManagedTerminal = {
      pty: shell,
      socketId,
      lastActivity: Date.now(),
      cleanups: [],
      ownershipToken,
      rootIdentity: Promise.resolve(null),
      groups: [],
      exited: false,
      exitCode: 0,
      stopping: null,
      stopRequested: false,
      windowsRoot: null,
      windowsMembers: new Map(),
      windowsCapture: null,
      windowsCaptureTimer: null,
      groupsCaptureTimer: null,
      groupsCapture: null,
    };
    if (this.platform !== 'win32') managed.rootIdentity = this.captureTerminalRoot(managed).catch(() => null);
    this.terminals.set(terminalId, managed);
    this.recordOwnership(socketId, terminalId);
    if (this.platform !== 'win32') {
      managed.groupsCaptureTimer = setInterval(() => {
        if (!managed.stopRequested && !managed.exited) void this.refreshGroups(managed, false).catch(() => undefined);
      }, 100);
      managed.groupsCaptureTimer.unref?.();
    }
    if (this.platform === 'win32') {
      void this.captureWindowsTree(managed).catch(() => undefined);
      managed.windowsCaptureTimer = setInterval(() => {
        void this.captureWindowsTree(managed).catch(() => undefined);
      }, 1_000);
      managed.windowsCaptureTimer.unref?.();
    }
    try {
      managed.cleanups.push(shell.onData((data) => {
        managed.lastActivity = Date.now();
        if (this.platform === 'win32') void this.captureWindowsTree(managed).catch(() => undefined);
        this.eventBus.emit('terminal:stdout', { terminalId, data });
      }));
      managed.cleanups.push(shell.onExit(({ exitCode }) => {
        managed.exited = true;
        managed.exitCode = exitCode;
        // Shell exit alone does not establish that its jobs exited.
        void this.destroy(terminalId).catch((error) => this.logCleanupFailure(terminalId, error));
      }));
    } catch (error) {
      void this.destroy(terminalId).catch((cleanupError) => this.logCleanupFailure(terminalId, cleanupError));
      throw error;
    }

    console.log(`[TerminalManager] Created terminal ${terminalId} (pid=${shell.pid}) for socket ${socketId} cwd=${cwd}`);

    return {
      terminalId,
      pid: shell.pid,
      cwd,
    };
  }

  /**
   * Write data to a terminal's stdin.
   */
  write(terminalId: string, data: string): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal || terminal.stopRequested || terminal.exited) return;
    terminal.lastActivity = Date.now();
    terminal.pty.write(data);
  }

  /**
   * Resize a terminal.
   */
  resize(terminalId: string, cols: number, rows: number): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal || terminal.stopRequested || terminal.exited) return;
    terminal.lastActivity = Date.now();
    terminal.pty.resize(cols, rows);
  }

  /**
   * Destroy a single terminal.
   */
  async destroy(terminalId: string): Promise<void> {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return;
    terminal.stopRequested = true;
    if (terminal.stopping) return terminal.stopping;
    const stopping = (async () => {
      if (this.platform === 'win32') {
        const deadline = Date.now() + this.forceTimeoutMs;
        while (true) {
          await this.captureWindowsTree(terminal);
          const alive = [];
          for (const member of terminal.windowsMembers.values()) {
            if (await this.windowsProcessAdapter.isProcessAlive(member)) alive.push(member);
          }
          if (terminal.exited && alive.length === 0) break;
          if (Date.now() >= deadline) throw new Error('Terminal process tree did not exit after forced termination');
          // Killing only an exited root PID cannot reclaim surviving children.
          for (const member of alive.reverse()) {
            if (await this.windowsProcessAdapter.isProcessAlive(member)) {
              await this.windowsProcessAdapter.terminateTree(member.pid);
            }
          }
          await this.delay();
        }
      } else {
        await this.refreshGroups(terminal);
        await this.signalGroups(terminal, 'SIGHUP');
        const gracefulDeadline = Date.now() + this.gracefulTimeoutMs;
        const forcedDeadline = gracefulDeadline + this.forceTimeoutMs;
        while (true) {
          await this.refreshGroups(terminal);
          const alive = await Promise.all(terminal.groups.map(group => this.unixProcessAdapter.isProcessGroupAlive(group)));
          if (terminal.exited && !alive.some(Boolean)) break;
          if (Date.now() >= forcedDeadline) throw new Error('Terminal process tree did not exit after forced termination');
          if (Date.now() >= gracefulDeadline) await this.signalGroups(terminal, 'SIGKILL');
          await this.delay();
        }
      }
      for (const cleanup of terminal.cleanups) cleanup.dispose();
      if (terminal.windowsCaptureTimer) clearInterval(terminal.windowsCaptureTimer);
      if (terminal.groupsCaptureTimer) clearInterval(terminal.groupsCaptureTimer);
      await terminal.groupsCapture;
      this.unixProcessAdapter.releaseOwnership?.(terminal.ownershipToken);
      this.removeTerminal(terminalId);
      this.eventBus.emit('terminal:exit', { terminalId, exitCode: terminal.exitCode });
    })();
    terminal.stopping = stopping;
    try {
      await stopping;
    } finally {
      // Retain ownership and identities on failure so disconnect/TTL/shutdown
      // can retry even when the shell has already exited.
      if (terminal.stopping === stopping) terminal.stopping = null;
    }
  }

  async cleanupBySocket(socketId: string): Promise<void> {
    await this.destroyMany([...(this.ownership.get(socketId) ?? [])]);
  }

  async destroyAll(): Promise<void> {
    this.stopped = true;
    if (this.ttlTimer) clearInterval(this.ttlTimer);
    this.ttlTimer = null;
    await this.destroyMany([...this.terminals.keys()]);
  }

  private async destroyMany(terminalIds: string[]): Promise<void> {
    const results = await Promise.allSettled(terminalIds.map(id => this.destroy(id)));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  private async captureWindowsTree(terminal: ManagedTerminal): Promise<void> {
    if (terminal.windowsCapture) return terminal.windowsCapture;
    const capture = (async () => {
      if (!terminal.windowsRoot) {
        if (terminal.exited) throw new Error('Terminal process identity was not verified before root exit');
        const root = await this.windowsProcessAdapter.captureProcess(terminal.pty.pid);
        if (!root || terminal.exited) throw new Error('Terminal process identity could not be verified');
        terminal.windowsRoot = root;
        terminal.windowsMembers.set(root.pid, root);
      }
      for (const member of [...terminal.windowsMembers.values()]) {
        if (!await this.windowsProcessAdapter.isProcessAlive(member)) continue;
        const descendants = await this.windowsProcessAdapter.captureDescendants(member.pid);
        if (!await this.windowsProcessAdapter.isProcessAlive(member)) continue;
        for (const descendant of descendants) {
          const previous = terminal.windowsMembers.get(descendant.pid);
          if (!previous || previous.birthMarker === descendant.birthMarker) terminal.windowsMembers.set(descendant.pid, descendant);
        }
      }
    })();
    terminal.windowsCapture = capture;
    try {
      await capture;
    } finally {
      if (terminal.windowsCapture === capture) terminal.windowsCapture = null;
    }
  }

  private async captureTerminalRoot(terminal: ManagedTerminal): Promise<UnixProcessIdentity | null> {
    if (terminal.exited) return null;
    const root = this.unixProcessAdapter.captureChildProcess
      ? await this.unixProcessAdapter.captureChildProcess(terminal.pty.pid, terminal.ownershipToken, () => !terminal.exited)
      : await this.unixProcessAdapter.captureProcess(terminal.pty.pid, terminal.ownershipToken);
    return terminal.exited ? null : root;
  }

  private async refreshGroups(terminal: ManagedTerminal, retainPrevious = true): Promise<void> {
    if (terminal.groupsCapture) return terminal.groupsCapture;
    const pending = this.refreshGroupsOnce(terminal, retainPrevious);
    terminal.groupsCapture = pending;
    try {
      await pending;
    } finally {
      if (terminal.groupsCapture === pending) terminal.groupsCapture = null;
    }
  }

  private async refreshGroupsOnce(terminal: ManagedTerminal, retainPrevious: boolean): Promise<void> {
    let root = await terminal.rootIdentity;
    if (!root && !terminal.exited) {
      root = await this.captureTerminalRoot(terminal);
      if (root) terminal.rootIdentity = Promise.resolve(root);
    }
    const captured = this.unixProcessAdapter.captureOwnedGroups
      ? await this.unixProcessAdapter.captureOwnedGroups(terminal.ownershipToken)
      : [];
    if (root) {
      captured.push({ pgid: root.pgid, members: [root] });
      if (!terminal.exited) captured.push(...await this.unixProcessAdapter.captureDescendantGroups(root));
    }
    if (!root && !terminal.exited && captured.length === 0 && terminal.groups.length === 0) {
      throw new Error('Terminal process identity could not be verified');
    }
    const groups = new Map<number, UnixProcessIdentity[]>();
    // A successful running snapshot replaces history. Failed probes retain the
    // previous snapshot; stop retries merge evidence until cleanup is confirmed.
    for (const group of [...(retainPrevious ? terminal.groups : []), ...captured]) {
      const members = groups.get(group.pgid) ?? [];
      for (const member of group.members) {
        if (!members.some(existing => existing.pid === member.pid && existing.birthIdentity === member.birthIdentity)) members.push(member);
      }
      groups.set(group.pgid, members);
    }
    terminal.groups = [...groups].map(([pgid, members]) => ({ pgid, members }));
  }

  private async signalGroups(terminal: ManagedTerminal, signal: NodeJS.Signals): Promise<void> {
    await Promise.all(terminal.groups.map(group => this.unixProcessAdapter.signalProcessGroup(group, signal)));
  }

  private async delay(): Promise<void> {
    await new Promise<void>(resolve => setTimeout(resolve, 25));
  }

  private logCleanupFailure(terminalId: string, error: unknown): void {
    writeErrorLog({ level: 'error', source: 'terminal.cleanup', message: 'Failed to clean up terminal process tree', error, metadata: { terminalId } });
  }

  /**
   * Check if a terminal exists.
   */
  has(terminalId: string): boolean {
    return this.terminals.has(terminalId);
  }

  /**
   * Get count of active terminals.
   */
  get size(): number {
    return this.terminals.size;
  }

  // --------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------

  private recordOwnership(socketId: string, terminalId: string): void {
    let owned = this.ownership.get(socketId);
    if (!owned) {
      owned = new Set();
      this.ownership.set(socketId, owned);
    }
    owned.add(terminalId);
  }

  private removeTerminal(terminalId: string): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return;

    // Remove from ownership map
    const owned = this.ownership.get(terminal.socketId);
    if (owned) {
      owned.delete(terminalId);
      if (owned.size === 0) {
        this.ownership.delete(terminal.socketId);
      }
    }

    this.terminals.delete(terminalId);
  }

  /**
   * Periodic TTL check — kill terminals that have been idle too long.
   */
  private startTTLChecker(): void {
    this.ttlTimer = setInterval(() => {
      const now = Date.now();
      for (const [terminalId, terminal] of this.terminals) {
        if (terminal.stopRequested || now - terminal.lastActivity > TERMINAL_TTL_MS) {
          console.log(`[TerminalManager] TTL expired for terminal ${terminalId} (idle ${Math.round((now - terminal.lastActivity) / 1000)}s)`);
          void this.destroy(terminalId).catch((error) => this.logCleanupFailure(terminalId, error));
        }
      }
    }, TTL_CHECK_INTERVAL_MS);

    // Don't block Node.js exit
    if (this.ttlTimer.unref) {
      this.ttlTimer.unref();
    }
  }
}
