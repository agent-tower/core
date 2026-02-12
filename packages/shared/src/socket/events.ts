/**
 * Unified Socket.IO event types.
 */

export const NAMESPACE = '/events' as const;

export const ClientEvents = {
  SUBSCRIBE: 'subscribe',
  UNSUBSCRIBE: 'unsubscribe',
  INPUT: 'input',
  RESIZE: 'resize',
  // Standalone terminal events (client -> server)
  TERMINAL_INPUT: 'terminal:input',
  TERMINAL_RESIZE: 'terminal:resize',
} as const;

export const ServerEvents = {
  SESSION_SUBSCRIBED: 'session:subscribed',
  SESSION_UNSUBSCRIBED: 'session:unsubscribed',
  SESSION_STDOUT: 'session:stdout',
  SESSION_PATCH: 'session:patch',
  SESSION_EXIT: 'session:exit',
  SESSION_ID: 'session:sessionId',
  SESSION_ERROR: 'session:error',
  TASK_UPDATED: 'task:updated',
  TASK_DELETED: 'task:deleted',
  AGENT_STATUS_CHANGED: 'agent:status_changed',
  // Standalone terminal events (server -> client)
  TERMINAL_STDOUT: 'terminal:stdout',
  TERMINAL_EXIT: 'terminal:exit',
  TERMINAL_SUBSCRIBED: 'terminal:subscribed',
  TERMINAL_UNSUBSCRIBED: 'terminal:unsubscribed',
} as const;

export interface SubscribePayload {
  topic: 'session' | 'task' | 'agent' | 'terminal' | 'project';
  id?: string;
}

export interface UnsubscribePayload {
  topic: 'session' | 'task' | 'agent' | 'terminal' | 'project';
  id?: string;
}

export interface SessionInputPayload {
  sessionId: string;
  data: string;
}

export interface SessionResizePayload {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface SessionStdoutPayload {
  sessionId: string;
  data: string;
}

export interface SessionPatchPayload {
  sessionId: string;
  patch: JsonPatchOperation[];
}

export interface SessionExitPayload {
  sessionId: string;
  exitCode: number;
}

export interface SessionIdPayload {
  sessionId: string;
  agentSessionId: string;
}

export interface SessionErrorPayload {
  sessionId: string;
  message: string;
}

export interface SessionSubscribedPayload {
  sessionId: string;
}

export interface SessionUnsubscribedPayload {
  sessionId: string;
}

export interface JsonPatchOperation {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  value?: unknown;
  from?: string;
}

export type AgentStatus = 'idle' | 'starting' | 'running' | 'stopped' | 'error';

export interface AgentStatusPayload {
  agentId: string;
  sessionId: string;
  status: AgentStatus;
  error?: string;
  timestamp: number;
}

export interface TaskUpdatedPayload {
  taskId: string;
  projectId: string;
  status: string;
}

export interface TaskDeletedPayload {
  taskId: string;
  projectId: string;
}

// Standalone terminal payloads
export interface TerminalInputPayload {
  terminalId: string;
  data: string;
}

export interface TerminalResizePayload {
  terminalId: string;
  cols: number;
  rows: number;
}

export interface TerminalStdoutPayload {
  terminalId: string;
  data: string;
}

export interface TerminalExitPayload {
  terminalId: string;
  exitCode: number;
}

export interface TerminalSubscribedPayload {
  terminalId: string;
}

export interface TerminalUnsubscribedPayload {
  terminalId: string;
}

export interface AckResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

export type ClientEventType = typeof ClientEvents[keyof typeof ClientEvents];
export type ServerEventType = typeof ServerEvents[keyof typeof ServerEvents];
