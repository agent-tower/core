import type { EventBus, EventMap, EventName } from '../core/event-bus.js';
import { prisma } from '../utils/index.js';
import { onWorkspaceGitOperation } from './git-operation-events.js';
import type { GitStateTrigger } from './state/git-state-types.js';

export interface WorkspaceGitSignalRegistry {
  hasSubscribers(): boolean;
  invalidateWorkspace(workspaceId: string, trigger: GitStateTrigger): void;
  /** Invalidates subscribed worktrees containing this working directory. */
  invalidatePath(workingDir: string, trigger: GitStateTrigger): void;
  /** Reloads placement metadata after Tower recreates a worktree. */
  refreshPath(workingDir: string, recreated?: boolean): void;
}

export interface WorkspaceGitSignalOptions {
  quietMs?: number;
  resolveSessionWorkspace?: (sessionId: string) => Promise<string | null>;
}

const QUIET_MS = 1_000;
const SESSION_CACHE_LIMIT = 256;
const TOOL_CACHE_LIMIT = 4_096;
const FINISHED_TOOL_STATUSES = new Set(['success', 'failed', 'denied', 'timed_out']);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

interface ToolState { tool: boolean; status?: string; id?: unknown }

/**
 * Converts Tower activity into cheap invalidations. No session database read,
 * patch scan or quiet timer is started when nobody subscribes to git state.
 * The state service owns the final debounce, rate limit and content comparison.
 */
export class WorkspaceGitSignals {
  private readonly disposeListeners: Array<() => void> = [];
  private readonly sessionWorkspaces = new Map<string, Promise<string | null>>();
  private readonly toolStates = new Map<string, ToolState>();
  private readonly terminalInputs = new Map<string, string>();
  private readonly quietTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly quietMs: number;
  private readonly resolveSessionWorkspace: (sessionId: string) => Promise<string | null>;
  private destroyed = false;

