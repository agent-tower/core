import { createHash, randomUUID } from 'node:crypto';
import type {
  AgentInvocation,
  AgentInvocationStatus,
  AgentInvocationTargetSyncStatus,
  IfBusyPolicy,
  TeamRunInvalidationReason,
  TeamRunInvalidationScope,
  TeamMemberCapabilities,
  TeamMemberQueueManagementPolicy,
  WorkRequestTargetKind,
  WorkRequestTargetPurpose,
  WorkRequest,
  WorkRequestRequesterType,
  WorkRequestStatus,
  WorkspacePolicy,
} from '@agent-tower/shared';
import type {
  AgentInvocation as PrismaAgentInvocation,
  Prisma,
  TeamMember as PrismaTeamMember,
  WorkRequest as PrismaWorkRequest,
  Workspace as PrismaWorkspace,
} from '@prisma/client';
import { AgentType } from '../types/index.js';
import { getProviderById, type Provider } from '../executors/index.js';
import { getEventBus, getSessionManager } from '../core/container.js';
import { NotFoundError, ServiceError } from '../errors.js';
import { prisma } from '../utils/index.js';
import { TeamLockService, defaultTeamLockService, type LockRequest } from './team-lock.service.js';
import { WorkspaceService } from './workspace.service.js';
import { appendAttachmentMarkdownContext } from './attachment-context.js';
import { emitTeamRunInvalidated } from './team-run-events.js';
import { TeamReconcilerService } from './team-reconciler.service.js';
import { ensureTaskNotDeleted, isTaskDeleted } from './deleted-task-guard.js';
import { TEAM_ROOM_SYSTEM_SHARED_PROTOCOL } from '../prompts/team-room-system-shared-protocol.js';

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

export interface WorkRequestControlOptions {
  teamRunId?: string;
  requesterMemberId?: string;
}

export interface CancelWorkRequestOptions {
  teamRunId: string;
  requesterMemberId: string;
}

type SchedulerTeamRun = {
  id: string;
  taskId: string;
  mainWorkspaceId: string | null;
  task: {
    projectId: string;
    title: string;
    description: string | null;
    deletedAt: Date | null;
    workspaces: PrismaWorkspace[];
  };
};

type WorkspaceStarter = {
  create(taskId: string): Promise<{ id: string }>;
  getOrCreateMainWorkspace?(teamRunId: string): Promise<{ id: string }>;
  getOrCreateDedicatedWorkspace?(teamRunId: string, memberId: string): Promise<{ id: string }>;
  prepareTargetedExecutionWorkspace?(input: PrepareTargetedExecutionWorkspaceInput): Promise<PrepareTargetedExecutionWorkspaceResult>;
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
  stop?(id: string, options?: { skipTeamRunReconcile?: boolean }): Promise<unknown>;
};

type TeamRunReviewAdvancer = {
  maybeAdvanceTeamRunToReview(teamRunId: string): Promise<boolean>;
};

type WorkRequestTargetSnapshot = {
  targetKind: WorkRequestTargetKind;
  targetPurpose: WorkRequestTargetPurpose;
  targetSourceWorkspaceId: string;
  targetSourceMemberId: string | null;
  targetHeadSha: string;
  targetBranchName: string;
  targetPlanItemId: string | null;
};

type PrepareTargetedExecutionWorkspaceInput = WorkRequestTargetSnapshot & {
  teamRunId: string;
  executionWorkspaceId: string;
  memberId: string;
};

type PrepareTargetedExecutionWorkspaceResult = {
  executionBranch: string;
};

type TargetPortAllocation = {
  targetPort: number;
  targetVitePort: number;
  targetE2EPort: number;
};

type InvocationTargetStartData = Partial<TargetPortAllocation> & {
  targetSyncStatus?: AgentInvocationTargetSyncStatus | null;
  targetSyncError?: string | null;
  targetExecutionBranch?: string | null;
};

