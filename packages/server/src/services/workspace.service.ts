import { prisma } from '../utils/index.js';
import { WorkspaceKind, WorkspaceStatus, TaskStatus, SessionStatus, SessionPurpose } from '../types/index.js';
import { WorktreeManager } from '../git/worktree.manager.js';
import { execGit, MergeConflictError } from '../git/git-cli.js';
import { NotFoundError, ServiceError } from '../errors.js';
import { getSessionManager, getEventBus } from '../core/container.js';
import { copyProjectFiles } from './copy-files.service.js';
import { defaultTeamLockService, type TeamLockService } from './team-lock.service.js';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Prisma } from '@prisma/client';
import type { EventBus } from '../core/event-bus.js';
import type {
  GitOperationStatus,
  MergeableWorkspaceItem,
  MergeableWorkspacesResponse,
  MergeReadinessBlocker,
  MergeTeamRunMemberResult,
  MergeTeamRunMembersInput,
  MergeTeamRunMembersResponse,
  TeamMemberCapabilities,
  WorkspaceVerdict,
  WorkspaceVerdictKind,
  WorkspaceVerdictValue,
} from '@agent-tower/shared';
import {
  ensureProjectIsMutable,
  ensureProjectSupportsWorktrees,
  hasGitMetadata,
} from './project-guards.js';
import { ensureTaskNotDeleted } from './deleted-task-guard.js';
import {
  getWorkspaceWorkingDir,
  isMainDirectoryWorkspace,
  isWorktreeWorkspace,
} from './workspace-kind.js';

const DEFAULT_IDLE_THRESHOLD_HOURS = 24;
const WORKSPACE_READY_RETRY_COUNT = 20;
const WORKSPACE_READY_RETRY_DELAY_MS = 50;
const DEFAULT_TEAM_MEMBER_CAPABILITIES: TeamMemberCapabilities = {
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

const execAsync = promisify(exec);

/** 过滤条件：只返回用户可见的 CHAT session，且不在 workspace 热路径携带 prompt/logSnapshot。 */
const visibleSessionsFilter = {
  where: { purpose: { not: SessionPurpose.COMMIT_MSG } },
  select: {
    id: true,
    workspaceId: true,
    agentType: true,
    variant: true,
    providerId: true,
    status: true,
    purpose: true,
    tokenUsage: true,
    createdAt: true,
    updatedAt: true,
  },
} satisfies Prisma.SessionFindManyArgs;
const activeSessionStatuses = [SessionStatus.PENDING, SessionStatus.RUNNING];
const activeInvocationStatuses = ['QUEUED', 'RUNNING', 'SESSION_ENDED', 'WAITING_ROOM_REPLY'];
const finalChildWorkspaceStatuses = [WorkspaceStatus.MERGED, WorkspaceStatus.ABANDONED];

export interface CreateWorkspaceOptions {
  branchName?: string;
  branchNamePrefix?: string;
  startPoint?: string | null;
  parentWorkspaceId?: string | null;
  ownerMemberId?: string | null;
  reuseInactive?: boolean;
  workspaceKind?: WorkspaceKind;
}

export interface MergeWorkspaceOptions {
  commitMessage?: string;
  lockOwnerId?: string;
  requesterMemberId?: string;
  invocationId?: string;
}

export interface RecordWorkspaceVerdictInput {
  kind: WorkspaceVerdictKind;
  verdict: WorkspaceVerdictValue;
  reviewedSha: string;
  reviewerMemberId: string;
  expectedTargetHeadSha?: string | null;
  reason?: string | null;
}

export interface WorkspaceInvocationIdentity {
  teamRunId: string;
  memberId: string;
  invocationId: string;
  targetHeadSha?: string | null;
  targetSourceWorkspaceId?: string | null;
}

export interface PrepareTargetedExecutionWorkspaceInput {
  teamRunId: string;
  memberId: string;
  executionWorkspaceId: string;
  targetKind: 'WORKSPACE_COMMIT';
  targetPurpose: 'REVIEW' | 'TEST';
  targetSourceWorkspaceId: string;
  targetSourceMemberId: string | null;
  targetHeadSha: string;
  targetBranchName: string;
  targetPlanItemId: string | null;
}

export interface PrepareTargetedExecutionWorkspaceResult {
  executionBranch: string;
}

export interface MergeTeamRunMembersOptions extends MergeTeamRunMembersInput {
  invocationId: string;
  requesterMemberId: string;
}

type WorkspaceWithTaskProject = Prisma.WorkspaceGetPayload<{
  include: { task: { include: { project: true } } };
}>;

type WorkspaceWithVisibleSessions = Prisma.WorkspaceGetPayload<{
  include: { sessions: typeof visibleSessionsFilter; task: { include: { project: true } } };
}>;

type MergeWorkspaceRecord = Prisma.WorkspaceGetPayload<{
  include: {
    task: {
      include: {
        project: true;
        teamRun: true;
      };
    };
  };
}>;

type TeamRunChildWorkspaceRecord = MergeWorkspaceRecord & {
  task: MergeWorkspaceRecord['task'] & { teamRun: NonNullable<MergeWorkspaceRecord['task']['teamRun']> };
  parentWorkspaceId: string;
  ownerMemberId: string;
};

type TeamRunMergeableRecord = Prisma.WorkspaceGetPayload<{
  include: {
    ownerMember: true;
    task: {
      include: {
        project: true;
        teamRun: true;
      };
    };
  };
}>;

type TeamRunMergeableWorkspaceRecord = TeamRunMergeableRecord & {
  task: TeamRunMergeableRecord['task'] & { teamRun: NonNullable<TeamRunMergeableRecord['task']['teamRun']> };
  parentWorkspaceId: string;
  ownerMemberId: string;
  ownerMember: NonNullable<TeamRunMergeableRecord['ownerMember']>;
};

type VerdictRecord = {
  id: string;
  workspaceId: string;
  teamRunId: string;
  kind: string;
  verdict: string;
  reviewedSha: string;
  reviewerMemberId: string | null;
  reason: string | null;
  sequence: number;
  createdAt: Date;
};

type MergeableComputationContext = {
  teamRunId: string;
  taskId: string;
  projectId: string;
  project: {
    name: string;
    repoPath: string;
    mainBranch: string;
    archivedAt: Date | null;
    repoDeletedAt: Date | null;
  };
  mainWorkspace: {
    id: string | null;
    branchName: string | null;
    status: string | null;
    worktreePath: string | null;
    headSha: string | null;
    hasActiveWriteSession: boolean;
  };
  generatedAt: string;
  workspaces: TeamRunMergeableWorkspaceRecord[];
  latestReviews: Map<string, VerdictRecord>;
  latestTests: Map<string, VerdictRecord>;
  ownerActiveMemberIds: Set<string>;
};

type NormalizedCreateWorkspaceOptions = Required<CreateWorkspaceOptions>;

type MergeLockTarget = {
  key: string;
  code: string;
  message: string;
};

function normalizeCreateOptions(input?: string | CreateWorkspaceOptions): NormalizedCreateWorkspaceOptions {
  if (typeof input === 'string') {
    return {
      branchName: input,
      branchNamePrefix: '',
      startPoint: null,
      parentWorkspaceId: null,
      ownerMemberId: null,
      reuseInactive: true,
      workspaceKind: WorkspaceKind.WORKTREE,
    };
  }

  return {
    branchName: input?.branchName ?? '',
    branchNamePrefix: input?.branchNamePrefix ?? '',
    startPoint: input?.startPoint ?? null,
    parentWorkspaceId: input?.parentWorkspaceId ?? null,
    ownerMemberId: input?.ownerMemberId ?? null,
    reuseInactive: input?.reuseInactive ?? true,
    workspaceKind: input?.workspaceKind ?? WorkspaceKind.WORKTREE,
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: string }).code === 'P2002';
}

function branchFromOptions(workspaceId: string, options: NormalizedCreateWorkspaceOptions): string {
  if (options.branchName) {
    return options.branchName;
  }

  if (options.branchNamePrefix) {
    return `${options.branchNamePrefix}/${workspaceId.slice(0, 8)}`;
  }

  return `at/${workspaceId.slice(0, 8)}`;
}

function teamRunBranchPrefix(teamRunId: string): string {
  return `at/team/${teamRunId.slice(0, 8)}`;
}

function targetExecutionBranchName(input: PrepareTargetedExecutionWorkspaceInput): string {
  return `${teamRunBranchPrefix(input.teamRunId)}/target/${input.targetPurpose.toLowerCase()}-${input.memberId.slice(0, 8)}-${input.targetHeadSha.slice(0, 12)}`;
}

