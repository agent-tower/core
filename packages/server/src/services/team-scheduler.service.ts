import { randomUUID } from 'node:crypto';
import type {
  AgentInvocation,
  AgentInvocationStatus,
  IfBusyPolicy,
  TeamMemberCapabilities,
  WorkRequest,
  WorkRequestRequesterType,
  WorkRequestStatus,
  WorkspacePolicy,
} from '@agent-tower/shared';
import type {
  AgentInvocation as PrismaAgentInvocation,
  TeamMember as PrismaTeamMember,
  WorkRequest as PrismaWorkRequest,
  Workspace as PrismaWorkspace,
} from '@prisma/client';
import { NotFoundError, ServiceError } from '../errors.js';
import { prisma } from '../utils/index.js';
import { TeamLockService, type LockRequest } from './team-lock.service.js';

export interface SchedulePlan {
  workRequestId: string;
  memberId: string;
  canStart: boolean;
  blockedReason?: 'member_busy' | 'member_already_planned' | 'resource_locked' | 'member_not_found';
  requiresStopCurrent: boolean;
  lockKeys: string[];
  workspaceId: string | null;
  projectId: string | null;
}

type SchedulerTeamRun = {
  id: string;
  taskId: string;
  task: {
    projectId: string;
    workspaces: PrismaWorkspace[];
  };
};

const ACTIVE_INVOCATION_STATUSES: AgentInvocationStatus[] = [
  'QUEUED',
  'RUNNING',
  'SESSION_ENDED',
  'WAITING_ROOM_REPLY',
];

const DEFAULT_CAPABILITIES: TeamMemberCapabilities = {
  readRoom: false,
  postRoomMessage: false,
  mentionMembers: false,
  stopMemberWork: false,
  markReadyForReview: false,
  readFiles: false,
  writeFiles: false,
  runCommands: false,
  readDiff: false,
  mergeWorkspace: false,
};

const defaultLockService = new TeamLockService();

