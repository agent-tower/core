import type {
  AgentInvocation,
  AgentInvocationStatus,
  TeamRunInvalidationReason,
  TeamRunInvalidationScope,
  TeamRunReviewReason,
} from '@agent-tower/shared';
import type { Prisma } from '@prisma/client';
import type { EventBus } from '../core/event-bus.js';
import { TaskStatus } from '../types/index.js';
import { prisma } from '../utils/index.js';
import { emitTeamRunInvalidated } from './team-run-events.js';
import { isTaskDeleted } from './deleted-task-guard.js';
import { acquireTeamMemberAdmission } from './team-member-admission-barrier.js';
import {
  evaluateSessionRuntimeCleanup,
  reportDueRuntimeCleanupQuarantines,
} from './session-runtime-cleanup-gate.js';

// 统一补催/唤醒退避：指数增长（×2）封顶 5min，共 10 档（约 42min 触达上限）。
const DEFAULT_REMINDER_DELAYS_MS = [
  60_000, 120_000, 240_000, 300_000, 300_000, 300_000, 300_000, 300_000, 300_000, 300_000,
];
const DEFAULT_MAX_ROOM_REPLY_REMINDERS = 10;
// RUNNING 成员超过该静默时长（无 session:patch 真实进展）视为无心跳，开始唤醒。
const DEFAULT_HEARTBEAT_IDLE_THRESHOLD_MS = 10 * 60_000;
// 绝对兜底：首次 nudge 起超过该时长仍未收到 room message（真实汇报）则强制释放，防止“吐假输出骗过清零”的活锁。
const DEFAULT_ABSOLUTE_NUDGE_BUDGET_MS = 30 * 60_000;
const TERMINAL_INVOCATION_STATUSES: AgentInvocationStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];
const ACTIVE_INVOCATION_STATUSES: AgentInvocationStatus[] = [
  'QUEUED',
  'RUNNING',
  'SESSION_ENDED',
  'WAITING_ROOM_REPLY',
];
// Statuses whose runtime can be reclaimed after the owning server generation
// lost its in-memory pipeline. Only RUNNING is safe here: WAITING_ROOM_REPLY is
// also the legal follow-up state of a healthy session, and this scan cannot tell
// the two apart because the cleanup gate deliberately ignores Session.status.
// Dead waiting invocations are retired by the due-reminder path instead.
const ORPHAN_RECOVERABLE_INVOCATION_STATUSES: AgentInvocationStatus[] = ['RUNNING'];
// A normal turn exit also has no active turn and confirmed cleanup, so a
// session only counts as dead when it ended abnormally.
const DEAD_SESSION_STATUSES = ['FAILED', 'CANCELLED'];
const OPEN_WORK_REQUEST_STATUSES = ['QUEUED', 'PENDING_APPROVAL'];
const TEAM_QUIESCENT_REVIEW_REASON: TeamRunReviewReason = 'TEAM_QUIESCENT';

type StalledReconcileAction =
  | { kind: 'none' }
  | { kind: 'nudge'; sessionId: string; invocationId: string }
  | { kind: 'terminal'; teamRunId: string; memberId: string; invocationId: string; sessionId: string | null };

type InvocationWithTaskState = Prisma.AgentInvocationGetPayload<{
  include: {
    teamRun: {
      select: {
        heartbeatTimeoutMinutes: true;
        task: {
          select: { deletedAt: true };
        };
      };
    };
  };
}>;

export const TEAM_ROOM_REPLY_REMINDER = [
  '你当前这次工作还没有向 Team Room 发送结果。',
  '如果任务已经完成，请调用 post_room_message，说明实际完成了什么、是否有代码/文件变更、是否遇到问题、建议下一步 @ 哪个成员。',
  '如果任务还没有完成，请直接继续完成任务；不要只发送状态说明到 Team Room。',
].join('\n');

export const TEAM_HEARTBEAT_NUDGE = [
  '检测到你已较长时间没有任何进展输出，可能卡住了。',
  '如果任务仍在进行，请立即继续推进；如果已经完成，请调用 post_room_message 汇报完成了什么、是否有代码/文件变更、遇到的问题以及建议的下一步。',
  '如果你在等待某个会阻塞的操作，请改用非阻塞方式并继续推进，不要静默等待。',
].join('\n');

export interface TeamReconcilerScheduler {
  releaseInvocationLocks(invocationId: string): void;
  startNextSessions(teamRunId: string): Promise<AgentInvocation[]>;
}

export interface TeamReconcilerSessionMessenger {
  sendMessage(
    sessionId: string,
    message: string,
    providerId?: string,
    expectedTeamRunInvocationId?: string,
  ): Promise<unknown>;
  stop?(sessionId: string, options?: { skipTeamRunReconcile?: boolean }): Promise<unknown>;
  disposeRuntimeSession?(sessionId: string, expectedRuntimeInstanceId?: string): Promise<void>;
  retryRuntimeProcessCleanup?(input: {
    sessionId: string;
    runtimeInstanceId: string;
    launchClaimNumber?: number | null;
    pid: number;
    processGroupId?: string | null;
    birthMarker?: string | null;
    ownershipToken: string;
  }): Promise<void>;
  hasRuntimeProcessOwner?(
    runtimeInstanceId: string,
    sessionId?: string,
    launchClaimNumber?: number | null,
  ): boolean;
  hasActivePipeline?(sessionId: string): boolean;
  hasActiveTurn?(sessionId: string): boolean;
  isAwaitingPermission?(sessionId: string): boolean;
  isRuntimeCleanupConfirmed?(sessionId: string): Promise<boolean>;
}

export interface TeamReconcilerDependencies {
  scheduler?: TeamReconcilerScheduler;
  sessionMessenger?: TeamReconcilerSessionMessenger;
  eventBus?: Pick<EventBus, 'emit'>;
  now?: () => Date;
  reminderDelaysMs?: number[];
  maxRoomReplyReminders?: number;
  scheduleReminders?: boolean;
  heartbeatIdleThresholdMs?: number;
  absoluteNudgeBudgetMs?: number;
}

export class TeamReconcilerService {
  private scheduler: TeamReconcilerScheduler | null;
  private readonly reminderTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly sessionMessenger?: TeamReconcilerSessionMessenger;
  private readonly eventBus?: Pick<EventBus, 'emit'>;
  private readonly now: () => Date;
  private readonly reminderDelaysMs: number[];
  private readonly maxRoomReplyReminders: number;
  private readonly scheduleReminders: boolean;
  private readonly heartbeatIdleThresholdMs?: number;
  private readonly absoluteNudgeBudgetMs: number;

