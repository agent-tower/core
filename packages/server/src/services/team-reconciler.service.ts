import type {
  AgentInvocationStatus,
  TeamRunInvalidationReason,
  TeamRunInvalidationScope,
  TeamRunReviewReason,
} from '@agent-tower/shared';
import type { EventBus } from '../core/event-bus.js';
import { TaskStatus } from '../types/index.js';
import { prisma } from '../utils/index.js';
import { emitTeamRunInvalidated } from './team-run-events.js';
import { isTaskDeleted } from './deleted-task-guard.js';

// 统一补催/唤醒退避：指数增长（×2）封顶 5min，共 10 档（约 42min 触达上限）。
const DEFAULT_REMINDER_DELAYS_MS = [
  60_000, 120_000, 240_000, 300_000, 300_000, 300_000, 300_000, 300_000, 300_000, 300_000,
];
const DEFAULT_MAX_ROOM_REPLY_REMINDERS = 10;
// RUNNING 成员超过该静默时长（无 session:patch 真实进展）视为无心跳，开始唤醒。
const DEFAULT_HEARTBEAT_IDLE_THRESHOLD_MS = 5 * 60_000;
// 绝对兜底：首次 nudge 起超过该时长仍未收到 room message（真实汇报）则强制释放，防止“吐假输出骗过清零”的活锁。
const DEFAULT_ABSOLUTE_NUDGE_BUDGET_MS = 30 * 60_000;
const TERMINAL_INVOCATION_STATUSES: AgentInvocationStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED'];
const ACTIVE_INVOCATION_STATUSES: AgentInvocationStatus[] = [
  'QUEUED',
  'RUNNING',
  'SESSION_ENDED',
  'WAITING_ROOM_REPLY',
];
const OPEN_WORK_REQUEST_STATUSES = ['QUEUED', 'PENDING_APPROVAL'];
const TEAM_QUIESCENT_REVIEW_REASON: TeamRunReviewReason = 'TEAM_QUIESCENT';

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
  startNextSessions(teamRunId: string): Promise<unknown>;
}

export interface TeamReconcilerSessionMessenger {
  sendMessage(sessionId: string, message: string): Promise<unknown>;
  stop?(sessionId: string, options?: { skipTeamRunReconcile?: boolean }): Promise<unknown>;
  hasActivePipeline?(sessionId: string): boolean;
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
  private readonly heartbeatIdleThresholdMs: number;
  private readonly absoluteNudgeBudgetMs: number;

  constructor(dependencies: TeamReconcilerDependencies = {}) {
    this.scheduler = dependencies.scheduler ?? null;
    this.sessionMessenger = dependencies.sessionMessenger;
    this.eventBus = dependencies.eventBus;
    this.now = dependencies.now ?? (() => new Date());
    this.reminderDelaysMs = dependencies.reminderDelaysMs ?? DEFAULT_REMINDER_DELAYS_MS;
    this.maxRoomReplyReminders = dependencies.maxRoomReplyReminders ?? DEFAULT_MAX_ROOM_REPLY_REMINDERS;
    this.scheduleReminders = dependencies.scheduleReminders ?? true;
    this.heartbeatIdleThresholdMs = dependencies.heartbeatIdleThresholdMs ?? DEFAULT_HEARTBEAT_IDLE_THRESHOLD_MS;
    this.absoluteNudgeBudgetMs = dependencies.absoluteNudgeBudgetMs ?? DEFAULT_ABSOLUTE_NUDGE_BUDGET_MS;
  }

  async handleSessionExit(sessionId: string): Promise<boolean> {
    const invocation = await prisma.agentInvocation.findFirst({
      where: { sessionId },
      select: { id: true },
    });
    if (!invocation) {
      return false;
    }

    await this.reconcileInvocation(invocation.id);
    return true;
  }

