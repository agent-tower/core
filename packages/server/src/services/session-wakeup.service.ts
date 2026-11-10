/**
 * Session wake-ups: an agent may ask to be re-invoked later (timer) or when a
 * workspace service it started exits. The wake-up is delivered as a session
 * message of origin SYSTEM_EVENT, so it goes through the same durable delivery
 * queue as user messages and starts a normal follow-up turn. Wake-ups survive
 * the end of the agent's turn and server restarts; they are never delivered
 * into a running turn, into a session the user stopped, or past the per-day cap.
 *
 * A pending wake-up is unfinished work the agent committed to: while one exists
 * the task stays IN_PROGRESS (SessionManager.checkTaskAutoAdvance reads
 * ACTIVE_WAKEUP_STATES). Conversely, once a person moves the task out of
 * IN_PROGRESS its wake-ups are cancelled instead of reopening the task.
 */
import type { SessionWakeupDto, SessionWakeupKind, SessionWakeupState } from '@agent-tower/shared';
import type { EventBus } from '../core/event-bus.js';
import { ServiceError } from '../errors.js';
import { TaskStatus } from '../types/index.js';
import { prisma } from '../utils/index.js';
import { writeErrorLog } from '../utils/error-log.js';
import type { WorkspaceServiceExitEvent } from './workspace-background-service.service.js';

export const MIN_WAKEUP_DELAY_SECONDS = 30;
export const MAX_WAKEUP_DELAY_SECONDS = 24 * 60 * 60;
export const MAX_PENDING_WAKEUPS_PER_SESSION = 8;
export const DEFAULT_MAX_WAKEUPS_PER_SESSION_PER_DAY = 24;
export const MAX_WAKEUPS_PER_DAY_ENV = 'AGENT_TOWER_MAX_WAKEUPS_PER_DAY';
/** States in which a wake-up still owes the session a future turn. */
export const ACTIVE_WAKEUP_STATES: SessionWakeupState[] = ['PENDING', 'READY'];
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const READY_BATCH = 50;
const LOG_TAIL_LINES = 40;
/**
 * A service exit is normally pushed by WorkspaceBackgroundService right after it
 * is persisted. A wait whose service has been inactive for longer than this
 * missed that push (server restart, a stop racing the exit handler, or an exit
 * landing between the service lookup and the wait being stored) and is
 * released from the persisted service state instead.
 */
const MISSED_EXIT_GRACE_MS = 15_000;
const INACTIVE_SERVICE_STATES = ['EXITED', 'FAILED', 'STOPPED'];

export interface SessionWakeupDeliveryPort {
  submitSession(input: { sessionId: string; message: string; systemEvent: true; clientSubmissionId: string }): Promise<{ operationId: string }>;
}

export interface SessionWakeupSessionGate {
  hasActiveTurn(sessionId: string): boolean;
}

export interface SessionWakeupServicePort {
  findService(workspaceId: string, name: string): Promise<{
    id: string;
    workspaceId: string;
    name: string;
    runtimeState: string;
    runtimeInstanceId: string | null;
    exitCode: number | null;
  } | null>;
  readLogTail(workspaceId: string, name: string, lines: number): Promise<string[]>;
}

export interface SessionWakeupServiceOptions {
  eventBus: EventBus;
  sessions: SessionWakeupSessionGate;
  delivery: SessionWakeupDeliveryPort;
  services: SessionWakeupServicePort;
  pollIntervalMs?: number;
  maxPerSessionPerDay?: number;
  now?: () => Date;
}

interface WakeupRow {
  id: string;
  sessionId: string;
  kind: string;
  reason: string;
  serviceId: string | null;
  serviceName: string | null;
  fireAt: Date | null;
  state: string;
  payload: string;
  deliveryId: string | null;
  lastError: string | null;
  createdAt: Date;
  firedAt: Date | null;
}

interface ServiceExitPayload {
  exitCode?: number | null;
  runtimeState?: string;
  stopped?: boolean;
  logTail?: string[];
  workspaceId?: string;
  /** The exit was recovered from the persisted service state, not observed when it happened. */
  missedExit?: boolean;
}

