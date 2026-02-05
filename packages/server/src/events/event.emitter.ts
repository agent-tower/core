import { EventEmitter } from 'events';

export interface AppEvent {
  type: string;
  payload: unknown;
  timestamp: Date;
}

class GlobalEventEmitter extends EventEmitter {
  emit(event: string, payload?: unknown): boolean {
    const appEvent: AppEvent = {
      type: event,
      payload,
      timestamp: new Date(),
    };
    return super.emit(event, appEvent);
  }
}

export const eventEmitter = new GlobalEventEmitter();

// 事件类型常量
export const EventTypes = {
  TASK_STATUS_CHANGED: 'task:status_changed',
  SESSION_STARTED: 'session:started',
  SESSION_COMPLETED: 'session:completed',
  SESSION_FAILED: 'session:failed',
  WORKSPACE_CREATED: 'workspace:created',
  WORKSPACE_MERGED: 'workspace:merged',
} as const;