interface TeamSchedulerDependencies {
  workspaceService?: WorkspaceStarter;
  sessionManager?: SessionStarter;
  getProviderById?: (providerId: string) => Provider | null;
  teamRunReviewAdvancer?: TeamRunReviewAdvancer;
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
const DEFAULT_QUEUE_MANAGEMENT_POLICY: TeamMemberQueueManagementPolicy = 'own_only';
const TARGET_REVIEW_TEST_PURPOSES = new Set(['REVIEW', 'TEST']);

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

function normalizeTargetPurpose(value: string | null | undefined): WorkRequestTargetPurpose | null {
  return value === 'REVIEW' || value === 'TEST' ? value : null;
}

function getWorkRequestTarget(workRequest: PrismaWorkRequest): WorkRequestTargetSnapshot | null {
  if (!workRequest.targetKind) {
    return null;
  }
  if (workRequest.targetKind !== 'WORKSPACE_COMMIT') {
    throw new ServiceError('Unsupported WorkRequest target kind', 'WORK_REQUEST_TARGET_KIND_UNSUPPORTED', 400);
  }
  const purpose = normalizeTargetPurpose(workRequest.targetPurpose);
  if (!purpose || !TARGET_REVIEW_TEST_PURPOSES.has(purpose)) {
    throw new ServiceError('Targeted WorkRequest purpose must be REVIEW or TEST', 'WORK_REQUEST_TARGET_PURPOSE_INVALID', 400);
  }
  if (!workRequest.targetSourceWorkspaceId || !workRequest.targetHeadSha || !workRequest.targetBranchName) {
    throw new ServiceError('Targeted WorkRequest is missing target commit fields', 'WORK_REQUEST_TARGET_INCOMPLETE', 400);
  }

  return {
    targetKind: 'WORKSPACE_COMMIT',
    targetPurpose: purpose,
    targetSourceWorkspaceId: workRequest.targetSourceWorkspaceId,
    targetSourceMemberId: workRequest.targetSourceMemberId,
    targetHeadSha: workRequest.targetHeadSha,
    targetBranchName: workRequest.targetBranchName,
    targetPlanItemId: workRequest.targetPlanItemId,
  };
}

function targetDataFromWorkRequest(workRequest: PrismaWorkRequest): Partial<PrismaAgentInvocation> {
  return {
    targetKind: workRequest.targetKind,
    targetPurpose: workRequest.targetPurpose,
    targetSourceWorkspaceId: workRequest.targetSourceWorkspaceId,
    targetSourceMemberId: workRequest.targetSourceMemberId,
    targetHeadSha: workRequest.targetHeadSha,
    targetBranchName: workRequest.targetBranchName,
    targetPlanItemId: workRequest.targetPlanItemId,
  };
}

function targetErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function targetedWorkspacePolicyError(
  member: Pick<PrismaTeamMember, 'name' | 'workspacePolicy'>,
  target: WorkRequestTargetSnapshot
): string {
  return `Targeted ${target.targetPurpose} requests require workspacePolicy=dedicated; ${member.name} is configured with workspacePolicy=${member.workspacePolicy}`;
}

function buildTargetHandoffPrompt(workRequest: PrismaWorkRequest): string {
  const target = getWorkRequestTarget(workRequest);
  if (!target) {
    return '';
  }

  const lines = [
    'Target commit handoff:',
    `- purpose: ${target.targetPurpose}`,
    `- sourceWorkspaceId: ${target.targetSourceWorkspaceId}`,
    `- targetHeadSha: ${target.targetHeadSha}`,
    `- sourceBranch: ${target.targetBranchName}`,
  ];
  if (target.targetPlanItemId) {
    lines.push(`- planItemId: ${target.targetPlanItemId}`);
  }
  lines.push(
    '- The execution workspace is synced to targetHeadSha before this session starts.',
    '- Record review/test verdicts against sourceWorkspaceId with reviewed_sha=targetHeadSha.'
  );
  return lines.join('\n');
}

function allocateTargetPorts(invocationId: string, target: WorkRequestTargetSnapshot | null): TargetPortAllocation | null {
  if (target?.targetPurpose !== 'TEST') {
    return null;
  }
  const hash = createHash('sha256').update(invocationId).digest();
  const slot = hash.readUInt16BE(0) % 1000;
  const base = 20_000 + slot * 10;
  return {
    targetPort: base,
    targetVitePort: base + 1,
    targetE2EPort: base + 2,
  };
}

function serializeTargetKind(value: string | null): WorkRequestTargetKind | null {
  return value === 'WORKSPACE_COMMIT' ? value : null;
}

function serializeTargetPurpose(value: string | null): WorkRequestTargetPurpose | null {
  return value === 'REVIEW' || value === 'TEST' ? value : null;
}

function serializeTargetSyncStatus(value: string | null): AgentInvocationTargetSyncStatus | null {
  return value === 'PENDING' || value === 'SYNCED' || value === 'FAILED' ? value : null;
}

export class TeamSchedulerService {
  private static readonly memberSchedulingLocks = new Set<string>();
  private static readonly sharedWorkspaceClaims = new Map<string, Promise<{ id: string }>>();
  private readonly workspaceService: WorkspaceStarter;
  private readonly sessionManager: SessionStarter;
  private readonly providerLookup: (providerId: string) => Provider | null;
  private readonly teamRunReviewAdvancer: TeamRunReviewAdvancer;