  constructor(dependencies: TeamReconcilerDependencies = {}) {
    this.scheduler = dependencies.scheduler ?? null;
    this.sessionMessenger = dependencies.sessionMessenger;
    this.eventBus = dependencies.eventBus;
    this.now = dependencies.now ?? (() => new Date());
    this.reminderDelaysMs = dependencies.reminderDelaysMs ?? DEFAULT_REMINDER_DELAYS_MS;
    this.maxRoomReplyReminders = dependencies.maxRoomReplyReminders ?? DEFAULT_MAX_ROOM_REPLY_REMINDERS;
    this.scheduleReminders = dependencies.scheduleReminders ?? true;
    this.heartbeatIdleThresholdMs = dependencies.heartbeatIdleThresholdMs;
    this.absoluteNudgeBudgetMs = dependencies.absoluteNudgeBudgetMs ?? DEFAULT_ABSOLUTE_NUDGE_BUDGET_MS;
  }

  async handleSessionExit(sessionId: string, expectedRuntimeInstanceId?: string): Promise<boolean> {
    const invocation = await prisma.agentInvocation.findFirst({
      where: { sessionId },
      select: { id: true },
    });
    if (!invocation) {
      return false;
    }

    await this.reconcileInvocation(invocation.id, expectedRuntimeInstanceId);
    return true;
  }

  async handleSessionStopped(sessionId: string): Promise<AgentInvocation[]> {
    const invocation = await prisma.agentInvocation.findFirst({
      where: { sessionId },
      select: {
        id: true,
        teamRunId: true,
        memberId: true,
        status: true,
        teamRun: { select: { task: { select: { deletedAt: true } } } },
      },
    });
    if (!invocation) {
      return [];
    }

    if (TERMINAL_INVOCATION_STATUSES.includes(invocation.status as AgentInvocationStatus)) {
      return this.afterInvocationTerminal(invocation.teamRunId, invocation.id);
    }

    await prisma.agentInvocation.updateMany({
      where: { id: invocation.id, status: { in: ACTIVE_INVOCATION_STATUSES } },
      data: { dispatchRevokedAt: this.now(), nextRoomReplyReminderAt: null },
    });
    return this.terminalizeRevokedInvocation(invocation.id);
  }

  async isSessionRuntimeCleanupConfirmed(sessionId: string): Promise<boolean> {
    return (await evaluateSessionRuntimeCleanup(sessionId, {
      hasActiveTurn: (candidateId) => this.hasActiveTurn(candidateId),
      hasRuntimeProcessOwner: this.sessionMessenger?.hasRuntimeProcessOwner
        ? (runtimeInstanceId, ownerSessionId, launchClaimNumber) => this.sessionMessenger!.hasRuntimeProcessOwner!(
          runtimeInstanceId,
          ownerSessionId ?? sessionId,
          launchClaimNumber,
        )
        : undefined,
    }, this.now())).confirmed;
  }

