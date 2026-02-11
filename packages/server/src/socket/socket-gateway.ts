import type { Namespace, Socket } from 'socket.io';
import type { EventBus } from '../core/event-bus.js';
import type { SessionManager } from '../services/session-manager.js';
import {
  ClientEvents,
  ServerEvents,
  type AckResponse,
  type SubscribePayload,
  type UnsubscribePayload,
  type SessionInputPayload,
  type SessionResizePayload,
  type AgentStatusPayload,
} from './events.js';

export class SocketGateway {
  private cleanups: Array<() => void> = [];

  constructor(
    private readonly nsp: Namespace,
    private readonly eventBus: EventBus,
    private readonly sessionManager: SessionManager
  ) {
    this.registerEventBusForwarders();
  }

  destroy(): void {
    for (const cleanup of this.cleanups) {
      cleanup();
    }
    this.cleanups = [];
  }

  register(socket: Socket): void {
    socket.on(ClientEvents.SUBSCRIBE, (payload: SubscribePayload, ack?: (res: AckResponse) => void) => {
      this.handleSubscribe(socket, payload, ack);
    });

    socket.on(ClientEvents.UNSUBSCRIBE, (payload: UnsubscribePayload, ack?: (res: AckResponse) => void) => {
      this.handleUnsubscribe(socket, payload, ack);
    });

    socket.on(ClientEvents.INPUT, (payload: SessionInputPayload) => {
      if (!payload?.sessionId || typeof payload.data !== 'string') return;
      try {
        this.sessionManager.writeInput(payload.sessionId, payload.data);
      } catch (err) {
        console.error(`[SocketGateway] INPUT error for session ${payload.sessionId}:`, err);
      }
    });

    socket.on(ClientEvents.RESIZE, (payload: SessionResizePayload) => {
      if (!payload?.sessionId || typeof payload.cols !== 'number' || typeof payload.rows !== 'number') return;
      try {
        this.sessionManager.resize(payload.sessionId, payload.cols, payload.rows);
      } catch (err) {
        console.error(`[SocketGateway] RESIZE error for session ${payload.sessionId}:`, err);
      }
    });
  }

  private registerEventBusForwarders(): void {
    const onStdout = ({ sessionId, data }: { sessionId: string; data: string }) => {
      this.nsp.to(`session:${sessionId}`).emit(ServerEvents.SESSION_STDOUT, { sessionId, data });
    };
    const onPatch = ({ sessionId, patch }: { sessionId: string; patch: unknown[] }) => {
      this.nsp.to(`session:${sessionId}`).emit(ServerEvents.SESSION_PATCH, { sessionId, patch });
    };
    const onSessionId = ({ sessionId, agentSessionId }: { sessionId: string; agentSessionId: string }) => {
      this.nsp.to(`session:${sessionId}`).emit(ServerEvents.SESSION_ID, { sessionId, agentSessionId });
    };
    const onExit = ({ sessionId, exitCode }: { sessionId: string; exitCode?: number }) => {
      this.nsp.to(`session:${sessionId}`).emit(ServerEvents.SESSION_EXIT, {
        sessionId,
        exitCode: typeof exitCode === 'number' ? exitCode : 0,
      });
    };
    const onTask = ({ taskId, status }: { taskId: string; status: string }) => {
      this.nsp.to(`task:${taskId}`).emit(ServerEvents.TASK_UPDATED, { taskId, status });
    };

    this.eventBus.on('session:stdout', onStdout);
    this.eventBus.on('session:patch', onPatch);
    this.eventBus.on('session:sessionId', onSessionId);
    this.eventBus.on('session:exit', onExit);
    this.eventBus.on('task:updated', onTask);

    this.cleanups.push(
      () => this.eventBus.off('session:stdout', onStdout),
      () => this.eventBus.off('session:patch', onPatch),
      () => this.eventBus.off('session:sessionId', onSessionId),
      () => this.eventBus.off('session:exit', onExit),
      () => this.eventBus.off('task:updated', onTask),
    );
  }

  broadcastAgentStatus(payload: AgentStatusPayload): void {
    this.nsp.to(`agent:${payload.agentId}`).emit(ServerEvents.AGENT_STATUS_CHANGED, payload);
    this.nsp.to('agent:all').emit(ServerEvents.AGENT_STATUS_CHANGED, payload);
  }

  private handleSubscribe(socket: Socket, payload: SubscribePayload, ack?: (res: AckResponse) => void): void {
    const room = this.buildRoom(payload);
    socket.join(room);

    if (payload.topic === 'session' && payload.id) {
      socket.emit(ServerEvents.SESSION_SUBSCRIBED, { sessionId: payload.id });
    }
    ack?.({ success: true });
  }

  private handleUnsubscribe(socket: Socket, payload: UnsubscribePayload, ack?: (res: AckResponse) => void): void {
    const room = this.buildRoom(payload);
    socket.leave(room);

    if (payload.topic === 'session' && payload.id) {
      socket.emit(ServerEvents.SESSION_UNSUBSCRIBED, { sessionId: payload.id });
    }
    ack?.({ success: true });
  }

  private buildRoom(payload: SubscribePayload | UnsubscribePayload): string {
    if (payload.topic === 'session') {
      return payload.id ? `session:${payload.id}` : 'session:all';
    }
    if (payload.topic === 'task') {
      return payload.id ? `task:${payload.id}` : 'task:all';
    }
    return payload.id ? `agent:${payload.id}` : 'agent:all';
  }
}