  async handleSessionStopped(sessionId: string): Promise<boolean> {
    const invocation = await prisma.agentInvocation.findFirst({
      where: { sessionId },
      select: {
        id: true,
        teamRunId: true,
        teamRun: { select: { task: { select: { deletedAt: true } } } },
      },
    });
    if (!invocation) {
      return false;
    }

    await prisma.agentInvocation.update({
      where: { id: invocation.id },
      data: {
        status: 'CANCELLED',
        nextRoomReplyReminderAt: null,
      },
    });
    await this.emitTeamRunInvalidated(invocation.teamRunId, ['agent-invocations', 'team-run'], 'agent-invocation-updated');
    this.clearReminderTimer(invocation.id);
    if (isTaskDeleted(invocation.teamRun.task)) {
      await this.syncTerminalWorkRequest(invocation.id);
      const scheduler = await this.getScheduler();
      scheduler.releaseInvocationLocks(invocation.id);
      return true;
    }
    await this.afterInvocationTerminal(invocation.teamRunId, invocation.id);
    return true;
  }

  async reconcileInvocation(invocationId: string): Promise<void> {
    const invocation = await prisma.agentInvocation.findUnique({
      where: { id: invocationId },
      include: { teamRun: { select: { task: { select: { deletedAt: true } } } } },
    });
    if (!invocation) {
      return;
    }
    if (isTaskDeleted(invocation.teamRun.task)) {
      const scheduler = await this.getScheduler();
      scheduler.releaseInvocationLocks(invocation.id);
      this.clearReminderTimer(invocation.id);
      return;
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
      await prisma.agentInvocation.update({
        where: { id: invocation.id },
        data: {
          status: 'COMPLETED',
          roomReplyReminderCount: 0,
          nextRoomReplyReminderAt: null,
          firstNudgeAt: null,
        },
      });
      await this.emitTeamRunInvalidated(invocation.teamRunId, ['agent-invocations', 'team-run'], 'agent-invocation-updated');
      this.clearReminderTimer(invocation.id);
      await this.afterInvocationTerminal(invocation.teamRunId, invocation.id);
      return;
    }

    if (
      invocation.status === 'WAITING_ROOM_REPLY'
      && invocation.nextRoomReplyReminderAt
      && invocation.nextRoomReplyReminderAt.getTime() > this.now().getTime()
    ) {
      this.scheduleReminderTimer(invocation.id, invocation.nextRoomReplyReminderAt);
      return;
    }

    if (invocation.roomReplyReminderCount >= this.maxRoomReplyReminders) {
      await prisma.agentInvocation.update({
        where: { id: invocation.id },
        data: {
          status: 'FAILED',
          roomReplyReminderCount: 0,
          nextRoomReplyReminderAt: null,
          firstNudgeAt: null,
        },
      });
      await this.emitTeamRunInvalidated(invocation.teamRunId, ['agent-invocations', 'team-run'], 'agent-invocation-updated');
      this.clearReminderTimer(invocation.id);
      await this.afterInvocationTerminal(invocation.teamRunId, invocation.id);
      return;
    }

    const nextReminderCount = invocation.roomReplyReminderCount + 1;
    const nextReminderAt = this.addDelay(this.now(), this.getReminderDelayMs(nextReminderCount));

    await prisma.agentInvocation.update({
      where: { id: invocation.id },
      data: {
        status: 'WAITING_ROOM_REPLY',
        roomReplyReminderCount: nextReminderCount,
        nextRoomReplyReminderAt: nextReminderAt,
      },
    });
    await this.emitTeamRunInvalidated(invocation.teamRunId, ['agent-invocations', 'team-run'], 'agent-invocation-updated');
    this.scheduleReminderTimer(invocation.id, nextReminderAt);

    if (invocation.sessionId) {
      await this.sendRoomReplyReminder(invocation.sessionId);
    }
  }

