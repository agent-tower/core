import type { Namespace, Socket } from 'socket.io';
import type { EventBus } from '../core/event-bus.js';
import type { SessionManager } from '../services/session-manager.js';
import type { TerminalManager } from '../services/terminal-manager.js';
import {
  ClientEvents,
  ServerEvents,
  type AckResponse,
  type SubscribePayload,
  type UnsubscribePayload,
  type SessionInputPayload,
  type SessionResizePayload,
  type TerminalInputPayload,
  type TerminalResizePayload,
  type AgentStatusPayload,
} from './events.js';

export class SocketGateway {
  private cleanups: Array<() => void> = [];

  constructor(
    private readonly nsp: Namespace,
    private readonly eventBus: EventBus,
    private readonly sessionManager: SessionManager,
    private readonly terminalManager: TerminalManager
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
    // --- Subscribe / Unsubscribe ---
    socket.on(ClientEvents.SUBSCRIBE, (payload: SubscribePayload, ack?: (res: AckResponse) => void) => {
      this.handleSubscribe(socket, payload, ack);
    });

    socket.on(ClientEvents.UNSUBSCRIBE, (payload: UnsubscribePayload, ack?: (res: AckResponse) => void) => {
      this.handleUnsubscribe(socket, payload, ack);
    });

    // --- Agent session I/O ---
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

    // --- Standalone terminal I/O ---
    socket.on(ClientEvents.TERMINAL_INPUT, (payload: TerminalInputPayload) => {
      if (!payload?.terminalId || typeof payload.data !== 'string') return;
      try {
        this.terminalManager.write(payload.terminalId, payload.data);
      } catch (err) {
        console.error(`[SocketGateway] TERMINAL_INPUT error for terminal ${payload.terminalId}:`, err);
      }
    });

    socket.on(ClientEvents.TERMINAL_RESIZE, (payload: TerminalResizePayload) => {
      if (!payload?.terminalId || typeof payload.cols !== 'number' || typeof payload.rows !== 'number') return;
      try {
        this.terminalManager.resize(payload.terminalId, payload.cols, payload.rows);
      } catch (err) {
        console.error(`[SocketGateway] TERMINAL_RESIZE error for terminal ${payload.terminalId}:`, err);
      }
    });

    // --- Socket disconnect: clean up owned terminals ---
    socket.on('disconnect', () => {
      this.terminalManager.cleanupBySocket(socket.id);
    });
  }

