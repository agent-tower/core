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

const DEFAULT_REMINDER_DELAYS_MS = [60_000, 120_000, 240_000];
const DEFAULT_MAX_ROOM_REPLY_REMINDERS = 3;
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

export interface TeamReconcilerScheduler {
  releaseInvocationLocks(invocationId: string): void;
  startNextSessions(teamRunId: string): Promise<unknown>;
}

export interface TeamReconcilerSessionMessenger {
  sendMessage(sessionId: string, message: string): Promise<unknown>;
}

export interface TeamReconcilerDependencies {
  scheduler?: TeamReconcilerScheduler;
  sessionMessenger?: TeamReconcilerSessionMessenger;
  eventBus?: Pick<EventBus, 'emit'>;
  now?: () => Date;
  reminderDelaysMs?: number[];
  maxRoomReplyReminders?: number;
  scheduleReminders?: boolean;
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

  constructor(dependencies: TeamReconcilerDependencies = {}) {
    this.scheduler = dependencies.scheduler ?? null;
    this.sessionMessenger = dependencies.sessionMessenger;
    this.eventBus = dependencies.eventBus;
    this.now = dependencies.now ?? (() => new Date());
    this.reminderDelaysMs = dependencies.reminderDelaysMs ?? DEFAULT_REMINDER_DELAYS_MS;
    this.maxRoomReplyReminders = dependencies.maxRoomReplyReminders ?? DEFAULT_MAX_ROOM_REPLY_REMINDERS;
    this.scheduleReminders = dependencies.scheduleReminders ?? true;
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
      select: { id: true, teamRunId: true },
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
    await this.afterInvocationTerminal(invocation.teamRunId, invocation.id);
    return true;
  }

  async reconcileInvocation(invocationId: string): Promise<void> {
    const invocation = await prisma.agentInvocation.findUnique({
      where: { id: invocationId },
    });
    if (!invocation) {
      return;
    }

    const hasRoomReply = await prisma.roomMessage.count({
      where: { senderInvocationId: invocation.id },
    }) > 0;

    if (hasRoomReply) {
      await prisma.agentInvocation.update({
        where: { id: invocation.id },
        data: {
          status: 'COMPLETED',
          nextRoomReplyReminderAt: null,
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
          nextRoomReplyReminderAt: null,
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
