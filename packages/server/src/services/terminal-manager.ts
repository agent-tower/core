import * as pty from '@shitiandmw/node-pty';
import type { IPty } from '@shitiandmw/node-pty';
import type { EventBus } from '../core/event-bus.js';
import { randomUUID } from 'crypto';
import { getDefaultTerminalShell } from '../utils/process-launch.js';
import { writeErrorLog } from '../utils/error-log.js';

// ============================================================
// Constants
// ============================================================

const MAX_TERMINALS_PER_SOCKET = 50;
const TERMINAL_TTL_MS = 30 * 60 * 1000; // 30 minutes idle timeout
const TTL_CHECK_INTERVAL_MS = 60 * 1000; // check every 60 seconds
const DEFAULT_TERMINAL_SHELL = getDefaultTerminalShell();

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

  constructor(private readonly eventBus: EventBus) {
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
    // Enforce per-socket limit
    const owned = this.ownership.get(socketId);
    if (owned && owned.size >= MAX_TERMINALS_PER_SOCKET) {
      throw new Error(`Terminal limit reached (max ${MAX_TERMINALS_PER_SOCKET} per connection)`);
    }

    const terminalId = `term-${randomUUID()}`;
    const cols = options.cols ?? 120;
    const rows = options.rows ?? 30;
    const cwd = options.cwd || process.cwd();

    let shell: IPty;
    try {
      shell = pty.spawn(DEFAULT_TERMINAL_SHELL.command, DEFAULT_TERMINAL_SHELL.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: cleanInternalEnv(process.env) as Record<string, string>,
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
          command: DEFAULT_TERMINAL_SHELL.command,
        },
      });
      throw error;
    }

    const cleanups: Array<{ dispose(): void }> = [];

    // Forward PTY output to EventBus
    const onData = shell.onData((data) => {
      const terminal = this.terminals.get(terminalId);
      if (terminal) {
        terminal.lastActivity = Date.now();
      }
      this.eventBus.emit('terminal:stdout', { terminalId, data });
    });
    cleanups.push(onData);

    // Handle PTY exit
    const onExit = shell.onExit(({ exitCode }) => {
      this.eventBus.emit('terminal:exit', { terminalId, exitCode });
      if (typeof exitCode === 'number' && exitCode !== 0) {
        writeErrorLog({
          level: 'warn',
          source: 'terminal.exit',
          message: `Standalone terminal exited with non-zero code ${exitCode}`,
          metadata: {
            terminalId,
            socketId,
            pid: shell.pid,
            exitCode,
          },
        });
      }
      // Dispose all listeners before removing from map
      const terminal = this.terminals.get(terminalId);
      if (terminal) {
        for (const cleanup of terminal.cleanups) {
          cleanup.dispose();
        }
      }
      this.removeTerminal(terminalId);
    });
    cleanups.push(onExit);

    const managed: ManagedTerminal = {
      pty: shell,
      socketId,
      lastActivity: Date.now(),
      cleanups,
    };

    this.terminals.set(terminalId, managed);
    this.recordOwnership(socketId, terminalId);

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
    if (!terminal) return;
    terminal.lastActivity = Date.now();
    terminal.pty.write(data);
  }

  /**
   * Resize a terminal.
   */
  resize(terminalId: string, cols: number, rows: number): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return;
    terminal.lastActivity = Date.now();
    terminal.pty.resize(cols, rows);
  }

  /**
   * Destroy a single terminal.
   */
  destroy(terminalId: string): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return;

    console.log(`[TerminalManager] Destroying terminal ${terminalId}`);

    // Dispose listeners
    for (const cleanup of terminal.cleanups) {
      cleanup.dispose();
    }

    // Kill the PTY process
    try {
      terminal.pty.kill();
    } catch {
      // Ignore kill errors for already-exited processes
    }

    this.removeTerminal(terminalId);
  }

  /**
   * Clean up all terminals owned by a specific socket.
   * Called when a socket disconnects.
   */
  cleanupBySocket(socketId: string): void {
    const owned = this.ownership.get(socketId);
    if (!owned || owned.size === 0) return;

    console.log(`[TerminalManager] Cleaning up ${owned.size} terminals for disconnected socket ${socketId}`);

    // Copy to array to avoid mutation during iteration
    const terminalIds = [...owned];
    for (const terminalId of terminalIds) {
      this.destroy(terminalId);
    }
    this.ownership.delete(socketId);
  }

  /**
   * Destroy all terminals. Called on graceful server shutdown.
   */
  destroyAll(): void {
    console.log(`[TerminalManager] Destroying all ${this.terminals.size} terminals`);
    const terminalIds = [...this.terminals.keys()];
    for (const id of terminalIds) {
      this.destroy(id);
    }
    this.ownership.clear();
    if (this.ttlTimer) {
      clearInterval(this.ttlTimer);
      this.ttlTimer = null;
    }
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
        if (now - terminal.lastActivity > TERMINAL_TTL_MS) {
          console.log(`[TerminalManager] TTL expired for terminal ${terminalId} (idle ${Math.round((now - terminal.lastActivity) / 1000)}s)`);
          this.destroy(terminalId);
        }
      }
    }, TTL_CHECK_INTERVAL_MS);

    // Don't block Node.js exit
    if (this.ttlTimer.unref) {
      this.ttlTimer.unref();
    }
  }
}