  constructor(
    private readonly lockService = defaultTeamLockService,
    dependencies: TeamSchedulerDependencies = {}
  ) {
    this.workspaceService = dependencies.workspaceService ?? new WorkspaceService();
    this.sessionManager = dependencies.sessionManager ?? getSessionManager();
    this.providerLookup = dependencies.getProviderById ?? getProviderById;
    this.teamRunReviewAdvancer = dependencies.teamRunReviewAdvancer ?? new TeamReconcilerService({
      eventBus: getEventBus(),
      scheduler: {
        releaseInvocationLocks: (invocationId) => this.releaseInvocationLocks(invocationId),
        startNextSessions: (nextTeamRunId) => this.startNextSessions(nextTeamRunId),
      },
    });
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

      const target = getWorkRequestTarget(workRequest);
      const workspaceId = this.resolveInvocationWorkspaceId(context.teamRun, member);
      const projectId = context.teamRun.task.projectId;
      const lockKeys = this.getRequiredLocks(context.teamRun, member);
      const requiresStopCurrent = workRequest.ifBusy === 'cancel_current_and_start'
        && activeMemberIds.has(member.id);

      if (target && member.workspacePolicy !== 'dedicated') {
        plans.push({
          workRequestId: workRequest.id,
          memberId: member.id,
          canStart: false,
          blockedReason: 'unsupported_workspace_policy',
          requiresStopCurrent,
          lockKeys,
          workspaceId,
          projectId,
        });
        continue;
      }

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
    let createdTerminalInvocation = false;

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
          console.warn(
            '[TeamSchedulerService] Skipping TeamRun WorkRequest because provider was not found:',
            {
              teamRunId,
              workRequestId: freshWorkRequest.id,
              memberId: member.id,
              providerId: member.providerId,
            }
          );
          const failedInvocation = await this.createFailedInvocationForClaimedWorkRequest(
            context.teamRun,
            member,
            freshWorkRequest,
            invocationId,
            null
          );
          this.lockService.releaseByOwner(invocationId);
          invocationId = null;
          if (failedInvocation) {
            createdTerminalInvocation = true;
            await this.emitTeamRunInvalidated(
              context.teamRun,
              ['work-requests', 'agent-invocations'],
              'agent-invocation-updated'
            );
          }
          continue;
        }

        const target = getWorkRequestTarget(freshWorkRequest);
        if (target && member.workspacePolicy !== 'dedicated') {
          const targetSyncError = targetedWorkspacePolicyError(member, target);
          const failedInvocation = await this.createFailedInvocationForClaimedWorkRequest(
            context.teamRun,
            member,
            freshWorkRequest,
            invocationId,
            null,
            targetSyncError,
            'FAILED'
          );
          this.lockService.releaseByOwner(invocationId);
          invocationId = null;
          if (failedInvocation) {
            createdTerminalInvocation = true;
            await this.createTargetedWorkspacePolicyFailureRoomMessage(
              context.teamRun,
              member,
              freshWorkRequest,
              failedInvocation,
              target,
              targetSyncError
            );
            await this.emitTeamRunInvalidated(
              context.teamRun,
              ['work-requests', 'agent-invocations', 'room-messages'],
              'agent-invocation-updated'
            );
          }
          continue;
        }