  /**
   * Whether the session behind an invocation died abnormally and can no longer
   * produce a room reply.
   *
   * `Session.status` alone is not proof that the owned process tree is gone, so
   * the shared cleanup gate must confirm it before the member slot is released
   * — exactly like every other terminal path. The gate alone is not enough
   * either: a normal turn exit also has no active turn plus confirmed cleanup
   * (that is the legal reminder/follow-up path), which is why only an
   * abnormal `FAILED`/`CANCELLED` session counts as dead here.
   */
  private async isSessionRuntimeDead(sessionId: string): Promise<boolean> {
    if (this.hasActiveTurn(sessionId)) {
      return false;
    }
    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      select: { status: true },
    });
    if (!session || !DEAD_SESSION_STATUSES.includes(session.status)) {
      return false;
    }
    return this.isSessionRuntimeCleanupConfirmed(sessionId);
  }

  async reconcileInvocation(invocationId: string, expectedRuntimeInstanceId?: string): Promise<void> {
    const candidate = await prisma.agentInvocation.findUnique({
      where: { id: invocationId },
      select: { teamRunId: true, memberId: true },
    });
    if (!candidate) {
      return;
    }
    let result: Awaited<ReturnType<TeamReconcilerService['reconcileInvocationUnderAdmission']>>;
    const releaseAdmission = await acquireTeamMemberAdmission(candidate.teamRunId, candidate.memberId, {
      holder: 'reconcileInvocation',
    });
    try {
      result = await this.reconcileInvocationUnderAdmission(invocationId);
    } finally {
      releaseAdmission();
    }

    if (result.kind === 'task_deleted') {
      const scheduler = await this.getScheduler();
      scheduler.releaseInvocationLocks(invocationId);
      return;
    }
    if (result.kind === 'terminal') {
      await this.emitTeamRunInvalidated(
        result.teamRunId,
        ['agent-invocations', 'team-run'],
        'agent-invocation-updated',
      );
      this.clearReminderTimer(result.invocationId);
      await this.afterInvocationTerminal(
        result.teamRunId,
        result.invocationId,
        expectedRuntimeInstanceId,
      );
      return;
    }
    // Sending a follow-up re-enters the same member barrier through
    // SessionManager.sendMessage, so it must happen after the release above —
    // the same pattern reconcileStalledInvocations uses for heartbeat nudges.
    if (result.kind === 'reminder') {
      await this.sendRoomReplyReminder(result.sessionId, result.invocationId);
    }
  }

  private async reconcileInvocationUnderAdmission(invocationId: string): Promise<
    | { kind: 'none' }
    | { kind: 'task_deleted' }
    | { kind: 'terminal'; teamRunId: string; invocationId: string }
    | { kind: 'reminder'; sessionId: string; invocationId: string }
  > {
    const invocation = await prisma.agentInvocation.findUnique({
      where: { id: invocationId },
      include: { teamRun: { select: { heartbeatTimeoutMinutes: true, task: { select: { deletedAt: true } } } } },
    });
    if (!invocation) return { kind: 'none' };
    if (isTaskDeleted(invocation.teamRun.task)) {
      this.clearReminderTimer(invocation.id);
      return { kind: 'task_deleted' };
    }

    // Stop admission is authoritative for all reminder/follow-up paths. A
    // revoked invocation is completed by the cleanup recovery boundary once
    // its owned tree is confirmed; it must never be nudged back into a turn.
    if (
      invocation.dispatchRevokedAt
      && ACTIVE_INVOCATION_STATUSES.includes(invocation.status as AgentInvocationStatus)
    ) {
      this.clearReminderTimer(invocation.id);
      return { kind: 'none' };
    }

    const hasRoomReply = await prisma.roomMessage.count({
      where: {
        senderType: 'agent',
        senderId: invocation.memberId,
        senderInvocationId: invocation.id,
        visibility: 'PUBLIC',
      },
    }) > 0;

    if (hasRoomReply) {
      const completed = await prisma.agentInvocation.updateMany({
        where: {
          id: invocation.id,
          status: { in: ACTIVE_INVOCATION_STATUSES },
          dispatchRevokedAt: null,
        },
        data: {
          status: 'COMPLETED',
          roomReplyReminderCount: 0,
          nextRoomReplyReminderAt: null,
          firstNudgeAt: null,
        },
      });
      return completed.count === 1
        ? { kind: 'terminal', teamRunId: invocation.teamRunId, invocationId: invocation.id }
        : { kind: 'none' };
    }

    // A crashed session can never produce the reply the reminder loop waits
    // for, so release the member slot immediately instead of walking the whole
    // backoff on a dead runtime.
    if (invocation.sessionId && await this.isSessionRuntimeDead(invocation.sessionId)) {
      const failed = await prisma.agentInvocation.updateMany({
        where: {
          id: invocation.id,
          status: { in: ACTIVE_INVOCATION_STATUSES },
          dispatchRevokedAt: null,
        },
        data: {
          status: 'FAILED',
          roomReplyReminderCount: 0,
          nextRoomReplyReminderAt: null,
          firstNudgeAt: null,
        },
      });
      return failed.count === 1
        ? { kind: 'terminal', teamRunId: invocation.teamRunId, invocationId: invocation.id }
        : { kind: 'none' };
    }

    if (
      invocation.status === 'WAITING_ROOM_REPLY'
      && invocation.nextRoomReplyReminderAt
      && invocation.nextRoomReplyReminderAt.getTime() > this.now().getTime()
    ) {
      this.scheduleReminderTimer(invocation.id, invocation.nextRoomReplyReminderAt);
      return { kind: 'none' };
    }

    if (invocation.roomReplyReminderCount >= this.maxRoomReplyReminders) {
      const failed = await prisma.agentInvocation.updateMany({
        where: {
          id: invocation.id,
          status: { in: ACTIVE_INVOCATION_STATUSES },
          dispatchRevokedAt: null,
        },
        data: {
          status: 'FAILED',
          roomReplyReminderCount: 0,
          nextRoomReplyReminderAt: null,
          firstNudgeAt: null,
        },
      });
      return failed.count === 1
        ? { kind: 'terminal', teamRunId: invocation.teamRunId, invocationId: invocation.id }
        : { kind: 'none' };
    }

    const nextReminderCount = invocation.roomReplyReminderCount + 1;
    const nextReminderAt = this.addDelay(this.now(), this.getReminderDelayMs(nextReminderCount));
    const claimed = await prisma.agentInvocation.updateMany({
      where: {
        id: invocation.id,
        status: { in: ACTIVE_INVOCATION_STATUSES },
        dispatchRevokedAt: null,
      },
      data: {
        status: 'WAITING_ROOM_REPLY',
        roomReplyReminderCount: nextReminderCount,
        nextRoomReplyReminderAt: nextReminderAt,
      },
    });
    if (claimed.count !== 1) return { kind: 'none' };
    await this.emitTeamRunInvalidated(
      invocation.teamRunId,
      ['agent-invocations', 'team-run'],
      'agent-invocation-updated',
    );
    this.scheduleReminderTimer(invocation.id, nextReminderAt);

    return invocation.sessionId
      ? { kind: 'reminder', sessionId: invocation.sessionId, invocationId: invocation.id }
      : { kind: 'none' };
  }

  async reconcileDueRoomReplyReminders(limit = 50): Promise<number> {
    const dueInvocations = await prisma.agentInvocation.findMany({
      where: {
        status: 'WAITING_ROOM_REPLY',
        dispatchRevokedAt: null,
        nextRoomReplyReminderAt: { lte: this.now() },
      },
      select: { id: true },
      orderBy: [{ nextRoomReplyReminderAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });

    for (const invocation of dueInvocations) {
      try {
        await this.reconcileInvocation(invocation.id);
      } catch (error) {
        this.logCandidateFailure('room reply reminder', invocation.id, error);
      }
    }

    return dueInvocations.length;
  }

  /**
   * 记录一次真实进展（session:patch / room message），刷新 RUNNING invocation 的心跳时间戳。
   * 节流由调用方（SessionManager）控制，这里只做最小写入。
   */
  async recordHeartbeat(sessionId: string): Promise<void> {
    await prisma.agentInvocation.updateMany({
      where: { sessionId, status: 'RUNNING' },
      data: { lastHeartbeatAt: this.now() },
    });
  }

  /**
   * 处理成员（agent）就某次 invocation 发出的 room message：
   * - WAITING_ROOM_REPLY：已在等待汇报，立即 reconcile（hasRoomReply 成立 → 转 COMPLETED、释放锁、推进调度/review）。
   * - RUNNING：进程仍在跑，room message 是真实进展，清零唤醒计数与绝对兜底并刷新心跳，但不终态。
   * - 其它状态（已终态等）：不处理。
   *
   * 仅应由 agent 自己的 room message 触发；user/system 消息不得调用，避免误终态化或误清零。
   */
  async handleAgentRoomMessage(invocationId: string): Promise<void> {
    const invocation = await prisma.agentInvocation.findUnique({
      where: { id: invocationId },
      select: { id: true, status: true },
    });
    if (!invocation) {
      return;
    }

    if (invocation.status === 'WAITING_ROOM_REPLY') {
      await this.reconcileInvocation(invocationId);
      return;
    }

    if (invocation.status === 'RUNNING') {
      await prisma.agentInvocation.updateMany({
        where: { id: invocationId, status: 'RUNNING' },
        data: {
          lastHeartbeatAt: this.now(),
          roomReplyReminderCount: 0,
          nextRoomReplyReminderAt: null,
          firstNudgeAt: null,
        },
      });
    }
  }

  /**
   * 心跳 watchdog：扫描 RUNNING 成员 invocation，对长时间无真实进展者按统一退避发送唤醒消息，
   * 唤醒上限或绝对兜底超时后释放。与 room reply 补催复用同一 roomReplyReminderCount /
   * nextRoomReplyReminderAt / 退避序列，避免计数系统分叉。
   */
  async reconcileStalledInvocations(): Promise<void> {
    const candidates = await prisma.agentInvocation.findMany({
      where: { status: 'RUNNING', dispatchRevokedAt: null, sessionId: { not: null } },
      include: { teamRun: { select: { heartbeatTimeoutMinutes: true, task: { select: { deletedAt: true } } } } },
    });
    const now = this.now();

    for (const invocation of candidates) {
      try {
        let action: StalledReconcileAction = { kind: 'none' };
        const releaseAdmission = await acquireTeamMemberAdmission(invocation.teamRunId, invocation.memberId, {
          holder: 'reconcileStalledInvocations',
        });
        try {
          const current = await prisma.agentInvocation.findUnique({
            where: { id: invocation.id },
            include: { teamRun: { select: { heartbeatTimeoutMinutes: true, task: { select: { deletedAt: true } } } } },
          });
          if (current) {
            action = await this.reconcileStalledCandidate(current, now);
          }
        } finally {
          releaseAdmission();
        }
        if (action.kind === 'nudge') {
          const nudgeSent = await this.sendHeartbeatNudge(action.sessionId, action.invocationId);
          if (!nudgeSent && this.isSessionPipelineMissing(action.sessionId)) {
            action = await this.claimStalledTerminal(action.invocationId, action.sessionId, now);
          }
        }
        if (action.kind === 'terminal') {
          await this.finishStalledTerminal(action);
        }
      } catch (error) {
        this.logCandidateFailure('stalled invocation', invocation.id, error);
      }
    }
  }

  /**
   * 首扫处理：server 重启后内存 pipeline 全丢，DB 中遗留的 RUNNING
   * invocation 会永久占用成员。这类 invocation 进程已脱管，直接释放并走调度闭环。
   */
  async reconcileOrphanInvocations(): Promise<void> {
    const candidates = await prisma.agentInvocation.findMany({
      where: {
        status: { in: ORPHAN_RECOVERABLE_INVOCATION_STATUSES },
        dispatchRevokedAt: null,
        sessionId: { not: null },
      },
      include: { teamRun: { select: { heartbeatTimeoutMinutes: true, task: { select: { deletedAt: true } } } } },
    });
    const failures: unknown[] = [];

    for (const invocation of candidates) {
      try {
        const action = await this.reconcileOrphanCandidate(invocation);
        if (action?.kind === 'terminal') await this.finishStalledTerminal(action);
      } catch (error) {
        this.logCandidateFailure('orphan invocation', invocation.id, error);
        failures.push(error);
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Failed to reconcile ${failures.length} orphan invocation candidate(s)`,
      );
    }
  }

  /**
   * 周期修复 Invocation 已终态、WorkRequest 仍为 STARTED 的半完成状态。
   * 正常 session exit、stalled 回收等运行期路径均可能在非事务后处理失败时留下该状态，
   * 因此不能依赖只执行一次的 orphan 首扫。
   */
  async reconcileIncompleteTerminalInvocations(): Promise<void> {
    const candidates = await this.findIncompleteTerminalInvocationCandidates();
    const failures: unknown[] = [];

    for (const invocation of candidates) {
      try {
        if (
          invocation.sessionId
          && !await this.isSessionRuntimeCleanupConfirmed(invocation.sessionId)
        ) continue;
        await this.afterInvocationTerminal(invocation.teamRunId, invocation.id);
      } catch (error) {
        this.logCandidateFailure('incomplete terminal invocation', invocation.id, error);
        failures.push(error);
      }
    }

    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Failed to reconcile ${failures.length} incomplete terminal invocation candidate(s)`,
      );
    }
  }

  async reconcilePendingRuntimeCleanup(limit = 50): Promise<number> {
    const now = this.now();
    const quarantineCount = await reportDueRuntimeCleanupQuarantines(limit, now);
    const retryable = this.sessionMessenger?.retryRuntimeProcessCleanup
      ? await prisma.executionProcess.findMany({
      where: {
        runtimeInstanceId: { not: null },
        ownershipToken: { not: null },
        cleanupState: { in: ['PENDING', 'FAILED'] },
        OR: [
          { nextCleanupRetryAt: null },
          { nextCleanupRetryAt: { lte: now } },
        ],
      },
      select: {
        sessionId: true,
        runtimeInstanceId: true,
        launchClaimNumber: true,
        pid: true,
        processGroupId: true,
        birthMarker: true,
        ownershipToken: true,
        cleanupState: true,
      },
      orderBy: [{ nextCleanupRetryAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
      })
      : [];

    // ACTIVE belongs to a live runtime in the current server generation. An
    // ACTIVE row without an in-memory owner is from an abrupt prior shutdown
    // and must enter the same persisted recovery path.
    const staleActive = this.sessionMessenger?.retryRuntimeProcessCleanup && retryable.length < limit
      ? (await prisma.executionProcess.findMany({
        where: {
          runtimeInstanceId: { not: null },
          ownershipToken: { not: null },
          cleanupState: 'ACTIVE',
        },
        select: {
          sessionId: true,
          runtimeInstanceId: true,
          launchClaimNumber: true,
          pid: true,
          processGroupId: true,
          birthMarker: true,
          ownershipToken: true,
          cleanupState: true,
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit - retryable.length,
      })).filter((candidate) => (
        candidate.runtimeInstanceId
        && Number.isInteger(candidate.launchClaimNumber)
        && candidate.launchClaimNumber! > 0
        && this.sessionMessenger?.hasRuntimeProcessOwner != null
      && !this.sessionMessenger.hasRuntimeProcessOwner(
        candidate.runtimeInstanceId,
        candidate.sessionId,
        candidate.launchClaimNumber,
      )
      ))
      : [];
    const candidates = [...retryable, ...staleActive];
    const sessionMessenger = this.sessionMessenger;
    const retryRuntimeProcessCleanup = sessionMessenger?.retryRuntimeProcessCleanup;

    for (const candidate of candidates) {
      if (
        !candidate.runtimeInstanceId
        || !candidate.ownershipToken
        || candidate.pid == null
        || !Number.isInteger(candidate.launchClaimNumber)
        || candidate.launchClaimNumber! <= 0
      ) continue;
      try {
        if (!retryRuntimeProcessCleanup) continue;
        // Keep the messenger as the receiver. SessionManager's cleanup method
        // updates its own durable state through `this`, so invoking a detached
        // function here would turn every restart recovery into a TypeError.
        await sessionMessenger!.retryRuntimeProcessCleanup!({
          sessionId: candidate.sessionId,
          runtimeInstanceId: candidate.runtimeInstanceId,
          launchClaimNumber: candidate.launchClaimNumber,
          pid: candidate.pid,
          processGroupId: candidate.processGroupId,
          birthMarker: candidate.birthMarker,
          ownershipToken: candidate.ownershipToken,
        });
        const invocation = await prisma.agentInvocation.findFirst({
          where: { sessionId: candidate.sessionId },
          select: {
            id: true,
            teamRunId: true,
            status: true,
            dispatchRevokedAt: true,
          },
        });
        if (!invocation) continue;
        if (
          invocation.dispatchRevokedAt
          && ACTIVE_INVOCATION_STATUSES.includes(invocation.status as AgentInvocationStatus)
        ) {
          const process = await prisma.executionProcess.findFirst({
            where: {
              sessionId: candidate.sessionId,
              runtimeInstanceId: candidate.runtimeInstanceId,
              launchClaimNumber: candidate.launchClaimNumber,
            },
            select: { cleanupState: true },
          });
          if (
            process?.cleanupState === 'CONFIRMED'
            && await this.canTerminalizeRevokedInvocation(invocation.id, candidate.sessionId)
          ) {
            await this.terminalizeRevokedInvocation(invocation.id);
          } else {
            await this.sessionMessenger?.stop?.(candidate.sessionId, { skipTeamRunReconcile: true });
            if (await this.canTerminalizeRevokedInvocation(invocation.id, candidate.sessionId)) {
              await this.terminalizeRevokedInvocation(invocation.id);
            }
          }
        } else if (TERMINAL_INVOCATION_STATUSES.includes(invocation.status as AgentInvocationStatus)) {
          await this.afterInvocationTerminal(
            invocation.teamRunId,
            invocation.id,
            candidate.runtimeInstanceId,
          );
        }
      } catch (error) {
        this.logCandidateFailure('runtime cleanup', candidate.runtimeInstanceId, error);
      }
    }

    // A tree can be confirmed immediately before a transient DB failure in
    // terminalization. Such rows are no longer PENDING/FAILED, so scan
    // confirmed ownership records for the revoked + active recovery case.
    const confirmedCandidates = await this.findConfirmedRevokedCandidates(limit);
    for (const candidate of confirmedCandidates) {
      try {
        if (await this.canTerminalizeRevokedInvocation(candidate.invocationId, candidate.sessionId)) {
          await this.terminalizeRevokedInvocation(candidate.invocationId);
        }
      } catch (error) {
        this.logCandidateFailure('revoked terminalization', candidate.invocationId, error);
      }
    }
    return candidates.length + quarantineCount;
  }

  private async findConfirmedRevokedCandidates(limit: number): Promise<Array<{
    invocationId: string;
    sessionId: string;
  }>> {
    const results: Array<{ invocationId: string; sessionId: string }> = [];
    const pageSize = Math.max(50, limit);
    let cursor: string | undefined;
    while (results.length < limit) {
      const invocations = await prisma.agentInvocation.findMany({
        where: {
          dispatchRevokedAt: { not: null },
          status: { in: ACTIVE_INVOCATION_STATUSES },
          sessionId: { not: null },
        },
        select: { id: true, sessionId: true },
        orderBy: { id: 'asc' },
        take: pageSize,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      for (const invocation of invocations) {
        if (
          invocation.sessionId
          && await this.canTerminalizeRevokedInvocation(invocation.id, invocation.sessionId)
        ) {
          results.push({ invocationId: invocation.id, sessionId: invocation.sessionId });
          if (results.length >= limit) break;
        }
      }
      if (invocations.length < pageSize) break;
      cursor = invocations[invocations.length - 1]!.id;
    }
    return results;
  }

  private async canTerminalizeRevokedInvocation(
    invocationId: string,
    sessionId: string,
  ): Promise<boolean> {
    return this.canTerminalizeAfterRuntimeCleanup(invocationId, sessionId, true);
  }

  /** All terminal paths share the durable launch + ownership cleanup gate. */
  private async canTerminalizeAfterRuntimeCleanup(
    invocationId: string,
    sessionId: string,
    requireDispatchRevoked = false,
  ): Promise<boolean> {
    if (!await this.isSessionRuntimeCleanupConfirmed(sessionId)) return false;
    const invocation = await prisma.agentInvocation.findUnique({
      where: { id: invocationId },
      select: { status: true, dispatchRevokedAt: true, sessionId: true },
    });
    return invocation?.sessionId === sessionId
      && (!requireDispatchRevoked || invocation.dispatchRevokedAt != null)
      && ACTIVE_INVOCATION_STATUSES.includes(invocation.status as AgentInvocationStatus);
  }

  private async terminalizeRevokedInvocation(invocationId: string): Promise<AgentInvocation[]> {
    const candidate = await prisma.agentInvocation.findUnique({
      where: { id: invocationId },
      select: { teamRunId: true, memberId: true, sessionId: true },
    });
    if (!candidate?.sessionId) return [];
    if (!await this.canTerminalizeAfterRuntimeCleanup(invocationId, candidate.sessionId, true)) return [];
    const releaseAdmission = await acquireTeamMemberAdmission(candidate.teamRunId, candidate.memberId, {
      holder: 'terminalizeRevokedInvocation',
    });
    let result: { teamRunId: string } | null = null;
    try {
      if (!await this.canTerminalizeAfterRuntimeCleanup(invocationId, candidate.sessionId, true)) return [];
      result = await prisma.$transaction(async (tx) => {
        const invocation = await tx.agentInvocation.findUnique({
          where: { id: invocationId },
          select: { id: true, teamRunId: true, sessionId: true, workRequestId: true, status: true, dispatchRevokedAt: true },
        });
        if (
          !invocation
          || !invocation.dispatchRevokedAt
          || !ACTIVE_INVOCATION_STATUSES.includes(invocation.status as AgentInvocationStatus)
        ) return null;

        const updated = await tx.agentInvocation.updateMany({
          where: { id: invocation.id, status: { in: ACTIVE_INVOCATION_STATUSES }, dispatchRevokedAt: { not: null } },
          data: { status: 'CANCELLED', nextRoomReplyReminderAt: null, roomReplyReminderCount: 0, firstNudgeAt: null },
        });
        if (updated.count !== 1) return null;
        if (invocation.sessionId) {
          await tx.session.updateMany({
            where: { id: invocation.sessionId, status: { notIn: ['COMPLETED', 'FAILED', 'CANCELLED'] } },
            data: { status: 'CANCELLED' },
          });
        }
        return { teamRunId: invocation.teamRunId };
      });
    } finally {
      releaseAdmission();
    }
    if (!result) return [];
    this.clearReminderTimer(invocationId);
    await this.emitTeamRunInvalidated(result.teamRunId, ['agent-invocations', 'team-run'], 'agent-invocation-updated');
    return this.afterInvocationTerminal(result.teamRunId, invocationId);
  }

  private async findIncompleteTerminalInvocationCandidates(): Promise<Array<{
    id: string;
    teamRunId: string;
    sessionId: string | null;
  }>> {
    const startedWorkRequests = await prisma.workRequest.findMany({
      where: { status: 'STARTED' },
      select: { id: true },
    });
    const candidates: Array<{ id: string; teamRunId: string; sessionId: string | null }> = [];

    for (let offset = 0; offset < startedWorkRequests.length; offset += 500) {
      const workRequestIds = startedWorkRequests
        .slice(offset, offset + 500)
        .map((workRequest) => workRequest.id);
      const invocations = await prisma.agentInvocation.findMany({
        where: {
          workRequestId: { in: workRequestIds },
          status: { in: [...ACTIVE_INVOCATION_STATUSES, ...TERMINAL_INVOCATION_STATUSES] },
        },
        select: { id: true, teamRunId: true, sessionId: true, workRequestId: true, status: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      const activeWorkRequestIds = new Set<string>();
      const latestTerminalByWorkRequest = new Map<string, {
        id: string;
        teamRunId: string;
        sessionId: string | null;
      }>();

      for (const invocation of invocations) {
        if (ACTIVE_INVOCATION_STATUSES.includes(invocation.status as AgentInvocationStatus)) {
          activeWorkRequestIds.add(invocation.workRequestId);
        } else if (
          TERMINAL_INVOCATION_STATUSES.includes(invocation.status as AgentInvocationStatus)
          && !latestTerminalByWorkRequest.has(invocation.workRequestId)
        ) {
          latestTerminalByWorkRequest.set(invocation.workRequestId, invocation);
        }
      }

      for (const [workRequestId, invocation] of latestTerminalByWorkRequest) {
        if (!activeWorkRequestIds.has(workRequestId)) {
          candidates.push(invocation);
        }
      }
    }

    return candidates;
  }

  private async reconcileStalledCandidate(
    invocation: InvocationWithTaskState,
    now: Date,
  ): Promise<StalledReconcileAction> {
    if (invocation.dispatchRevokedAt) {
      return { kind: 'none' };
    }
    if (isTaskDeleted(invocation.teamRun.task)) {
      return { kind: 'none' };
    }
    const sessionId = invocation.sessionId;
    if (!sessionId) {
      return { kind: 'none' };
    }
    // Permission waits are an active turn controlled by the user. They do not
    // count as agent silence and must not trigger an automated nudge.
    if (this.sessionMessenger?.isAwaitingPermission?.(sessionId)) {
      return { kind: 'none' };
    }
    // 进程已不在内存管理中：仍需通过 persisted cleanup gate，避免把
    // hasActiveTurn=false 误当成 owned process tree 已退出。
    if (!this.hasActiveTurn(sessionId)) {
      return this.claimStalledTerminalUnderAdmission(invocation.id, sessionId, now);
    }

    const lastActivity = invocation.lastHeartbeatAt ?? invocation.createdAt;
    const idleMs = now.getTime() - lastActivity.getTime();

    const configuredThresholdMs = invocation.teamRun.heartbeatTimeoutMinutes * 60_000;
    const heartbeatIdleThresholdMs = this.heartbeatIdleThresholdMs
      ?? (configuredThresholdMs > 0 ? configuredThresholdMs : DEFAULT_HEARTBEAT_IDLE_THRESHOLD_MS);
    if (idleMs < heartbeatIdleThresholdMs) {
      if (invocation.roomReplyReminderCount > 0 || invocation.nextRoomReplyReminderAt) {
        await prisma.agentInvocation.updateMany({
          where: { id: invocation.id, status: 'RUNNING', dispatchRevokedAt: null },
          data: { roomReplyReminderCount: 0, nextRoomReplyReminderAt: null },
        });
        await this.emitTeamRunInvalidated(invocation.teamRunId, ['agent-invocations'], 'agent-invocation-updated');
      }
      return { kind: 'none' };
    }

    if (invocation.firstNudgeAt && now.getTime() - invocation.firstNudgeAt.getTime() > this.absoluteNudgeBudgetMs) {
      const claimed = await this.claimStalledRelease(invocation.id, now);
      return claimed
        ? { kind: 'terminal', teamRunId: invocation.teamRunId, memberId: invocation.memberId, invocationId: invocation.id, sessionId }
        : { kind: 'none' };
    }
    if (invocation.roomReplyReminderCount >= this.maxRoomReplyReminders) {
      const claimed = await this.claimStalledRelease(invocation.id, now);
      return claimed
        ? { kind: 'terminal', teamRunId: invocation.teamRunId, memberId: invocation.memberId, invocationId: invocation.id, sessionId }
        : { kind: 'none' };
    }
    if (invocation.nextRoomReplyReminderAt && invocation.nextRoomReplyReminderAt.getTime() > now.getTime()) {
      return { kind: 'none' };
    }

    const nextCount = invocation.roomReplyReminderCount + 1;
    const nextAt = this.addDelay(now, this.getReminderDelayMs(nextCount));
    const claimed = await prisma.agentInvocation.updateMany({
      where: { id: invocation.id, status: 'RUNNING', dispatchRevokedAt: null },
      data: {
        roomReplyReminderCount: nextCount,
        nextRoomReplyReminderAt: nextAt,
        firstNudgeAt: invocation.firstNudgeAt ?? now,
      },
    });
    if (claimed.count !== 1) return { kind: 'none' };
    await this.emitTeamRunInvalidated(invocation.teamRunId, ['agent-invocations'], 'agent-invocation-updated');
    return { kind: 'nudge', sessionId, invocationId: invocation.id };
  }

  private async claimStalledRelease(invocationId: string, now: Date): Promise<boolean> {
    const claimed = await prisma.agentInvocation.updateMany({
      where: { id: invocationId, status: 'RUNNING', dispatchRevokedAt: null },
      data: { dispatchRevokedAt: now, nextRoomReplyReminderAt: null },
    });
    return claimed.count === 1;
  }

  private async reconcileOrphanCandidate(
    invocation: InvocationWithTaskState,
  ): Promise<StalledReconcileAction> {
    if (isTaskDeleted(invocation.teamRun.task) || !invocation.sessionId) {
      return { kind: 'none' };
    }
    const alive = this.hasActiveTurn(invocation.sessionId);
    if (!alive) {
      const releaseAdmission = await acquireTeamMemberAdmission(invocation.teamRunId, invocation.memberId, {
        holder: 'reconcileOrphanCandidate',
      });
      try {
        return this.claimStalledTerminalUnderAdmission(
          invocation.id,
          invocation.sessionId,
          this.now(),
          ORPHAN_RECOVERABLE_INVOCATION_STATUSES,
        );
      } finally {
        releaseAdmission();
      }
    }
    return { kind: 'none' };
  }

  private logCandidateFailure(kind: string, invocationId: string, error: unknown): void {
    console.warn(
      `[TeamReconcilerService] Failed to reconcile ${kind} ${invocationId}:`,
      error instanceof Error ? error.message : error,
    );
  }

  private async claimStalledTerminal(
    invocationId: string,
    sessionId: string,
    now: Date,
    recoverableStatuses: readonly AgentInvocationStatus[] = ['RUNNING'],
  ): Promise<StalledReconcileAction> {
    const candidate = await prisma.agentInvocation.findUnique({
      where: { id: invocationId },
      select: { teamRunId: true, memberId: true },
    });
    if (!candidate) return { kind: 'none' };
    const releaseAdmission = await acquireTeamMemberAdmission(candidate.teamRunId, candidate.memberId, {
      holder: 'claimStalledTerminal',
    });
    try {
      return await this.claimStalledTerminalUnderAdmission(invocationId, sessionId, now, recoverableStatuses);
    } finally {
      releaseAdmission();
    }
  }

  /**
   * Reclaims an invocation whose runtime is gone. `recoverableStatuses` keeps
   * each caller inside the state it actually observed: the stalled scan must
   * never fail an invocation that just moved to WAITING_ROOM_REPLY, and the
   * startup orphan scan stays on RUNNING for the same reason.
   */
  private async claimStalledTerminalUnderAdmission(
    invocationId: string,
    sessionId: string,
    now: Date,
    recoverableStatuses: readonly AgentInvocationStatus[] = ['RUNNING'],
  ): Promise<StalledReconcileAction> {
    const current = await prisma.agentInvocation.findUnique({
      where: { id: invocationId },
      select: { id: true, teamRunId: true, memberId: true, sessionId: true, status: true, dispatchRevokedAt: true },
    });
    if (
      !current
      || !recoverableStatuses.includes(current.status as AgentInvocationStatus)
      || current.dispatchRevokedAt
    ) return { kind: 'none' };
    if (!await this.canTerminalizeAfterRuntimeCleanup(invocationId, sessionId)) {
      await prisma.agentInvocation.updateMany({
        where: {
          id: invocationId,
          status: { in: [...recoverableStatuses] },
          dispatchRevokedAt: null,
        },
        data: { dispatchRevokedAt: now, nextRoomReplyReminderAt: null },
      });
      return { kind: 'none' };
    }
    const failed = await prisma.agentInvocation.updateMany({
      where: {
        id: invocationId,
        status: { in: [...recoverableStatuses] },
        dispatchRevokedAt: null,
      },
      data: {
        status: 'FAILED',
        nextRoomReplyReminderAt: null,
        roomReplyReminderCount: 0,
        firstNudgeAt: null,
      },
    });
    if (failed.count !== 1) return { kind: 'none' };
    await prisma.session.updateMany({
      where: { id: sessionId, status: { notIn: ['COMPLETED', 'FAILED', 'CANCELLED'] } },
      data: { status: 'FAILED' },
    });
    return { kind: 'terminal', teamRunId: current.teamRunId, memberId: current.memberId, invocationId, sessionId };
  }

  private async finishStalledTerminal(action: Extract<StalledReconcileAction, { kind: 'terminal' }>): Promise<void> {
    this.clearReminderTimer(action.invocationId);
    const before = await prisma.agentInvocation.findUnique({
      where: { id: action.invocationId },
      select: { status: true, dispatchRevokedAt: true },
    });
    if (!before) return;
    if (ACTIVE_INVOCATION_STATUSES.includes(before.status as AgentInvocationStatus)) {
      if (action.sessionId && this.hasActiveTurn(action.sessionId) && this.sessionMessenger?.stop) {
        await this.sessionMessenger.stop(action.sessionId, { skipTeamRunReconcile: true });
      }
      if (
        action.sessionId
        && !await this.canTerminalizeAfterRuntimeCleanup(action.invocationId, action.sessionId, true)
      ) {
        return;
      }
    }

    const releaseAdmission = await acquireTeamMemberAdmission(action.teamRunId, action.memberId, {
      holder: 'finishStalledTerminal',
    });
    let cancelled = false;
    try {
      const current = await prisma.agentInvocation.findUnique({
        where: { id: action.invocationId },
        select: { teamRunId: true, memberId: true, status: true, dispatchRevokedAt: true },
      });
      if (current?.status === 'FAILED') {
        cancelled = true;
      } else if (current && current.dispatchRevokedAt && ACTIVE_INVOCATION_STATUSES.includes(current.status as AgentInvocationStatus)) {
        const updated = await prisma.agentInvocation.updateMany({
          where: { id: action.invocationId, status: { in: ACTIVE_INVOCATION_STATUSES }, dispatchRevokedAt: { not: null } },
          data: {
            status: 'CANCELLED',
            nextRoomReplyReminderAt: null,
            roomReplyReminderCount: 0,
            firstNudgeAt: null,
          },
        });
        cancelled = updated.count === 1;
        if (cancelled && action.sessionId) {
          await prisma.session.updateMany({
            where: { id: action.sessionId, status: { notIn: ['COMPLETED', 'FAILED', 'CANCELLED'] } },
            data: { status: 'CANCELLED' },
          });
        }
      }
    } finally {
      releaseAdmission();
    }
    if (!cancelled) return;
    await this.emitTeamRunInvalidated(action.teamRunId, ['agent-invocations', 'team-run'], 'agent-invocation-updated');
    await this.afterInvocationTerminal(action.teamRunId, action.invocationId);
  }

  private async sendHeartbeatNudge(sessionId: string, invocationId?: string): Promise<boolean> {
    if (!this.sessionMessenger) {
      return false;
    }
    try {
      if (invocationId) {
        const admitted = await prisma.agentInvocation.findFirst({
          where: { id: invocationId, sessionId, status: 'RUNNING', dispatchRevokedAt: null },
          select: { id: true },
        });
        if (!admitted) return false;
      }
      await this.sessionMessenger.sendMessage(sessionId, TEAM_HEARTBEAT_NUDGE, undefined, invocationId);
      return true;
    } catch (error) {
      console.warn(
        `[TeamReconcilerService] Failed to send heartbeat nudge to session ${sessionId}:`,
        error instanceof Error ? error.message : error
      );
      return false;
    }
  }

  private isSessionPipelineMissing(sessionId: string): boolean {
    return !this.hasActiveTurn(sessionId);
  }

  private hasActiveTurn(sessionId: string): boolean {
    if (this.sessionMessenger?.hasActiveTurn) {
      return this.sessionMessenger.hasActiveTurn(sessionId);
    }
    return this.sessionMessenger?.hasActivePipeline?.(sessionId) ?? false;
  }

  async maybeAdvanceTeamRunToReview(teamRunId: string): Promise<boolean> {
    const teamRun = await prisma.teamRun.findUnique({
      where: { id: teamRunId },
      include: {
        task: true,
        invocations: { select: { id: true, status: true } },
        workRequests: { select: { status: true } },
      },
    });
    if (!teamRun) {
      return false;
    }

    if (teamRun.task.deletedAt) {
      return false;
    }

    if (teamRun.task.status !== TaskStatus.IN_PROGRESS) {
      return false;
    }

    const hasActiveInvocation = teamRun.invocations.some((invocation) => {
      return ACTIVE_INVOCATION_STATUSES.includes(invocation.status as AgentInvocationStatus);
    });
    if (hasActiveInvocation) {
      return false;
    }

    const hasOpenWorkRequest = teamRun.workRequests.some((request) => {
      return OPEN_WORK_REQUEST_STATUSES.includes(request.status);
    });
    if (hasOpenWorkRequest) {
      return false;
    }

    const updatedTask = await prisma.$transaction(async (tx) => {
      const taskUpdate = await tx.task.updateMany({
        where: {
          id: teamRun.taskId,
          status: TaskStatus.IN_PROGRESS,
        },
        data: { status: TaskStatus.IN_REVIEW },
      });
      if (taskUpdate.count !== 1) {
        return null;
      }

      await tx.teamRun.update({
        where: { id: teamRunId },
        data: { reviewReason: TEAM_QUIESCENT_REVIEW_REASON },
      });

      return tx.task.findUnique({
        where: { id: teamRun.taskId },
        select: { id: true, projectId: true, status: true },
      });
    });

    if (!updatedTask) {
      return false;
    }

    this.eventBus?.emit('task:updated', {
      taskId: updatedTask.id,
      projectId: updatedTask.projectId,
      status: updatedTask.status,
    });
    await this.emitTeamRunInvalidated(
      teamRunId,
      ['team-run', 'task', 'agent-invocations', 'work-requests'],
      'team-review-updated',
      {
        taskId: updatedTask.id,
        projectId: updatedTask.projectId,
      }
    );

    return true;
  }

  private async emitTeamRunInvalidated(
    teamRunId: string,
    scopes: TeamRunInvalidationScope[],
    reason: TeamRunInvalidationReason,
    context: { taskId?: string; projectId?: string } = {}
  ): Promise<void> {
    if (!this.eventBus) {
      return;
    }

    await emitTeamRunInvalidated({
      teamRunId,
      taskId: context.taskId,
      projectId: context.projectId,
      scopes,
      reason,
    }, this.eventBus);
  }

  private async afterInvocationTerminal(
    teamRunId: string,
    invocationId: string,
    expectedRuntimeInstanceId?: string,
  ): Promise<AgentInvocation[]> {
    const terminalInvocation = await prisma.agentInvocation.findUnique({
      where: { id: invocationId },
      select: {
        sessionId: true,
        status: true,
        teamRun: { select: { task: { select: { deletedAt: true } } } },
      },
    });
    if (!terminalInvocation || !TERMINAL_INVOCATION_STATUSES.includes(
      terminalInvocation.status as AgentInvocationStatus,
    )) return [];

    if (terminalInvocation.sessionId) {
      // TeamRun sessions are one invocation per Tower Session. Dispose only
      // after the invocation is genuinely terminal; WAITING_ROOM_REPLY keeps
      // the runtime open for the legal reminder/follow-up path.
      await this.sessionMessenger?.disposeRuntimeSession?.(
        terminalInvocation.sessionId,
        expectedRuntimeInstanceId,
      );
      if (!await this.isSessionRuntimeCleanupConfirmed(terminalInvocation.sessionId)) return [];
    }

    // WorkRequest STARTED -> terminal is the unique durable winner for all
    // after-terminal side effects. Repeated heartbeat/startup reconciliation is
    // therefore idempotent once cleanup has been confirmed.
    if (!await this.syncTerminalWorkRequest(invocationId)) return [];
    const scheduler = await this.getScheduler();
    scheduler.releaseInvocationLocks(invocationId);

    if (isTaskDeleted(terminalInvocation.teamRun.task)) return [];

    let startedInvocations: AgentInvocation[] = [];
    try {
      startedInvocations = await scheduler.startNextSessions(teamRunId);
    } catch (error) {
      console.warn(
        `[TeamReconcilerService] Failed to start queued TeamRun work for ${teamRunId}:`,
        error instanceof Error ? error.message : error
      );
    }

    await this.maybeAdvanceTeamRunToReview(teamRunId);
    return startedInvocations;
  }

  private async syncTerminalWorkRequest(invocationId: string): Promise<boolean> {
    const invocation = await prisma.agentInvocation.findUnique({
      where: { id: invocationId },
      select: { status: true, workRequestId: true },
    });
    if (!invocation) {
      return false;
    }
    const terminalWorkRequestStatus = this.toTerminalWorkRequestStatus(invocation.status);
    if (!terminalWorkRequestStatus) {
      return false;
    }

    const updated = await prisma.workRequest.updateMany({
      where: {
        id: invocation.workRequestId,
        status: 'STARTED',
      },
      data: { status: terminalWorkRequestStatus },
    });
    return updated.count === 1;
  }

  private toTerminalWorkRequestStatus(status: string): 'COMPLETED' | 'FAILED' | 'CANCELLED' | null {
    if (status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED') {
      return status;
    }
    return null;
  }

  private async sendRoomReplyReminder(sessionId: string, invocationId: string): Promise<void> {
    if (!this.sessionMessenger) {
      console.warn(`[TeamReconcilerService] No session messenger configured for room reply reminder: ${sessionId}`);
      return;
    }

    try {
      await this.sessionMessenger.sendMessage(
        sessionId,
        TEAM_ROOM_REPLY_REMINDER,
        undefined,
        invocationId,
      );
    } catch (error) {
      console.warn(
        `[TeamReconcilerService] Failed to send room reply reminder to session ${sessionId}:`,
        error instanceof Error ? error.message : error
      );
    }
  }

  private scheduleReminderTimer(invocationId: string, runAt: Date): void {
    if (!this.scheduleReminders) {
      return;
    }

    this.clearReminderTimer(invocationId);
    const delayMs = Math.max(0, runAt.getTime() - this.now().getTime());
    const timer = setTimeout(() => {
      this.reminderTimers.delete(invocationId);
      this.reconcileInvocation(invocationId).catch((error) => {
        console.warn(
          `[TeamReconcilerService] Due room reply reconciliation failed for invocation ${invocationId}:`,
          error instanceof Error ? error.message : error
        );
      });
    }, delayMs);
    (timer as { unref?: () => void }).unref?.();
    this.reminderTimers.set(invocationId, timer);
  }

  private clearReminderTimer(invocationId: string): void {
    const timer = this.reminderTimers.get(invocationId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.reminderTimers.delete(invocationId);
  }

  private getReminderDelayMs(nextReminderCount: number): number {
    return this.reminderDelaysMs[Math.min(nextReminderCount - 1, this.reminderDelaysMs.length - 1)]
      ?? DEFAULT_REMINDER_DELAYS_MS[DEFAULT_REMINDER_DELAYS_MS.length - 1]!;
  }

  private addDelay(date: Date, delayMs: number): Date {
    return new Date(date.getTime() + delayMs);
  }

  private async getScheduler(): Promise<TeamReconcilerScheduler> {
    if (this.scheduler) {
      return this.scheduler;
    }

    const { TeamSchedulerService } = await import('./team-scheduler.service.js');
    this.scheduler = new TeamSchedulerService();
    return this.scheduler;
  }
}
