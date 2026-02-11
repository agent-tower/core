import { EventBus } from './event-bus.js';
import { SessionManager } from '../services/session-manager.js';

let eventBus: EventBus | null = null;
let sessionManager: SessionManager | null = null;

export function getEventBus(): EventBus {
  if (!eventBus) {
    eventBus = new EventBus();
  }
  return eventBus;
}

export function getSessionManager(): SessionManager {
  if (!sessionManager) {
    sessionManager = new SessionManager(getEventBus());
  }
  return sessionManager;
}