        const workspace = target
          ? await this.getOrCreateDedicatedWorkspace(context.teamRun, member)
          : await this.getOrCreateWorkspaceForMember(context.teamRun, member);
        let targetSyncStatus: AgentInvocationTargetSyncStatus | null = null;
        let targetSyncError: string | null = null;
        let targetExecutionBranch: string | null = null;
        const targetPorts = allocateTargetPorts(invocationId, target);
        if (target) {
          try {
            const syncResult = await this.prepareTargetedExecutionWorkspace(
              context.teamRun,
              member,
              workspace.id,
              target
            );
            targetSyncStatus = 'SYNCED';
            targetExecutionBranch = syncResult.executionBranch;
          } catch (error) {
            targetSyncStatus = 'FAILED';
            targetSyncError = targetErrorMessage(error);
            const failedInvocation = await this.createFailedInvocationForClaimedWorkRequest(
              context.teamRun,
              member,
              freshWorkRequest,
              invocationId,
              workspace.id,
              targetSyncError,
              targetSyncStatus,
              {
                targetExecutionBranch,
                ...targetPorts,
              }
            );
            this.lockService.releaseByOwner(invocationId);
            invocationId = null;
            if (failedInvocation) {
              createdTerminalInvocation = true;
              await this.emitTeamRunInvalidated(
                context.teamRun,
                ['work-requests', 'agent-invocations', 'workspaces'],
                'agent-invocation-updated'
              );
            }
            continue;
          }
        }

        const session = await this.sessionManager.create(
          workspace.id,
          provider.agentType as AgentType,
          await this.buildSessionPrompt(context.teamRun, member, freshWorkRequest),
          'DEFAULT',
          member.providerId
        );

        const createdInvocation = await this.createRunningInvocationForClaimedWorkRequest(
          context.teamRun,
          member,
          freshWorkRequest,
          invocationId,
          workspace.id,
          session.id,
          {
            targetSyncStatus,
            targetSyncError,
            targetExecutionBranch,
            ...targetPorts,
          }
        );

        if (!createdInvocation) {
          await this.markSessionFailed(session.id);
          this.lockService.releaseByOwner(invocationId);
          invocationId = null;
          continue;
        }

        const resumeFromSessionId = await this.findResumeSourceSessionId(member, session.id, workspace.id, target?.targetHeadSha ?? null);
        try {
          if (resumeFromSessionId && this.sessionManager.startFollowUp) {
            await this.sessionManager.startFollowUp(session.id, resumeFromSessionId);
          } else {
            await this.sessionManager.start(session.id);
          }
        } catch (error) {
          await this.markInvocationStartFailed(createdInvocation.id, session.id);
          this.lockService.releaseByOwner(createdInvocation.id);
          createdTerminalInvocation = true;
          await this.emitTeamRunInvalidated(
            context.teamRun,
            ['work-requests', 'agent-invocations'],
            'agent-invocation-updated'
          );
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
        if (createdTerminalInvocation) {
          await this.teamRunReviewAdvancer.maybeAdvanceTeamRunToReview(teamRunId);
        }
        throw error;
      } finally {
        this.releaseMemberSchedulingLock(memberLockKey);
      }
    }

    if (createdTerminalInvocation) {
      await this.teamRunReviewAdvancer.maybeAdvanceTeamRunToReview(teamRunId);
    }