function parseJsonField<T>(value: string | null | undefined, fallback: T): T {
  if (value == null || value === '') {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function toIso(date: Date): string {
  return date.toISOString();
}

function invalidTransition(action: string, status: string): ServiceError {
  return new ServiceError(
    `Cannot ${action} WorkRequest in ${status} status`,
    'INVALID_STATE_TRANSITION',
    400
  );
}

export class TeamSchedulerService {
  private static readonly memberSchedulingLocks = new Set<string>();

  constructor(private readonly lockService = defaultLockService) {}

  async planNext(teamRunId: string): Promise<SchedulePlan[]> {
    const context = await this.getSchedulingContext(teamRunId);
    const activeMemberIds = await this.findActiveMemberIds(teamRunId);
    const plannedMemberIds = new Set<string>();
    const plannedLockKeys = new Set<string>();
    const plans: SchedulePlan[] = [];

    for (const workRequest of context.workRequests) {
      const member = context.memberById.get(workRequest.targetMemberId);
      if (!member) {
        plans.push({
          workRequestId: workRequest.id,
          memberId: workRequest.targetMemberId,
          canStart: false,
          blockedReason: 'member_not_found',
          requiresStopCurrent: false,
          lockKeys: [],
          workspaceId: null,
          projectId: context.teamRun.task.projectId,
        });
        continue;
      }

      const workspaceId = this.resolveInvocationWorkspaceId(context.teamRun, member);
      const projectId = context.teamRun.task.projectId;
      const lockKeys = this.getRequiredLocks(context.teamRun, member);
      const requiresStopCurrent = workRequest.ifBusy === 'cancel_current_and_start'
        && activeMemberIds.has(member.id);

      if (activeMemberIds.has(member.id)) {
        plans.push({
          workRequestId: workRequest.id,
          memberId: member.id,
          canStart: false,
          blockedReason: 'member_busy',
          requiresStopCurrent,
          lockKeys,
          workspaceId,
          projectId,
        });
        continue;
      }

      if (plannedMemberIds.has(member.id)) {
        plans.push({
          workRequestId: workRequest.id,
          memberId: member.id,
          canStart: false,
          blockedReason: 'member_already_planned',
          requiresStopCurrent: false,
          lockKeys,
          workspaceId,
          projectId,
        });
        continue;
      }

      const hasPlannedLockConflict = lockKeys.some((key) => plannedLockKeys.has(key));
      if (hasPlannedLockConflict || !this.lockService.canAcquire(lockKeys)) {
        plans.push({
          workRequestId: workRequest.id,
          memberId: member.id,
          canStart: false,
          blockedReason: 'resource_locked',
          requiresStopCurrent: false,
          lockKeys,
          workspaceId,
          projectId,
        });
        continue;
      }

      plannedMemberIds.add(member.id);
      for (const key of lockKeys) {
        plannedLockKeys.add(key);
      }

      plans.push({
        workRequestId: workRequest.id,
        memberId: member.id,
        canStart: true,
        requiresStopCurrent: false,
        lockKeys,
        workspaceId,
        projectId,
      });
    }

    return plans;
  }

  async startNext(teamRunId: string): Promise<AgentInvocation[]> {
    const context = await this.getSchedulingContext(teamRunId);
    const startedInvocations: AgentInvocation[] = [];

    for (const workRequest of context.workRequests) {
      const member = context.memberById.get(workRequest.targetMemberId);
      if (!member) {
        continue;
      }

      const memberLockKey = this.memberSchedulingLockKey(teamRunId, member.id);
      if (!this.acquireMemberSchedulingLock(memberLockKey)) {
        continue;
      }

      let invocationId: string | null = null;
      try {
        if (await this.hasActiveInvocation(teamRunId, member.id)) {
          continue;
        }

        const freshWorkRequest = await prisma.workRequest.findUnique({
          where: { id: workRequest.id },
        });
        if (!freshWorkRequest || freshWorkRequest.status !== 'QUEUED') {
          continue;
        }

        const lockKeys = this.getRequiredLocks(context.teamRun, member);
        invocationId = randomUUID();
        if (!this.lockService.acquire(invocationId, lockKeys)) {
          invocationId = null;
          continue;
        }

        const createdInvocation = await this.createInvocationForClaimedWorkRequest(
          context.teamRun,
          member,
          freshWorkRequest,
          invocationId
        );

        if (!createdInvocation) {
          this.lockService.releaseByOwner(invocationId);
          invocationId = null;
          continue;
        }

        startedInvocations.push(this.serializeAgentInvocation(createdInvocation));
        invocationId = null;
      } catch (error) {
        if (invocationId) {
          this.lockService.releaseByOwner(invocationId);
        }
        throw error;
      } finally {
        this.releaseMemberSchedulingLock(memberLockKey);
      }
    }

    return startedInvocations;
  }

  async approveWorkRequest(workRequestId: string): Promise<WorkRequest> {
    return this.transitionWorkRequestStatus(
      workRequestId,
      'approve',
      ['PENDING_APPROVAL'],
      'QUEUED'
    );
  }

  async rejectWorkRequest(workRequestId: string): Promise<WorkRequest> {
    return this.transitionWorkRequestStatus(
      workRequestId,
      'reject',
      ['PENDING_APPROVAL'],
      'REJECTED'
    );
  }

  async cancelWorkRequest(workRequestId: string): Promise<WorkRequest> {
    return this.transitionWorkRequestStatus(
      workRequestId,
      'cancel',
      ['PENDING_APPROVAL', 'QUEUED'],
      'CANCELLED'
    );
  }

  releaseInvocationLocks(invocationId: string): void {
    this.lockService.releaseByOwner(invocationId);
  }

  private async createInvocationForClaimedWorkRequest(
    teamRun: SchedulerTeamRun,
    member: PrismaTeamMember,
    workRequest: PrismaWorkRequest,
    invocationId: string
  ): Promise<PrismaAgentInvocation | null> {
    return prisma.$transaction(async (tx) => {
      const claimed = await tx.workRequest.updateMany({
        where: {
          id: workRequest.id,
          teamRunId: teamRun.id,
          status: 'QUEUED',
        },
        data: { status: 'STARTED' },
      });

      if (claimed.count !== 1) {
        return null;
      }

      if (workRequest.cancelQueued) {
        await tx.workRequest.updateMany({
          where: {
            teamRunId: teamRun.id,
            targetMemberId: member.id,
            status: 'QUEUED',
            id: { not: workRequest.id },
          },
          data: { status: 'CANCELLED' },
        });
      }

      return tx.agentInvocation.create({
        data: {
          id: invocationId,
          teamRunId: teamRun.id,
          workRequestId: workRequest.id,
          memberId: member.id,
          workspaceId: this.resolveInvocationWorkspaceId(teamRun, member),
          sessionId: null,
          status: 'QUEUED',
        },
      });
    });
  }

  private async getSchedulingContext(teamRunId: string): Promise<{
    teamRun: SchedulerTeamRun;
    memberById: Map<string, PrismaTeamMember>;
    workRequests: PrismaWorkRequest[];
  }> {
    const teamRun = await prisma.teamRun.findUnique({
      where: { id: teamRunId },
      include: {
        task: {
          include: {
            workspaces: {
              where: { status: 'ACTIVE' },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              take: 1,
            },
          },
        },
      },
    });
    if (!teamRun) {
      throw new NotFoundError('TeamRun', teamRunId);
    }

    const [members, workRequests] = await Promise.all([
      prisma.teamMember.findMany({
        where: { teamRunId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      prisma.workRequest.findMany({
        where: { teamRunId, status: 'QUEUED' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);

    return {
      teamRun,
      memberById: new Map(members.map((member) => [member.id, member])),
      workRequests,
    };
  }

  private async getWorkRequestOrThrow(workRequestId: string): Promise<PrismaWorkRequest> {
    const workRequest = await prisma.workRequest.findUnique({ where: { id: workRequestId } });
    if (!workRequest) {
      throw new NotFoundError('WorkRequest', workRequestId);
    }
    return workRequest;
  }

  private async transitionWorkRequestStatus(
    workRequestId: string,
    action: 'approve' | 'reject' | 'cancel',
    allowedStatuses: WorkRequestStatus[],
    nextStatus: WorkRequestStatus
  ): Promise<WorkRequest> {
    const updated = await prisma.$transaction(async (tx) => {
      const claimed = allowedStatuses.length === 1
        ? await tx.workRequest.updateMany({
          where: { id: workRequestId, status: allowedStatuses[0] },
          data: { status: nextStatus },
        })
        : await tx.workRequest.updateMany({
          where: { id: workRequestId, status: { in: allowedStatuses } },
          data: { status: nextStatus },
        });

      if (claimed.count !== 1) {
        return null;
      }

      return tx.workRequest.findUnique({ where: { id: workRequestId } });
    });

    if (!updated) {
      const current = await this.getWorkRequestOrThrow(workRequestId);
      throw invalidTransition(action, current.status);
    }

    return this.serializeWorkRequest(updated);
  }

  private async findActiveMemberIds(teamRunId: string): Promise<Set<string>> {
    const activeInvocations = await prisma.agentInvocation.findMany({
      where: {
        teamRunId,
        status: { in: ACTIVE_INVOCATION_STATUSES },
      },
      select: { memberId: true },
    });

    return new Set(activeInvocations.map((invocation) => invocation.memberId));
  }

  private async hasActiveInvocation(teamRunId: string, memberId: string): Promise<boolean> {
    const count = await prisma.agentInvocation.count({
      where: {
        teamRunId,
        memberId,
        status: { in: ACTIVE_INVOCATION_STATUSES },
      },
    });

    return count > 0;
  }

  private getRequiredLocks(teamRun: SchedulerTeamRun, member: PrismaTeamMember): string[] {
    const request: LockRequest = {
      teamRunId: teamRun.id,
      memberId: member.id,
      workspaceId: this.resolveLockWorkspaceId(teamRun, member),
      projectId: teamRun.task.projectId,
      capabilities: parseJsonField<TeamMemberCapabilities>(member.capabilities, DEFAULT_CAPABILITIES),
      workspacePolicy: member.workspacePolicy as WorkspacePolicy,
    };

    return this.lockService.getRequiredLocks(request);
  }

  private resolveInvocationWorkspaceId(teamRun: SchedulerTeamRun, member: PrismaTeamMember): string | null {
    if (member.workspacePolicy !== 'shared') {
      return null;
    }

    return teamRun.task.workspaces[0]?.id ?? null;
  }

  private resolveLockWorkspaceId(teamRun: SchedulerTeamRun, member: PrismaTeamMember): string | null {
    if (member.workspacePolicy !== 'shared') {
      return null;
    }

    return teamRun.task.workspaces[0]?.id ?? `task:${teamRun.taskId}`;
  }

  private memberSchedulingLockKey(teamRunId: string, memberId: string): string {
    return `scheduling:${teamRunId}:member:${memberId}`;
  }

  private acquireMemberSchedulingLock(lockKey: string): boolean {
    if (TeamSchedulerService.memberSchedulingLocks.has(lockKey)) {
      return false;
    }

    TeamSchedulerService.memberSchedulingLocks.add(lockKey);
    return true;
  }

  private releaseMemberSchedulingLock(lockKey: string): void {
    TeamSchedulerService.memberSchedulingLocks.delete(lockKey);
  }

  private serializeWorkRequest(workRequest: PrismaWorkRequest): WorkRequest {
    return {
      ...workRequest,
      requesterType: workRequest.requesterType as WorkRequestRequesterType,
      ifBusy: workRequest.ifBusy as IfBusyPolicy,
      status: workRequest.status as WorkRequestStatus,
      createdAt: toIso(workRequest.createdAt),
      updatedAt: toIso(workRequest.updatedAt),
    };
  }

  private serializeAgentInvocation(invocation: PrismaAgentInvocation): AgentInvocation {
    return {
      ...invocation,
      status: invocation.status as AgentInvocationStatus,
      createdAt: toIso(invocation.createdAt),
      updatedAt: toIso(invocation.updatedAt),
      nextRoomReplyReminderAt: invocation.nextRoomReplyReminderAt
        ? toIso(invocation.nextRoomReplyReminderAt)
        : null,
    };
  }
}