function assertFullCommitSha(value: string): void {
  if (!/^[0-9a-f]{40}$/i.test(value)) {
    throw new ServiceError(
      'targetHeadSha must be a full 40-character commit SHA',
      'TARGET_HEAD_SHA_INVALID',
      400
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mainDirectoryGitStatus(): GitOperationStatus {
  return {
    operation: 'idle',
    conflictedFiles: [],
    conflictOp: null,
    ahead: 0,
    behind: 0,
    hasUncommittedChanges: false,
    uncommittedCount: 0,
    untrackedCount: 0,
  };
}

function toIso(date: Date): string {
  return date.toISOString();
}

function serializeWorkspaceVerdict(verdict: {
  id: string;
  workspaceId: string;
  teamRunId: string;
  kind: string;
  verdict: string;
  reviewedSha: string;
  reviewerMemberId: string | null;
  reason: string | null;
  sequence: number;
  createdAt: Date;
}): WorkspaceVerdict {
  return {
    id: verdict.id,
    workspaceId: verdict.workspaceId,
    teamRunId: verdict.teamRunId,
    kind: verdict.kind as WorkspaceVerdictKind,
    verdict: verdict.verdict as WorkspaceVerdictValue,
    reviewedSha: verdict.reviewedSha,
    reviewerMemberId: verdict.reviewerMemberId,
    reason: verdict.reason,
    sequence: verdict.sequence,
    createdAt: toIso(verdict.createdAt),
  };
}

function parseCapabilities(value: string | null | undefined): TeamMemberCapabilities {
  if (!value) {
    return DEFAULT_TEAM_MEMBER_CAPABILITIES;
  }

  try {
    return {
      ...DEFAULT_TEAM_MEMBER_CAPABILITIES,
      ...(JSON.parse(value) as Partial<TeamMemberCapabilities>),
    };
  } catch {
    return DEFAULT_TEAM_MEMBER_CAPABILITIES;
  }
}

function blocker(
  code: MergeReadinessBlocker['code'],
  severity: MergeReadinessBlocker['severity'],
  message: string,
  details?: Record<string, unknown>
): MergeReadinessBlocker {
  return details
    ? { code, severity, message, details }
    : { code, severity, message };
}

function serializeLatestVerdict(
  verdict: VerdictRecord | undefined,
  currentHeadSha: string | null,
  ownerMemberId: string
): MergeableWorkspaceItem['latestReview'] {
  if (!verdict) {
    return null;
  }

  return {
    id: verdict.id,
    verdict: verdict.verdict as WorkspaceVerdictValue,
    reviewedSha: verdict.reviewedSha,
    reviewerMemberId: verdict.reviewerMemberId,
    reason: verdict.reason,
    sequence: verdict.sequence,
    createdAt: toIso(verdict.createdAt),
    matchesHead: currentHeadSha !== null && verdict.reviewedSha === currentHeadSha,
    isSelfReview: verdict.reviewerMemberId === ownerMemberId,
  };
}

function resultSummary(
  results: MergeTeamRunMemberResult[],
  requested = results.length
): MergeTeamRunMembersResponse['summary'] {
  return {
    requested,
    considered: results.length,
    merged: results.filter((item) => item.status === 'MERGED').length,
    alreadyMerged: results.filter((item) => item.status === 'ALREADY_MERGED').length,
    wouldMerge: results.filter((item) => item.status === 'WOULD_MERGE').length,
    skipped: results.filter((item) => item.status === 'SKIPPED').length,
    conflicts: results.filter((item) => item.status === 'CONFLICT').length,
    failed: results.filter((item) => item.status === 'FAILED').length,
  };
}

export class WorkspaceService {
  private static readonly mainWorkspaceClaims = new Map<string, Promise<WorkspaceWithVisibleSessions>>();
  private static readonly dedicatedWorkspaceClaims = new Map<string, Promise<WorkspaceWithVisibleSessions>>();
  private sessionService = getSessionManager();
  private eventBus: EventBus = getEventBus();

  constructor(private readonly lockService: TeamLockService = defaultTeamLockService) {}

  private getBaseBranch(workspace: {
    baseBranch: string | null;
    task: { project: { mainBranch: string } };
  }): string {
    return workspace.baseBranch || workspace.task.project.mainBranch;
  }

  // ── Queries ──────────────────────────────────────────────────────────────────

  async findById(id: string) {
    const workspace = await prisma.workspace.findUnique({
      where: { id },
      include: { sessions: visibleSessionsFilter, task: { include: { project: true } } },
    });
    if (!workspace) return null;
    ensureTaskNotDeleted(workspace.task);
    return workspace;
  }

  /**
   * 获取 Task 下所有 Workspace
   */
  async findByTaskId(taskId: string) {
    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task) {
      throw new NotFoundError('Task', taskId);
    }
    ensureTaskNotDeleted(task);

    return prisma.workspace.findMany({
      where: { taskId },
      include: { sessions: visibleSessionsFilter },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listVerdicts(workspaceId: string): Promise<WorkspaceVerdict[]> {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: { task: true },
    });
    if (!workspace) {
      throw new NotFoundError('Workspace', workspaceId);
    }
    ensureTaskNotDeleted(workspace.task);

    const verdicts = await prisma.workspaceVerdict.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
    return verdicts.map(serializeWorkspaceVerdict);
  }

  async listTeamRunMergeableWorkspaces(teamRunId: string): Promise<MergeableWorkspacesResponse> {
    const context = await this.loadTeamRunMergeableContext(teamRunId);
    return this.buildMergeableWorkspacesResponse(context);
  }

  async mergeTeamRunMembers(
    teamRunId: string,
    options: MergeTeamRunMembersOptions
  ): Promise<MergeTeamRunMembersResponse> {
    await this.assertTeamRunMergeInvocation(teamRunId, options.invocationId, options.requesterMemberId);

    const initialContext = await this.loadTeamRunMergeableContext(teamRunId);
    ensureProjectIsMutable(initialContext.project, 'merge TeamRun member workspaces');

    const dryRun = options.dryRun === true;
    const stopOnConflict = options.stopOnConflict === true;
    const hasExplicitWorkspaceIds = Array.isArray(options.workspaceIds);
    const requestedWorkspaceIds = hasExplicitWorkspaceIds
      ? [...new Set(options.workspaceIds)]
      : undefined;
    const requestedCount = requestedWorkspaceIds?.length ?? initialContext.workspaces.length;

    const run = async (): Promise<MergeTeamRunMembersResponse> => {
      const context = await this.loadTeamRunMergeableContext(teamRunId);
      const response = await this.buildMergeableWorkspacesResponse(context);
      const results: MergeTeamRunMemberResult[] = [];
      const selected: MergeableWorkspaceItem[] = [];

      if (requestedWorkspaceIds) {
        const itemsById = new Map(response.workspaces.map((item) => [item.workspaceId, item]));
        for (const workspaceId of requestedWorkspaceIds) {
          const item = itemsById.get(workspaceId);
          if (item) {
            selected.push(item);
          } else {
            results.push({
              workspaceId,
              ownerMemberId: null,
              status: 'SKIPPED',
              code: 'INVALID_WORKSPACE_STATE',
              message: 'Workspace is not a mergeable dedicated TeamRun child workspace',
            });
          }
        }
      } else {
        selected.push(...response.workspaces);
      }

      for (const item of selected) {
        if (item.status === WorkspaceStatus.MERGED) {
          results.push({
            workspaceId: item.workspaceId,
            ownerMemberId: item.owner.memberId,
            status: dryRun ? 'ALREADY_MERGED' : 'ALREADY_MERGED',
            sha: item.headSha ?? undefined,
          });
          continue;
        }

        if (!item.mergeReady) {
          const firstBlocking = item.blockers.find((entry) => entry.severity === 'BLOCKING') ?? item.blockers[0];
          results.push({
            workspaceId: item.workspaceId,
            ownerMemberId: item.owner.memberId,
            status: 'SKIPPED',
            code: firstBlocking?.code ?? 'WORKSPACE_NOT_ACTIVE',
            message: firstBlocking?.message ?? 'Workspace is not ready to merge',
            blockers: item.blockers,
          });
          continue;
        }

        if (dryRun) {
          results.push({
            workspaceId: item.workspaceId,
            ownerMemberId: item.owner.memberId,
            status: 'WOULD_MERGE',
            sha: item.headSha ?? undefined,
          });
          continue;
        }

        try {
          const sha = await this.merge(item.workspaceId, {
            invocationId: options.invocationId,
            lockOwnerId: options.invocationId,
            requesterMemberId: options.requesterMemberId,
          });
          results.push({
            workspaceId: item.workspaceId,
            ownerMemberId: item.owner.memberId,
            status: 'MERGED',
            sha,
          });
        } catch (error) {
          const result = this.mergeErrorToResult(item, error);
          results.push(result);
          if (stopOnConflict && result.status === 'CONFLICT') {
            break;
          }
        }
      }

      return {
        teamRunId: response.teamRunId,
        taskId: response.taskId,
        projectId: response.projectId,
        mainWorkspaceId: response.mainWorkspace.id,
        dryRun,
        stopOnConflict,
        requestedWorkspaceIds,
        summary: resultSummary(results, requestedCount),
        results,
      };
    };

    if (dryRun) {
      return run();
    }

    const mainWorkspaceId = initialContext.mainWorkspace.id;
    if (!mainWorkspaceId) {
      return run();
    }

    return this.withMergeTargetLock(
      this.getParentWorkspaceMergeLockTarget(mainWorkspaceId),
      options.invocationId,
      run
    );
  }

  async recordVerdict(workspaceId: string, input: RecordWorkspaceVerdictInput): Promise<WorkspaceVerdict> {
    if (input.kind === 'REVIEW' && !['APPROVED', 'CHANGES_REQUESTED'].includes(input.verdict)) {
      throw new ServiceError('Invalid review verdict', 'INVALID_WORKSPACE_VERDICT', 400);
    }
    if (input.kind === 'TEST' && !['PASSED', 'FAILED'].includes(input.verdict)) {
      throw new ServiceError('Invalid test verdict', 'INVALID_WORKSPACE_VERDICT', 400);
    }
    if (!input.reviewedSha.trim()) {
      throw new ServiceError('reviewedSha is required', 'VALIDATION_ERROR', 400);
    }

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: { task: { include: { teamRun: true } } },
    });
    if (!workspace) {
      throw new NotFoundError('Workspace', workspaceId);
    }
    ensureTaskNotDeleted(workspace.task);
    const teamRun = workspace.task.teamRun;
    if (!teamRun) {
      throw new ServiceError('Workspace verdicts are only supported for TeamRun workspaces', 'WORKSPACE_VERDICT_TEAM_RUN_REQUIRED', 400);
    }
    this.assertWorktreeWorkspace(workspace);

    const reviewedSha = input.reviewedSha.trim();
    const currentHeadSha = await this.getHeadSha(workspace.worktreePath);
    const expectedTargetHeadSha = input.expectedTargetHeadSha?.trim() || null;
    if (expectedTargetHeadSha && currentHeadSha !== expectedTargetHeadSha) {
      throw new ServiceError(
        'Targeted workspace verdict is stale because the source workspace HEAD changed',
        'TARGET_VERDICT_STALE',
        409
      );
    }
    if (expectedTargetHeadSha && reviewedSha !== expectedTargetHeadSha) {
      throw new ServiceError(
        'Targeted workspace verdict SHA must match the invocation targetHeadSha',
        'TARGET_VERDICT_SHA_MISMATCH',
        409
      );
    }
    if (reviewedSha !== currentHeadSha) {
      throw new ServiceError(
        'Workspace verdict SHA must match the current workspace HEAD',
        'WORKSPACE_VERDICT_SHA_MISMATCH',
        409
      );
    }

    const reviewer = await prisma.teamMember.findFirst({
      where: {
        id: input.reviewerMemberId,
        teamRunId: teamRun.id,
        membershipStatus: { not: 'REMOVED' },
      },
      select: { id: true, capabilities: true },
    });
    if (!reviewer) {
      throw new ServiceError('Reviewer is not an active member of this TeamRun', 'WORKSPACE_VERDICT_REVIEWER_INVALID', 403);
    }
    const reviewerCapabilities = parseCapabilities(reviewer.capabilities);
    const requiredCapability = input.kind === 'REVIEW' ? 'readDiff' : 'runCommands';
    if (reviewerCapabilities[requiredCapability] !== true) {
      throw new ServiceError(
        `Current TeamRun member lacks required capabilities: ${requiredCapability}`,
        'TEAM_RUN_MEMBER_CAPABILITY_REQUIRED',
        403
      );
    }

    const verdict = await prisma.$transaction(async (tx) => {
      const latest = await tx.workspaceVerdict.findFirst({
        where: {
          workspaceId,
          kind: input.kind,
        },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });

      return tx.workspaceVerdict.create({
        data: {
          workspaceId,
          teamRunId: teamRun.id,
          kind: input.kind,
          verdict: input.verdict,
          reviewedSha,
          reviewerMemberId: input.reviewerMemberId,
          reason: input.reason ?? null,
          sequence: (latest?.sequence ?? 0) + 1,
        },
      });
    });

    return serializeWorkspaceVerdict(verdict);
  }

  async resolveInvocationMemberForWorkspace(
    workspaceId: string,
    invocationId: string | null | undefined
  ): Promise<WorkspaceInvocationIdentity | null> {
    if (!invocationId) {
      return null;
    }

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: { task: { include: { teamRun: true } } },
    });
    if (!workspace) {
      throw new NotFoundError('Workspace', workspaceId);
    }
    ensureTaskNotDeleted(workspace.task);
    const teamRunId = workspace.task.teamRun?.id;
    if (!teamRunId) {
      return null;
    }

    const invocation = await prisma.agentInvocation.findFirst({
      where: {
        id: invocationId,
        teamRunId,
        OR: [
          { workspaceId },
          { targetSourceWorkspaceId: workspaceId },
        ],
      },
      select: {
        id: true,
        memberId: true,
        targetHeadSha: true,
        targetSourceWorkspaceId: true,
      },
    });
    return invocation
      ? {
        teamRunId,
        memberId: invocation.memberId,
        invocationId: invocation.id,
        targetHeadSha: invocation.targetSourceWorkspaceId === workspaceId
          ? invocation.targetHeadSha
          : null,
        targetSourceWorkspaceId: invocation.targetSourceWorkspaceId,
      }
      : null;
  }

  async resolveInvocationMemberForTeamRun(teamRunId: string, invocationId: string | null | undefined): Promise<{
    teamRunId: string;
    memberId: string;
    invocationId: string;
  } | null> {
    if (!invocationId) {
      return null;
    }

    const invocation = await prisma.agentInvocation.findFirst({
      where: {
        id: invocationId,
        teamRunId,
      },
      select: {
        id: true,
        memberId: true,
      },
    });

    return invocation
      ? { teamRunId, memberId: invocation.memberId, invocationId: invocation.id }
      : null;
  }

  private async assertTeamRunMergeInvocation(
    teamRunId: string,
    invocationId: string | null | undefined,
    requesterMemberId?: string | null
  ): Promise<void> {
    if (!invocationId) {
      throw new ServiceError(
        'TeamRun member merge requires an agent invocation identity',
        'TEAM_RUN_MERGE_INVOCATION_REQUIRED',
        403
      );
    }

    const identity = await this.resolveInvocationMemberForTeamRun(teamRunId, invocationId);
    if (!identity) {
      throw new ServiceError('Agent invocation identity is invalid for this TeamRun', 'FORBIDDEN', 403);
    }
    if (requesterMemberId && requesterMemberId !== identity.memberId) {
      throw new ServiceError('Requester member does not match the agent invocation identity', 'FORBIDDEN', 403);
    }

    const member = await prisma.teamMember.findFirst({
      where: {
        id: identity.memberId,
        teamRunId,
        membershipStatus: { not: 'REMOVED' },
      },
      select: {
        capabilities: true,
      },
    });
    if (!member) {
      throw new ServiceError('Current TeamRun member was not found', 'FORBIDDEN', 403);
    }

    const capabilities = parseCapabilities(member.capabilities);
    if (capabilities.mergeWorkspace !== true) {
      throw new ServiceError(
        'Current TeamRun member lacks required capabilities: mergeWorkspace',
        'TEAM_RUN_MEMBER_CAPABILITY_REQUIRED',
        403
      );
    }
  }

  private async loadTeamRunMergeableContext(teamRunId: string): Promise<MergeableComputationContext> {
    const teamRun = await prisma.teamRun.findUnique({
      where: { id: teamRunId },
      include: {
        task: { include: { project: true } },
        mainWorkspace: true,
      },
    });
    if (!teamRun) {
      throw new NotFoundError('TeamRun', teamRunId);
    }
    ensureTaskNotDeleted(teamRun.task);

    const mainWorkspace = teamRun.mainWorkspace;
    const workspaces = mainWorkspace
      ? await prisma.workspace.findMany({
        where: {
          taskId: teamRun.taskId,
          parentWorkspaceId: mainWorkspace.id,
          ownerMemberId: { not: null },
        },
        include: {
          ownerMember: true,
          task: { include: { project: true, teamRun: true } },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
      : [];
    const dedicatedWorkspaces = workspaces.filter((workspace): workspace is TeamRunMergeableWorkspaceRecord => {
      return Boolean(
        workspace.ownerMember
        && workspace.ownerMemberId
        && workspace.parentWorkspaceId
        && workspace.task.teamRun
      );
    });

    const workspaceIds = dedicatedWorkspaces.map((workspace) => workspace.id);
    const ownerMemberIds = dedicatedWorkspaces.map((workspace) => workspace.ownerMemberId);

    const [verdicts, ownerInvocations, parentActiveWriteSession, mainHeadSha] = await Promise.all([
      workspaceIds.length > 0
        ? prisma.workspaceVerdict.findMany({
          where: {
            teamRunId,
            workspaceId: { in: workspaceIds },
            kind: { in: ['REVIEW', 'TEST'] },
          },
          orderBy: [
            { workspaceId: 'asc' },
            { kind: 'asc' },
            { sequence: 'desc' },
            { createdAt: 'desc' },
            { id: 'desc' },
          ],
        })
        : Promise.resolve([]),
      ownerMemberIds.length > 0
        ? prisma.agentInvocation.findMany({
          where: {
            teamRunId,
            memberId: { in: ownerMemberIds },
            status: { in: activeInvocationStatuses },
          },
          select: { memberId: true },
        })
        : Promise.resolve([]),
      mainWorkspace
        ? prisma.session.findFirst({
          where: {
            workspaceId: mainWorkspace.id,
            status: { in: activeSessionStatuses },
            purpose: SessionPurpose.CHAT,
          },
          select: { id: true },
        })
        : Promise.resolve(null),
      mainWorkspace?.worktreePath
        ? this.getHeadSha(mainWorkspace.worktreePath).catch(() => null)
        : Promise.resolve(null),
    ]);

    const latestReviews = new Map<string, VerdictRecord>();
    const latestTests = new Map<string, VerdictRecord>();
    for (const verdict of verdicts) {
      const key = verdict.workspaceId;
      if (verdict.kind === 'REVIEW' && !latestReviews.has(key)) {
        latestReviews.set(key, verdict);
      }
      if (verdict.kind === 'TEST' && !latestTests.has(key)) {
        latestTests.set(key, verdict);
      }
    }

    return {
      teamRunId,
      taskId: teamRun.taskId,
      projectId: teamRun.task.projectId,
      project: {
        name: teamRun.task.project.name,
        repoPath: teamRun.task.project.repoPath,
        mainBranch: teamRun.task.project.mainBranch,
        archivedAt: teamRun.task.project.archivedAt,
        repoDeletedAt: teamRun.task.project.repoDeletedAt,
      },
      mainWorkspace: {
        id: mainWorkspace?.id ?? null,
        branchName: mainWorkspace?.branchName ?? null,
        status: mainWorkspace?.status ?? null,
        worktreePath: mainWorkspace?.worktreePath ?? null,
        headSha: mainHeadSha,
        hasActiveWriteSession: Boolean(parentActiveWriteSession),
      },
      generatedAt: new Date().toISOString(),
      workspaces: dedicatedWorkspaces,
      latestReviews,
      latestTests,
      ownerActiveMemberIds: new Set(ownerInvocations.map((invocation) => invocation.memberId)),
    };
  }

  private async buildMergeableWorkspacesResponse(context: MergeableComputationContext): Promise<MergeableWorkspacesResponse> {
    const workspaceOrder = new Map(context.workspaces.map((workspace, index) => [workspace.id, index]));
    const items = (await Promise.all(
      context.workspaces.map((workspace) => this.buildMergeableWorkspaceItem(context, workspace))
    ))
      .sort((left, right) => {
        const leftBehind = left.git.behindMain ?? Number.MAX_SAFE_INTEGER;
        const rightBehind = right.git.behindMain ?? Number.MAX_SAFE_INTEGER;
        if (leftBehind !== rightBehind) return leftBehind - rightBehind;
        const leftOrder = workspaceOrder.get(left.workspaceId) ?? Number.MAX_SAFE_INTEGER;
        const rightOrder = workspaceOrder.get(right.workspaceId) ?? Number.MAX_SAFE_INTEGER;
        if (leftOrder !== rightOrder) return leftOrder - rightOrder;
        return left.workspaceId.localeCompare(right.workspaceId);
      });

    return {
      teamRunId: context.teamRunId,
      taskId: context.taskId,
      projectId: context.projectId,
      mainWorkspace: {
        id: context.mainWorkspace.id,
        branchName: context.mainWorkspace.branchName,
        status: context.mainWorkspace.status,
        headSha: context.mainWorkspace.headSha,
        hasActiveWriteSession: context.mainWorkspace.hasActiveWriteSession,
      },
      generatedAt: context.generatedAt,
      workspaces: items,
    };
  }

  private async buildMergeableWorkspaceItem(
    context: MergeableComputationContext,
    workspace: TeamRunMergeableWorkspaceRecord
  ): Promise<MergeableWorkspaceItem> {
    const blockers: MergeReadinessBlocker[] = [];
    let headSha: string | null = null;
    let gitStatus: GitOperationStatus | null = null;
    let gitStatusAvailable = false;
    const worktreeManager = new WorktreeManager(context.project.repoPath);
    const isWorktree = workspace.workspaceKind === WorkspaceKind.WORKTREE;

    if (!isWorktree) {
      blockers.push(blocker(
        'WORKSPACE_GIT_UNAVAILABLE',
        'BLOCKING',
        'Workspace git operations are unavailable for this workspace type'
      ));
    } else if (!workspace.worktreePath) {
      blockers.push(blocker('MISSING_HEAD_SHA', 'BLOCKING', 'Workspace worktree path is missing'));
    } else {
      try {
        headSha = await this.getHeadSha(workspace.worktreePath);
      } catch {
        blockers.push(blocker('MISSING_HEAD_SHA', 'BLOCKING', 'Cannot read workspace HEAD SHA'));
      }

      try {
        gitStatus = await worktreeManager.getGitOperationStatus(
          workspace.worktreePath,
          context.mainWorkspace.branchName ?? workspace.baseBranch ?? context.project.mainBranch
        );
        gitStatusAvailable = true;
      } catch (error) {
        blockers.push(blocker(
          'GIT_STATUS_UNAVAILABLE',
          'BLOCKING',
          error instanceof Error ? error.message : 'Cannot read workspace git status'
        ));
      }
    }

    const latestReview = serializeLatestVerdict(
      context.latestReviews.get(workspace.id),
      headSha,
      workspace.ownerMemberId
    );
    const latestTest = serializeLatestVerdict(
      context.latestTests.get(workspace.id),
      headSha,
      workspace.ownerMemberId
    );
    const ownerHasActiveInvocation = context.ownerActiveMemberIds.has(workspace.ownerMemberId);
    const clean = gitStatusAvailable && gitStatus
      ? gitStatus.operation === 'idle'
        && !gitStatus.hasUncommittedChanges
        && gitStatus.untrackedCount === 0
      : null;

    if (workspace.status === WorkspaceStatus.MERGED) {
      blockers.push(blocker('WORKSPACE_ALREADY_MERGED', 'WARNING', 'Workspace has already been merged'));
    } else if (workspace.status === WorkspaceStatus.ABANDONED) {
      blockers.push(blocker('WORKSPACE_ABANDONED', 'BLOCKING', 'Workspace has been abandoned'));
    } else if (workspace.status === WorkspaceStatus.HIBERNATED) {
      blockers.push(blocker('WORKSPACE_HIBERNATED', 'BLOCKING', 'Workspace is hibernated'));
    } else if (workspace.status !== WorkspaceStatus.ACTIVE) {
      blockers.push(blocker(
        'INVALID_WORKSPACE_STATE',
        'BLOCKING',
        `Workspace is in ${workspace.status} status`
      ));
    }

    if (context.mainWorkspace.id !== workspace.parentWorkspaceId) {
      blockers.push(blocker('INVALID_PARENT_WORKSPACE', 'BLOCKING', 'Workspace parent is not the TeamRun main workspace'));
    }
    if (context.mainWorkspace.status !== WorkspaceStatus.ACTIVE) {
      blockers.push(blocker(
        'INVALID_PARENT_WORKSPACE_STATE',
        'BLOCKING',
        `TeamRun main workspace is in ${context.mainWorkspace.status ?? 'missing'} status`
      ));
    }

    if (workspace.status === WorkspaceStatus.ACTIVE) {
      if (!latestReview || latestReview.verdict !== 'APPROVED') {
        blockers.push(blocker('REVIEW_REQUIRED', 'BLOCKING', 'TeamRun workspace merge requires an approved review'));
      } else if (!latestReview.matchesHead) {
        blockers.push(blocker('REVIEW_STALE', 'BLOCKING', 'Approved review is stale because the workspace HEAD changed'));
      } else if (!latestReview.reviewerMemberId || latestReview.isSelfReview) {
        blockers.push(blocker('SELF_REVIEW_FORBIDDEN', 'BLOCKING', 'Workspace owner cannot approve their own workspace for merge'));
      }

      if (ownerHasActiveInvocation) {
        blockers.push(blocker('OWNER_HAS_ACTIVE_INVOCATION', 'BLOCKING', 'Cannot merge while the workspace owner has active work'));
      }
      if (context.mainWorkspace.hasActiveWriteSession) {
        blockers.push(blocker('PARENT_WORKSPACE_HAS_ACTIVE_SESSION', 'BLOCKING', 'Cannot merge into parent workspace while it has an active write session'));
      }
      if (gitStatus?.operation === 'rebase') {
        blockers.push(blocker('REBASE_IN_PROGRESS', 'BLOCKING', 'Workspace has a rebase in progress'));
      }
      if (gitStatus?.operation === 'merge') {
        blockers.push(blocker('MERGE_CONFLICT', 'BLOCKING', 'Workspace has a merge in progress', {
          conflictedFiles: gitStatus.conflictedFiles,
        }));
      }
      if (gitStatus && (gitStatus.hasUncommittedChanges || gitStatus.untrackedCount > 0)) {
        blockers.push(blocker('WORKTREE_DIRTY', 'BLOCKING', 'Workspace has uncommitted or untracked changes', {
          uncommittedCount: gitStatus.uncommittedCount,
          untrackedCount: gitStatus.untrackedCount,
        }));
      }
      if ((gitStatus?.behind ?? 0) > 0) {
        blockers.push(blocker('BEHIND_MAIN', 'WARNING', 'Workspace branch is behind the TeamRun main workspace', {
          behindMain: gitStatus?.behind ?? 0,
          aheadOfMain: gitStatus?.ahead ?? 0,
        }));
      }
    }

    return {
      workspaceId: workspace.id,
      owner: {
        memberId: workspace.ownerMemberId,
        name: workspace.ownerMember.name,
        membershipStatus: workspace.ownerMember.membershipStatus,
      },
      status: workspace.status,
      branchName: workspace.branchName,
      baseBranch: workspace.baseBranch,
      parentWorkspaceId: workspace.parentWorkspaceId,
      headSha,
      git: {
        clean,
        aheadOfMain: gitStatus?.ahead ?? null,
        behindMain: gitStatus?.behind ?? null,
        operation: gitStatus?.operation ?? null,
        conflictedFiles: gitStatus?.conflictedFiles ?? [],
        hasUncommittedChanges: gitStatus?.hasUncommittedChanges ?? null,
        uncommittedCount: gitStatus?.uncommittedCount ?? null,
        untrackedCount: gitStatus?.untrackedCount ?? null,
        statusAvailable: gitStatusAvailable,
      },
      activity: {
        ownerHasActiveInvocation,
        parentHasActiveWriteSession: context.mainWorkspace.hasActiveWriteSession,
      },
      latestReview,
      latestTest,
      mergeReady: workspace.status === WorkspaceStatus.ACTIVE
        && blockers.every((entry) => entry.severity !== 'BLOCKING'),
      blockers,
    };
  }

  private mergeErrorToResult(
    item: MergeableWorkspaceItem,
    error: unknown
  ): MergeTeamRunMemberResult {
    const errorCode = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
    if (error instanceof MergeConflictError || errorCode === 'MERGE_CONFLICT') {
      const conflict = error as Partial<MergeConflictError>;
      return {
        workspaceId: item.workspaceId,
        ownerMemberId: item.owner.memberId,
        status: 'CONFLICT',
        code: errorCode || 'MERGE_CONFLICT',
        message: error instanceof Error ? error.message : 'Merge conflict',
        conflictedFiles: Array.isArray(conflict.conflictedFiles) ? conflict.conflictedFiles : [],
        sourceBranch: conflict.sourceBranch,
        targetBranch: conflict.targetBranch,
        sourceWorkspaceId: conflict.sourceWorkspaceId,
        targetWorkspaceId: conflict.targetWorkspaceId,
      };
    }

    const code = errorCode || 'UNKNOWN';
    const message = error instanceof Error ? error.message : String(error);

    return {
      workspaceId: item.workspaceId,
      ownerMemberId: item.owner.memberId,
      status: 'FAILED',
      code,
      message,
    };
  }

  // ── Create ───────────────────────────────────────────────────────────────────

  /**
   * 创建 Workspace
   *
   * - 默认分支名: at/{workspace-short-id}（ID 前 8 位）
   * - 支持用户自定义分支名
   * - 创建前校验分支名合法性 & 是否已存在
   * - 创建后自动将关联 Task 状态改为 IN_PROGRESS
   * - 失败时回滚已创建的数据库记录
   */
  async create(taskId: string, branchNameOrOptions?: string | CreateWorkspaceOptions) {
    const options = normalizeCreateOptions(branchNameOrOptions);
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      include: { project: true, teamRun: { select: { id: true } } },
    });

    if (!task) {
      throw new NotFoundError('Task', taskId);
    }
    ensureTaskNotDeleted(task);
    ensureProjectIsMutable(task.project, 'create workspaces');

    if (options.workspaceKind === WorkspaceKind.MAIN_DIRECTORY) {
      return this.createMainDirectoryWorkspace(taskId, task, options);
    }

    await ensureProjectSupportsWorktrees(task.project, 'create a worktree workspace');

    const worktreeManager = new WorktreeManager(task.project.repoPath);

    // 查找可复用的 MERGED 或 HIBERNATED workspace
    if (!options.branchName && options.reuseInactive) {
      const reusableWorkspace = await prisma.workspace.findFirst({
        where: {
          taskId,
          parentWorkspaceId: options.parentWorkspaceId,
          ownerMemberId: options.ownerMemberId,
          workspaceKind: WorkspaceKind.WORKTREE,
          status: { in: [WorkspaceStatus.MERGED, WorkspaceStatus.HIBERNATED] },
        },
        orderBy: { updatedAt: 'desc' },
      });

      if (reusableWorkspace) {
        return this.restoreInactiveWorkspace({
          ...reusableWorkspace,
          task: { ...task, project: task.project },
        });
      }
    }

    // 先在数据库创建记录以获取 ID（用于生成默认分支名）
    const workspace = await prisma.workspace.create({
      data: {
        taskId,
        parentWorkspaceId: options.parentWorkspaceId,
        ownerMemberId: options.ownerMemberId,
        branchName: '', // 占位，稍后更新
        worktreePath: '', // 占位，稍后更新
        workspaceKind: WorkspaceKind.WORKTREE,
        workingDir: '',
        status: WorkspaceStatus.ACTIVE,
      },
    });

    try {
      // 生成分支名：用户指定 or 自动生成 at/{shortId}
      const branch = branchFromOptions(workspace.id, options);

      // 空仓库（无任何 commit）无法创建 worktree，提前报错
      const startPoint = options.startPoint || null;
      let baseBranch: string | null = startPoint;
      if (!startPoint) {
        try {
          const currentBranch = (
            await execGit(task.project.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
          ).trim();
          baseBranch = currentBranch && currentBranch !== 'HEAD' ? currentBranch : null;
        } catch {
          throw new Error(
            '仓库尚无任何提交记录，无法创建 Workspace。请重新编辑项目以触发自动初始化，或手动执行 git commit。'
          );
        }
      }

      // WorktreeManager.create 内部已做分支名合法性校验和重复检查
      const worktreePath = await worktreeManager.create(branch, startPoint ?? undefined);

      const updateResult = await prisma.workspace.updateMany({
        where: { id: workspace.id, task: { deletedAt: null } },
        data: {
          branchName: branch,
          baseBranch,
          worktreePath,
          workingDir: worktreePath,
          workspaceKind: WorkspaceKind.WORKTREE,
        },
      });
      if (updateResult.count === 0) {
        await this.cleanupCreatedWorktree(worktreeManager, worktreePath, branch, [
          task.project.mainBranch,
          baseBranch,
        ]);
        throw new NotFoundError('Task', taskId);
      }

      // worktree 创建后：复制文件 + 异步执行 setup 脚本（fire-and-forget）
      this.runCopyFiles(task.project.repoPath, worktreePath, task.project.copyFiles);
      this.fireSetupScript(workspace.id, taskId, worktreePath, task.project.setupScript);

      const updated = await prisma.workspace.findUniqueOrThrow({
        where: { id: workspace.id },
        include: { sessions: true, task: { include: { project: true } } },
      });

      return updated;
    } catch (err) {
      // 回滚：删除已创建的数据库记录
      await prisma.workspace.delete({ where: { id: workspace.id } }).catch(() => {
        // 忽略回滚失败
      });
      throw err;
    }
  }

  private async createMainDirectoryWorkspace(
    taskId: string,
    task: Prisma.TaskGetPayload<{ include: { project: true; teamRun: { select: { id: true } } } }>,
    options: NormalizedCreateWorkspaceOptions,
  ): Promise<WorkspaceWithVisibleSessions> {
    if (task.teamRun) {
      throw new ServiceError(
        'Main-directory workspaces are not available for TeamRun tasks',
        'MAIN_DIRECTORY_TEAM_RUN_UNSUPPORTED',
        400,
      );
    }

    if (
      options.branchName
      || options.branchNamePrefix
      || options.startPoint
      || options.parentWorkspaceId
      || options.ownerMemberId
    ) {
      throw new ServiceError(
        'Main-directory workspaces cannot use branch, parent, owner, or startPoint options',
        'MAIN_DIRECTORY_WORKSPACE_OPTIONS_UNSUPPORTED',
        400,
      );
    }

    const currentBranch = await execGit(task.project.repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
      .then((value) => {
        const branch = value.trim();
        return branch && branch !== 'HEAD' ? branch : null;
      })
      .catch(() => null);

    const workspace = await prisma.workspace.create({
      data: {
        taskId,
        branchName: '',
        baseBranch: currentBranch ?? task.project.mainBranch,
        worktreePath: '',
        workspaceKind: WorkspaceKind.MAIN_DIRECTORY,
        workingDir: task.project.repoPath,
        status: WorkspaceStatus.ACTIVE,
      },
      include: { sessions: visibleSessionsFilter, task: { include: { project: true } } },
    });

    return workspace;
  }

  async getOrCreateMainWorkspace(teamRunId: string) {
    const existingClaim = WorkspaceService.mainWorkspaceClaims.get(teamRunId);
    if (existingClaim) {
      return existingClaim;
    }

    const claim = this.findOrCreateMainWorkspace(teamRunId);
    WorkspaceService.mainWorkspaceClaims.set(teamRunId, claim);

    try {
      return await claim;
    } finally {
      if (WorkspaceService.mainWorkspaceClaims.get(teamRunId) === claim) {
        WorkspaceService.mainWorkspaceClaims.delete(teamRunId);
      }
    }
  }

  async getOrCreateDedicatedWorkspace(teamRunId: string, memberId: string) {
    const mainWorkspace = await this.getOrCreateMainWorkspace(teamRunId);
    const claimKey = `${mainWorkspace.id}:${memberId}`;
    const existingClaim = WorkspaceService.dedicatedWorkspaceClaims.get(claimKey);
    if (existingClaim) {
      return existingClaim;
    }

    const claim = this.findOrCreateDedicatedWorkspace(teamRunId, memberId, mainWorkspace);
    WorkspaceService.dedicatedWorkspaceClaims.set(claimKey, claim);

    try {
      return await claim;
    } finally {
      if (WorkspaceService.dedicatedWorkspaceClaims.get(claimKey) === claim) {
        WorkspaceService.dedicatedWorkspaceClaims.delete(claimKey);
      }
    }
  }

  private async findOrCreateMainWorkspace(teamRunId: string): Promise<WorkspaceWithVisibleSessions> {
    const teamRun = await prisma.teamRun.findUnique({
      where: { id: teamRunId },
      include: {
        task: { include: { project: true } },
        mainWorkspace: { include: { task: { include: { project: true } } } },
      },
    });

    if (!teamRun) {
      throw new NotFoundError('TeamRun', teamRunId);
    }
    ensureTaskNotDeleted(teamRun.task);
    ensureProjectIsMutable(teamRun.task.project, 'create workspaces');
    await ensureProjectSupportsWorktrees(teamRun.task.project, 'create TeamRun workspaces');

    if (
      teamRun.mainWorkspace
      && teamRun.mainWorkspace.taskId === teamRun.taskId
      && teamRun.mainWorkspace.parentWorkspaceId == null
      && teamRun.mainWorkspace.ownerMemberId == null
      && isWorktreeWorkspace(teamRun.mainWorkspace)
      && teamRun.mainWorkspace.status === WorkspaceStatus.ACTIVE
    ) {
      return this.ensureActiveWorkspaceWorktree(teamRun.mainWorkspace);
    }

    const activeRoot = await prisma.workspace.findFirst({
      where: {
        taskId: teamRun.taskId,
        parentWorkspaceId: null,
        ownerMemberId: null,
        workspaceKind: WorkspaceKind.WORKTREE,
        status: WorkspaceStatus.ACTIVE,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { task: { include: { project: true } } },
    });

    if (activeRoot) {
      await prisma.teamRun.update({
        where: { id: teamRun.id },
        data: { mainWorkspaceId: activeRoot.id },
      });
      return this.ensureActiveWorkspaceWorktree(activeRoot);
    }

    const workspace = await this.create(teamRun.taskId, {
      branchNamePrefix: `${teamRunBranchPrefix(teamRun.id)}/main`,
      parentWorkspaceId: null,
      ownerMemberId: null,
      reuseInactive: false,
    });
    await prisma.teamRun.update({
      where: { id: teamRun.id },
      data: { mainWorkspaceId: workspace.id },
    });
    return workspace;
  }

  private async findOrCreateDedicatedWorkspace(
    teamRunId: string,
    memberId: string,
    mainWorkspace: WorkspaceWithVisibleSessions,
  ): Promise<WorkspaceWithVisibleSessions> {
    const teamRun = await prisma.teamRun.findUnique({
      where: { id: teamRunId },
      include: { task: { include: { project: true } } },
    });
    if (!teamRun) {
      throw new NotFoundError('TeamRun', teamRunId);
    }
    ensureTaskNotDeleted(teamRun.task);

    const member = await prisma.teamMember.findFirst({
      where: { id: memberId, teamRunId },
      select: { id: true },
    });
    if (!member) {
      throw new NotFoundError('TeamMember', memberId);
    }
    ensureProjectIsMutable(teamRun.task.project, 'create workspaces');
    await ensureProjectSupportsWorktrees(teamRun.task.project, 'create TeamRun workspaces');

    const existing = await this.findDedicatedWorkspace(mainWorkspace.id, memberId);
    if (existing) {
      return this.activateDedicatedWorkspace(existing, mainWorkspace);
    }

    try {
      return await this.create(teamRun.taskId, {
        branchNamePrefix: `${teamRunBranchPrefix(teamRun.id)}/member-${memberId.slice(0, 8)}`,
        startPoint: mainWorkspace.branchName,
        parentWorkspaceId: mainWorkspace.id,
        ownerMemberId: memberId,
        reuseInactive: false,
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      const raced = await this.findDedicatedWorkspace(mainWorkspace.id, memberId);
      if (!raced) {
        throw error;
      }
      return this.activateDedicatedWorkspace(await this.waitForWorkspaceReady(raced), mainWorkspace);
    }
  }

  async prepareTargetedExecutionWorkspace(
    input: PrepareTargetedExecutionWorkspaceInput
  ): Promise<PrepareTargetedExecutionWorkspaceResult> {
    assertFullCommitSha(input.targetHeadSha);

    const [teamRun, sourceWorkspace, executionWorkspace] = await Promise.all([
      prisma.teamRun.findUnique({
        where: { id: input.teamRunId },
        include: { task: { include: { project: true } }, mainWorkspace: true },
      }),
      prisma.workspace.findFirst({
        where: {
          id: input.targetSourceWorkspaceId,
          task: { teamRun: { id: input.teamRunId } },
        },
        include: { task: { include: { project: true } } },
      }),
      prisma.workspace.findFirst({
        where: {
          id: input.executionWorkspaceId,
          ownerMemberId: input.memberId,
          task: { teamRun: { id: input.teamRunId } },
        },
        include: { task: { include: { project: true } } },
      }),
    ]);

    if (!teamRun) {
      throw new NotFoundError('TeamRun', input.teamRunId);
    }
    ensureTaskNotDeleted(teamRun.task);
    await ensureProjectSupportsWorktrees(teamRun.task.project, 'prepare targeted TeamRun workspace');

    if (!sourceWorkspace) {
      throw new ServiceError(
        'Target source workspace must belong to this TeamRun',
        'TARGET_SOURCE_WORKSPACE_INVALID',
        400
      );
    }
    if (!executionWorkspace) {
      throw new ServiceError(
        'Execution workspace must be a dedicated workspace owned by the target member',
        'TARGET_EXECUTION_WORKSPACE_INVALID',
        400
      );
    }
    this.assertWorktreeWorkspace(sourceWorkspace);
    this.assertWorktreeWorkspace(executionWorkspace);

    if (!teamRun.mainWorkspaceId || executionWorkspace.parentWorkspaceId !== teamRun.mainWorkspaceId) {
      throw new ServiceError(
        'Targeted review/test requires a dedicated TeamRun execution workspace',
        'TARGET_EXECUTION_WORKSPACE_NOT_DEDICATED',
        400
      );
    }

    if (executionWorkspace.id === sourceWorkspace.id) {
      throw new ServiceError(
        'Execution workspace cannot be the source workspace being reviewed or tested',
        'TARGET_EXECUTION_WORKSPACE_SOURCE_CONFLICT',
        400
      );
    }

    const repoPath = teamRun.task.project.repoPath;
    try {
      await execGit(repoPath, ['cat-file', '-e', `${input.targetHeadSha}^{commit}`]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/(?:not a valid object|bad object|invalid object name)/i.test(message)) {
        throw error;
      }
      throw new ServiceError(
        `Target commit does not exist in the TeamRun repository: ${message}`,
        'TARGET_COMMIT_NOT_FOUND',
        400,
      );
    }

    const clean = await new WorktreeManager(repoPath).isWorktreeClean(executionWorkspace.worktreePath);
    if (!clean) {
      throw new ServiceError(
        'Execution workspace has uncommitted changes; targeted sync was not applied',
        'TARGET_EXECUTION_WORKSPACE_DIRTY',
        409
      );
    }

    const executionBranch = targetExecutionBranchName(input);
    await execGit(executionWorkspace.worktreePath, ['checkout', '-B', executionBranch, input.targetHeadSha]);
    await execGit(executionWorkspace.worktreePath, ['reset', '--hard', input.targetHeadSha]);
    const actualHead = (await execGit(executionWorkspace.worktreePath, ['rev-parse', 'HEAD'])).trim();
    if (actualHead !== input.targetHeadSha) {
      throw new ServiceError(
        'Execution workspace HEAD does not match targetHeadSha after sync',
        'TARGET_SYNC_HEAD_MISMATCH',
        500
      );
    }

    await prisma.workspace.update({
      where: { id: executionWorkspace.id },
      data: {
        branchName: executionBranch,
        baseBranch: input.targetBranchName,
      },
    });
    return { executionBranch };
  }

  private async findDedicatedWorkspace(
    mainWorkspaceId: string,
    memberId: string,
  ): Promise<WorkspaceWithTaskProject | null> {
    return prisma.workspace.findFirst({
      where: {
        parentWorkspaceId: mainWorkspaceId,
        ownerMemberId: memberId,
        workspaceKind: WorkspaceKind.WORKTREE,
      },
      include: { task: { include: { project: true } } },
    });
  }

  private async activateDedicatedWorkspace(
    workspace: WorkspaceWithTaskProject,
    mainWorkspace: WorkspaceWithVisibleSessions,
  ): Promise<WorkspaceWithVisibleSessions> {
    this.assertWorktreeWorkspace(workspace);

    if (!workspace.branchName) {
      workspace = await this.waitForWorkspaceReady(workspace);
    }

    if (workspace.status === WorkspaceStatus.ACTIVE) {
      return this.ensureActiveWorkspaceWorktree(workspace);
    }

    if (workspace.status === WorkspaceStatus.HIBERNATED) {
      return this.restoreInactiveWorkspace(workspace);
    }

    if (workspace.status === WorkspaceStatus.MERGED) {
      return this.resetMergedDedicatedWorkspace(workspace, mainWorkspace);
    }

    throw new ServiceError(
      `Cannot reuse dedicated workspace in ${workspace.status} status`,
      'DEDICATED_WORKSPACE_UNAVAILABLE',
      409
    );
  }

  private async resetMergedDedicatedWorkspace(
    workspace: WorkspaceWithTaskProject,
    mainWorkspace: WorkspaceWithVisibleSessions,
  ): Promise<WorkspaceWithVisibleSessions> {
    this.assertWorktreeWorkspace(workspace);
    this.assertWorktreeWorkspace(mainWorkspace);

    const worktreeManager = new WorktreeManager(workspace.task.project.repoPath);
    const worktreePath = await worktreeManager.ensureWorktreeExists(workspace.branchName);
    if (!(await worktreeManager.isWorktreeClean(worktreePath))) {
      throw new ServiceError(
        `Cannot start new work from merged workspace ${workspace.id} because it has uncommitted changes`,
        'MERGED_WORKSPACE_DIRTY',
        409,
      );
    }

    const mainHead = (await execGit(mainWorkspace.worktreePath, ['rev-parse', 'HEAD'])).trim();
    await execGit(worktreePath, ['reset', '--hard', mainHead]);

    const actualHead = (await execGit(worktreePath, ['rev-parse', 'HEAD'])).trim();
    if (!mainHead || actualHead !== mainHead || !(await worktreeManager.isWorktreeClean(worktreePath))) {
      throw new ServiceError(
        `Merged workspace ${workspace.id} could not be aligned to the TeamRun main workspace`,
        'MERGED_WORKSPACE_RESET_FAILED',
        500,
      );
    }

    const updateResult = await prisma.workspace.updateMany({
      where: {
        id: workspace.id,
        status: WorkspaceStatus.MERGED,
        task: { deletedAt: null },
      },
      data: {
        status: WorkspaceStatus.ACTIVE,
        baseBranch: mainWorkspace.branchName,
        worktreePath,
        workingDir: worktreePath,
        hibernatedAt: null,
        commitMessage: null,
      },
    });
    if (updateResult.count !== 1) {
      throw new ServiceError(
        `Merged workspace ${workspace.id} changed state while starting new work`,
        'MERGED_WORKSPACE_STATE_CHANGED',
        409,
      );
    }

    this.runCopyFiles(workspace.task.project.repoPath, worktreePath, workspace.task.project.copyFiles);
    this.fireSetupScript(workspace.id, workspace.taskId, worktreePath, workspace.task.project.setupScript);

    const activated = await prisma.workspace.findUniqueOrThrow({
      where: { id: workspace.id },
      include: { sessions: visibleSessionsFilter, task: { include: { project: true } } },
    });
    return activated;
  }

  private async waitForWorkspaceReady(workspace: WorkspaceWithTaskProject): Promise<WorkspaceWithTaskProject> {
    if (workspace.branchName) {
      return workspace;
    }

    for (let attempt = 0; attempt < WORKSPACE_READY_RETRY_COUNT; attempt++) {
      await sleep(WORKSPACE_READY_RETRY_DELAY_MS);
      const reloaded = await prisma.workspace.findUnique({
        where: { id: workspace.id },
        include: { task: { include: { project: true } } },
      });
      if (!reloaded) {
        break;
      }
      if (reloaded.branchName) {
        return reloaded;
      }
    }

    throw new ServiceError(
      `Workspace ${workspace.id} is still initializing`,
      'WORKSPACE_INITIALIZING',
      409
    );
  }

  private async ensureActiveWorkspaceWorktree(workspace: WorkspaceWithTaskProject): Promise<WorkspaceWithVisibleSessions> {
    ensureTaskNotDeleted(workspace.task);
    this.assertWorktreeWorkspace(workspace);

    if (!workspace.branchName) {
      workspace = await this.waitForWorkspaceReady(workspace);
    }

    if (workspace.worktreePath) {
      const gitFileExists = await fs
        .access(path.join(workspace.worktreePath, '.git'))
        .then(() => true)
        .catch(() => false);
      if (gitFileExists) {
        const active = await prisma.workspace.findUniqueOrThrow({
          where: { id: workspace.id },
          include: { sessions: visibleSessionsFilter, task: { include: { project: true } } },
        });
        return active;
      }
    }

    return this.restoreInactiveWorkspace(workspace);
  }

  private async restoreInactiveWorkspace(workspace: WorkspaceWithTaskProject): Promise<WorkspaceWithVisibleSessions> {
    ensureTaskNotDeleted(workspace.task);
    this.assertWorktreeWorkspace(workspace);

    const worktreeManager = new WorktreeManager(workspace.task.project.repoPath);
    const worktreePath = await worktreeManager.ensureWorktreeExists(workspace.branchName);

    const updateResult = await prisma.workspace.updateMany({
      where: { id: workspace.id, task: { deletedAt: null } },
      data: {
        status: WorkspaceStatus.ACTIVE,
        worktreePath,
        workingDir: worktreePath,
        hibernatedAt: null,
      },
    });
    if (updateResult.count === 0) {
      await this.cleanupRestoredWorktree(worktreeManager, worktreePath);
      throw new NotFoundError('Task', workspace.taskId);
    }

    this.runCopyFiles(workspace.task.project.repoPath, worktreePath, workspace.task.project.copyFiles);
    this.fireSetupScript(workspace.id, workspace.taskId, worktreePath, workspace.task.project.setupScript);

    const restored = await prisma.workspace.findUniqueOrThrow({
      where: { id: workspace.id },
      include: { sessions: visibleSessionsFilter, task: { include: { project: true } } },
    });
    return restored;
  }

  // ── Delete ───────────────────────────────────────────────────────────────────

  /**
   * 删除 Workspace
   *
   * - 删除前检查是否有 RUNNING 状态的 Session，有则拒绝删除
   * - 删除时先停止所有关联 Session 的进程
   * - 删除时调用 WorktreeManager.remove 清理 worktree
   * - worktree 清理失败时仍然删除数据库记录（记录警告日志）
   */
  async delete(id: string) {
    const workspace = await prisma.workspace.findUnique({
      where: { id },
      include: {
        sessions: true,
        task: { include: { project: true } },
      },
    });

    if (!workspace) {
      throw new NotFoundError('Workspace', id);
    }
    ensureProjectIsMutable(workspace.task.project, 'delete workspaces');

    // 停止所有活跃的 Session（RUNNING 和 PENDING 状态）
    const activeSessions = workspace.sessions.filter(
      (s) => s.status === SessionStatus.PENDING || s.status === SessionStatus.RUNNING
    );
    for (const session of activeSessions) {
      try {
        await this.sessionService.stop(session.id);
      } catch {
        // 忽略停止失败
      }
    }

    if (isWorktreeWorkspace(workspace) && workspace.worktreePath) {
      // 清理 worktree
      try {
        const worktreeManager = new WorktreeManager(workspace.task.project.repoPath);
        await worktreeManager.remove(workspace.worktreePath);
      } catch (err) {
        // worktree 清理失败时记录警告但不阻断删除
        console.warn(
          `[WorkspaceService] Failed to remove worktree for workspace ${id}: ${err instanceof Error ? err.message : err}`
        );
      }
    }

    // 删除数据库记录（级联删除 sessions）
    await prisma.workspace.delete({ where: { id } });
    return true;
  }

  // ── Diff ─────────────────────────────────────────────────────────────────────

  async getDiff(id: string) {
    const workspace = await prisma.workspace.findUnique({
      where: { id },
      include: { task: { include: { project: true } } },
    });

    if (!workspace) {
      throw new NotFoundError('Workspace', id);
    }
    ensureProjectIsMutable(workspace.task.project, 'read workspace diff');
    this.assertWorktreeWorkspace(workspace);

    const worktreeManager = new WorktreeManager(workspace.task.project.repoPath);
    return worktreeManager.getDiff(
      workspace.worktreePath,
      this.getBaseBranch(workspace)
    );
  }

  // ── Merge ────────────────────────────────────────────────────────────────────

  // ── Git Operations ──────────────────────────────────────────────────────────

  /**
   * Rebase 工作空间分支到最新的基础分支
   */
  async rebase(id: string): Promise<void> {
    const workspace = await prisma.workspace.findUnique({
      where: { id },
      include: { task: { include: { project: true } } },
    });

    if (!workspace) {
      throw new NotFoundError('Workspace', id);
    }
    ensureProjectIsMutable(workspace.task.project, 'abort workspace git operations');
    this.assertWorktreeWorkspace(workspace);

    const worktreeManager = new WorktreeManager(workspace.task.project.repoPath);
    await worktreeManager.rebase(
      workspace.worktreePath,
      this.getBaseBranch(workspace)
    );
  }

  /**
   * 获取工作空间的 Git 操作状态
   */
  async getGitStatus(id: string): Promise<GitOperationStatus> {
    const workspace = await prisma.workspace.findUnique({
      where: { id },
      include: { task: { include: { project: true } } },
    });

    if (!workspace) {
      throw new NotFoundError('Workspace', id);
    }
    if (isMainDirectoryWorkspace(workspace)) {
      if (!hasGitMetadata(workspace.task.project.repoPath)) {
        throw new ServiceError(
          'Workspace git status is unavailable because the project is not a Git repository',
          'WORKSPACE_GIT_UNAVAILABLE',
          400,
        );
      }
      return mainDirectoryGitStatus();
    }

    const worktreeManager = new WorktreeManager(workspace.task.project.repoPath);
    return worktreeManager.getGitOperationStatus(
      workspace.worktreePath,
      this.getBaseBranch(workspace)
    );
  }

  /**
   * 中止工作空间当前进行中的 Git 操作
   */
  async abortOperation(id: string): Promise<void> {
    const workspace = await prisma.workspace.findUnique({
      where: { id },
      include: { task: { include: { project: true } } },
    });

    if (!workspace) {
      throw new NotFoundError('Workspace', id);
    }
    this.assertWorktreeWorkspace(workspace);

    const worktreeManager = new WorktreeManager(workspace.task.project.repoPath);
    await worktreeManager.abortOperation(workspace.worktreePath);
  }

  // ── Merge (squash) ──────────────────────────────────────────────────────────

  async merge(id: string, commitMessage?: string): Promise<string>;
  async merge(id: string, options?: MergeWorkspaceOptions): Promise<string>;
  async merge(id: string, commitMessageOrOptions?: string | MergeWorkspaceOptions): Promise<string> {
    const options = typeof commitMessageOrOptions === 'string'
      ? { commitMessage: commitMessageOrOptions }
      : (commitMessageOrOptions ?? {});
    const workspace = await prisma.workspace.findUnique({
      where: { id },
      include: { task: { include: { project: true, teamRun: true } } },
    });

    if (!workspace) {
      throw new NotFoundError('Workspace', id);
    }
    ensureProjectIsMutable(workspace.task.project, 'merge workspaces');
    this.assertWorktreeWorkspace(workspace);

    return this.withMergeTargetLock(
      this.getMergeLockTarget(workspace),
      options.lockOwnerId,
      () => this.mergeWithLock(workspace, options)
    );
  }

  private async mergeWithLock(workspace: MergeWorkspaceRecord, options: MergeWorkspaceOptions): Promise<string> {
    if (this.isTeamRunDedicatedChildWorkspace(workspace) && workspace.status === WorkspaceStatus.MERGED) {
      if (!workspace.worktreePath) {
        return '';
      }
      try {
        return await this.getHeadSha(workspace.worktreePath);
      } catch {
        return '';
      }
    }

    if (workspace.status !== WorkspaceStatus.ACTIVE) {
      throw new ServiceError(
        `Cannot merge workspace in ${workspace.status} status`,
        'INVALID_WORKSPACE_STATE',
        400
      );
    }

    if (workspace.parentWorkspaceId) {
      if (this.isTeamRunDedicatedChildWorkspace(workspace)) {
        await this.assertTeamRunChildMergeGate(workspace, options);
      }
      return this.mergeChildIntoParent(workspace, options.commitMessage);
    }

    return this.mergeRootWorkspaceToMain(workspace, options.commitMessage);
  }

  private isTeamRunDedicatedChildWorkspace(workspace: MergeWorkspaceRecord): workspace is TeamRunChildWorkspaceRecord {
    return Boolean(
      workspace.task.teamRun
      && workspace.task.teamRun.mainWorkspaceId === workspace.parentWorkspaceId
      && workspace.parentWorkspaceId
      && workspace.ownerMemberId
    );
  }

  private async getHeadSha(worktreePath: string): Promise<string> {
    return (await execGit(worktreePath, ['rev-parse', 'HEAD'])).trim();
  }

  private async assertTeamRunChildMergeGate(
    workspace: TeamRunChildWorkspaceRecord,
    options: MergeWorkspaceOptions
  ): Promise<void> {
    const invocationId = options.invocationId ?? options.lockOwnerId;
    if (!invocationId) {
      throw new ServiceError(
        'TeamRun workspace merge requires an agent invocation identity',
        'TEAM_RUN_MERGE_INVOCATION_REQUIRED',
        403
      );
    }

    const invocation = await prisma.agentInvocation.findFirst({
      where: {
        id: invocationId,
        teamRunId: workspace.task.teamRun.id,
      },
      select: {
        id: true,
        memberId: true,
      },
    });
    if (!invocation) {
      throw new ServiceError(
        'Agent invocation identity is invalid for this TeamRun',
        'FORBIDDEN',
        403
      );
    }
    if (options.requesterMemberId && options.requesterMemberId !== invocation.memberId) {
      throw new ServiceError(
        'Requester member does not match the agent invocation identity',
        'FORBIDDEN',
        403
      );
    }

    const member = await prisma.teamMember.findFirst({
      where: {
        id: invocation.memberId,
        teamRunId: workspace.task.teamRun.id,
        membershipStatus: { not: 'REMOVED' },
      },
      select: {
        id: true,
        capabilities: true,
      },
    });
    if (!member) {
      throw new ServiceError(
        'Current TeamRun member was not found',
        'FORBIDDEN',
        403
      );
    }

    const capabilities = parseCapabilities(member.capabilities);
    if (capabilities.mergeWorkspace !== true) {
      throw new ServiceError(
        'Current TeamRun member lacks required capabilities: mergeWorkspace',
        'TEAM_RUN_MEMBER_CAPABILITY_REQUIRED',
        403
      );
    }

    const currentHeadSha = await this.getHeadSha(workspace.worktreePath);
    const latestReview = await prisma.workspaceVerdict.findFirst({
      where: {
        workspaceId: workspace.id,
        teamRunId: workspace.task.teamRun.id,
        kind: 'REVIEW',
      },
      orderBy: [
        { sequence: 'desc' },
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
    });
    if (!latestReview || latestReview.verdict !== 'APPROVED') {
      throw new ServiceError(
        'TeamRun workspace merge requires an approved review',
        'REVIEW_REQUIRED',
        409
      );
    }
    if (latestReview.reviewedSha !== currentHeadSha) {
      throw new ServiceError(
        'Approved review is stale because the workspace HEAD changed',
        'REVIEW_STALE',
        409
      );
    }
    if (!latestReview.reviewerMemberId || latestReview.reviewerMemberId === workspace.ownerMemberId) {
      throw new ServiceError(
        'Workspace owner cannot approve their own workspace for merge',
        'SELF_REVIEW_FORBIDDEN',
        409
      );
    }

    const ownerActiveInvocation = await prisma.agentInvocation.findFirst({
      where: {
        teamRunId: workspace.task.teamRun.id,
        memberId: workspace.ownerMemberId,
        status: { in: ['QUEUED', 'RUNNING', 'SESSION_ENDED', 'WAITING_ROOM_REPLY'] },
      },
      select: { id: true },
    });
    if (ownerActiveInvocation) {
      throw new ServiceError(
        'Cannot merge while the workspace owner has active work',
        'OWNER_HAS_ACTIVE_INVOCATION',
        409
      );
    }
  }

  private async mergeChildIntoParent(workspace: MergeWorkspaceRecord, commitMessage?: string): Promise<string> {
    this.assertWorktreeWorkspace(workspace);

    const parentWorkspace = await prisma.workspace.findUnique({
      where: { id: workspace.parentWorkspaceId ?? '' },
      include: { task: { include: { project: true } } },
    });
    if (!parentWorkspace) {
      throw new NotFoundError('Workspace', workspace.parentWorkspaceId ?? '');
    }
    if (parentWorkspace.taskId !== workspace.taskId || parentWorkspace.ownerMemberId != null) {
      throw new ServiceError(
        'Dedicated child workspace parent is not a valid TeamRun main workspace',
        'INVALID_PARENT_WORKSPACE',
        400
      );
    }
    if (parentWorkspace.status !== WorkspaceStatus.ACTIVE) {
      throw new ServiceError(
        `Cannot merge into parent workspace in ${parentWorkspace.status} status`,
        'INVALID_PARENT_WORKSPACE_STATE',
        409
      );
    }
    this.assertWorktreeWorkspace(parentWorkspace);

    await this.assertNoActiveWriteSessions(parentWorkspace.id);

    const worktreeManager = new WorktreeManager(workspace.task.project.repoPath);
    let sha: string;
    try {
      ({ sha } = await worktreeManager.mergeIntoWorktree(
        workspace.worktreePath,
        parentWorkspace.worktreePath,
        { commitMessage: commitMessage || workspace.commitMessage || undefined }
      ));
    } catch (error) {
      if (error instanceof MergeConflictError) {
        error.sourceWorkspaceId = workspace.id;
        error.targetWorkspaceId = parentWorkspace.id;
        error.sourceWorktreePath ??= workspace.worktreePath;
        error.targetWorktreePath ??= parentWorkspace.worktreePath;
        error.sourceBranch ??= workspace.branchName;
        error.targetBranch ??= parentWorkspace.branchName;
      }
      throw error;
    }

    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { status: WorkspaceStatus.MERGED },
    });
    return sha;
  }

  private async mergeRootWorkspaceToMain(workspace: MergeWorkspaceRecord, commitMessage?: string): Promise<string> {
    this.assertWorktreeWorkspace(workspace);

    await this.assertTeamRunFinalMergeAllowed(workspace);

    const worktreeManager = new WorktreeManager(workspace.task.project.repoPath);
    let sha: string;
    const targetBranch = this.getBaseBranch(workspace);
    try {
      ({ sha } = await worktreeManager.merge(
        workspace.worktreePath,
        targetBranch,
        { commitMessage: commitMessage || workspace.commitMessage || undefined }
      ));
    } catch (error) {
      if (error instanceof MergeConflictError) {
        error.sourceWorkspaceId = workspace.id;
        error.sourceWorktreePath ??= workspace.worktreePath;
        error.sourceBranch ??= workspace.branchName;
        error.targetBranch ??= targetBranch;
      }
      throw error;
    }

    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { status: WorkspaceStatus.MERGED },
    });
    const advanceableStatuses = [TaskStatus.IN_PROGRESS, TaskStatus.IN_REVIEW];
    if (advanceableStatuses.includes(workspace.task.status as TaskStatus)) {
      await prisma.task.update({
        where: { id: workspace.task.id },
        data: { status: TaskStatus.DONE },
      });
      this.eventBus.emit('task:updated', {
        taskId: workspace.task.id,
        projectId: workspace.task.projectId,
        status: TaskStatus.DONE,
      });
    }

    return sha;
  }

  private async assertTeamRunFinalMergeAllowed(workspace: MergeWorkspaceRecord): Promise<void> {
    const teamRun = workspace.task.teamRun;
    if (!teamRun) {
      return;
    }
    if (teamRun.mainWorkspaceId !== workspace.id) {
      throw new ServiceError(
        'Only the bound TeamRun main workspace can be merged into the project main branch',
        'TEAM_RUN_NON_MAIN_WORKSPACE_FINAL_MERGE_FORBIDDEN',
        409
      );
    }

    const blockingChildren = await prisma.workspace.findMany({
      where: {
        parentWorkspaceId: workspace.id,
        status: { notIn: finalChildWorkspaceStatuses },
      },
      select: { id: true, status: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    if (blockingChildren.length > 0) {
      throw new ServiceError(
        'Cannot merge TeamRun main workspace before all dedicated child workspaces are merged or abandoned',
        'TEAM_RUN_CHILD_WORKSPACES_NOT_FINAL',
        409
      );
    }
  }

  private async assertNoActiveWriteSessions(workspaceId: string): Promise<void> {
    const activeSession = await prisma.session.findFirst({
      where: {
        workspaceId,
        status: { in: activeSessionStatuses },
        purpose: SessionPurpose.CHAT,
      },
      select: { id: true },
    });

    if (activeSession) {
      throw new ServiceError(
        'Cannot merge into parent workspace while it has an active write session',
        'PARENT_WORKSPACE_HAS_ACTIVE_SESSION',
        409
      );
    }
  }

  private getMergeLockTarget(workspace: MergeWorkspaceRecord): MergeLockTarget {
    if (workspace.parentWorkspaceId) {
      return this.getParentWorkspaceMergeLockTarget(workspace.parentWorkspaceId);
    }

    return {
      key: `project:${workspace.task.projectId}:main-worktree:merge`,
      code: 'PROJECT_MERGE_LOCKED',
      message: 'Another workspace merge into the project main worktree is already running',
    };
  }

  private getParentWorkspaceMergeLockTarget(parentWorkspaceId: string): MergeLockTarget {
    return {
      key: `workspace:${parentWorkspaceId}:merge`,
      code: 'WORKSPACE_MERGE_LOCKED',
      message: 'Another merge into the target workspace is already running',
    };
  }

  private async withMergeTargetLock<T>(
    target: MergeLockTarget,
    requestedOwnerId: string | undefined,
    fn: () => Promise<T>
  ): Promise<T> {
    const ownerId = requestedOwnerId ?? `merge-operation:${randomUUID()}`;
    const alreadyHeldByOwner = this.lockService.isHeldBy(ownerId, target.key);
    if (!alreadyHeldByOwner && !this.lockService.acquire(ownerId, [target.key])) {
      throw new ServiceError(
        target.message,
        target.code,
        409
      );
    }

    try {
      return await fn();
    } finally {
      if (!alreadyHeldByOwner) {
        this.lockService.release(ownerId, [target.key]);
      }
    }
  }

  // ── Archive ──────────────────────────────────────────────────────────────────

  /**
   * 归档 Workspace（标记状态为 ABANDONED）
   */
  async archive(id: string) {
    const workspace = await prisma.workspace.findUnique({
      where: { id },
      include: { sessions: true, task: { include: { project: true } } },
    });

    if (!workspace) {
      throw new NotFoundError('Workspace', id);
    }
    ensureProjectIsMutable(workspace.task.project, 'archive workspaces');

    if (workspace.status !== WorkspaceStatus.ACTIVE) {
      throw new ServiceError(
        `Cannot archive workspace in ${workspace.status} status`,
        'INVALID_WORKSPACE_STATE',
        400
      );
    }

    // 停止所有活跃的 Session
    const activeSessions = workspace.sessions.filter(
      (s) => s.status === SessionStatus.PENDING || s.status === SessionStatus.RUNNING
    );
    for (const session of activeSessions) {
      try {
        await this.sessionService.stop(session.id);
      } catch {
        // 忽略停止失败
      }
    }

    const archived = await prisma.workspace.update({
      where: { id },
      data: { status: WorkspaceStatus.ABANDONED },
      include: { sessions: true, task: { include: { project: true } } },
    });
    return archived;
  }

  // ── Hibernate / Reactivate ───────────────────────────────────────────────────

  /**
   * 休眠单个 workspace：auto-commit dirty changes → 删除 worktree 目录 → 标记 HIBERNATED
   * Branch 保留，可随时通过 reactivate() 恢复。
   */
  async hibernate(id: string): Promise<void> {
    const workspace = await prisma.workspace.findUnique({
      where: { id },
      include: {
        sessions: true,
        task: { include: { project: true } },
      },
    });

    if (!workspace) {
      throw new NotFoundError('Workspace', id);
    }
    this.assertWorktreeWorkspace(workspace);

    if (workspace.status !== WorkspaceStatus.ACTIVE) {
      throw new ServiceError(
        `Cannot hibernate workspace in ${workspace.status} status`,
        'INVALID_WORKSPACE_STATE',
        400,
      );
    }

    const hasActiveSessions = workspace.sessions.some(
      (s) => s.status === SessionStatus.PENDING || s.status === SessionStatus.RUNNING,
    );
    if (hasActiveSessions) {
      throw new ServiceError(
        'Cannot hibernate workspace with active sessions',
        'WORKSPACE_HAS_ACTIVE_SESSIONS',
        409,
      );
    }

    // Auto-commit any dirty changes before removing worktree
    if (workspace.worktreePath) {
      const worktreeExists = await fs.access(workspace.worktreePath).then(() => true).catch(() => false);
      if (worktreeExists) {
        await this.autoCommitIfDirty(workspace.worktreePath, id);

        try {
          const worktreeManager = new WorktreeManager(workspace.task.project.repoPath);
          await worktreeManager.remove(workspace.worktreePath);
        } catch (err) {
          console.warn(
            `[WorkspaceService] hibernate: failed to remove worktree for ${id}: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }

    await prisma.workspace.update({
      where: { id },
      data: {
        status: WorkspaceStatus.HIBERNATED,
        worktreePath: '',
        workingDir: '',
        hibernatedAt: new Date(),
      },
    });

    this.eventBus.emit('workspace:hibernated', {
      workspaceId: id,
      taskId: workspace.taskId,
      projectId: workspace.task.projectId,
    });

    console.log(`[WorkspaceService] Workspace ${id} hibernated (branch: ${workspace.branchName})`);
  }

  /**
   * 唤醒休眠的 workspace：从 branch 重建 worktree → 复制文件 → 执行 setup → 恢复 ACTIVE
   */
  async reactivate(id: string) {
    const workspace = await prisma.workspace.findUnique({
      where: { id },
      include: { task: { include: { project: true } } },
    });

    if (!workspace) {
      throw new NotFoundError('Workspace', id);
    }
    ensureTaskNotDeleted(workspace.task);
    this.assertWorktreeWorkspace(workspace);

    if (workspace.status !== WorkspaceStatus.HIBERNATED) {
      throw new ServiceError(
        `Cannot reactivate workspace in ${workspace.status} status`,
        'INVALID_WORKSPACE_STATE',
        400,
      );
    }

    const worktreeManager = new WorktreeManager(workspace.task.project.repoPath);
    const worktreePath = await worktreeManager.ensureWorktreeExists(workspace.branchName);

    const updateResult = await prisma.workspace.updateMany({
      where: { id, task: { deletedAt: null } },
      data: {
        status: WorkspaceStatus.ACTIVE,
        worktreePath,
        workingDir: worktreePath,
        hibernatedAt: null,
      },
    });
    if (updateResult.count === 0) {
      await this.cleanupRestoredWorktree(worktreeManager, worktreePath);
      throw new NotFoundError('Task', workspace.taskId);
    }

    this.runCopyFiles(workspace.task.project.repoPath, worktreePath, workspace.task.project.copyFiles);
    this.fireSetupScript(id, workspace.taskId, worktreePath, workspace.task.project.setupScript);

    const updated = await prisma.workspace.findUniqueOrThrow({
      where: { id },
      include: { sessions: visibleSessionsFilter, task: { include: { project: true } } },
    });

    console.log(`[WorkspaceService] Workspace ${id} reactivated at ${worktreePath}`);
    return updated;
  }

  private async cleanupCreatedWorktree(
    worktreeManager: WorktreeManager,
    worktreePath: string,
    branchName: string,
    protectedBranches: Array<string | null | undefined>,
  ): Promise<void> {
    await this.cleanupRestoredWorktree(worktreeManager, worktreePath);
    try {
      const result = await worktreeManager.deleteBranchIfSafe(branchName, { protectedBranches });
      if (result.status === 'failed' || result.status === 'checked_out') {
        console.warn(
          `[WorkspaceService] failed to delete branch ${result.branchName} after deleted task race: ${result.reason ?? result.status}`,
        );
      }
    } catch (error) {
      console.warn(
        `[WorkspaceService] failed to delete branch ${branchName} after deleted task race: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private async cleanupRestoredWorktree(
    worktreeManager: WorktreeManager,
    worktreePath: string,
  ): Promise<void> {
    try {
      const result = await worktreeManager.remove(worktreePath);
      if (result.status === 'unregistered') {
        console.warn(
          `[WorkspaceService] worktree ${result.path} is unregistered or unsafe to remove after deleted task race`,
        );
      }
    } catch (error) {
      console.warn(
        `[WorkspaceService] failed to remove worktree ${worktreePath} after deleted task race: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  /**
   * 批量休眠空闲 workspace：
   * - ACTIVE 状态
   * - 没有运行中的 session
   * - task 状态不是 IN_PROGRESS / IN_REVIEW
   * - 超过 idleThresholdHours 未活动
   *
   * @returns 休眠的 workspace 数量
   */
  async hibernateIdle(idleThresholdHours = DEFAULT_IDLE_THRESHOLD_HOURS): Promise<number> {
    const cutoff = new Date(Date.now() - idleThresholdHours * 60 * 60 * 1000);

    const candidates = await prisma.workspace.findMany({
      where: {
        status: WorkspaceStatus.ACTIVE,
        workspaceKind: WorkspaceKind.WORKTREE,
        worktreePath: { not: '' },
        task: {
          status: { notIn: [TaskStatus.IN_PROGRESS, TaskStatus.IN_REVIEW] },
        },
        sessions: {
          none: {
            status: { in: [SessionStatus.PENDING, SessionStatus.RUNNING] },
          },
        },
        updatedAt: { lt: cutoff },
      },
      select: { id: true, branchName: true },
    });

    let hibernated = 0;
    for (const ws of candidates) {
      try {
        await this.hibernate(ws.id);
        hibernated++;
      } catch (err) {
        console.warn(
          `[WorkspaceService] hibernateIdle: failed for workspace ${ws.id}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (hibernated > 0) {
      console.log(`[WorkspaceService] hibernateIdle: ${hibernated}/${candidates.length} workspaces hibernated`);
    }

    return hibernated;
  }

  /**
   * Auto-commit all changes in a worktree directory to prevent data loss.
   */
  private async autoCommitIfDirty(worktreePath: string, workspaceId: string): Promise<void> {
    try {
      const status = await execGit(worktreePath, ['status', '--porcelain']);
      if (!status.trim()) return;

      await execGit(worktreePath, ['add', '-A']);
      await execGit(worktreePath, [
        'commit', '-m',
        `auto-commit: save changes before hibernation (workspace ${workspaceId.slice(0, 8)})`,
      ]);
      console.log(`[WorkspaceService] Auto-committed dirty changes before hibernation for ${workspaceId}`);
    } catch (err) {
      console.warn(
        `[WorkspaceService] Auto-commit before hibernation failed for ${workspaceId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────────

  /**
   * 清理所有 ABANDONED/MERGED 状态且关联 Task 为 DONE 的 Workspace
   *
   * @returns 被清理的 Workspace 数量
   */
  async cleanup(): Promise<number> {
    const workspaces = await prisma.workspace.findMany({
      where: {
        status: { in: [WorkspaceStatus.ABANDONED, WorkspaceStatus.MERGED] },
        task: { status: TaskStatus.DONE },
      },
      include: { task: { include: { project: true } } },
    });

    let cleaned = 0;

    for (const workspace of workspaces) {
      try {
        if (isMainDirectoryWorkspace(workspace)) {
          await prisma.workspace.delete({ where: { id: workspace.id } });
          cleaned++;
          continue;
        }

        const worktreeManager = new WorktreeManager(workspace.task.project.repoPath);

        // 清理残留 worktree（如果还存在）
        if (workspace.worktreePath) {
          const removeResult = await worktreeManager.remove(workspace.worktreePath);
          if (removeResult.status === 'unregistered') {
            console.warn(
              `[WorkspaceService] cleanup: workspace ${workspace.id} path is unregistered or unsafe to remove: ${removeResult.path}`,
            );
            continue;
          }
        }

        // Task 已 DONE，branch 不再需要，删除。安全 helper 会跳过 base/main/master/current/missing。
        const branchDeleteResult = await worktreeManager.deleteBranchIfSafe(workspace.branchName, {
          protectedBranches: [workspace.task.project.mainBranch, workspace.baseBranch],
        });
        if (branchDeleteResult.status === 'failed') {
          console.warn(
            `[WorkspaceService] cleanup: failed to delete branch ${branchDeleteResult.branchName} for workspace ${workspace.id}: ${branchDeleteResult.reason}`,
          );
        } else if (branchDeleteResult.status === 'checked_out') {
          console.warn(
            `[WorkspaceService] cleanup: skipped checked-out branch ${branchDeleteResult.branchName} for workspace ${workspace.id}: ${branchDeleteResult.reason}`,
          );
        }

        await prisma.workspace.delete({ where: { id: workspace.id } });
        cleaned++;
      } catch (err) {
        // worktree 删除失败时保留 DB 记录，下次 scan 重试
        console.warn(
          `[WorkspaceService] cleanup: failed for workspace ${workspace.id}: ${err instanceof Error ? err.message : err}`
        );
      }
    }

    return cleaned;
  }

  // ── Startup Prune ────────────────────────────────────────────────────────────

  private assertWorktreeWorkspace(workspace: { workspaceKind?: string | null }): void {
    if (isWorktreeWorkspace(workspace)) return;
    throw new ServiceError(
      'Workspace git lifecycle operations are unavailable for main-directory workspaces',
      'WORKSPACE_GIT_UNAVAILABLE',
      400,
    );
  }

  /**
   * 复制项目配置的文件到 worktree
   */
  private runCopyFiles(repoPath: string, worktreePath: string, copyFiles: string | null): void {
    if (!copyFiles?.trim()) return;
    try {
      copyProjectFiles(repoPath, worktreePath, copyFiles);
    } catch (err) {
      console.warn(
        `[WorkspaceService] copyFiles failed: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  /**
   * 在 worktree 中执行 setup 脚本（逐行执行），通过 EventBus 推送进度
   */
  private async runSetupScript(
    workspaceId: string,
    taskId: string,
    worktreePath: string,
    setupScript: string | null,
  ): Promise<void> {
    if (!setupScript?.trim()) return;
    const commands = setupScript.split('\n').map((c) => c.trim()).filter(Boolean);
    if (commands.length === 0) return;

    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      console.log(`[WorkspaceService] Setup [${i + 1}/${commands.length}] running: "${cmd}"`);
      this.eventBus.emit('workspace:setup_progress', {
        workspaceId,
        taskId,
        status: 'running',
        currentCommand: cmd,
        currentIndex: i + 1,
        totalCommands: commands.length,
      });

      try {
        await execAsync(cmd, { cwd: worktreePath, timeout: 300_000 });
      } catch (err) {
        console.warn(
          `[WorkspaceService] Setup command failed: "${cmd}" - ${err instanceof Error ? err.message : err}`
        );
        // 不中断，继续执行下一条
      }
    }

    console.log(`[WorkspaceService] Setup completed (${commands.length} commands)`);
    this.eventBus.emit('workspace:setup_progress', {
      workspaceId,
      taskId,
      status: 'completed',
      totalCommands: commands.length,
    });
  }

  /**
   * Fire-and-forget 包装：异步执行 setup 脚本，不阻塞调用方
   */
  private fireSetupScript(
    workspaceId: string,
    taskId: string,
    worktreePath: string,
    setupScript: string | null,
  ): void {
    if (!setupScript?.trim()) return;
    this.runSetupScript(workspaceId, taskId, worktreePath, setupScript).catch((err) => {
      console.error(`[WorkspaceService] Setup script unexpected error:`, err);
      this.eventBus.emit('workspace:setup_progress', {
        workspaceId,
        taskId,
        status: 'failed',
        totalCommands: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * 服务启动时调用：对所有项目执行 git worktree prune
   */
  static async pruneAllWorktrees(): Promise<void> {
    const projects = await prisma.project.findMany();

    for (const project of projects) {
      if (!hasGitMetadata(project.repoPath)) continue;
      try {
        const worktreeManager = new WorktreeManager(project.repoPath);
        await worktreeManager.prune();
      } catch (err) {
        console.warn(
          `[WorkspaceService] prune failed for project ${project.id}: ${err instanceof Error ? err.message : err}`
        );
      }
    }
  }
}