    return startedInvocations;
  }

  async approveWorkRequest(
    workRequestId: string,
    options?: WorkRequestControlOptions
  ): Promise<WorkRequest> {
    const current = await this.getWorkRequestOrThrow(workRequestId);
    await this.assertMemberCanControlWorkRequest(current, options, 'approve');

    const workRequest = await this.transitionWorkRequestStatus(
      workRequestId,
      'approve',
      ['PENDING_APPROVAL'],
      'QUEUED'
    );
    await this.emitTeamRunInvalidatedById(workRequest.teamRunId, ['work-requests', 'team-run'], 'work-request-updated');
    return workRequest;
  }

  async approveWorkRequestAndStartNext(
    workRequestId: string,
    options?: WorkRequestControlOptions
  ): Promise<{
    workRequest: WorkRequest;
    startedInvocations: AgentInvocation[];
  }> {
    const workRequest = await this.approveWorkRequest(workRequestId, options);
    const startedInvocations = await this.startNextSessions(workRequest.teamRunId);
    return { workRequest, startedInvocations };
  }

  async rejectWorkRequest(
    workRequestId: string,
    options?: WorkRequestControlOptions
  ): Promise<WorkRequest> {
    const current = await this.getWorkRequestOrThrow(workRequestId);
    await this.assertMemberCanControlWorkRequest(current, options, 'reject');

    const workRequest = await this.transitionWorkRequestStatus(
      workRequestId,
      'reject',
      ['PENDING_APPROVAL'],
      'REJECTED'
    );
    await this.emitTeamRunInvalidatedById(workRequest.teamRunId, ['work-requests', 'team-run'], 'work-request-updated');
    return workRequest;
  }

  async cancelWorkRequest(
    workRequestId: string,
    options: CancelWorkRequestOptions
  ): Promise<WorkRequest> {
    if (!options?.teamRunId || !options.requesterMemberId) {
      throw new ServiceError(
        'teamRunId and requesterMemberId are required when cancelling a TeamRun WorkRequest',
        'VALIDATION_ERROR',
        400
      );
    }

    const current = await this.getWorkRequestOrThrow(workRequestId);
    if (current.teamRunId !== options.teamRunId) {
      throw new NotFoundError('WorkRequest', workRequestId);
    }
    await this.assertMemberCanControlWorkRequest(current, options, 'cancel');

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
    workspaceId: string | null,
    targetStartData: InvocationTargetStartData = {}
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
          ...targetDataFromWorkRequest(workRequest),
          targetSyncStatus: targetStartData.targetSyncStatus ?? null,
          targetSyncError: targetStartData.targetSyncError ?? null,
          targetExecutionBranch: targetStartData.targetExecutionBranch ?? null,
          targetPort: targetStartData.targetPort ?? null,
          targetVitePort: targetStartData.targetVitePort ?? null,
          targetE2EPort: targetStartData.targetE2EPort ?? null,
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
    sessionId: string,
    targetStartData: InvocationTargetStartData = {}
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
          ...targetDataFromWorkRequest(workRequest),
          targetSyncStatus: targetStartData.targetSyncStatus ?? null,
          targetSyncError: targetStartData.targetSyncError ?? null,
          targetExecutionBranch: targetStartData.targetExecutionBranch ?? null,
          targetPort: targetStartData.targetPort ?? null,
          targetVitePort: targetStartData.targetVitePort ?? null,
          targetE2EPort: targetStartData.targetE2EPort ?? null,
          status: 'RUNNING',
        },
      });
    });
  }

  private async createFailedInvocationForClaimedWorkRequest(
    teamRun: SchedulerTeamRun,
    member: PrismaTeamMember,
    workRequest: PrismaWorkRequest,
    invocationId: string,
    workspaceId: string | null,
    targetSyncError: string | null = null,
    targetSyncStatus: AgentInvocationTargetSyncStatus | null = null,
    targetStartData: InvocationTargetStartData = {}
  ): Promise<PrismaAgentInvocation | null> {
    return prisma.$transaction(async (tx) => {
      const claimed = await tx.workRequest.updateMany({
        where: {
          id: workRequest.id,
          teamRunId: teamRun.id,
          status: 'QUEUED',
        },
        data: { status: 'FAILED' },
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
          ...targetDataFromWorkRequest(workRequest),
          targetSyncStatus,
          targetSyncError,
          targetExecutionBranch: targetStartData.targetExecutionBranch ?? null,
          targetPort: targetStartData.targetPort ?? null,
          targetVitePort: targetStartData.targetVitePort ?? null,
          targetE2EPort: targetStartData.targetE2EPort ?? null,
          status: 'FAILED',
        },
      });
    });
  }

  private async createTargetedWorkspacePolicyFailureRoomMessage(
    teamRun: SchedulerTeamRun,
    member: PrismaTeamMember,
    workRequest: PrismaWorkRequest,
    invocation: PrismaAgentInvocation,
    target: WorkRequestTargetSnapshot,
    targetSyncError: string
  ): Promise<void> {
    const shortSha = target.targetHeadSha.slice(0, 12);
    const content = [
      `Targeted ${target.targetPurpose} request for ${member.name} failed before start.`,
      '',
      `Reason: ${targetSyncError}.`,
      `Target: ${shortSha} from source workspace ${target.targetSourceWorkspaceId}.`,
      '',
      'Action: change this TeamMember instance to workspacePolicy=dedicated, and update the MemberPreset or TeamTemplate for future TeamRuns. Then create a new targeted REVIEW/TEST request for the same commit.',
    ].join('\n');

    try {
      await prisma.roomMessage.create({
        data: {
          teamRunId: teamRun.id,
          senderType: 'system',
          senderId: null,
          senderInvocationId: invocation.id,
          kind: 'system',
          visibility: 'PUBLIC',
          content,
          mentions: JSON.stringify([]),
          workRequestIds: JSON.stringify([workRequest.id]),
          artifactRefs: JSON.stringify([]),
          attachmentIds: JSON.stringify([]),
        },
      });
    } catch (error) {
      console.warn('[TeamSchedulerService] Failed to create targeted workspace policy failure RoomMessage:', {
        teamRunId: teamRun.id,
        workRequestId: workRequest.id,
        invocationId: invocation.id,
        memberId: member.id,
        error,
      });
    }
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
    if (isTaskDeleted(teamRun.task)) {
      return {
        teamRun,
        memberById: new Map(),
        workRequests: [],
      };
    }

    const [members, workRequests] = await Promise.all([
      prisma.teamMember.findMany({
        where: { teamRunId, membershipStatus: 'ACTIVE' },
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

  private async assertMemberCanControlWorkRequest(
    workRequest: PrismaWorkRequest,
    options: WorkRequestControlOptions | undefined,
    action: 'approve' | 'reject' | 'cancel'
  ): Promise<void> {
    if (!options) {
      return;
    }

    if (!options.teamRunId || !options.requesterMemberId) {
      throw new ServiceError(
        `teamRunId and requesterMemberId are required when ${action}ing a TeamRun WorkRequest`,
        'VALIDATION_ERROR',
        400
      );
    }

    if (workRequest.teamRunId !== options.teamRunId) {
      throw new NotFoundError('WorkRequest', workRequest.id);
    }

    const requester = await this.getTeamMemberOrThrow(workRequest.teamRunId, options.requesterMemberId);
    if (requester.membershipStatus === 'REMOVED') {
      throw new ServiceError('Removed TeamRun members cannot control WorkRequests', 'FORBIDDEN', 403);
    }

    const requesterMemberId = options.requesterMemberId;
    if (workRequest.targetMemberId === requesterMemberId) {
      return;
    }

    if (this.resolveQueueManagementPolicy(requester.queueManagementPolicy) === 'team_pending') {
      return;
    }

    throw new ServiceError(
      `Current TeamRun member cannot ${action} WorkRequest for another member`,
      'FORBIDDEN',
      403
    );
  }

  private resolveQueueManagementPolicy(
    value: string | null | undefined
  ): TeamMemberQueueManagementPolicy {
    return value === 'team_pending' ? 'team_pending' : DEFAULT_QUEUE_MANAGEMENT_POLICY;
  }

  private async transitionWorkRequestStatus(
    workRequestId: string,
    action: 'approve' | 'reject' | 'cancel',
    allowedStatuses: WorkRequestStatus[],
    nextStatus: WorkRequestStatus
  ): Promise<WorkRequest> {
    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.workRequest.findUnique({
        where: { id: workRequestId },
        include: { teamRun: { include: { task: true } } },
      });
      if (!current) {
        return null;
      }
      ensureTaskNotDeleted(current.teamRun.task);

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

  private async prepareTargetedExecutionWorkspace(
    teamRun: SchedulerTeamRun,
    member: PrismaTeamMember,
    executionWorkspaceId: string,
    target: WorkRequestTargetSnapshot
  ): Promise<PrepareTargetedExecutionWorkspaceResult> {
    if (!this.workspaceService.prepareTargetedExecutionWorkspace) {
      throw new ServiceError(
        'Targeted workspace sync is not available',
        'TARGETED_WORKSPACE_SYNC_UNAVAILABLE',
        500
      );
    }

    return this.workspaceService.prepareTargetedExecutionWorkspace({
      teamRunId: teamRun.id,
      memberId: member.id,
      executionWorkspaceId,
      ...target,
    });
  }

  private async buildSessionPrompt(
    teamRun: SchedulerTeamRun,
    member: PrismaTeamMember,
    workRequest: PrismaWorkRequest
  ): Promise<string> {
    const triggerMessage = await prisma.roomMessage.findUnique({
      where: { id: workRequest.triggerMessageId },
      select: { content: true, attachmentIds: true },
    });
    const attachmentIds = parseJsonField<string[]>(triggerMessage?.attachmentIds, []);
    const taskContext = [
      teamRun.task.title.trim(),
      teamRun.task.description?.trim() ?? '',
    ].filter(Boolean).join('\n\n');
    const targetContext = buildTargetHandoffPrompt(workRequest);
    const triggerContent = triggerMessage?.content?.trim() ?? '';
    const instructionParts = [
      taskContext,
      targetContext,
      triggerContent && triggerContent !== taskContext ? `Triggering room message:\n${triggerContent}` : '',
      workRequest.instruction.trim() && workRequest.instruction.trim() !== triggerContent
        ? `Work request summary:\n${workRequest.instruction.trim()}`
        : '',
    ].filter(Boolean);
    const instruction = await appendAttachmentMarkdownContext(instructionParts.join('\n\n'), attachmentIds);

    return `${TEAM_ROOM_SYSTEM_SHARED_PROTOCOL}\n\n${member.rolePrompt}\n\nTask:\n${instruction}`;
  }

  private async findResumeSourceSessionId(
    member: PrismaTeamMember,
    currentSessionId: string,
    workspaceId: string,
    targetHeadSha: string | null,
  ): Promise<string | null> {
    if (member.sessionPolicy !== 'resume_last') {
      return null;
    }

    const previousInvocation = await prisma.agentInvocation.findFirst({
      where: {
        memberId: member.id,
        workspaceId,
        targetHeadSha: targetHeadSha == null ? null : targetHeadSha,
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
    await prisma.$transaction(async (tx) => {
      const invocation = await tx.agentInvocation.update({
        where: { id: invocationId },
        data: { status: 'FAILED' },
        select: { workRequestId: true },
      });
      await tx.workRequest.updateMany({
        where: {
          id: invocation.workRequestId,
          status: 'STARTED',
        },
        data: { status: 'FAILED' },
      });
      await tx.session.update({
        where: { id: sessionId },
        data: { status: 'FAILED' },
      });
    });
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
      targetKind: serializeTargetKind(workRequest.targetKind),
      targetPurpose: serializeTargetPurpose(workRequest.targetPurpose),
      ifBusy: workRequest.ifBusy as IfBusyPolicy,
      status: workRequest.status as WorkRequestStatus,
      createdAt: toIso(workRequest.createdAt),
      updatedAt: toIso(workRequest.updatedAt),
    };
  }

  private serializeAgentInvocation(invocation: PrismaAgentInvocation): AgentInvocation {
    return {
      ...invocation,
      targetKind: serializeTargetKind(invocation.targetKind),
      targetPurpose: serializeTargetPurpose(invocation.targetPurpose),
      targetSyncStatus: serializeTargetSyncStatus(invocation.targetSyncStatus),
      status: invocation.status as AgentInvocationStatus,
      createdAt: toIso(invocation.createdAt),
      updatedAt: toIso(invocation.updatedAt),
      nextRoomReplyReminderAt: invocation.nextRoomReplyReminderAt
        ? toIso(invocation.nextRoomReplyReminderAt)
        : null,
      lastHeartbeatAt: invocation.lastHeartbeatAt ? toIso(invocation.lastHeartbeatAt) : null,
      firstNudgeAt: invocation.firstNudgeAt ? toIso(invocation.firstNudgeAt) : null,
    };
  }
}
