import { getTranslationService } from '../core/container.js';
import { AGENT_API_CREDENTIAL_HEADER } from '../utils/agent-api-credential.js';
import { INTERNAL_API_TOKEN_HEADER } from '../utils/internal-api-token.js';
import type { TranslationInvalidatedPayload } from '@agent-tower/shared';
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
  type SessionPermissionInvalidatedPayload,
  type SessionPermissionRequestedPayload,
  type SessionRuntimeStateChangedPayload,
  type TerminalInputPayload,
  type TerminalResizePayload,
  type TeamRunInvalidatedPayload,
  type WorkspaceGitChangedPayload,
  type WorkspaceSetupProgressPayload,
} from './events.js';

export class SocketGateway {
  private destroyed = false;
  private cleanups: Array<() => void> = [];
  private taskDeliverySubscriptions = new WeakMap<Socket, Map<string, symbol>>();
  private sessionSubscriptions = new WeakMap<Socket, Map<string, symbol>>();
  private roomTranslationSubscriptions = new WeakMap<Socket, Map<string, symbol>>();

  constructor(
    private readonly nsp: Namespace,
    private readonly eventBus: EventBus,
    private readonly sessionManager: SessionManager,
    private readonly terminalManager: TerminalManager
  ) {
    this.registerEventBusForwarders();
  }

  destroy(): void {
    this.destroyed = true;
    for (const cleanup of this.cleanups) {
      cleanup();
    }
    this.cleanups = [];
  }

