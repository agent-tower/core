import { randomUUID } from 'node:crypto';
import type {
  AgentInvocation,
  AgentInvocationStatus,
  IfBusyPolicy,
  TeamRunInvalidationReason,
  TeamRunInvalidationScope,
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
import { AgentType } from '../types/index.js';
import { getProviderById, type Provider } from '../executors/index.js';
import { getSessionManager } from '../core/container.js';
import { NotFoundError, ServiceError } from '../errors.js';
import { prisma } from '../utils/index.js';
import { TeamLockService, defaultTeamLockService, type LockRequest } from './team-lock.service.js';
import { WorkspaceService } from './workspace.service.js';
import { emitTeamRunInvalidated } from './team-run-events.js';

export interface SchedulePlan {
  workRequestId: string;
  memberId: string;
  canStart: boolean;
  blockedReason?: 'member_busy' | 'member_already_planned' | 'resource_locked' | 'member_not_found' | 'unsupported_workspace_policy';
  requiresStopCurrent: boolean;
  lockKeys: string[];
  workspaceId: string | null;
  projectId: string | null;
}

export interface StopMemberWorkResult {
  stoppedSessionIds: string[];
  cancelledInvocationIds: string[];
  cancelledWorkRequestIds: string[];
  startedInvocations: AgentInvocation[];
}

type SchedulerTeamRun = {
  id: string;
  taskId: string;
  mainWorkspaceId: string | null;
  task: {
    projectId: string;
    workspaces: PrismaWorkspace[];
  };
};

type WorkspaceStarter = {
  create(taskId: string): Promise<{ id: string }>;
  getOrCreateMainWorkspace?(teamRunId: string): Promise<{ id: string }>;
  getOrCreateDedicatedWorkspace?(teamRunId: string, memberId: string): Promise<{ id: string }>;
};

type SessionStarter = {
  create(
    workspaceId: string,
    agentType: AgentType,
    prompt: string,
    variant?: string,
    providerId?: string
  ): Promise<{ id: string }>;
  start(id: string): Promise<unknown>;
  startFollowUp?(id: string, resumeFromSessionId: string): Promise<unknown>;
  stop?(id: string): Promise<unknown>;
};

interface TeamSchedulerDependencies {
  workspaceService?: WorkspaceStarter;
  sessionManager?: SessionStarter;
  getProviderById?: (providerId: string) => Provider | null;
}

const ACTIVE_INVOCATION_STATUSES: AgentInvocationStatus[] = [
  'QUEUED',
  'RUNNING',
  'SESSION_ENDED',
  'WAITING_ROOM_REPLY',
];
const STOPPABLE_INVOCATION_STATUSES: AgentInvocationStatus[] = [
  'QUEUED',
  'RUNNING',
  'SESSION_ENDED',
  'WAITING_ROOM_REPLY',
];
const CANCELLABLE_QUEUED_WORK_REQUEST_STATUSES: WorkRequestStatus[] = [
  'PENDING_APPROVAL',
  'QUEUED',
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
  private static readonly sharedWorkspaceClaims = new Map<string, Promise<{ id: string }>>();
  private readonly workspaceService: WorkspaceStarter;
  private readonly sessionManager: SessionStarter;
  private readonly providerLookup: (providerId: string) => Provider | null;

  constructor(
    private readonly lockService = defaultTeamLockService,
    dependencies: TeamSchedulerDependencies = {}
  ) {
    this.workspaceService = dependencies.workspaceService ?? new WorkspaceService();
    this.sessionManager = dependencies.sessionManager ?? getSessionManager();
    this.providerLookup = dependencies.getProviderById ?? getProviderById;
  }

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

        const workspaceId = await this.resolveQueuedInvocationWorkspaceId(context.teamRun, member);
        const createdInvocation = await this.createInvocationForClaimedWorkRequest(
          context.teamRun,
          member,
          freshWorkRequest,
          invocationId,
          workspaceId
        );

        if (!createdInvocation) {
          this.lockService.releaseByOwner(invocationId);
          invocationId = null;
          continue;
        }

        startedInvocations.push(this.serializeAgentInvocation(createdInvocation));
        await this.emitTeamRunInvalidated(context.teamRun, ['work-requests', 'agent-invocations'], 'agent-invocation-updated');
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

  async startNextSessions(teamRunId: string): Promise<AgentInvocation[]> {
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

        const provider = this.providerLookup(member.providerId);
        if (!provider) {
          this.lockService.releaseByOwner(invocationId);
          invocationId = null;
          throw new ServiceError(`Provider not found: ${member.providerId}`, 'PROVIDER_NOT_FOUND', 400);
        }

        const workspace = await this.getOrCreateWorkspaceForMember(context.teamRun, member);
        const session = await this.sessionManager.create(
          workspace.id,
          provider.agentType as AgentType,
          this.buildSessionPrompt(member, freshWorkRequest),
          'DEFAULT',
          member.providerId
        );

        const createdInvocation = await this.createRunningInvocationForClaimedWorkRequest(
          context.teamRun,
          member,
          freshWorkRequest,
          invocationId,
          workspace.id,
          session.id
        );

        if (!createdInvocation) {
          await this.markSessionFailed(session.id);
          this.lockService.releaseByOwner(invocationId);
          invocationId = null;
          continue;
        }

        const resumeFromSessionId = await this.findResumeSourceSessionId(member, session.id, workspace.id);
        try {
          if (resumeFromSessionId && this.sessionManager.startFollowUp) {
            await this.sessionManager.startFollowUp(session.id, resumeFromSessionId);
          } else {
            await this.sessionManager.start(session.id);
          }
        } catch (error) {
          await this.markInvocationStartFailed(createdInvocation.id, session.id);
          this.lockService.releaseByOwner(createdInvocation.id);
          invocationId = null;
          throw error;
        }

        startedInvocations.push(this.serializeAgentInvocation(createdInvocation));
        await this.emitTeamRunInvalidated(context.teamRun, ['work-requests', 'agent-invocations', 'workspaces'], 'agent-invocation-updated');
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
    const workRequest = await this.transitionWorkRequestStatus(
      workRequestId,
      'approve',
      ['PENDING_APPROVAL'],
      'QUEUED'
    );
    await this.emitTeamRunInvalidatedById(workRequest.teamRunId, ['work-requests', 'team-run'], 'work-request-updated');
    return workRequest;
  }

  async approveWorkRequestAndStartNext(workRequestId: string): Promise<{
    workRequest: WorkRequest;
    startedInvocations: AgentInvocation[];
  }> {
    const workRequest = await this.approveWorkRequest(workRequestId);
    const startedInvocations = await this.startNextSessions(workRequest.teamRunId);
    return { workRequest, startedInvocations };
  }

  async rejectWorkRequest(workRequestId: string): Promise<WorkRequest> {
    const workRequest = await this.transitionWorkRequestStatus(
      workRequestId,
      'reject',
      ['PENDING_APPROVAL'],
      'REJECTED'
    );
    await this.emitTeamRunInvalidatedById(workRequest.teamRunId, ['work-requests', 'team-run'], 'work-request-updated');
    return workRequest;
  }

  async cancelWorkRequest(workRequestId: string): Promise<WorkRequest> {
    const workRequest = await this.transitionWorkRequestStatus(
      workRequestId,
      'cancel',
      ['PENDING_APPROVAL', 'QUEUED'],
      'CANCELLED'
    );
    await this.emitTeamRunInvalidatedById(workRequest.teamRunId, ['work-requests', 'team-run'], 'work-request-updated');
    return workRequest;
  }

  async stopMemberWork(teamRunId: string, memberId: string, options: {
    cancelQueued?: boolean;
  } = {}): Promise<StopMemberWorkResult> {
    await this.getTeamMemberOrThrow(teamRunId, memberId);

    const activeInvocations = await prisma.agentInvocation.findMany({
      where: {
        teamRunId,
        memberId,
        status: { in: STOPPABLE_INVOCATION_STATUSES },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    const stoppedSessionIds: string[] = [];
    const queuedInvocationIds = activeInvocations
      .filter((invocation) => invocation.sessionId == null)
      .map((invocation) => invocation.id);

    const queuedCancellation = queuedInvocationIds.length > 0
      ? await this.cancelInvocationsWithoutSession(queuedInvocationIds)
      : { cancelledInvocationIds: [], cancelledWorkRequestIds: [] };

    if (options.cancelQueued) {
      const cancelledQueuedRequestIds = await this.cancelQueuedWorkRequestsForMember(teamRunId, memberId);
      queuedCancellation.cancelledWorkRequestIds.push(...cancelledQueuedRequestIds);
    }

    const sessionIds = activeInvocations
      .map((invocation) => invocation.sessionId)
      .filter((sessionId): sessionId is string => sessionId != null);

    if (sessionIds.length > 0) {
      if (!this.sessionManager.stop) {
        throw new ServiceError('Session stop is not available', 'SESSION_STOP_UNAVAILABLE', 500);
      }

      for (const sessionId of sessionIds) {
        const stopped = await this.sessionManager.stop(sessionId);
        if (stopped) {
          stoppedSessionIds.push(sessionId);
        }
      }
    }

    const cancelledWorkRequestIds = Array.from(new Set(queuedCancellation.cancelledWorkRequestIds));
    const shouldStartNext = stoppedSessionIds.length > 0
      || queuedCancellation.cancelledInvocationIds.length > 0
      || cancelledWorkRequestIds.length > 0;
    const startedInvocations = shouldStartNext
      ? await this.startNextSessions(teamRunId)
      : [];

    if (shouldStartNext) {
      await this.emitTeamRunInvalidatedById(
        teamRunId,
        ['work-requests', 'agent-invocations', 'team-run'],
        'member-work-stopped'
      );
    }

    return {
      stoppedSessionIds,
      cancelledInvocationIds: queuedCancellation.cancelledInvocationIds,
      cancelledWorkRequestIds,
      startedInvocations,
    };
  }

  releaseInvocationLocks(invocationId: string): void {
    this.lockService.releaseByOwner(invocationId);
  }

  private async createInvocationForClaimedWorkRequest(
    teamRun: SchedulerTeamRun,
    member: PrismaTeamMember,
    workRequest: PrismaWorkRequest,
    invocationId: string,
    workspaceId: string | null
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
          workspaceId,
          sessionId: null,
          status: 'QUEUED',
        },
      });
    });
  }

  private async createRunningInvocationForClaimedWorkRequest(
    teamRun: SchedulerTeamRun,
    member: PrismaTeamMember,
    workRequest: PrismaWorkRequest,
    invocationId: string,
    workspaceId: string,
    sessionId: string
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
          workspaceId,
          sessionId,
          status: 'RUNNING',
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
              where: {
                status: 'ACTIVE',
                parentWorkspaceId: null,
              },
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

  private async getTeamMemberOrThrow(teamRunId: string, memberId: string): Promise<PrismaTeamMember> {
    const member = await prisma.teamMember.findFirst({ where: { id: memberId, teamRunId } });
    if (member) {
      return member;
    }

    const teamRun = await prisma.teamRun.findUnique({
      where: { id: teamRunId },
      select: { id: true },
    });
    if (!teamRun) {
      throw new NotFoundError('TeamRun', teamRunId);
    }
    throw new NotFoundError('TeamMember', memberId);
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

  private async cancelInvocationsWithoutSession(invocationIds: string[]): Promise<{
    cancelledInvocationIds: string[];
    cancelledWorkRequestIds: string[];
  }> {
    if (invocationIds.length === 0) {
      return { cancelledInvocationIds: [], cancelledWorkRequestIds: [] };
    }

    const cancelled = await prisma.$transaction(async (tx) => {
      const invocations = await tx.agentInvocation.findMany({
        where: {
          id: { in: invocationIds },
          sessionId: null,
          status: { in: STOPPABLE_INVOCATION_STATUSES },
        },
        select: { id: true, workRequestId: true },
      });
      if (invocations.length === 0) {
        return { invocationIds: [], workRequestIds: [] };
      }

      const cancellableWorkRequestIds = invocations.map((invocation) => invocation.workRequestId);

      await tx.agentInvocation.updateMany({
        where: { id: { in: invocations.map((invocation) => invocation.id) } },
        data: {
          status: 'CANCELLED',
          nextRoomReplyReminderAt: null,
        },
      });

      await tx.workRequest.updateMany({
        where: {
          id: { in: cancellableWorkRequestIds },
          status: { in: ['PENDING_APPROVAL', 'QUEUED', 'STARTED'] },
        },
        data: { status: 'CANCELLED' },
      });

      return {
        invocationIds: invocations.map((invocation) => invocation.id),
        workRequestIds: cancellableWorkRequestIds,
      };
    });

    for (const invocationId of cancelled.invocationIds) {
      this.releaseInvocationLocks(invocationId);
    }

    return {
      cancelledInvocationIds: cancelled.invocationIds,
      cancelledWorkRequestIds: cancelled.workRequestIds,
    };
  }

  private async cancelQueuedWorkRequestsForMember(teamRunId: string, memberId: string): Promise<string[]> {
    const workRequests = await prisma.workRequest.findMany({
      where: {
        teamRunId,
        targetMemberId: memberId,
        status: { in: CANCELLABLE_QUEUED_WORK_REQUEST_STATUSES },
      },
      select: { id: true },
    });
    if (workRequests.length === 0) {
      return [];
    }

    const workRequestIds = workRequests.map((workRequest) => workRequest.id);
    await prisma.workRequest.updateMany({
      where: {
        id: { in: workRequestIds },
        status: { in: CANCELLABLE_QUEUED_WORK_REQUEST_STATUSES },
      },
      data: { status: 'CANCELLED' },
    });
    return workRequestIds;
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

  private async getOrCreateWorkspaceForMember(
    teamRun: SchedulerTeamRun,
    member: PrismaTeamMember,
  ): Promise<{ id: string }> {
    if (member.workspacePolicy === 'dedicated') {
      return this.getOrCreateDedicatedWorkspace(teamRun, member);
    }

    return this.getOrCreateSharedWorkspace(teamRun);
  }

  private async resolveQueuedInvocationWorkspaceId(
    teamRun: SchedulerTeamRun,
    member: PrismaTeamMember,
  ): Promise<string | null> {
    if (member.workspacePolicy !== 'dedicated') {
      return this.resolveInvocationWorkspaceId(teamRun, member);
    }

    const workspace = await this.getOrCreateDedicatedWorkspace(teamRun, member);
    await this.emitTeamRunInvalidated(teamRun, ['workspaces'], 'agent-invocation-updated');
    return workspace.id;
  }

  private async getOrCreateSharedWorkspace(teamRun: SchedulerTeamRun): Promise<{ id: string }> {
    const existingClaim = TeamSchedulerService.sharedWorkspaceClaims.get(teamRun.taskId);
    if (existingClaim) {
      return existingClaim;
    }

    const claim = this.findOrCreateSharedWorkspace(teamRun);
    TeamSchedulerService.sharedWorkspaceClaims.set(teamRun.taskId, claim);

    try {
      return await claim;
    } finally {
      if (TeamSchedulerService.sharedWorkspaceClaims.get(teamRun.taskId) === claim) {
        TeamSchedulerService.sharedWorkspaceClaims.delete(teamRun.taskId);
      }
    }
  }

  private async findOrCreateSharedWorkspace(teamRun: SchedulerTeamRun): Promise<{ id: string }> {
    if (this.workspaceService.getOrCreateMainWorkspace) {
      const workspace = await this.workspaceService.getOrCreateMainWorkspace(teamRun.id);
      await this.emitTeamRunInvalidated(teamRun, ['workspaces', 'team-run'], 'agent-invocation-updated');
      return workspace;
    }

    const activeWorkspace = await prisma.workspace.findFirst({
      where: {
        taskId: teamRun.taskId,
        parentWorkspaceId: null,
        status: 'ACTIVE',
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });

    if (activeWorkspace) {
      return activeWorkspace;
    }

    const workspace = await this.workspaceService.create(teamRun.taskId);
    await this.emitTeamRunInvalidated(teamRun, ['workspaces'], 'agent-invocation-updated');
    return workspace;
  }

  private async getOrCreateDedicatedWorkspace(
    teamRun: SchedulerTeamRun,
    member: PrismaTeamMember,
  ): Promise<{ id: string }> {
    if (!this.workspaceService.getOrCreateDedicatedWorkspace) {
      throw new ServiceError('Dedicated workspace startup is not available', 'DEDICATED_WORKSPACE_UNAVAILABLE', 500);
    }

    const workspace = await this.workspaceService.getOrCreateDedicatedWorkspace(teamRun.id, member.id);
    await this.emitTeamRunInvalidated(teamRun, ['workspaces', 'team-run'], 'agent-invocation-updated');
    return workspace;
  }

  private buildSessionPrompt(member: PrismaTeamMember, workRequest: PrismaWorkRequest): string {
    return `${member.rolePrompt}\n\nTask:\n${workRequest.instruction}`;
  }

  private async findResumeSourceSessionId(
    member: PrismaTeamMember,
    currentSessionId: string,
    workspaceId: string,
  ): Promise<string | null> {
    if (member.sessionPolicy !== 'resume_last') {
      return null;
    }

    const previousInvocation = await prisma.agentInvocation.findFirst({
      where: {
        memberId: member.id,
        workspaceId,
        sessionId: {
          not: null,
          notIn: [currentSessionId],
        },
      },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      select: {
        sessionId: true,
      },
    });

    if (!previousInvocation?.sessionId) {
      return null;
    }

    const previousSession = await prisma.session.findUnique({
      where: { id: previousInvocation.sessionId },
      select: { logSnapshot: true },
    });

    if (!previousSession?.logSnapshot) {
      return null;
    }

    return previousInvocation.sessionId;
  }

  private async markInvocationStartFailed(invocationId: string, sessionId: string): Promise<void> {
    await prisma.$transaction([
      prisma.agentInvocation.update({
        where: { id: invocationId },
        data: { status: 'FAILED' },
      }),
      prisma.session.update({
        where: { id: sessionId },
        data: { status: 'FAILED' },
      }),
    ]);
  }

  private async emitTeamRunInvalidated(
    teamRun: SchedulerTeamRun,
    scopes: TeamRunInvalidationScope[],
    reason: TeamRunInvalidationReason
  ): Promise<void> {
    await emitTeamRunInvalidated({
      teamRunId: teamRun.id,
      taskId: teamRun.taskId,
      projectId: teamRun.task.projectId,
      scopes,
      reason,
    });
  }

  private async emitTeamRunInvalidatedById(
    teamRunId: string,
    scopes: TeamRunInvalidationScope[],
    reason: TeamRunInvalidationReason
  ): Promise<void> {
    await emitTeamRunInvalidated({ teamRunId, scopes, reason });
  }

  private async markSessionFailed(sessionId: string): Promise<void> {
    await prisma.session.update({
      where: { id: sessionId },
      data: { status: 'FAILED' },
    });
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
    if (member.workspacePolicy === 'dedicated') {
      return null;
    }

    if (member.workspacePolicy !== 'shared' && member.workspacePolicy !== 'none') {
      return null;
    }

    return teamRun.mainWorkspaceId ?? teamRun.task.workspaces[0]?.id ?? null;
  }

  private resolveLockWorkspaceId(teamRun: SchedulerTeamRun, member: PrismaTeamMember): string | null {
    if (member.workspacePolicy !== 'shared') {
      return null;
    }

    return `task:${teamRun.taskId}`;
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
