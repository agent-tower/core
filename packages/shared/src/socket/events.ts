/**
 * Unified Socket.IO event types.
 */

export const NAMESPACE = '/events' as const;

export const ClientEvents = {
  SUBSCRIBE: 'subscribe',
  UNSUBSCRIBE: 'unsubscribe',
  INPUT: 'input',
  RESIZE: 'resize',
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
  AGENT_STATUS_CHANGED: 'agent:status_changed',
} as const;

export interface SubscribePayload {
  topic: 'session' | 'task' | 'agent';
  id?: string;
}

export interface UnsubscribePayload {
  topic: 'session' | 'task' | 'agent';
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
  status: string;
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