  async reconcileDueRoomReplyReminders(limit = 50): Promise<number> {
    const dueInvocations = await prisma.agentInvocation.findMany({
      where: {
        status: 'WAITING_ROOM_REPLY',
        nextRoomReplyReminderAt: { lte: this.now() },
      },
      select: { id: true },
      orderBy: [{ nextRoomReplyReminderAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });

    for (const invocation of dueInvocations) {
      await this.reconcileInvocation(invocation.id);
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
      where: { status: 'RUNNING', sessionId: { not: null } },
      include: { teamRun: { select: { task: { select: { deletedAt: true } } } } },
    });
    const now = this.now();

    for (const invocation of candidates) {
      if (isTaskDeleted(invocation.teamRun.task)) {
        continue;
      }
      const sessionId = invocation.sessionId;
      if (!sessionId) {
        continue;
      }
      // 进程已不在内存管理中：交给首扫 orphan 或正常 exit 流程，避免运行期对刚退出瞬态的误判。
      if (this.sessionMessenger?.hasActivePipeline && !this.sessionMessenger.hasActivePipeline(sessionId)) {
        continue;
      }

      const lastActivity = invocation.lastHeartbeatAt ?? invocation.createdAt;
      const idleMs = now.getTime() - lastActivity.getTime();

      if (idleMs < this.heartbeatIdleThresholdMs) {
        // 有真实进展（含被唤醒后恢复）：清零连续 nudge 计数，保留 firstNudgeAt 作为绝对兜底。
        if (invocation.roomReplyReminderCount > 0 || invocation.nextRoomReplyReminderAt) {
          await prisma.agentInvocation.update({
            where: { id: invocation.id },
            data: { roomReplyReminderCount: 0, nextRoomReplyReminderAt: null },
          });
          await this.emitTeamRunInvalidated(invocation.teamRunId, ['agent-invocations'], 'agent-invocation-updated');
        }
        continue;
      }

      // 绝对兜底：首次 nudge 起超时仍无 room message 真实汇报 → 强制释放，防“吐假输出骗过清零”的活锁。
      if (invocation.firstNudgeAt && now.getTime() - invocation.firstNudgeAt.getTime() > this.absoluteNudgeBudgetMs) {
        await this.releaseStalledInvocation(invocation);
        continue;
      }

      // 连续无进展唤醒达上限 → 释放。
      if (invocation.roomReplyReminderCount >= this.maxRoomReplyReminders) {
        await this.releaseStalledInvocation(invocation);
        continue;
      }

      // 退避中，未到下次唤醒时间。
      if (invocation.nextRoomReplyReminderAt && invocation.nextRoomReplyReminderAt.getTime() > now.getTime()) {
        continue;
      }

      // 发出唤醒：递增计数、按退避排下次、记录首次 nudge 时间（lastHeartbeatAt 留给真实进展更新）。
      const nextCount = invocation.roomReplyReminderCount + 1;
      const nextAt = this.addDelay(now, this.getReminderDelayMs(nextCount));
      await prisma.agentInvocation.update({
        where: { id: invocation.id },
        data: {
          roomReplyReminderCount: nextCount,
          nextRoomReplyReminderAt: nextAt,
          firstNudgeAt: invocation.firstNudgeAt ?? now,
        },
      });
      await this.emitTeamRunInvalidated(invocation.teamRunId, ['agent-invocations'], 'agent-invocation-updated');
      const nudgeSent = await this.sendHeartbeatNudge(sessionId);
      if (!nudgeSent && this.isSessionPipelineMissing(sessionId)) {
        const current = await prisma.agentInvocation.findUnique({
          where: { id: invocation.id },
          select: { id: true, teamRunId: true, sessionId: true, status: true },
        });
        if (current?.status === 'RUNNING') {
          await this.releaseStalledInvocation(current);
        }
      }
    }
  }

  /**
   * 首扫处理：server 重启后内存 pipeline 全丢，DB 中遗留的 RUNNING invocation 会永久占用成员。
   * 这类 invocation 进程已脱管，直接释放并走调度闭环，避免房间永久卡死。
   */
  async reconcileOrphanInvocations(): Promise<void> {
    const candidates = await prisma.agentInvocation.findMany({
      where: { status: 'RUNNING', sessionId: { not: null } },
      include: { teamRun: { select: { task: { select: { deletedAt: true } } } } },
    });

    for (const invocation of candidates) {
      if (isTaskDeleted(invocation.teamRun.task)) {
        continue;
      }
      if (!invocation.sessionId) {
        continue;
      }
      const alive = this.sessionMessenger?.hasActivePipeline?.(invocation.sessionId) ?? false;
      if (alive) {
        continue;
      }
      await this.releaseStalledInvocation(invocation);
    }
  }

  private async releaseStalledInvocation(invocation: {
    id: string;
    teamRunId: string;
    sessionId: string | null;
  }): Promise<void> {
    const sessionId = invocation.sessionId;
    const alive = sessionId ? !this.isSessionPipelineMissing(sessionId) : false;

    // 进程仍存活：走 stop，由 handleSessionStopped 置 CANCELLED 并触发 afterInvocationTerminal 闭环。
    if (sessionId && alive && this.sessionMessenger?.stop) {
      this.clearReminderTimer(invocation.id);
      await this.sessionMessenger.stop(sessionId);
      return;
    }

    // 无存活进程（已退出 / orphan）：直接置 FAILED 并手动走释放闭环。
    await prisma.agentInvocation.update({
      where: { id: invocation.id },
      data: {
        status: 'FAILED',
        roomReplyReminderCount: 0,
        nextRoomReplyReminderAt: null,
        firstNudgeAt: null,
      },
    });
    await this.emitTeamRunInvalidated(invocation.teamRunId, ['agent-invocations', 'team-run'], 'agent-invocation-updated');
    this.clearReminderTimer(invocation.id);
    await this.afterInvocationTerminal(invocation.teamRunId, invocation.id);
  }

  private async sendHeartbeatNudge(sessionId: string): Promise<boolean> {
    if (!this.sessionMessenger) {
      return false;
    }
    try {
      await this.sessionMessenger.sendMessage(sessionId, TEAM_HEARTBEAT_NUDGE);
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
    return this.sessionMessenger?.hasActivePipeline?.(sessionId) === false;
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

    await this.releaseTerminalInvocationLocks(teamRun.invocations);

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

  private async afterInvocationTerminal(teamRunId: string, invocationId: string): Promise<void> {
    await this.syncTerminalWorkRequest(invocationId);

    const scheduler = await this.getScheduler();
    scheduler.releaseInvocationLocks(invocationId);

    try {
      await scheduler.startNextSessions(teamRunId);
    } catch (error) {
      console.warn(
        `[TeamReconcilerService] Failed to start queued TeamRun work for ${teamRunId}:`,
        error instanceof Error ? error.message : error
      );
    }

    await this.maybeAdvanceTeamRunToReview(teamRunId);
  }

  private async syncTerminalWorkRequest(invocationId: string): Promise<void> {
    const invocation = await prisma.agentInvocation.findUnique({
      where: { id: invocationId },
      select: { status: true, workRequestId: true },
    });
    if (!invocation) {
      return;
    }
    const terminalWorkRequestStatus = this.toTerminalWorkRequestStatus(invocation.status);
    if (!terminalWorkRequestStatus) {
      return;
    }

    await prisma.workRequest.updateMany({
      where: {
        id: invocation.workRequestId,
        status: 'STARTED',
      },
      data: { status: terminalWorkRequestStatus },
    });
  }

  private toTerminalWorkRequestStatus(status: string): 'COMPLETED' | 'FAILED' | 'CANCELLED' | null {
    if (status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED') {
      return status;
    }
    return null;
  }

  private async releaseTerminalInvocationLocks(invocations: Array<{ id: string; status: string }>): Promise<void> {
    const scheduler = await this.getScheduler();
    for (const invocation of invocations) {
      if (TERMINAL_INVOCATION_STATUSES.includes(invocation.status as AgentInvocationStatus)) {
        scheduler.releaseInvocationLocks(invocation.id);
      }
    }
  }

  private async sendRoomReplyReminder(sessionId: string): Promise<void> {
    if (!this.sessionMessenger) {
      console.warn(`[TeamReconcilerService] No session messenger configured for room reply reminder: ${sessionId}`);
      return;
    }

    try {
      await this.sessionMessenger.sendMessage(sessionId, TEAM_ROOM_REPLY_REMINDER);
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