  constructor(
    private readonly eventBus: EventBus,
    private readonly registry: WorkspaceGitSignalRegistry,
    options: WorkspaceGitSignalOptions = {},
  ) {
    this.quietMs = options.quietMs ?? QUIET_MS;
    this.resolveSessionWorkspace = options.resolveSessionWorkspace ?? (async (sessionId) => {
      const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { workspaceId: true } });
      return session?.workspaceId ?? null;
    });
    this.listen('session:patch', ({ sessionId, patch }) => {
      if (this.active() && this.toolFinished(sessionId, patch)) this.agentActivity(sessionId);
    });
    for (const event of ['session:turn-completed', 'session:completed', 'session:exit'] as const) {
      this.listen(event, ({ sessionId }) => { if (this.active()) this.agentActivity(sessionId); });
    }
    this.listen('terminal:input', ({ terminalId, cwd }) => {
      this.terminalInputs.set(terminalId, cwd);
    });
    this.listen('terminal:stdout', ({ terminalId, data }) => {
      if (!this.active() || !data) return;
      const cwd = this.terminalInputs.get(terminalId);
      if (!cwd) return;
      this.afterQuiet(`terminal:${terminalId}`, () => {
        // Keep the input association across quiet gaps in a long command.
        // A prompt echo may precede its actual file write by many seconds.
        this.registry.invalidatePath(cwd, 'terminal');
      });
    });
    this.listen('terminal:exit', ({ terminalId }) => {
      // An already queued output signal still fires after the shell exits.
      this.terminalInputs.delete(terminalId);
    });
    this.listen('workspace-service:output', ({ serviceId, workspaceId }) => {
      if (this.active()) this.afterQuiet(`service:${serviceId}`, () => this.registry.invalidateWorkspace(workspaceId, 'service'));
    });
    this.listen('workspace-service:exit', ({ serviceId, workspaceId }) => {
      this.cancelQuiet(`service:${serviceId}`);
      if (this.active()) this.registry.invalidateWorkspace(workspaceId, 'service');
    });
    this.disposeListeners.push(onWorkspaceGitOperation(({ worktreePaths, recreated, metadataChanged }) => {
      // A first subscription may still be loading its directory metadata.
      // Record this revision even before its directory is registered; the
      // registry performs no database work for a directory without owners.
      if (metadataChanged && !this.destroyed) {
        for (const worktreePath of new Set(worktreePaths)) this.registry.refreshPath(worktreePath, false);
        return;
      }
      if (!this.active()) return;
      for (const worktreePath of new Set(worktreePaths)) {
        if (recreated) this.registry.refreshPath(worktreePath, true);
        else this.registry.invalidatePath(worktreePath, 'operation');
      }
    }));
  }

  destroy(): void {
    this.destroyed = true;
    for (const dispose of this.disposeListeners.splice(0)) dispose();
    for (const timer of this.quietTimers.values()) clearTimeout(timer);
    this.quietTimers.clear();
    this.terminalInputs.clear();
    this.sessionWorkspaces.clear();
    this.toolStates.clear();
  }

  private active(): boolean { return !this.destroyed && this.registry.hasSubscribers(); }

  private listen<K extends EventName>(event: K, listener: (payload: EventMap[K]) => void): void {
    this.eventBus.on(event, listener);
    this.disposeListeners.push(() => this.eventBus.off(event, listener));
  }

  private agentActivity(sessionId: string): void {
    let pending = this.sessionWorkspaces.get(sessionId);
    if (!pending) {
      pending = this.resolveSessionWorkspace(sessionId);
      this.sessionWorkspaces.set(sessionId, pending);
      if (this.sessionWorkspaces.size > SESSION_CACHE_LIMIT) this.sessionWorkspaces.delete(this.sessionWorkspaces.keys().next().value!);
      // Failed lookups can be retried by the next real activity signal.
      pending.catch(() => { if (this.sessionWorkspaces.get(sessionId) === pending) this.sessionWorkspaces.delete(sessionId); });
    }
    void pending.then((workspaceId) => {
      if (workspaceId && this.active()) this.registry.invalidateWorkspace(workspaceId, 'agent');
    }).catch((error) => console.warn('[workspace-git] session lookup failed', error));
  }

  private afterQuiet(key: string, callback: () => void): void {
    this.cancelQuiet(key);
    const timer = setTimeout(() => {
      this.quietTimers.delete(key);
      if (this.active()) callback();
    }, this.quietMs);
    timer.unref?.();
    this.quietTimers.set(key, timer);
  }

  private cancelQuiet(key: string): void {
    const timer = this.quietTimers.get(key);
    if (timer) clearTimeout(timer);
    this.quietTimers.delete(key);
  }

  private toolFinished(sessionId: string, patch: unknown[]): boolean {
    let finished = false;
    for (const raw of patch) {
      const op = record(raw);
      if (!op || typeof op.path !== 'string') continue;
      const match = /^\/entries\/([^/]+)(?:\/(metadata)(?:\/(status))?)?$/.exec(op.path);
      if (!match) continue; // Streamed content is deliberately ignored.
      const key = `${sessionId}:${match[1]}`;
      const previous = this.toolStates.get(key);
      if (op.op === 'remove') {
        this.toolStates.delete(key);
        continue;
      }
      if (op.op !== 'add' && op.op !== 'replace') continue;
      let current: ToolState;
      if (!match[2]) {
        const entry = record(op.value);
        if (!entry) continue;
        const status = record(entry.metadata)?.status;
        current = { tool: entry.entryType === 'tool_use', status: typeof status === 'string' ? status : undefined, id: entry.id };
      } else {
        const status = match[3] ? op.value : record(op.value)?.status;
        if (typeof status !== 'string') continue;
        // A leaf status patch is the tool-status patch contract. Accept it if
        // subscription began after the full entry arrived, but never override
        // an entry already known to be a non-tool.
        current = { ...previous, tool: previous?.tool ?? true, status };
      }
      this.toolStates.delete(key);
      this.toolStates.set(key, current);
      if (this.toolStates.size > TOOL_CACHE_LIMIT) this.toolStates.delete(this.toolStates.keys().next().value!);
      if (current.tool && FINISHED_TOOL_STATUSES.has(current.status ?? '')
        && (current.status !== previous?.status || current.id !== previous?.id || !previous?.tool)) finished = true;
    }
    return finished;
  }
}