  private registerEventBusForwarders(): void {
    // --- Session events (unchanged) ---
    const onStdout = ({ sessionId, data }: { sessionId: string; data: string }) => {
      this.nsp.to(`session:${sessionId}`).emit(ServerEvents.SESSION_STDOUT, { sessionId, data });
    };
    const onPatch = ({ sessionId, patch, seq }: { sessionId: string; patch: unknown[]; seq: number }) => {
      this.nsp.to(`session:${sessionId}`).emit(ServerEvents.SESSION_PATCH, { sessionId, patch, seq });
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
    const onSessionCompleted = ({ sessionId, status }: { sessionId: string; status: string }) => {
      this.nsp.to(`session:${sessionId}`).emit(ServerEvents.SESSION_COMPLETED, {
        sessionId,
        status,
      });
    };
    const onTask = ({ taskId, projectId, status }: { taskId: string; projectId: string; status: string }) => {
      const payload = { taskId, projectId, status };
      this.nsp.to(`task:${taskId}`).emit(ServerEvents.TASK_UPDATED, payload);
      // 同时广播到 project room，让看板实时更新
      this.nsp.to(`project:${projectId}`).emit(ServerEvents.TASK_UPDATED, payload);
    };
    const onTaskDeleted = ({ taskId, projectId }: { taskId: string; projectId: string }) => {
      const payload = { taskId, projectId };
      this.nsp.to(`task:${taskId}`).emit(ServerEvents.TASK_DELETED, payload);
      this.nsp.to(`project:${projectId}`).emit(ServerEvents.TASK_DELETED, payload);
    };
    const onWorkspaceCommitMessageUpdated = (payload: {
      workspaceId: string;
      taskId: string;
      commitMessage: string | null;
    }) => {
      this.nsp.to(`task:${payload.taskId}`).emit(ServerEvents.WORKSPACE_COMMIT_MESSAGE_UPDATED, payload);
    };

    // --- Terminal events (new) ---
    const onTerminalStdout = ({ terminalId, data }: { terminalId: string; data: string }) => {
      this.nsp.to(`terminal:${terminalId}`).emit(ServerEvents.TERMINAL_STDOUT, { terminalId, data });
    };
    const onTerminalExit = ({ terminalId, exitCode }: { terminalId: string; exitCode?: number }) => {
      this.nsp.to(`terminal:${terminalId}`).emit(ServerEvents.TERMINAL_EXIT, {
        terminalId,
        exitCode: typeof exitCode === 'number' ? exitCode : 0,
      });
    };

    // --- Workspace setup progress (broadcast to task room) ---
    const onWorkspaceSetupProgress = (payload: {
      workspaceId: string;
      taskId: string;
      status: string;
      currentCommand?: string;
      currentIndex?: number;
      totalCommands: number;
      error?: string;
    }) => {
      this.nsp.to(`task:${payload.taskId}`).emit(ServerEvents.WORKSPACE_SETUP_PROGRESS, payload);
    };

    const onWorkspaceHibernated = (payload: {
      workspaceId: string;
      taskId: string;
      projectId: string;
    }) => {
      this.nsp.to(`task:${payload.taskId}`).emit(ServerEvents.WORKSPACE_HIBERNATED, payload);
      this.nsp.to(`project:${payload.projectId}`).emit(ServerEvents.WORKSPACE_HIBERNATED, payload);
    };

    this.eventBus.on('session:stdout', onStdout);
    this.eventBus.on('session:patch', onPatch);
    this.eventBus.on('session:sessionId', onSessionId);
    this.eventBus.on('session:exit', onExit);
    this.eventBus.on('session:completed', onSessionCompleted);
    this.eventBus.on('task:updated', onTask);
    this.eventBus.on('task:deleted', onTaskDeleted);
    this.eventBus.on('workspace:commit_message_updated', onWorkspaceCommitMessageUpdated);
    this.eventBus.on('terminal:stdout', onTerminalStdout);
    this.eventBus.on('terminal:exit', onTerminalExit);
    this.eventBus.on('workspace:setup_progress', onWorkspaceSetupProgress);
    this.eventBus.on('workspace:hibernated', onWorkspaceHibernated);

    this.cleanups.push(
      () => this.eventBus.off('session:stdout', onStdout),
      () => this.eventBus.off('session:patch', onPatch),
      () => this.eventBus.off('session:sessionId', onSessionId),
      () => this.eventBus.off('session:exit', onExit),
      () => this.eventBus.off('session:completed', onSessionCompleted),
      () => this.eventBus.off('task:updated', onTask),
      () => this.eventBus.off('task:deleted', onTaskDeleted),
      () => this.eventBus.off('workspace:commit_message_updated', onWorkspaceCommitMessageUpdated),
      () => this.eventBus.off('terminal:stdout', onTerminalStdout),
      () => this.eventBus.off('terminal:exit', onTerminalExit),
      () => this.eventBus.off('workspace:setup_progress', onWorkspaceSetupProgress),
      () => this.eventBus.off('workspace:hibernated', onWorkspaceHibernated),
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
    if (payload.topic === 'terminal' && payload.id) {
      socket.emit(ServerEvents.TERMINAL_SUBSCRIBED, { terminalId: payload.id });
    }
    ack?.({ success: true });
  }

  private handleUnsubscribe(socket: Socket, payload: UnsubscribePayload, ack?: (res: AckResponse) => void): void {
    const room = this.buildRoom(payload);
    socket.leave(room);

    if (payload.topic === 'session' && payload.id) {
      socket.emit(ServerEvents.SESSION_UNSUBSCRIBED, { sessionId: payload.id });
    }
    if (payload.topic === 'terminal' && payload.id) {
      socket.emit(ServerEvents.TERMINAL_UNSUBSCRIBED, { terminalId: payload.id });
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
    if (payload.topic === 'terminal') {
      return payload.id ? `terminal:${payload.id}` : 'terminal:all';
    }
    if (payload.topic === 'project') {
      return payload.id ? `project:${payload.id}` : 'project:all';
    }
    return payload.id ? `agent:${payload.id}` : 'agent:all';
  }
}