const ACTIVE_STATES = ACTIVE_WAKEUP_STATES;

export function resolveMaxWakeupsPerSessionPerDay(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[MAX_WAKEUPS_PER_DAY_ENV]?.trim();
  if (!raw) return DEFAULT_MAX_WAKEUPS_PER_SESSION_PER_DAY;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : DEFAULT_MAX_WAKEUPS_PER_SESSION_PER_DAY;
}

function toDto(row: WakeupRow): SessionWakeupDto {
  return {
    id: row.id,
    sessionId: row.sessionId,
    kind: row.kind as SessionWakeupKind,
    reason: row.reason,
    serviceName: row.serviceName,
    fireAt: row.fireAt?.toISOString() ?? null,
    state: row.state as SessionWakeupState,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    firedAt: row.firedAt?.toISOString() ?? null,
  };
}

function escapeAttribute(value: string): string {
  return value.replace(/[&"<>]/g, (char) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[char] ?? char));
}

const NOTIFICATION_HEADER = [
  '[SYSTEM NOTIFICATION - NOT USER INPUT]',
  'This is an automated Agent Tower wake-up, not a message from the user. It is not approval, consent, or an answer to any pending question.',
  'Continue the work you planned around this event. If nothing is needed, say so briefly and finish your turn.',
].join('\n');

export function buildWakeupMessage(row: Pick<WakeupRow, 'kind' | 'reason' | 'serviceName' | 'fireAt' | 'createdAt' | 'payload'>): string {
  if (row.kind === 'SERVICE_EXIT') {
    let payload: ServiceExitPayload = {};
    try { payload = JSON.parse(row.payload) as ServiceExitPayload; } catch { /* empty payload */ }
    const name = row.serviceName ?? 'unknown';
    const exitCode = payload.exitCode ?? null;
    const state = payload.runtimeState ?? (payload.stopped ? 'STOPPED' : 'EXITED');
    const lines = [
      `<agent_tower_wakeup kind="service_exit" service="${escapeAttribute(name)}" exit_code="${exitCode ?? 'unknown'}" runtime_state="${escapeAttribute(state)}">`,
      payload.stopped
        ? `Workspace service "${name}" was stopped before it finished.`
        : `Workspace service "${name}" exited with code ${exitCode ?? 'unknown'}.`,
    ];
    if (payload.missedExit) {
      lines.push('Agent Tower did not observe this exit when it happened (for example, it restarted); the state above is the last one it recorded.');
    }
    if (row.reason) lines.push(`Reason you gave for waiting: ${row.reason}`);
    const tail = (payload.logTail ?? []).filter((line) => line.length > 0).slice(-LOG_TAIL_LINES);
    if (tail.length > 0) {
      lines.push('Last log lines:');
      lines.push(...tail);
    } else {
      lines.push('No log output was captured for this service.');
    }
    lines.push('</agent_tower_wakeup>');
    return `${NOTIFICATION_HEADER}\n\n${lines.join('\n')}`;
  }
  const scheduledAt = row.createdAt.toISOString();
  const delaySeconds = row.fireAt ? Math.max(0, Math.round((row.fireAt.getTime() - row.createdAt.getTime()) / 1000)) : 0;
  return [
    NOTIFICATION_HEADER,
    '',
    `<agent_tower_wakeup kind="timer" scheduled_at="${scheduledAt}" delay_seconds="${delaySeconds}">`,
    'The wake-up you scheduled has fired.',
    `Reason: ${row.reason || '(none given)'}`,
    '</agent_tower_wakeup>',
  ].join('\n');
}

export class SessionWakeupService {
  private timer?: ReturnType<typeof setInterval>;
  private pumping?: Promise<void>;
  private pumpAgain = false;
  private closed = false;
  private readonly unsubscribe: Array<() => void> = [];
  private readonly maxPerSessionPerDay: number;
  private readonly now: () => Date;

  constructor(private readonly options: SessionWakeupServiceOptions) {
    this.maxPerSessionPerDay = options.maxPerSessionPerDay ?? resolveMaxWakeupsPerSessionPerDay();
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer || this.closed) return;
    const interval = this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.timer = setInterval(() => { void this.pump(); }, interval);
    this.timer.unref?.();
    const bus = this.options.eventBus;
    const onCompleted = () => { void this.pump(); };
    const onStopped = ({ sessionId }: { sessionId: string }) => {
      void this.cancelForSession(sessionId, 'SESSION_STOPPED').catch((error) => this.log('cancel after stop failed', error, { sessionId }));
    };
    const onTaskUpdated = ({ taskId, status }: { taskId: string; status: string }) => {
      if (status === TaskStatus.IN_PROGRESS) return;
      void this.cancelForTask(taskId, 'TASK_NOT_IN_PROGRESS').catch((error) => this.log('cancel after task status change failed', error, { taskId }));
    };
    bus.on('session:completed', onCompleted);
    bus.on('session:stopped', onStopped);
    bus.on('task:updated', onTaskUpdated);
    this.unsubscribe.push(
      () => bus.off('session:completed', onCompleted),
      () => bus.off('session:stopped', onStopped),
      () => bus.off('task:updated', onTaskUpdated),
    );
    void this.pump();
  }

  stop(): void {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const off of this.unsubscribe.splice(0)) off();
  }

  async scheduleTimer(input: { sessionId: string; delaySeconds: number; reason: string }): Promise<SessionWakeupDto> {
    const delaySeconds = Math.floor(input.delaySeconds);
    if (!Number.isFinite(delaySeconds) || delaySeconds < MIN_WAKEUP_DELAY_SECONDS || delaySeconds > MAX_WAKEUP_DELAY_SECONDS) {
      throw new ServiceError(
        `delaySeconds must be between ${MIN_WAKEUP_DELAY_SECONDS} and ${MAX_WAKEUP_DELAY_SECONDS}`,
        'VALIDATION_ERROR',
        400,
      );
    }
    const reason = input.reason.trim().slice(0, 500);
    if (!reason) throw new ServiceError('A reason is required for a wake-up', 'VALIDATION_ERROR', 400);
    await this.assertSession(input.sessionId);
    await this.assertCapacity(input.sessionId);
    const row = await prisma.sessionWakeup.create({
      data: {
        sessionId: input.sessionId,
        kind: 'TIMER',
        reason,
        fireAt: new Date(this.now().getTime() + delaySeconds * 1000),
        state: 'PENDING',
      },
    });
    this.changed([row.sessionId]);
    return toDto(row);
  }

  async waitForService(input: { sessionId: string; workspaceId: string; serviceName: string; reason?: string }): Promise<SessionWakeupDto> {
    const session = await this.assertSession(input.sessionId);
    if (session.workspaceId !== input.workspaceId) {
      throw new ServiceError('Agent session is not bound to this workspace', 'INTERNAL_SESSION_WORKSPACE_MISMATCH', 403);
    }
    const service = await this.options.services.findService(input.workspaceId, input.serviceName);
    if (!service) throw new ServiceError('Workspace service not found', 'NOT_FOUND', 404);
    const existing = await prisma.sessionWakeup.findFirst({
      where: { sessionId: input.sessionId, serviceId: service.id, kind: 'SERVICE_EXIT', state: { in: ACTIVE_STATES } },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return toDto(existing);
    await this.assertCapacity(input.sessionId);
    const reason = (input.reason ?? '').trim().slice(0, 500);
    const alreadyExited = service.runtimeInstanceId === null && ['EXITED', 'FAILED', 'STOPPED'].includes(service.runtimeState);
    let payload: ServiceExitPayload | undefined;
    if (alreadyExited) {
      let logTail: string[] = [];
      try { logTail = await this.options.services.readLogTail(input.workspaceId, input.serviceName, LOG_TAIL_LINES); } catch { /* optional */ }
      payload = { exitCode: service.exitCode, runtimeState: service.runtimeState, stopped: service.runtimeState === 'STOPPED', logTail, workspaceId: input.workspaceId };
    }
    const row = await prisma.sessionWakeup.create({
      data: {
        sessionId: input.sessionId,
        kind: 'SERVICE_EXIT',
        reason,
        serviceId: service.id,
        serviceName: service.name,
        state: alreadyExited ? 'READY' : 'PENDING',
        payload: JSON.stringify(payload ?? { workspaceId: input.workspaceId }),
      },
    });
    this.changed([row.sessionId]);
    if (alreadyExited) void this.pump();
    return toDto(row);
  }

  async listForSession(sessionId: string): Promise<SessionWakeupDto[]> {
    const rows = await prisma.sessionWakeup.findMany({ where: { sessionId }, orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.map(toDto);
  }

  async cancelForSession(sessionId: string, reason: string): Promise<number> {
    const result = await prisma.sessionWakeup.updateMany({
      where: { sessionId, state: { in: ACTIVE_STATES } },
      data: { state: 'CANCELLED', lastError: reason },
    });
    if (result.count > 0) this.changed([sessionId]);
    return result.count;
  }

  /**
   * The task left IN_PROGRESS. Agent Tower itself never moves a task with
   * pending wake-ups out of IN_PROGRESS, so this is a person's (or a merge's)
   * decision about the work: drop the wake-ups rather than reopen the task.
   * The status is re-read so a late event cannot cancel wake-ups of a task
   * that has already been reopened.
   */
  async cancelForTask(taskId: string, reason: string): Promise<number> {
    const task = await prisma.task.findUnique({ where: { id: taskId }, select: { status: true } });
    if (!task || task.status === TaskStatus.IN_PROGRESS) return 0;
    const rows = await prisma.sessionWakeup.findMany({
      where: { state: { in: ACTIVE_STATES }, session: { workspace: { taskId } } },
      select: { id: true, sessionId: true },
    });
    if (rows.length === 0) return 0;
    const result = await prisma.sessionWakeup.updateMany({
      where: { id: { in: rows.map((row) => row.id) }, state: { in: ACTIVE_STATES } },
      data: { state: 'CANCELLED', lastError: reason },
    });
    if (result.count > 0) this.changed(rows.map((row) => row.sessionId));
    return result.count;
  }

  /** A person dismissed one pending wake-up from the session view. */
  async cancelById(sessionId: string, wakeupId: string, reason = 'USER_CANCELLED'): Promise<SessionWakeupDto> {
    const result = await prisma.sessionWakeup.updateMany({
      where: { id: wakeupId, sessionId, state: { in: ACTIVE_STATES } },
      data: { state: 'CANCELLED', lastError: reason },
    });
    const row = await prisma.sessionWakeup.findFirst({ where: { id: wakeupId, sessionId } });
    if (!row) throw new ServiceError('Wake-up not found', 'NOT_FOUND', 404);
    if (result.count === 0 && row.state !== 'CANCELLED') {
      throw new ServiceError('This wake-up has already fired', 'WAKEUP_ALREADY_FIRED', 409);
    }
    if (result.count > 0) this.changed([sessionId]);
    return toDto(row);
  }

  /** A workspace service exit was persisted; release the wake-ups waiting for it. */
  async handleServiceExit(event: WorkspaceServiceExitEvent): Promise<void> {
    const payload: ServiceExitPayload = {
      exitCode: event.exitCode,
      runtimeState: event.runtimeState,
      stopped: event.stopped,
      logTail: event.logTail.slice(-LOG_TAIL_LINES),
      workspaceId: event.workspaceId,
    };
    const waiting = await prisma.sessionWakeup.findMany({
      where: { serviceId: event.serviceId, kind: 'SERVICE_EXIT', state: 'PENDING' },
      select: { id: true, sessionId: true },
    });
    if (waiting.length === 0) return;
    const updated = await prisma.sessionWakeup.updateMany({
      where: { id: { in: waiting.map((row) => row.id) }, state: 'PENDING' },
      data: { state: 'READY', payload: JSON.stringify(payload) },
    });
    if (updated.count > 0) {
      this.changed(waiting.map((row) => row.sessionId));
      void this.pump();
    }
  }

  /** Promote due timers and deliver every READY wake-up whose session can accept it. */
  async pump(): Promise<void> {
    if (this.closed) return;
    if (this.pumping) {
      this.pumpAgain = true;
      return this.pumping;
    }
    this.pumping = this.runPump().catch((error) => this.log('pump failed', error)).finally(() => {
      this.pumping = undefined;
      if (this.pumpAgain) {
        this.pumpAgain = false;
        void this.pump();
      }
    });
    return this.pumping;
  }

  private async runPump(): Promise<void> {
    const due = await prisma.sessionWakeup.findMany({
      where: { state: 'PENDING', kind: 'TIMER', fireAt: { lte: this.now() } },
      select: { id: true, sessionId: true },
    });
    if (due.length > 0) {
      await prisma.sessionWakeup.updateMany({
        where: { id: { in: due.map((row) => row.id) }, state: 'PENDING' },
        data: { state: 'READY' },
      });
      this.changed(due.map((row) => row.sessionId));
    }
    await this.releaseMissedServiceExits();
    const ready = await prisma.sessionWakeup.findMany({ where: { state: 'READY' }, orderBy: { createdAt: 'asc' }, take: READY_BATCH });
    const blockedSessions = new Set<string>();
    for (const row of ready) {
      if (this.closed) return;
      if (blockedSessions.has(row.sessionId)) continue;
      const delivered = await this.deliver(row);
      if (!delivered) blockedSessions.add(row.sessionId);
    }
  }

  /**
   * Release SERVICE_EXIT waits whose service is no longer running but whose
   * exit push never reached this service; see MISSED_EXIT_GRACE_MS.
   */
  private async releaseMissedServiceExits(): Promise<void> {
    const cutoff = new Date(this.now().getTime() - MISSED_EXIT_GRACE_MS);
    const missed = await prisma.sessionWakeup.findMany({
      where: {
        state: 'PENDING',
        kind: 'SERVICE_EXIT',
        createdAt: { lte: cutoff },
        service: {
          is: {
            runtimeInstanceId: null,
            runtimeState: { in: INACTIVE_SERVICE_STATES },
            OR: [{ stoppedAt: null }, { stoppedAt: { lte: cutoff } }],
          },
        },
      },
      select: {
        id: true,
        sessionId: true,
        service: { select: { workspaceId: true, name: true, runtimeState: true, exitCode: true } },
      },
      take: READY_BATCH,
    });
    for (const row of missed) {
      if (!row.service) continue;
      const stopped = row.service.runtimeState === 'STOPPED';
      let logTail: string[] = [];
      try { logTail = await this.options.services.readLogTail(row.service.workspaceId, row.service.name, LOG_TAIL_LINES); } catch { /* optional */ }
      const payload: ServiceExitPayload = {
        // A STOPPED record may still carry the exit code of an earlier run.
        exitCode: stopped ? null : row.service.exitCode,
        runtimeState: row.service.runtimeState,
        stopped,
        logTail,
        workspaceId: row.service.workspaceId,
        missedExit: true,
      };
      const updated = await prisma.sessionWakeup.updateMany({
        where: { id: row.id, state: 'PENDING' },
        data: { state: 'READY', payload: JSON.stringify(payload) },
      });
      if (updated.count > 0) {
        this.changed([row.sessionId]);
        this.log('released a wake-up whose service exit was not observed', undefined, { sessionId: row.sessionId, wakeupId: row.id });
      }
    }
  }

  private async deliver(row: WakeupRow): Promise<boolean> {
    const session = await prisma.session.findUnique({
      where: { id: row.sessionId },
      select: {
        status: true,
        conversationId: true,
        workspace: { select: { task: { select: { deletedAt: true, status: true } } } },
      },
    });
    if (!session || session.conversationId || session.workspace?.task?.deletedAt) {
      await this.cancel(row, 'SESSION_UNAVAILABLE');
      return true;
    }
    if (session.status === 'CANCELLED') {
      // The user stopped this session; an automatic wake-up must not restart it.
      await this.cancel(row, 'SESSION_STOPPED');
      return true;
    }
    if (session.workspace?.task && session.workspace.task.status !== TaskStatus.IN_PROGRESS) {
      // A person moved the task to review, done or back to the backlog while the
      // wake-up was pending. Durable twin of the task:updated listener.
      await this.cancel(row, 'TASK_NOT_IN_PROGRESS');
      return true;
    }
    if (this.options.sessions.hasActiveTurn(row.sessionId)) return false;
    if (await this.firedInLastDay(row.sessionId) >= this.maxPerSessionPerDay) {
      await this.cancel(row, 'CAP_EXCEEDED');
      this.log('wake-up cap exceeded', undefined, { sessionId: row.sessionId, wakeupId: row.id });
      return true;
    }
    try {
      const result = await this.options.delivery.submitSession({
        sessionId: row.sessionId,
        message: buildWakeupMessage(row),
        systemEvent: true,
        clientSubmissionId: `wakeup:${row.id}`,
      });
      // The delivery row exists before the wake-up stops counting as active, so
      // a task review check always sees at least one of them (task-outstanding-work.ts).
      await prisma.sessionWakeup.updateMany({
        where: { id: row.id, state: 'READY' },
        data: { state: 'FIRED', firedAt: this.now(), deliveryId: result.operationId, lastError: null },
      });
      this.changed([row.sessionId]);
      return true;
    } catch (error) {
      if (error instanceof ServiceError && error.code === 'DELIVERY_QUEUE_FULL') return false;
      await this.cancel(row, error instanceof ServiceError ? error.code : 'DELIVERY_FAILED');
      this.log('wake-up delivery failed', error, { sessionId: row.sessionId, wakeupId: row.id });
      return true;
    }
  }

  private async cancel(row: Pick<WakeupRow, 'id' | 'sessionId'>, reason: string): Promise<void> {
    const result = await prisma.sessionWakeup.updateMany({ where: { id: row.id, state: { in: ACTIVE_STATES } }, data: { state: 'CANCELLED', lastError: reason } });
    if (result.count > 0) this.changed([row.sessionId]);
  }

  /** Tell the UI and the task review check that a session's pending wake-ups changed. */
  private changed(sessionIds: string[]): void {
    for (const sessionId of new Set(sessionIds)) {
      try {
        this.options.eventBus.emit('session:wakeups_changed', { sessionId });
      } catch (error) {
        this.log('wake-up change listener failed', error, { sessionId });
      }
    }
  }

  private async assertSession(sessionId: string) {
    const session = await prisma.session.findUnique({ where: { id: sessionId }, select: { id: true, workspaceId: true, conversationId: true } });
    if (!session) throw new ServiceError('Session not found', 'NOT_FOUND', 404);
    if (session.conversationId || !session.workspaceId) {
      throw new ServiceError('Wake-ups are available for workspace sessions only', 'WAKEUP_UNAVAILABLE', 409);
    }
    return session;
  }

  private async assertCapacity(sessionId: string): Promise<void> {
    const pending = await prisma.sessionWakeup.count({ where: { sessionId, state: { in: ACTIVE_STATES } } });
    if (pending >= MAX_PENDING_WAKEUPS_PER_SESSION) {
      throw new ServiceError(`At most ${MAX_PENDING_WAKEUPS_PER_SESSION} wake-ups can be pending for a session`, 'WAKEUP_LIMIT', 429);
    }
    if (await this.firedInLastDay(sessionId) >= this.maxPerSessionPerDay) {
      throw new ServiceError(`This session already used its ${this.maxPerSessionPerDay} automatic wake-ups for today`, 'WAKEUP_CAP_EXCEEDED', 429);
    }
  }

  private firedInLastDay(sessionId: string): Promise<number> {
    return prisma.sessionWakeup.count({
      where: { sessionId, state: 'FIRED', firedAt: { gte: new Date(this.now().getTime() - 24 * 60 * 60_000) } },
    });
  }

  private log(message: string, error?: unknown, metadata?: Record<string, unknown>): void {
    writeErrorLog({ level: 'warn', source: 'sessionWakeup', message: `[SessionWakeupService] ${message}`, error, metadata });
  }
}
