type EventMap = {
  'session:stdout': { sessionId: string; data: string };
  'session:patch': { sessionId: string; patch: unknown[] };
  'session:exit': { sessionId: string; exitCode?: number };
  'session:completed': { sessionId: string; status: string };
  'session:started': { sessionId: string };
  'session:stopped': { sessionId: string };
  'session:sessionId': { sessionId: string; agentSessionId: string };
  'task:updated': { taskId: string; projectId: string; status: string };
  'task:deleted': { taskId: string; projectId: string };
  // Standalone terminal events
  'terminal:stdout': { terminalId: string; data: string };
  'terminal:exit': { terminalId: string; exitCode?: number };
  // Workspace setup progress
  'workspace:setup_progress': {
    workspaceId: string;
    taskId: string;
    status: 'running' | 'completed' | 'failed';
    currentCommand?: string;
    currentIndex?: number;
    totalCommands: number;
    error?: string;
  };
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
