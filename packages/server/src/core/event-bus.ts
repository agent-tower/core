import type {
  SessionPermissionInvalidatedPayload,
  SessionPermissionRequestedPayload,
  SessionRuntimeStateChangedPayload,
  SessionWakeupsChangedPayload,
  TeamRunInvalidatedPayload,
  WorkspaceGitChangedPayload,
  WorkspaceSetupProgressPayload,
} from '@agent-tower/shared/socket';

type EventMap = {
  'message-delivery:invalidated': import('@agent-tower/shared').MessageDeliveryInvalidatedPayload;
  'translation:invalidated': import('@agent-tower/shared').TranslationInvalidatedPayload;
  'session:stdout': { sessionId: string; data: string };
  'session:patch': { sessionId: string; patch: unknown[]; seq: number };
  'session:exit': { sessionId: string; exitCode?: number };
  /** Codex reported a successful turn before its wrapper process exited. */
  'session:turn-completed': { sessionId: string };
  /** Codex reported a failed turn before its wrapper process exited. */
  'session:turn-failed': { sessionId: string };
  /** The agent's output says why a turn failed (for example a usage limit); continuation turns included. */
  'session:turn-failure-cause': { sessionId: string; cause: import('../output/turn-failure.js').TurnFailureCause };
  'session:completed': { sessionId: string; status: string };
  'session:started': { sessionId: string };
  'session:stopped': { sessionId: string };
  'session:sessionId': { sessionId: string; agentSessionId: string };
  'session:permission_requested': SessionPermissionRequestedPayload;
  'session:permission_invalidated': SessionPermissionInvalidatedPayload;
  'session:runtime_state_changed': SessionRuntimeStateChangedPayload;
  /** A wake-up of this session was scheduled, released, fired or cancelled. */
  'session:wakeups_changed': SessionWakeupsChangedPayload;
  'task:updated': { taskId: string; projectId: string; status: string; priority?: number };
  'task:deleted': { taskId: string; projectId: string };
  // Standalone terminal events
  'terminal:stdout': { terminalId: string; data: string };
  /** User input arms output-driven git invalidation; cwd is server-owned. */
  'terminal:input': { terminalId: string; cwd: string };
  'terminal:exit': { terminalId: string; exitCode?: number };
  'workspace-service:output': { serviceId: string; workspaceId: string; runtimeInstanceId: string };
  'workspace-service:exit': { serviceId: string; workspaceId: string; runtimeInstanceId: string };
  // Workspace setup progress
  'workspace:setup_progress': WorkspaceSetupProgressPayload;
  'workspace:commit_message_updated': {
    workspaceId: string;
    taskId: string;
    commitMessage: string | null;
  };
  'workspace:hibernated': {
    workspaceId: string;
    taskId: string;
    projectId: string;
  };
  'workspace:git_changed': WorkspaceGitChangedPayload;
  'team-run:invalidated': TeamRunInvalidatedPayload;
  'access-auth:session-secret-rotated': { generation: number };
};

type EventName = keyof EventMap;
type Handler<K extends EventName> = (payload: EventMap[K]) => void;

/**
 * A small, type-safe in-process event bus.
 */
export class EventBus {
  private listeners = new Map<EventName, Set<(payload: unknown) => void>>();

  on<K extends EventName>(event: K, handler: Handler<K>): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(handler as (payload: unknown) => void);
    this.listeners.set(event, set);
  }

  off<K extends EventName>(event: K, handler: Handler<K>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(handler as (payload: unknown) => void);
    if (set.size === 0) {
      this.listeners.delete(event);
    }
  }

  emit<K extends EventName>(event: K, payload: EventMap[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const handler of set) {
      handler(payload);
    }
  }
}

export type { EventMap, EventName };
