import type { Namespace, Socket } from 'socket.io';
import type { EventBus } from '../core/event-bus.js';
import type { SessionManager } from '../services/session-manager.js';
import type { TerminalManager } from '../services/terminal-manager.js';
import { AccessAuthService } from '../services/access-auth.service.js';
import type { AuthenticatedSocket } from './middleware/index.js';
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
  type TeamRunInvalidatedPayload,
  type WorkspaceGitChangedPayload,
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

  register(socket: AuthenticatedSocket): void {
    // --- Subscribe / Unsubscribe ---
    socket.on(ClientEvents.SUBSCRIBE, (payload: SubscribePayload, ack?: (res: AckResponse) => void) => {
      if (!this.ensureSocketAuthIsCurrent(socket, ack)) return;
      this.handleSubscribe(socket, payload, ack);
    });

    socket.on(ClientEvents.UNSUBSCRIBE, (payload: UnsubscribePayload, ack?: (res: AckResponse) => void) => {
      if (!this.ensureSocketAuthIsCurrent(socket, ack)) return;
      this.handleUnsubscribe(socket, payload, ack);
    });

    // --- Agent session I/O ---
    socket.on(ClientEvents.INPUT, (payload: SessionInputPayload) => {
      if (!this.ensureSocketAuthIsCurrent(socket)) return;
      if (!payload?.sessionId || typeof payload.data !== 'string') return;
      try {
        this.sessionManager.writeInput(payload.sessionId, payload.data);
      } catch (err) {
        console.error(`[SocketGateway] INPUT error for session ${payload.sessionId}:`, err);
      }
    });

    socket.on(ClientEvents.RESIZE, (payload: SessionResizePayload) => {
      if (!this.ensureSocketAuthIsCurrent(socket)) return;
      if (!payload?.sessionId || typeof payload.cols !== 'number' || typeof payload.rows !== 'number') return;
      try {
        this.sessionManager.resize(payload.sessionId, payload.cols, payload.rows);
      } catch (err) {
        console.error(`[SocketGateway] RESIZE error for session ${payload.sessionId}:`, err);
      }
    });

    // --- Standalone terminal I/O ---
    socket.on(ClientEvents.TERMINAL_INPUT, (payload: TerminalInputPayload) => {
      if (!this.ensureSocketAuthIsCurrent(socket)) return;
      if (!payload?.terminalId || typeof payload.data !== 'string') return;
      try {
        this.terminalManager.write(payload.terminalId, payload.data);
      } catch (err) {
        console.error(`[SocketGateway] TERMINAL_INPUT error for terminal ${payload.terminalId}:`, err);
      }
    });

    socket.on(ClientEvents.TERMINAL_RESIZE, (payload: TerminalResizePayload) => {
      if (!this.ensureSocketAuthIsCurrent(socket)) return;
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
    const emitToCurrentSockets = (event: string, payload: unknown) => {
      for (const socket of this.nsp.sockets.values()) {
        if (this.isSocketAuthCurrent(socket as AuthenticatedSocket)) {
          socket.emit(event, payload);
        } else {
          socket.disconnect(true);
        }
      }
    };

    const emitToCurrentTerminalRoom = (terminalId: string, event: string, payload: unknown) => {
      for (const socketId of this.nsp.adapter.rooms.get(`terminal:${terminalId}`) ?? []) {
        const socket = this.nsp.sockets.get(socketId);
        if (!socket) continue;
        if (this.isSocketAuthCurrent(socket as AuthenticatedSocket)) {
          socket.emit(event, payload);
        } else {
          socket.disconnect(true);
        }
      }
    };

    // --- Session events: broadcast to entire namespace (no room filtering) ---
    const onStdout = ({ sessionId, data }: { sessionId: string; data: string }) => {
      emitToCurrentSockets(ServerEvents.SESSION_STDOUT, { sessionId, data });
    };
    const onPatch = ({ sessionId, patch, seq }: { sessionId: string; patch: unknown[]; seq: number }) => {
      emitToCurrentSockets(ServerEvents.SESSION_PATCH, { sessionId, patch, seq });
    };
    const onSessionId = ({ sessionId, agentSessionId }: { sessionId: string; agentSessionId: string }) => {
      emitToCurrentSockets(ServerEvents.SESSION_ID, { sessionId, agentSessionId });
    };
    const onExit = ({ sessionId, exitCode }: { sessionId: string; exitCode?: number }) => {
      emitToCurrentSockets(ServerEvents.SESSION_EXIT, {
        sessionId,
        exitCode: typeof exitCode === 'number' ? exitCode : 0,
      });
    };
    const onSessionCompleted = ({ sessionId, status }: { sessionId: string; status: string }) => {
      emitToCurrentSockets(ServerEvents.SESSION_COMPLETED, { sessionId, status });
    };
    const onTask = ({ taskId, projectId, status }: { taskId: string; projectId: string; status: string }) => {
      emitToCurrentSockets(ServerEvents.TASK_UPDATED, { taskId, projectId, status });
    };
    const onTaskDeleted = ({ taskId, projectId }: { taskId: string; projectId: string }) => {
      emitToCurrentSockets(ServerEvents.TASK_DELETED, { taskId, projectId });
    };
    const onWorkspaceCommitMessageUpdated = (payload: {
      workspaceId: string;
      taskId: string;
      commitMessage: string | null;
    }) => {
      emitToCurrentSockets(ServerEvents.WORKSPACE_COMMIT_MESSAGE_UPDATED, payload);
    };

    // --- Terminal events: keep room-based dispatch (lifecycle tied to socket) ---
    const onTerminalStdout = ({ terminalId, data }: { terminalId: string; data: string }) => {
      emitToCurrentTerminalRoom(terminalId, ServerEvents.TERMINAL_STDOUT, { terminalId, data });
    };
    const onTerminalExit = ({ terminalId, exitCode }: { terminalId: string; exitCode?: number }) => {
      emitToCurrentTerminalRoom(terminalId, ServerEvents.TERMINAL_EXIT, {
        terminalId,
        exitCode: typeof exitCode === 'number' ? exitCode : 0,
      });
    };

    // --- Workspace events: broadcast to entire namespace ---
    const onWorkspaceSetupProgress = (payload: {
      workspaceId: string;
      taskId: string;
      status: string;
      currentCommand?: string;
      currentIndex?: number;
      totalCommands: number;
      error?: string;
    }) => {
      emitToCurrentSockets(ServerEvents.WORKSPACE_SETUP_PROGRESS, payload);
    };

    const onWorkspaceHibernated = (payload: {
      workspaceId: string;
      taskId: string;
      projectId: string;
    }) => {
      emitToCurrentSockets(ServerEvents.WORKSPACE_HIBERNATED, payload);
    };

    const onWorkspaceGitChanged = (payload: WorkspaceGitChangedPayload) => {
      emitToCurrentSockets(ServerEvents.WORKSPACE_GIT_CHANGED, payload);
    };

    const onTeamRunInvalidated = (payload: TeamRunInvalidatedPayload) => {
      emitToCurrentSockets(ServerEvents.TEAM_RUN_INVALIDATED, payload);
    };

    const onAccessAuthSessionSecretRotated = () => {
      this.disconnectStaleSockets();
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
    this.eventBus.on('workspace:git_changed', onWorkspaceGitChanged);
    this.eventBus.on('team-run:invalidated', onTeamRunInvalidated);
    this.eventBus.on('access-auth:session-secret-rotated', onAccessAuthSessionSecretRotated);

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
      () => this.eventBus.off('workspace:git_changed', onWorkspaceGitChanged),
      () => this.eventBus.off('team-run:invalidated', onTeamRunInvalidated),
      () => this.eventBus.off('access-auth:session-secret-rotated', onAccessAuthSessionSecretRotated),
    );
  }

  private isSocketAuthCurrent(socket: AuthenticatedSocket): boolean {
    return socket.accessAuthSessionSecretGeneration === AccessAuthService.getSessionSecretGeneration();
  }

  private ensureSocketAuthIsCurrent(
    socket: AuthenticatedSocket,
    ack?: (res: AckResponse) => void,
  ): boolean {
    if (this.isSocketAuthCurrent(socket)) return true;

    ack?.({
      success: false,
      error: {
        code: 'ACCESS_AUTH_STALE_SESSION',
        message: 'Socket authentication is no longer current',
      },
    });
    socket.disconnect(true);
    return false;
  }

  private disconnectStaleSockets(): void {
    for (const socket of this.nsp.sockets.values()) {
      if (!this.isSocketAuthCurrent(socket as AuthenticatedSocket)) {
        socket.disconnect(true);
      }
    }
  }

  private handleSubscribe(socket: Socket, payload: SubscribePayload, ack?: (res: AckResponse) => void): void {
    if (payload.topic === 'terminal' && payload.id) {
      socket.join(`terminal:${payload.id}`);
      socket.emit(ServerEvents.TERMINAL_SUBSCRIBED, { terminalId: payload.id });
    }
    ack?.({ success: true });
  }

  private handleUnsubscribe(socket: Socket, payload: UnsubscribePayload, ack?: (res: AckResponse) => void): void {
    if (payload.topic === 'terminal' && payload.id) {
      socket.leave(`terminal:${payload.id}`);
      socket.emit(ServerEvents.TERMINAL_UNSUBSCRIBED, { terminalId: payload.id });
    }
    ack?.({ success: true });
  }
}