  register(socket: AuthenticatedSocket): void {
    // --- Subscribe / Unsubscribe ---
    socket.on(ClientEvents.SUBSCRIBE, (payload: SubscribePayload, ack?: (res: AckResponse) => void) => {
      if (!this.ensureSocketAuthIsCurrent(socket, ack)) return;
      void this.handleSubscribe(socket, payload, ack);
    });

    socket.on(ClientEvents.UNSUBSCRIBE, (payload: UnsubscribePayload, ack?: (res: AckResponse) => void) => {
      if (!this.ensureSocketAuthIsCurrent(socket, ack)) return;
      void this.handleUnsubscribe(socket, payload, ack);
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
    socket.on('disconnect', async () => {
      try {
        await this.terminalManager.cleanupBySocket(socket.id);
      } catch (error) {
        console.error(`[SocketGateway] Terminal cleanup pending for socket ${socket.id}:`, error);
      }
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

    const onTranslation = (payload: TranslationInvalidatedPayload) => {
      void (async () => {
        if (payload.teamRunId !== undefined) {
          const { teamRunId, messageId, sourceId, sourceRevision, overlayRevision } = payload;
          if (!teamRunId || teamRunId === 'all' || payload.sessionId !== undefined) return;
          const room = `team-run:${teamRunId}`;
          for (const socketId of this.nsp.adapter.rooms.get(room) ?? []) {
            const socket = this.nsp.sockets.get(socketId) as AuthenticatedSocket | undefined;
            if (!socket) continue;
            const subscription = this.roomTranslationSubscriptions.get(socket)?.get(teamRunId);
            if (!subscription) continue;
            const isCurrentOwner = await this.prepareRoomOwnerSocketValidation(socket);
            if (!isCurrentOwner()) continue;
            try { await getTranslationService().assertReadableRoomTranslation(teamRunId, messageId, sourceId); } catch { continue; }
            // Recheck synchronously after every await, including auth loading.
            if (!isCurrentOwner() || this.roomTranslationSubscriptions.get(socket)?.get(teamRunId) !== subscription || !this.nsp.adapter.rooms.get(room)?.has(socketId)) continue;
            socket.emit(ServerEvents.TRANSLATION_INVALIDATED, { teamRunId, messageId, sourceId, sourceRevision, overlayRevision });
          }
          return;
        }
        try { await getTranslationService().assertReadableSession(payload.sessionId); } catch { return; }
        if (this.destroyed) return;
        for (const socketId of this.nsp.adapter.rooms.get(`session:${payload.sessionId}`) ?? []) {
          const socket = this.nsp.sockets.get(socketId) as AuthenticatedSocket | undefined;
          if (!socket || !this.isCurrentOwnerSocket(socket)) continue;
          socket.emit(ServerEvents.TRANSLATION_INVALIDATED, payload);
        }
      })().catch(() => undefined);
    };
    this.eventBus.on('translation:invalidated', onTranslation);
    this.cleanups.push(() => this.eventBus.off('translation:invalidated', onTranslation));

    const onDelivery = (payload: import('@agent-tower/shared').MessageDeliveryInvalidatedPayload) => {
      void (async () => {
        if (payload.taskId !== undefined) {
          const { taskId, teamRunId, operationId, deliveryRevision } = payload;
          if (teamRunId === 'all' || payload.sessionId !== undefined || taskId === 'all') return;
          if (!teamRunId) {
            try { await getTranslationService().assertReadableTeamTask(taskId); } catch { return; }
            for (const socketId of this.nsp.adapter.rooms.get(`task:${taskId}`) ?? []) {
              const socket = this.nsp.sockets.get(socketId) as AuthenticatedSocket | undefined;
              if (!socket) continue;
              const subscription = this.taskDeliverySubscriptions.get(socket)?.get(taskId);
              if (!subscription) continue;
              const isOwner = await this.prepareRoomOwnerSocketValidation(socket);
              if (isOwner() && this.taskDeliverySubscriptions.get(socket)?.get(taskId) === subscription && this.nsp.adapter.rooms.get(`task:${taskId}`)?.has(socketId)) socket.emit(ServerEvents.MESSAGE_DELIVERY_INVALIDATED, { taskId, operationId, deliveryRevision });
            }
            return;
          }
          const room = `team-run:${teamRunId}`;
          for (const socketId of this.nsp.adapter.rooms.get(room) ?? []) {
            const socket = this.nsp.sockets.get(socketId) as AuthenticatedSocket | undefined;
            if (!socket) continue;
            const subscription = this.roomTranslationSubscriptions.get(socket)?.get(teamRunId);
            if (!subscription) continue;
            const isOwner = await this.prepareRoomOwnerSocketValidation(socket);
            if (!isOwner()) continue;
            try { await getTranslationService().assertReadableTeamRun(teamRunId); } catch { continue; }
            if (!isOwner() || this.roomTranslationSubscriptions.get(socket)?.get(teamRunId) !== subscription || !this.nsp.adapter.rooms.get(room)?.has(socketId)) continue;
            socket.emit(ServerEvents.MESSAGE_DELIVERY_INVALIDATED, { taskId, teamRunId, operationId, deliveryRevision });
          }
          return;
        }
        try { await getTranslationService().assertReadableSession(payload.sessionId); } catch { return; }
        if (this.destroyed) return;
        for (const socketId of this.nsp.adapter.rooms.get(`session:${payload.sessionId}`) ?? []) {
          const socket = this.nsp.sockets.get(socketId) as AuthenticatedSocket | undefined;
          if (socket && this.isCurrentOwnerSocket(socket)) socket.emit(ServerEvents.MESSAGE_DELIVERY_INVALIDATED, payload);
        }
      })().catch(() => undefined);
    };
    this.eventBus.on('message-delivery:invalidated', onDelivery);
    this.cleanups.push(() => this.eventBus.off('message-delivery:invalidated', onDelivery));

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
    const onPermissionRequested = (payload: SessionPermissionRequestedPayload) => {
      emitToCurrentSockets(ServerEvents.SESSION_PERMISSION_REQUESTED, payload);
    };
    const onPermissionInvalidated = (payload: SessionPermissionInvalidatedPayload) => {
      emitToCurrentSockets(ServerEvents.SESSION_PERMISSION_INVALIDATED, payload);
    };
    const onRuntimeStateChanged = (payload: SessionRuntimeStateChangedPayload) => {
      emitToCurrentSockets(ServerEvents.SESSION_RUNTIME_STATE_CHANGED, payload);
    };
    const onTask = ({ taskId, projectId, status, priority }: { taskId: string; projectId: string; status: string; priority?: number }) => {
      emitToCurrentSockets(ServerEvents.TASK_UPDATED, { taskId, projectId, status, ...(priority === undefined ? {} : { priority }) });
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
    const onWorkspaceSetupProgress = (payload: WorkspaceSetupProgressPayload) => {
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
    this.eventBus.on('session:permission_requested', onPermissionRequested);
    this.eventBus.on('session:permission_invalidated', onPermissionInvalidated);
    this.eventBus.on('session:runtime_state_changed', onRuntimeStateChanged);
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
      () => this.eventBus.off('session:permission_requested', onPermissionRequested),
      () => this.eventBus.off('session:permission_invalidated', onPermissionInvalidated),
      () => this.eventBus.off('session:runtime_state_changed', onRuntimeStateChanged),
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

  private isCurrentOwnerSocket(socket: AuthenticatedSocket): boolean {
    const headers = socket.request.headers;
    return this.isSocketAuthCurrent(socket) && headers[AGENT_API_CREDENTIAL_HEADER] === undefined && headers[INTERNAL_API_TOKEN_HEADER] === undefined;
  }

  private async prepareRoomOwnerSocketValidation(socket: AuthenticatedSocket): Promise<() => boolean> {
    if (this.destroyed || socket.disconnected || !this.isCurrentOwnerSocket(socket)) return () => false;
    const token = AccessAuthService.extractCookieFromHeader(socket.request.headers.cookie);
    const validate = await AccessAuthService.prepareSessionTokenValidation(token);
    return () => !this.destroyed && !socket.disconnected && this.isCurrentOwnerSocket(socket) && validate();
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

  private async handleSubscribe(socket: AuthenticatedSocket, payload: SubscribePayload, ack?: (res: AckResponse) => void): Promise<void> {
    if (payload?.topic === 'team-run') {
      const id = payload.id;
      const denied = () => ack?.({ success: false, error: { code: 'TRANSLATION_SUBSCRIPTION_DENIED', message: 'Room translation subscription is unavailable' } });
      if (typeof id !== 'string' || !id.trim() || id === 'all' || !this.isCurrentOwnerSocket(socket)) { denied(); return; }
      let pending = this.roomTranslationSubscriptions.get(socket);
      if (!pending) { pending = new Map(); this.roomTranslationSubscriptions.set(socket, pending); }
      const request = Symbol(); pending.set(id, request);
      try {
        if (!(await this.prepareRoomOwnerSocketValidation(socket))()) {
          if (pending.get(id) === request) { pending.delete(id); await socket.leave(`team-run:${id}`); }
          denied(); return;
        }
        await getTranslationService().assertReadableTeamRun(id);
        if (this.destroyed || socket.disconnected || !this.isCurrentOwnerSocket(socket) || pending.get(id) !== request) {
          if (pending.get(id) === request) { pending.delete(id); await socket.leave(`team-run:${id}`); }
          denied(); return;
        }
        await socket.join(`team-run:${id}`);
        const isCurrentAfterJoin = await this.prepareRoomOwnerSocketValidation(socket);
        if (!isCurrentAfterJoin() || pending.get(id) !== request) {
          if (pending.get(id) === request) pending.delete(id);
          if (!pending.has(id) || !isCurrentAfterJoin()) await socket.leave(`team-run:${id}`);
          denied(); return;
        }
        await getTranslationService().assertReadableTeamRun(id);
        // Nothing may await between this current-login/intent check and success.
        if (!isCurrentAfterJoin() || pending.get(id) !== request) {
          if (pending.get(id) === request) pending.delete(id);
          if (!pending.has(id) || !isCurrentAfterJoin()) await socket.leave(`team-run:${id}`);
          denied(); return;
        }
        ack?.({ success: true });
      } catch {
        if (pending.get(id) === request) { pending.delete(id); await socket.leave(`team-run:${id}`); }
        denied();
      }
      return;
    }
    if (payload?.topic === 'session') {
      const id = payload.id;
      const denied = () => ack?.({ success: false, error: { code: 'SESSION_SUBSCRIPTION_DENIED', message: 'Session subscription is unavailable' } });
      if (typeof id !== 'string' || !id.trim() || id === 'all' || !this.isCurrentOwnerSocket(socket)) { denied(); return; }
      let pending = this.sessionSubscriptions.get(socket);
      if (!pending) { pending = new Map(); this.sessionSubscriptions.set(socket, pending); }
      const request = Symbol(); pending.set(id, request);
      try {
        await getTranslationService().assertReadableSession(id);
        if (this.destroyed || socket.disconnected || !this.isCurrentOwnerSocket(socket) || pending.get(id) !== request) { denied(); return; }
        await socket.join(`session:${id}`);
        if (this.destroyed || socket.disconnected || !this.isCurrentOwnerSocket(socket) || pending.get(id) !== request) {
          // A newer subscribe may already own this room. Only revoke it when
          // there is no remaining subscription intent, or the socket is invalid.
          if (!pending.has(id) || this.destroyed || socket.disconnected || !this.isCurrentOwnerSocket(socket)) await socket.leave(`session:${id}`);
          denied(); return;
        }
        socket.emit(ServerEvents.SESSION_SUBSCRIBED, { sessionId: id });
        ack?.({ success: true });
      } catch {
        if (pending.get(id) === request) { pending.delete(id); await socket.leave(`session:${id}`); }
        denied();
      }
      return;
    }
    if (payload?.topic === 'task') {
      const id = payload.id;
      const denied = () => ack?.({ success: false, error: { code: 'TASK_SUBSCRIPTION_DENIED', message: 'Task delivery subscription is unavailable' } });
      if (typeof id !== 'string' || !id.trim() || id === 'all' || !this.isCurrentOwnerSocket(socket)) { denied(); return; }
      let pending = this.taskDeliverySubscriptions.get(socket);
      if (!pending) { pending = new Map(); this.taskDeliverySubscriptions.set(socket, pending); }
      const request = Symbol(); pending.set(id, request);
      try {
        const currentOwner = await this.prepareRoomOwnerSocketValidation(socket);
        if (!currentOwner()) { denied(); return; }
        await getTranslationService().assertReadableTeamTask(id);
        if (!currentOwner() || pending.get(id) !== request) { denied(); return; }
        await socket.join(`task:${id}`);
        const afterJoin = await this.prepareRoomOwnerSocketValidation(socket);
        if (!afterJoin() || pending.get(id) !== request) {
          if (!pending.has(id) || !afterJoin()) await socket.leave(`task:${id}`);
          denied(); return;
        }
        ack?.({ success: true });
      } catch {
        if (pending.get(id) === request) { pending.delete(id); await socket.leave(`task:${id}`); }
        denied();
      }
      return;
    }
    if (payload?.topic === 'terminal' && payload.id) {
      socket.join(`terminal:${payload.id}`);
      socket.emit(ServerEvents.TERMINAL_SUBSCRIBED, { terminalId: payload.id });
    }
    ack?.({ success: true });
  }

  private async handleUnsubscribe(socket: Socket, payload: UnsubscribePayload, ack?: (res: AckResponse) => void): Promise<void> {
    if (payload?.topic === 'team-run' && typeof payload.id === 'string' && payload.id !== 'all') {
      this.roomTranslationSubscriptions.get(socket)?.delete(payload.id);
      try { await socket.leave(`team-run:${payload.id}`); }
      catch { ack?.({ success: false, error: { code: 'TRANSLATION_SUBSCRIPTION_DENIED', message: 'Room translation subscription is unavailable' } }); return; }
    }
    if (payload?.topic === 'task' && typeof payload.id === 'string' && payload.id !== 'all') {
      this.taskDeliverySubscriptions.get(socket)?.delete(payload.id);
      await socket.leave(`task:${payload.id}`);
    }
    if (payload?.topic === 'session' && typeof payload.id === 'string' && payload.id !== 'all') {
      this.sessionSubscriptions.get(socket)?.delete(payload.id);
      try { await socket.leave(`session:${payload.id}`); }
      catch { ack?.({ success: false, error: { code: 'SESSION_SUBSCRIPTION_DENIED', message: 'Session subscription is unavailable' } }); return; }
      socket.emit(ServerEvents.SESSION_UNSUBSCRIBED, { sessionId: payload.id });
    }
    if (payload?.topic === 'terminal' && payload.id) {
      socket.leave(`terminal:${payload.id}`);
      socket.emit(ServerEvents.TERMINAL_UNSUBSCRIBED, { terminalId: payload.id });
    }
    ack?.({ success: true });
  }
}
