import type {
  AgentInvocation,
  AgentInvocationStatus,
  AgentInvocationTargetSyncStatus,
  IfBusyPolicy,
  MemberPreset,
  RoomMessage,
  RoomMessageContentMode,
  RoomMessageKind,
  RoomMessageParticipant,
  RoomMessageParticipantRole,
  RoomMessageSenderType,
  RoomMessageVisibility,
  StructuredMention,
  TeamMember,
  TeamMemberCapabilities,
  TeamMemberMembershipStatus,
  TeamMemberQueueManagementPolicy,
  TeamMemberSessionPolicy,
  TeamMemberStatus,
  TeamMemberTriggerPolicy,
  TeamRun,
  TeamRunMode,
  TeamRunReviewReason,
  TeamTemplate,
  TeamTemplateMember,
  WorkRequest,
  WorkRequestRequesterType,
  WorkRequestStatus,
  WorkRequestTargetKind,
  WorkRequestTargetPurpose,
  WorkspacePolicy,
} from '@agent-tower/shared';
import type {
  AgentInvocation as PrismaAgentInvocation,
  MemberPreset as PrismaMemberPreset,
  Prisma,
  RoomMessage as PrismaRoomMessage,
  RoomMessageParticipant as PrismaRoomMessageParticipant,
  TeamMember as PrismaTeamMember,
  TeamRun as PrismaTeamRun,
  TeamTemplate as PrismaTeamTemplate,
  TeamTemplateMember as PrismaTeamTemplateMember,
  WorkRequest as PrismaWorkRequest,
} from '@prisma/client';
import { ServiceError, NotFoundError, ValidationError } from '../errors.js';
import { randomUUID } from 'node:crypto';
import { getProviderById } from '../executors/index.js';
import { prisma } from '../utils/index.js';
import { getEventBus, getSessionManager, getTranslationService } from '../core/container.js';
import { appendAttachmentMarkdownContext } from './attachment-context.js';
import { emitTeamRunInvalidated } from './team-run-events.js';
import { TeamReconcilerService } from './team-reconciler.service.js';
import { ensureTaskNotDeleted } from './deleted-task-guard.js';
import { buildTextPreview, TASK_TITLE_MAX_LENGTH } from './task.service.js';
import { ensureProjectSupportsWorktrees } from './project-guards.js';
import { taskInputHash, buildTaskUserText, adoptTaskInputInTransaction, type TaskInputAcceptanceToken } from './team-task-input.js';
import { readTeamDeliveryIntent, verifyPublishedTeamDelivery, roomDeliveryIntegrityError, teamInitialIntentSchema, type TeamInitialDeliveryIntent } from './team-room-delivery.js';
import { isRuntimeAwaitingPermission } from '../runtime/runtime-state-view.js';

const TERMINAL_AGENT_INVOCATION_STATUSES = new Set<AgentInvocationStatus>([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);

export interface CreateMemberPresetInput {
  name: string;
  aliases: string[];
  providerId: string;
  rolePrompt: string;
  capabilities: TeamMemberCapabilities;
  workspacePolicy: WorkspacePolicy;
  triggerPolicy: TeamMemberTriggerPolicy;
  sessionPolicy: TeamMemberSessionPolicy;
  queueManagementPolicy: TeamMemberQueueManagementPolicy;
  avatar?: string | null;
}

export type UpdateMemberPresetInput = Partial<CreateMemberPresetInput>;

export interface TeamTemplateMemberInput {
  memberPresetId: string;
  position?: number;
}

export interface CreateTeamTemplateInput {
  name: string;
  heartbeatTimeoutMinutes?: number;
  memberPresetIds?: string[];
  members?: TeamTemplateMemberInput[];
}

export interface UpdateTeamTemplateInput {
  name?: string;
  heartbeatTimeoutMinutes?: number;
  memberPresetIds?: string[];
  members?: TeamTemplateMemberInput[];
}

export interface CreateTeamRunMemberInput {
  name: string;
  aliases: string[];
  providerId: string;
  rolePrompt: string;
  capabilities: TeamMemberCapabilities;
  workspacePolicy: WorkspacePolicy;
  triggerPolicy: TeamMemberTriggerPolicy;
  sessionPolicy: TeamMemberSessionPolicy;
  queueManagementPolicy: TeamMemberQueueManagementPolicy;
  avatar?: string | null;
}

export interface AddTeamRunMemberInput {
  memberPresetId?: string;
  member?: CreateTeamRunMemberInput;
}

export type PatchTeamRunMemberInput = Partial<CreateTeamRunMemberInput>;

export interface RemoveTeamRunMemberOptions {
  cancelQueued?: boolean;
}

export interface CreateTeamRunInput {
  mode: TeamRunMode;
  teamTemplateId?: string;
  memberPresetIds?: string[];
  members?: CreateTeamRunMemberInput[];
}

export interface CreateRoomMessageInput {
  content: string;
  mentions?: StructuredMention[];
  attachmentIds?: string[];
  artifactRefs?: string[];
  senderType?: RoomMessageSenderType;
  senderId?: string | null;
  senderInvocationId?: string | null;
  kind?: RoomMessageKind;
}

export interface CreatePrivateRoomMessageInput {
  content: string;
  recipientMemberIds: string[];
  target?: StructuredMention['target'];
  attachmentIds?: string[];
  artifactRefs?: string[];
  senderType?: RoomMessageSenderType;
  senderId?: string | null;
  senderInvocationId?: string | null;
  ifBusy?: IfBusyPolicy;
  cancelQueued?: boolean;
}

export interface TeamRunVisibilityOptions {
  viewerMemberId?: string | null;
}

export interface ListRoomMessagesOptions extends TeamRunVisibilityOptions {
  limit?: number;
}

export interface TeamRunAgentInvocationIdentity {
  invocationId: string;
  memberId: string;
}

export interface WorkRequestQueueItem extends WorkRequest {
  triggerMessage: {
    id: string;
    senderType: RoomMessageSenderType;
    senderId: string | null;
    senderInvocationId: string | null;
    kind: RoomMessageKind;
    contentPreview: string;
    createdAt: string;
  } | null;
  targetMember: {
    id: string;
    name: string;
    label: string;
  } | null;
}

export interface MemberWorkRequestQueue {
  teamRunId: string;
  currentMemberId: string;
  queueManagementPolicy: TeamMemberQueueManagementPolicy;
  canManageTeamRunQueue: boolean;
  workRequests: WorkRequestQueueItem[];
}

interface TeamMemberSnapshot {
  presetId: string | null;
  name: string;
  aliases: string[];
  providerId: string;
  rolePrompt: string;
  capabilities: TeamMemberCapabilities;
  workspacePolicy: WorkspacePolicy;
  triggerPolicy: TeamMemberTriggerPolicy;
  sessionPolicy: TeamMemberSessionPolicy;
  queueManagementPolicy: TeamMemberQueueManagementPolicy;
  avatar: string | null;
}

type PrismaTeamTemplateWithMembers = PrismaTeamTemplate & {
  members?: PrismaTeamTemplateMember[];
};

const ownerDeliverySelect = { clientSubmissionId: true, id: true, originalText: true, actualSentText: true, sentMode: true, revision: true } as const;
type PrismaRoomMessageWithParticipants = PrismaRoomMessage & {
  delivery?: { clientSubmissionId: string; id: string; originalText: string; actualSentText: string | null; sentMode: string | null; revision: number } | null;
  participants?: PrismaRoomMessageParticipant[];
};

type PrismaTeamRunWithRelations = PrismaTeamRun & {
  members?: PrismaTeamMember[];
  messages?: PrismaRoomMessageWithParticipants[];
  workRequests?: PrismaWorkRequest[];
  invocations?: PrismaAgentInvocation[];
};

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

const DEFAULT_SESSION_POLICY: TeamMemberSessionPolicy = 'new_per_request';
const DEFAULT_QUEUE_MANAGEMENT_POLICY: TeamMemberQueueManagementPolicy = 'own_only';
const ACTIVE_MEMBERSHIP_STATUS: TeamMemberMembershipStatus = 'ACTIVE';
const REMOVED_MEMBERSHIP_STATUS: TeamMemberMembershipStatus = 'REMOVED';
const ACTIVE_INVOCATION_STATUSES: AgentInvocationStatus[] = [
  'QUEUED',
  'RUNNING',
  'SESSION_ENDED',
  'WAITING_ROOM_REPLY',
];

function serializeTargetKind(value: string | null): WorkRequestTargetKind | null {
  return value === 'WORKSPACE_COMMIT' ? value : null;
}

function serializeTargetPurpose(value: string | null): WorkRequestTargetPurpose | null {
  return value === 'REVIEW' || value === 'TEST' ? value : null;
}

function serializeTargetSyncStatus(value: string | null): AgentInvocationTargetSyncStatus | null {
  return value === 'PENDING' || value === 'SYNCED' || value === 'FAILED' ? value : null;
}
const OPEN_WORK_REQUEST_STATUSES: WorkRequestStatus[] = [
  'PENDING_APPROVAL',
  'QUEUED',
];

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

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function toIso(date: Date): string {
  return date.toISOString();
}

function applyStableInstanceNames(snapshots: TeamMemberSnapshot[]): TeamMemberSnapshot[] {
  const totalsByName = new Map<string, number>();
  for (const snapshot of snapshots) {
    totalsByName.set(snapshot.name, (totalsByName.get(snapshot.name) ?? 0) + 1);
  }

  const seenByName = new Map<string, number>();
  return snapshots.map((snapshot) => {
    const total = totalsByName.get(snapshot.name) ?? 0;
    if (total <= 1) {
      return snapshot;
    }

    const instanceIndex = (seenByName.get(snapshot.name) ?? 0) + 1;
    seenByName.set(snapshot.name, instanceIndex);
    return {
      ...snapshot,
      name: `${snapshot.name} #${instanceIndex}`,
    };
  });
}

function toConflict(message: string): ServiceError {
  return new ServiceError(message, 'CONFLICT', 409);
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: string }).code === 'P2002';
}

function buildInitialTaskRoomMessageContent(task: { title: string; description?: string | null }): string {
  const title = buildTextPreview(task.title, TASK_TITLE_MAX_LENGTH);
  if (title.length === 0) {
    throw new ValidationError('Task title is required to create a TeamRun');
  }

  // 标题保持截断（避免把超长内容塞进任务标题），但任务描述完整写入首条群消息，
  // 让成员通过 list_room_messages / get_room_message 能拿到完整需求，而不再只是预览。
  const description = task.description;
  return description?.trim()
    ? `${title}\n\n${description}`
    : title;
}

function buildInitialTaskMentionSource(task: { title: string; description?: string | null }): string {
  return [task.title.trim(), task.description?.trim() ?? ''].filter(Boolean).join('\n\n');
}

function extractMentionTokens(content: string): string[] {
  const tokens: string[] = [];
  const tokenPattern = /(^|[^\p{L}\p{N}_-])@([^\s@]+)/gu;
  const trailingPunctuation = /[.,!?;:，。！？；：、)\]}>"'”’）】》]+$/u;

  for (const match of content.matchAll(tokenPattern)) {
    const token = (match[2] ?? '').replace(trailingPunctuation, '');
    if (token.length > 0) {
      tokens.push(token);
    }
  }

  return tokens;
}

function deriveStructuredMentionsFromContent(
  content: string,
  members: Array<Pick<PrismaTeamMember, 'id' | 'name' | 'aliases'>>
): { mentions: StructuredMention[]; tokenCount: number } {
  const matchesByToken = new Map<string, Array<{ memberId: string; label: string }>>();

  for (const member of members) {
    const labels = Array.from(new Set([
      member.name,
      ...parseJsonField<string[]>(member.aliases, []),
    ].map((label) => label.trim()).filter(Boolean)));

    for (const label of labels) {
      const matches = matchesByToken.get(label) ?? [];
      if (!matches.some((match) => match.memberId === member.id)) {
        matches.push({ memberId: member.id, label });
      }
      matchesByToken.set(label, matches);
    }
  }

  const mentions: StructuredMention[] = [];
  const mentionedMemberIds = new Set<string>();
  const tokens = extractMentionTokens(content);
  for (const token of tokens) {
    const matches = matchesByToken.get(token) ?? [];
    if (matches.length !== 1 || mentionedMemberIds.has(matches[0]!.memberId)) {
      continue;
    }

    const match = matches[0]!;
    mentions.push({ memberId: match.memberId, label: match.label });
    mentionedMemberIds.add(match.memberId);
  }

  return { mentions, tokenCount: tokens.length };
}

function assertMentionsReferenceMembers(mentions: StructuredMention[], memberIds: Set<string>): void {
  for (const mention of mentions) {
    if (!memberIds.has(mention.memberId)) {
      throw new NotFoundError('TeamMember', mention.memberId);
    }
  }
}

function uniqueMemberIds(memberIds: string[]): string[] {
  return Array.from(new Set(memberIds.map((memberId) => memberId.trim()).filter(Boolean)));
}

function isActiveMembershipStatus(value: string | null | undefined): boolean {
  return value !== REMOVED_MEMBERSHIP_STATUS;
}

function buildRoomMessageVisibilityWhere(
  teamRunId: string,
  viewerMemberId?: string | null
) {
  if (!viewerMemberId) {
    return { teamRunId };
  }

  return {
    teamRunId,
    OR: [
      { visibility: 'PUBLIC' },
      {
        participants: {
          some: {
            memberId: viewerMemberId,
          },
        },
      },
    ],
  };
}

function activeTeamMembersWhere(teamRunId: string) {
  return {
    teamRunId,
    membershipStatus: ACTIVE_MEMBERSHIP_STATUS,
  };
}

function isRoomMessageVisibleToViewer(
  message: PrismaRoomMessageWithParticipants,
  viewerMemberId?: string | null
): boolean {
  if (!viewerMemberId) return true;
  if (message.visibility !== 'PRIVATE') return true;
  return (message.participants ?? []).some((participant) => participant.memberId === viewerMemberId);
}

function getVisibleWorkRequestIds(
  messages: PrismaRoomMessageWithParticipants[],
  viewerMemberId?: string | null
): Set<string> | null {
  if (!viewerMemberId) return null;

  const visibleWorkRequestIds = new Set<string>();
  for (const message of messages) {
    if (!isRoomMessageVisibleToViewer(message, viewerMemberId)) {
      continue;
    }
    for (const workRequestId of parseJsonField<string[]>(message.workRequestIds, [])) {
      visibleWorkRequestIds.add(workRequestId);
    }
  }
  return visibleWorkRequestIds;
}

function resolveRoomMessageTargetRequests({
  mentions,
  members,
  senderType,
  requesterMemberId,
  allowUserMessageFallback = true,
}: {
  mentions: StructuredMention[];
  members: Array<Pick<PrismaTeamMember, 'id' | 'triggerPolicy'>>;
  senderType: RoomMessageSenderType;
  requesterMemberId: string | null;
  allowUserMessageFallback?: boolean;
}): Array<{ targetMemberId: string; ifBusy: IfBusyPolicy; cancelQueued: boolean; target?: StructuredMention['target'] }> {
  if (mentions.length > 0) {
    return mentions.map((mention) => ({
      targetMemberId: mention.memberId,
      ifBusy: mention.ifBusy ?? 'queue',
      cancelQueued: mention.cancelQueued ?? false,
      target: mention.target ?? null,
    }));
  }

  if (!allowUserMessageFallback) {
    return [];
  }

  if (senderType !== 'user' && senderType !== 'agent') {
    return [];
  }

  return members
    .filter((member) => member.triggerPolicy === 'USER_MESSAGES')
    .filter((member) => member.id !== requesterMemberId)
    .map((member) => ({
      targetMemberId: member.id,
      ifBusy: 'queue' as const,
      cancelQueued: false,
      target: null,
    }));
}

type WorkRequestTargetData = {
  targetKind?: string | null;
  targetPurpose?: string | null;
  targetSourceWorkspaceId?: string | null;
  targetSourceMemberId?: string | null;
  targetHeadSha?: string | null;
  targetBranchName?: string | null;
  targetPlanItemId?: string | null;
};

async function buildWorkRequestTargetData(
  tx: Prisma.TransactionClient,
  teamRunId: string,
  target: StructuredMention['target'] | null | undefined
): Promise<WorkRequestTargetData> {
  if (!target) {
    return {};
  }

  const sourceWorkspace = await tx.workspace.findFirst({
    where: {
      id: target.sourceWorkspaceId,
      task: { teamRun: { id: teamRunId } },
    },
    select: {
      id: true,
      ownerMemberId: true,
    },
  });
  if (!sourceWorkspace) {
    throw new ValidationError('Target sourceWorkspaceId must belong to this TeamRun');
  }

  return {
    targetKind: target.kind,
    targetPurpose: target.purpose,
    targetSourceWorkspaceId: sourceWorkspace.id,
    targetSourceMemberId: sourceWorkspace.ownerMemberId,
    targetHeadSha: target.headSha.trim(),
    targetBranchName: target.branchName.trim(),
    targetPlanItemId: target.planItemId?.trim() || null,
  };
}

export class TeamRunService {
  private reconciler?: TeamReconcilerService;

  // 懒加载 reconciler，用于 agent room message 的即时 reconcile（WAITING_ROOM_REPLY→COMPLETED / RUNNING 清零）。
  private getReconciler(): TeamReconcilerService {
    if (!this.reconciler) {
      // Room replies can terminalize a TeamRun invocation. The reconciler
      // must own the same SessionManager so that terminalization also disposes
      // the runtime process tree instead of only updating database state.
      this.reconciler = new TeamReconcilerService({
        eventBus: getEventBus(),
        sessionMessenger: getSessionManager(),
      });
    }
    return this.reconciler;
  }

  async listMemberPresets(): Promise<MemberPreset[]> {
    const presets = await prisma.memberPreset.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return presets.map((preset) => this.serializeMemberPreset(preset));
  }

  async getMemberPresetById(id: string): Promise<MemberPreset> {
    const preset = await prisma.memberPreset.findUnique({ where: { id } });
    if (!preset) {
      throw new NotFoundError('MemberPreset', id);
    }
    return this.serializeMemberPreset(preset);
  }

  async createMemberPreset(input: CreateMemberPresetInput): Promise<MemberPreset> {
    const preset = await prisma.memberPreset.create({
      data: {
        name: input.name,
        aliases: stringifyJson(input.aliases),
        providerId: input.providerId,
        rolePrompt: input.rolePrompt,
        capabilities: stringifyJson(input.capabilities),
        workspacePolicy: input.workspacePolicy,
        triggerPolicy: input.triggerPolicy,
        sessionPolicy: input.sessionPolicy,
        queueManagementPolicy: input.queueManagementPolicy,
        avatar: input.avatar ?? null,
      },
    });
    return this.serializeMemberPreset(preset);
  }

  async updateMemberPreset(id: string, input: UpdateMemberPresetInput): Promise<MemberPreset> {
    await this.getMemberPresetById(id);
    if (Object.keys(input).length === 0) {
      throw new ValidationError('At least one member preset field is required');
    }

    const preset = await prisma.memberPreset.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.aliases !== undefined ? { aliases: stringifyJson(input.aliases) } : {}),
        ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
        ...(input.rolePrompt !== undefined ? { rolePrompt: input.rolePrompt } : {}),
        ...(input.capabilities !== undefined ? { capabilities: stringifyJson(input.capabilities) } : {}),
        ...(input.workspacePolicy !== undefined ? { workspacePolicy: input.workspacePolicy } : {}),
        ...(input.triggerPolicy !== undefined ? { triggerPolicy: input.triggerPolicy } : {}),
        ...(input.sessionPolicy !== undefined ? { sessionPolicy: input.sessionPolicy } : {}),
        ...(input.queueManagementPolicy !== undefined ? { queueManagementPolicy: input.queueManagementPolicy } : {}),
        ...(input.avatar !== undefined ? { avatar: input.avatar } : {}),
      },
    });

    return this.serializeMemberPreset(preset);
  }

  async deleteMemberPreset(id: string): Promise<void> {
    await this.getMemberPresetById(id);
    const templateMemberCount = await prisma.teamTemplateMember.count({
      where: { memberPresetId: id },
    });
    if (templateMemberCount > 0) {
      throw toConflict(`MemberPreset is used by ${templateMemberCount} TeamTemplate member(s): ${id}`);
    }

    await prisma.memberPreset.delete({ where: { id } });
  }

  async listTeamTemplates(): Promise<TeamTemplate[]> {
    const templates = await prisma.teamTemplate.findMany({
      include: { members: { orderBy: { position: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    });

    return Promise.all(templates.map((template) => this.serializeTeamTemplate(template)));
  }

  async getTeamTemplateById(id: string): Promise<TeamTemplate> {
    const template = await prisma.teamTemplate.findUnique({
      where: { id },
      include: { members: { orderBy: { position: 'asc' } } },
    });
    if (!template) {
      throw new NotFoundError('TeamTemplate', id);
    }
    return this.serializeTeamTemplate(template);
  }

  async createTeamTemplate(input: CreateTeamTemplateInput): Promise<TeamTemplate> {
    const members = this.normalizeTeamTemplateMembers(input);
    await this.assertMemberPresetsExist(members.map((member) => member.memberPresetId));

    const template = await prisma.teamTemplate.create({
      data: {
        name: input.name,
        heartbeatTimeoutMinutes: input.heartbeatTimeoutMinutes ?? 10,
        members: {
          create: members,
        },
      },
      include: { members: { orderBy: { position: 'asc' } } },
    });

    return this.serializeTeamTemplate(template);
  }

  async updateTeamTemplate(id: string, input: UpdateTeamTemplateInput): Promise<TeamTemplate> {
    await this.getTeamTemplateById(id);
    if (
      input.name === undefined
      && input.heartbeatTimeoutMinutes === undefined
      && input.memberPresetIds === undefined
      && input.members === undefined
    ) {
      throw new ValidationError('At least one team template field is required');
    }

    const shouldReplaceMembers = input.members !== undefined || input.memberPresetIds !== undefined;
    const members = shouldReplaceMembers ? this.normalizeTeamTemplateMembers(input) : [];
    if (shouldReplaceMembers) {
      await this.assertMemberPresetsExist(members.map((member) => member.memberPresetId));
    }

    await prisma.$transaction(async (tx) => {
      if (input.name !== undefined || input.heartbeatTimeoutMinutes !== undefined) {
        await tx.teamTemplate.update({
          where: { id },
          data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.heartbeatTimeoutMinutes !== undefined
              ? { heartbeatTimeoutMinutes: input.heartbeatTimeoutMinutes }
              : {}),
          },
        });
      }

      if (shouldReplaceMembers) {
        await tx.teamTemplateMember.deleteMany({ where: { teamTemplateId: id } });
        if (members.length > 0) {
          await tx.teamTemplateMember.createMany({
            data: members.map((member) => ({
              teamTemplateId: id,
              memberPresetId: member.memberPresetId,
              position: member.position,
            })),
          });
        }
      }
    });

    return this.getTeamTemplateById(id);
  }

  async deleteTeamTemplate(id: string): Promise<void> {
    await this.getTeamTemplateById(id);
    await prisma.teamTemplate.delete({ where: { id } });
  }

  async createTeamRun(taskId: string, input: CreateTeamRunInput): Promise<TeamRun> {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      include: { project: true },
    });
    if (!task) {
      throw new NotFoundError('Task', taskId);
    }
    ensureTaskNotDeleted(task);
    await ensureProjectSupportsWorktrees(task.project, 'create TeamRun');
    buildInitialTaskRoomMessageContent(task);

    const existing = await prisma.teamRun.findUnique({ where: { taskId } });
    if (existing) {
      throw toConflict(`Task already has a TeamRun: ${taskId}`);
    }

    const snapshots = applyStableInstanceNames(await this.buildTeamMemberSnapshots(input));
    const heartbeatTimeoutMinutes = await this.resolveHeartbeatTimeoutMinutes(input);
    if (snapshots.length === 0) {
      throw new ValidationError('TeamRun must include at least one member');
    }

    let teamRunId = '';
    try {
      await prisma.$transaction(async (tx) => {
        const teamRun = await tx.teamRun.create({
          data: {
            taskId,
            mode: input.mode,
            heartbeatTimeoutMinutes,
          },
        });
        teamRunId = teamRun.id;

        for (const snapshot of snapshots) {
          await tx.teamMember.create({
            data: {
              teamRunId: teamRun.id,
              presetId: snapshot.presetId,
              name: snapshot.name,
              aliases: stringifyJson(snapshot.aliases),
              providerId: snapshot.providerId,
              rolePrompt: snapshot.rolePrompt,
              capabilities: stringifyJson(snapshot.capabilities),
              workspacePolicy: snapshot.workspacePolicy,
              triggerPolicy: snapshot.triggerPolicy,
              sessionPolicy: snapshot.sessionPolicy,
              queueManagementPolicy: snapshot.queueManagementPolicy,
              membershipStatus: ACTIVE_MEMBERSHIP_STATUS,
              avatar: snapshot.avatar,
            },
          });
        }
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw toConflict(`Task already has a TeamRun: ${taskId}`);
      }
      throw error;
    }

    const teamRun = await this.getTeamRunById(teamRunId);
    await emitTeamRunInvalidated({
      teamRunId,
      taskId,
      projectId: task.projectId,
      scopes: ['team-run', 'team-members', 'task'],
      reason: 'team-run-created',
    });

    return teamRun;
  }

  async createTeamRunWithInitialRoomMessage(taskId: string, input: CreateTeamRunInput): Promise<TeamRun> {
    const snapshots = applyStableInstanceNames(await this.buildTeamMemberSnapshots(input));
    const heartbeatTimeoutMinutes = await this.resolveHeartbeatTimeoutMinutes(input);
    if (snapshots.length === 0) {
      throw new ValidationError('TeamRun must include at least one member');
    }

    const taskForGitCheck = await prisma.task.findUnique({
      where: { id: taskId },
      include: { project: true },
    });
    if (!taskForGitCheck) {
      throw new NotFoundError('Task', taskId);
    }
    ensureTaskNotDeleted(taskForGitCheck);
    await ensureProjectSupportsWorktrees(taskForGitCheck.project, 'create TeamRun');

    let teamRunId = '';
    let projectId = '';
    let createdTeamRun: PrismaTeamRunWithRelations | null = null;

    try {
      createdTeamRun = await prisma.$transaction(async (tx) => {
        const task = await tx.task.findUnique({
          where: { id: taskId },
          include: { project: true },
        });
        if (!task) {
          throw new NotFoundError('Task', taskId);
        }
        ensureTaskNotDeleted(task);
        projectId = task.projectId;
        const initialContent = buildInitialTaskRoomMessageContent(task);
        const initialMentionSource = buildInitialTaskMentionSource(task);

        const existing = await tx.teamRun.findUnique({ where: { taskId } });
        if (existing) {
          throw toConflict(`Task already has a TeamRun: ${taskId}`);
        }

        const teamRun = await tx.teamRun.create({
          data: {
            taskId,
            mode: input.mode,
            heartbeatTimeoutMinutes,
          },
        });
        teamRunId = teamRun.id;

        const members: PrismaTeamMember[] = [];
        for (const snapshot of snapshots) {
          const member = await tx.teamMember.create({
            data: {
              teamRunId: teamRun.id,
              presetId: snapshot.presetId,
              name: snapshot.name,
              aliases: stringifyJson(snapshot.aliases),
              providerId: snapshot.providerId,
              rolePrompt: snapshot.rolePrompt,
              capabilities: stringifyJson(snapshot.capabilities),
              workspacePolicy: snapshot.workspacePolicy,
              triggerPolicy: snapshot.triggerPolicy,
              sessionPolicy: snapshot.sessionPolicy,
              queueManagementPolicy: snapshot.queueManagementPolicy,
              membershipStatus: ACTIVE_MEMBERSHIP_STATUS,
              avatar: snapshot.avatar,
            },
          });
          members.push(member);
        }

        const initialMentionParse = deriveStructuredMentionsFromContent(initialMentionSource, members);
        const message = await tx.roomMessage.create({
          data: {
            teamRunId: teamRun.id,
            senderType: 'user',
            senderId: null,
            senderInvocationId: null,
            kind: 'chat',
            content: initialContent,
            mentions: stringifyJson(initialMentionParse.mentions),
            artifactRefs: stringifyJson([]),
            attachmentIds: stringifyJson([]),
            workRequestIds: stringifyJson([]),
          },
        });

        const workRequestStatus: WorkRequestStatus = input.mode === 'CONFIRM'
          ? 'PENDING_APPROVAL'
          : 'QUEUED';
        const targetRequests = resolveRoomMessageTargetRequests({
          mentions: initialMentionParse.mentions,
          members,
          senderType: 'user',
          requesterMemberId: null,
          allowUserMessageFallback: initialMentionParse.tokenCount === 0,
        });
        const workRequestIds: string[] = [];
        for (const targetRequest of targetRequests) {
          const targetData = await buildWorkRequestTargetData(tx, teamRun.id, targetRequest.target);
          const workRequest = await tx.workRequest.create({
            data: {
              teamRunId: teamRun.id,
              requesterMemberId: null,
              requesterType: 'user',
              targetMemberId: targetRequest.targetMemberId,
              ...targetData,
              triggerMessageId: message.id,
              instruction: initialContent,
              ifBusy: targetRequest.ifBusy,
              cancelQueued: targetRequest.cancelQueued,
              status: workRequestStatus,
            },
          });
          workRequestIds.push(workRequest.id);
        }

        if (workRequestIds.length > 0) {
          await tx.roomMessage.update({
            where: { id: message.id },
            data: { workRequestIds: stringifyJson(workRequestIds) },
          });
        }

        const created = await tx.teamRun.findUnique({
          where: { id: teamRun.id },
          include: this.teamRunInclude(),
        });
        if (!created) {
          throw new NotFoundError('TeamRun', teamRun.id);
        }
        return created;
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw toConflict(`Task already has a TeamRun: ${taskId}`);
      }
      throw error;
    }

    const serialized = this.serializeTeamRun(createdTeamRun);
    await emitTeamRunInvalidated({
      teamRunId,
      taskId,
      projectId,
      scopes: ['team-run', 'team-members', 'room-messages', 'work-requests', 'task'],
      reason: 'team-run-created',
    });

    return serialized;
  }

  async getTaskTeamRun(taskId: string, options: TeamRunVisibilityOptions = {}): Promise<TeamRun> {
    const teamRun = await prisma.teamRun.findUnique({
      where: { taskId },
      include: this.teamRunInclude(),
    });
    if (!teamRun) {
      throw new NotFoundError('TeamRun for task', taskId);
    }
    return this.serializeTeamRun(teamRun, options);
  }

  async getTeamRunById(id: string, options: TeamRunVisibilityOptions = {}): Promise<TeamRun> {
    const teamRun = await prisma.teamRun.findUnique({
      where: { id },
      include: this.teamRunInclude(),
    });
    if (!teamRun) {
      throw new NotFoundError('TeamRun', id);
    }
    return this.serializeTeamRun(teamRun, options);
  }

  async listTeamMembers(teamRunId: string, options: TeamRunVisibilityOptions = {}): Promise<TeamMember[]> {
    await this.assertTeamRunExists(teamRunId);
    const [members, invocations, workRequests, messages] = await Promise.all([
      prisma.teamMember.findMany({
        where: { teamRunId },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.agentInvocation.findMany({
        where: {
          teamRunId,
          status: { in: ACTIVE_INVOCATION_STATUSES },
        },
      }),
      prisma.workRequest.findMany({
        where: {
          teamRunId,
          status: { in: OPEN_WORK_REQUEST_STATUSES },
        },
      }),
      options.viewerMemberId
        ? prisma.roomMessage.findMany({
          where: { teamRunId },
          include: { participants: true },
        })
        : Promise.resolve([]),
    ]);
    const visibleWorkRequestIds = getVisibleWorkRequestIds(messages, options.viewerMemberId);
    const visibleWorkRequests = visibleWorkRequestIds
      ? workRequests.filter((request) => visibleWorkRequestIds.has(request.id))
      : workRequests;
    const visibleInvocations = visibleWorkRequestIds
      ? invocations.filter((invocation) => visibleWorkRequestIds.has(invocation.workRequestId))
      : invocations;
    const memberStatuses = this.deriveTeamMemberStatuses(members, visibleInvocations, visibleWorkRequests);
    return members.map((member) => this.serializeTeamMember(member, memberStatuses.get(member.id)));
  }

  async addTeamRunMember(teamRunId: string, input: AddTeamRunMemberInput): Promise<TeamMember> {
    if ((input.memberPresetId ? 1 : 0) + (input.member ? 1 : 0) !== 1) {
      throw new ValidationError('Exactly one of memberPresetId or member is required');
    }

    const snapshot = await this.buildAddTeamRunMemberSnapshot(input);
    const created = await prisma.$transaction(async (tx) => {
      const teamRun = await tx.teamRun.findUnique({
        where: { id: teamRunId },
        include: { task: true },
      });
      if (!teamRun) {
        throw new NotFoundError('TeamRun', teamRunId);
      }
      ensureTaskNotDeleted(teamRun.task);

      const existingMembers = await tx.teamMember.findMany({
        where: activeTeamMembersWhere(teamRunId),
        select: { name: true },
      });
      const instanceName = this.resolveAddedMemberInstanceName(snapshot.name, existingMembers.map((member) => member.name));

      return tx.teamMember.create({
        data: {
          teamRunId,
          presetId: snapshot.presetId,
          name: instanceName,
          aliases: stringifyJson(snapshot.aliases),
          providerId: snapshot.providerId,
          rolePrompt: snapshot.rolePrompt,
          capabilities: stringifyJson(snapshot.capabilities),
          workspacePolicy: snapshot.workspacePolicy,
          triggerPolicy: snapshot.triggerPolicy,
          sessionPolicy: snapshot.sessionPolicy,
          queueManagementPolicy: snapshot.queueManagementPolicy,
          membershipStatus: ACTIVE_MEMBERSHIP_STATUS,
          avatar: snapshot.avatar,
        },
      });
    });

    await emitTeamRunInvalidated({
      teamRunId,
      scopes: ['team-run', 'team-members'],
      reason: 'team-members-updated',
    });

    return this.serializeTeamMember(created);
  }

  async patchTeamRunMember(
    teamRunId: string,
    memberId: string,
    input: PatchTeamRunMemberInput
  ): Promise<TeamMember> {
    if (Object.keys(input).length === 0) {
      throw new ValidationError('At least one TeamMember field is required');
    }

    const updated = await prisma.$transaction(async (tx) => {
      const member = await tx.teamMember.findFirst({
        where: { id: memberId, teamRunId },
        include: { teamRun: { include: { task: true } } },
      });
      if (!member) {
        const teamRun = await tx.teamRun.findUnique({ where: { id: teamRunId }, select: { id: true } });
        if (!teamRun) throw new NotFoundError('TeamRun', teamRunId);
        throw new NotFoundError('TeamMember', memberId);
      }
      ensureTaskNotDeleted(member.teamRun.task);
      if (!isActiveMembershipStatus(member.membershipStatus)) {
        throw new ServiceError('Removed TeamRun members cannot be updated', 'INVALID_STATE_TRANSITION', 400);
      }

      return tx.teamMember.update({
        where: { id: memberId },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.aliases !== undefined ? { aliases: stringifyJson(input.aliases) } : {}),
          ...(input.providerId !== undefined ? { providerId: input.providerId } : {}),
          ...(input.rolePrompt !== undefined ? { rolePrompt: input.rolePrompt } : {}),
          ...(input.capabilities !== undefined ? { capabilities: stringifyJson(input.capabilities) } : {}),
          ...(input.workspacePolicy !== undefined ? { workspacePolicy: input.workspacePolicy } : {}),
          ...(input.triggerPolicy !== undefined ? { triggerPolicy: input.triggerPolicy } : {}),
          ...(input.sessionPolicy !== undefined ? { sessionPolicy: input.sessionPolicy } : {}),
          ...(input.queueManagementPolicy !== undefined ? { queueManagementPolicy: input.queueManagementPolicy } : {}),
          ...(input.avatar !== undefined ? { avatar: input.avatar ?? null } : {}),
        },
      });
    });

    await emitTeamRunInvalidated({
      teamRunId,
      scopes: ['team-run', 'team-members'],
      reason: 'team-members-updated',
    });

    return this.serializeTeamMember(updated);
  }

  async softRemoveTeamRunMember(
    teamRunId: string,
    memberId: string,
    options: RemoveTeamRunMemberOptions = {}
  ): Promise<{ member: TeamMember; cancelledWorkRequestIds: string[] }> {
    const result = await prisma.$transaction(async (tx) => {
      const member = await tx.teamMember.findFirst({
        where: { id: memberId, teamRunId },
        include: { teamRun: { include: { task: true } } },
      });
      if (!member) {
        const teamRun = await tx.teamRun.findUnique({ where: { id: teamRunId }, select: { id: true } });
        if (!teamRun) throw new NotFoundError('TeamRun', teamRunId);
        throw new NotFoundError('TeamMember', memberId);
      }
      ensureTaskNotDeleted(member.teamRun.task);

      const cancellableRequests = options.cancelQueued === false
        ? []
        : await tx.workRequest.findMany({
          where: {
            teamRunId,
            targetMemberId: memberId,
            status: { in: OPEN_WORK_REQUEST_STATUSES },
          },
          select: { id: true },
        });
      const cancellableRequestIds = cancellableRequests.map((request) => request.id);

      if (cancellableRequestIds.length > 0) {
        await tx.workRequest.updateMany({
          where: { id: { in: cancellableRequestIds } },
          data: { status: 'CANCELLED' },
        });
      }

      const updated = await tx.teamMember.update({
        where: { id: memberId },
        data: {
          membershipStatus: REMOVED_MEMBERSHIP_STATUS,
          status: 'REMOVED',
        },
      });

      return { member: updated, cancelledWorkRequestIds: cancellableRequestIds };
    });

    await emitTeamRunInvalidated({
      teamRunId,
      scopes: ['team-run', 'team-members', 'work-requests'],
      reason: 'team-members-updated',
    });

    return {
      member: this.serializeTeamMember(result.member, 'REMOVED'),
      cancelledWorkRequestIds: result.cancelledWorkRequestIds,
    };
  }

  async listRoomMessages(teamRunId: string, options: ListRoomMessagesOptions = {}): Promise<RoomMessage[]> {
    const normalizedLimit = options.limit && options.limit > 0
      ? Math.min(Math.floor(options.limit), 200)
      : undefined;
    const [teamRun, messages] = await Promise.all([
      prisma.teamRun.findUnique({
        where: { id: teamRunId },
        select: { id: true },
      }),
      prisma.roomMessage.findMany({
        where: buildRoomMessageVisibilityWhere(teamRunId, options.viewerMemberId),
        include: { participants: true, delivery: !options.viewerMemberId ? { select: ownerDeliverySelect } : false },
        orderBy: normalizedLimit
          ? [{ createdAt: 'desc' }, { id: 'desc' }]
          : [{ createdAt: 'asc' }, { id: 'asc' }],
        ...(normalizedLimit ? { take: normalizedLimit } : {}),
      }),
    ]);
    if (!teamRun) {
      throw new NotFoundError('TeamRun', teamRunId);
    }
    const orderedMessages = normalizedLimit ? [...messages].reverse() : messages;
    return orderedMessages.map((message) => this.serializeRoomMessage(message, { owner: !options.viewerMemberId }));
  }

  async getRoomMessage(teamRunId: string, messageId: string, options: TeamRunVisibilityOptions = {}): Promise<RoomMessage> {
    const [teamRun, message] = await Promise.all([
      prisma.teamRun.findUnique({
        where: { id: teamRunId },
        select: { id: true },
      }),
      prisma.roomMessage.findFirst({
        where: {
          id: messageId,
          ...buildRoomMessageVisibilityWhere(teamRunId, options.viewerMemberId),
        },
        include: { participants: true, delivery: !options.viewerMemberId ? { select: ownerDeliverySelect } : false },
      }),
    ]);
    if (!teamRun) {
      throw new NotFoundError('TeamRun', teamRunId);
    }
    if (!message) {
      throw new NotFoundError('RoomMessage', messageId);
    }
    return this.serializeRoomMessage(message, {
      includeFullContent: true, owner: !options.viewerMemberId,
    });
  }

  async listWorkRequests(teamRunId: string, options: TeamRunVisibilityOptions = {}): Promise<WorkRequest[]> {
    await this.assertTeamRunExists(teamRunId);
    const workRequests = await prisma.workRequest.findMany({
      where: { teamRunId },
      orderBy: { createdAt: 'asc' },
    });
    if (!options.viewerMemberId) {
      return workRequests.map((workRequest) => this.serializeWorkRequest(workRequest));
    }

    const messages = await prisma.roomMessage.findMany({
      where: buildRoomMessageVisibilityWhere(teamRunId, options.viewerMemberId),
      include: { participants: true },
    });
    const visibleWorkRequestIds = getVisibleWorkRequestIds(messages, options.viewerMemberId) ?? new Set<string>();
    return workRequests
      .filter((workRequest) => visibleWorkRequestIds.has(workRequest.id))
      .map((workRequest) => this.serializeWorkRequest(workRequest));
  }

  async listQueuedWorkRequestsForMember(teamRunId: string, memberId: string): Promise<MemberWorkRequestQueue> {
    const member = await this.getTeamMemberOrThrow(teamRunId, memberId);
    if (!isActiveMembershipStatus(member.membershipStatus)) {
      throw new ServiceError('Removed TeamRun members cannot access the work request queue', 'FORBIDDEN', 403);
    }

    const queueManagementPolicy = this.resolveQueueManagementPolicy(member.queueManagementPolicy);
    const canManageTeamRunQueue = queueManagementPolicy === 'team_pending';
    const workRequests = await prisma.workRequest.findMany({
      where: {
        teamRunId,
        status: { in: OPEN_WORK_REQUEST_STATUSES },
        ...(canManageTeamRunQueue ? {} : { targetMemberId: memberId }),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    const triggerMessageIds = Array.from(new Set(workRequests.map((workRequest) => workRequest.triggerMessageId)));
    const targetMemberIds = Array.from(new Set(workRequests.map((workRequest) => workRequest.targetMemberId)));
    const [triggerMessages, targetMembers] = await Promise.all([
      triggerMessageIds.length > 0
        ? prisma.roomMessage.findMany({
          where: {
            id: { in: triggerMessageIds },
            ...buildRoomMessageVisibilityWhere(teamRunId, memberId),
          },
          include: { participants: true },
        })
        : [],
      targetMemberIds.length > 0
        ? prisma.teamMember.findMany({
          where: { id: { in: targetMemberIds }, teamRunId },
          select: { id: true, name: true },
        })
        : [],
    ]);
    const triggerMessageById = new Map(triggerMessages.map((message) => [message.id, message]));
    const targetMemberById = new Map(targetMembers.map((targetMember) => [targetMember.id, targetMember]));

    const visibleTriggerMessageIds = new Set(triggerMessages.map((message) => message.id));
    const visibleWorkRequests = workRequests.filter((workRequest) => visibleTriggerMessageIds.has(workRequest.triggerMessageId));

    return {
      teamRunId,
      currentMemberId: memberId,
      queueManagementPolicy,
      canManageTeamRunQueue,
      workRequests: visibleWorkRequests.map((workRequest) => (
        this.serializeWorkRequestQueueItem(
          workRequest,
          triggerMessageById.get(workRequest.triggerMessageId) ?? null,
          targetMemberById.get(workRequest.targetMemberId) ?? null
        )
      )),
    };
  }

  async listAgentInvocations(teamRunId: string, options: TeamRunVisibilityOptions = {}): Promise<AgentInvocation[]> {
    await this.assertTeamRunExists(teamRunId);
    const invocations = await prisma.agentInvocation.findMany({
      where: { teamRunId },
      orderBy: { createdAt: 'asc' },
    });
    if (!options.viewerMemberId) {
      return invocations.map((invocation) => this.serializeAgentInvocation(invocation));
    }

    const messages = await prisma.roomMessage.findMany({
      where: buildRoomMessageVisibilityWhere(teamRunId, options.viewerMemberId),
      include: { participants: true },
    });
    const visibleWorkRequestIds = getVisibleWorkRequestIds(messages, options.viewerMemberId) ?? new Set<string>();
    return invocations
      .filter((invocation) => visibleWorkRequestIds.has(invocation.workRequestId))
      .map((invocation) => this.serializeAgentInvocation(invocation));
  }

  /** The admission transaction freezes identities and preset expansion, without creating a team. */
  async prepareInitialDelivery(tx: Prisma.TransactionClient, task: { title: string; description: string | null }, input: CreateTeamRunInput): Promise<TeamInitialDeliveryIntent> {
    const members = applyStableInstanceNames(await this.buildTeamMemberSnapshots(input, tx)).map(m => ({ ...m, id: randomUUID() }));
    const intent = teamInitialIntentSchema.parse({ version: 2, plannedTeamRunId: randomUUID(), members, mode: input.mode,
      heartbeatTimeoutMinutes: await this.resolveHeartbeatTimeoutMinutes(input, tx), originalTitle: task.title, originalDescription: task.description,
      sourceRevision: 1, taskSourceHash: taskInputHash(task.title, task.description), kind: 'chat', mentions: [], artifactRefs: [], resolvedRecipients: [], mentionTokenCount: 0 });
    this.assertFrozenInitialMembers(intent);
    return this.refreshInitialIntent(intent, task);
  }

  refreshInitialIntent(intent: TeamInitialDeliveryIntent, task: { title: string; description: string | null }): TeamInitialDeliveryIntent {
    const members = intent.members.map(m => ({ ...m, aliases: JSON.stringify(m.aliases), membershipStatus: 'ACTIVE' }));
    const parsed = deriveStructuredMentionsFromContent(buildTaskUserText(task.title, task.description), members);
    const recipients = resolveRoomMessageTargetRequests({ mentions: parsed.mentions, members, senderType: 'user', requesterMemberId: null, allowUserMessageFallback: parsed.tokenCount === 0 });
    return { ...intent, taskSourceHash: taskInputHash(task.title, task.description), originalTitle: task.title, originalDescription: task.description,
      sourceRevision: intent.sourceRevision + (intent.taskSourceHash === taskInputHash(task.title, task.description) ? 0 : 1), mentions: parsed.mentions, mentionTokenCount: parsed.tokenCount,
      resolvedRecipients: recipients.map(r => ({ memberId: r.targetMemberId, ifBusy: r.ifBusy, cancelQueued: r.cancelQueued, target: null, targetSourceMemberId: null })) };
  }

  private assertFrozenInitialMembers(intent: TeamInitialDeliveryIntent) {
    for (const m of intent.members) if (!getProviderById(m.providerId)) throw new ServiceError('Frozen member Provider unavailable', 'RECIPIENT_UNAVAILABLE', 409);
  }

  /** Git inspection is outside the short publication transaction. */
  async prepareInitialPublication(taskId: string) {
    const task = await prisma.task.findFirst({ where: { id: taskId, deletedAt: null, project: { archivedAt: null, repoDeletedAt: null } }, include: { project: true } });
    if (!task) throw new NotFoundError('Task', taskId);
    await ensureProjectSupportsWorktrees(task.project, 'create TeamRun');
    return { projectId: task.projectId, repoPath: task.project.repoPath };
  }

  async publishAcceptedInitialDelivery(tx: Prisma.TransactionClient, deliveryId: string, expectedRevision: number, prepared: { projectId: string; repoPath: string }) {
    const row = await tx.messageDelivery.findUniqueOrThrow({ where: { id: deliveryId } });
    const intent = readTeamDeliveryIntent(row);
    if (row.state === 'SENT') return verifyPublishedTeamDelivery(tx, row);
    if (intent.version !== 2 || row.origin !== 'TEAM_INITIAL') roomDeliveryIntegrityError();
    if (await tx.roomMessage.count({ where: { deliveryId } }) || await tx.deliveryReceipt.count({ where: { deliveryId } }) || await tx.teamRun.count({ where: { id: intent.plannedTeamRunId } })) roomDeliveryIntegrityError();
    if (row.revision !== expectedRevision || !['READY','WAITING_PREDECESSOR'].includes(row.state) || row.acceptedText == null || !row.sentMode) throw new ServiceError('Delivery changed', 'DELIVERY_CONFLICT', 409);
    const config = await tx.translationSettings.findUniqueOrThrow({ where: { id: 'singleton' } });
    if (config.enableEpoch !== row.enableEpoch || row.requiresTranslation && !config.enabled) throw new ServiceError('Translation epoch changed', 'DELIVERY_CONFLICT', 409);
    if (await tx.messageDelivery.count({ where: { channelKey: row.channelKey, sequence: { lt: row.sequence }, state: { notIn: ['SENT','CANCELLED'] } } })) throw new ServiceError('Waiting for an earlier delivery', 'DELIVERY_PREDECESSOR', 409);
    const task = await tx.task.findUnique({ where: { id: row.taskId! }, include: { project: true } });
    if (!task || task.deletedAt || task.project.archivedAt || task.project.repoDeletedAt) throw new NotFoundError('Task', row.taskId!);
    if (task.projectId !== prepared.projectId || task.project.repoPath !== prepared.repoPath || !task.project.worktreeReady) throw new ServiceError('Project changed', 'PROJECT_CHANGED', 409);
    if (taskInputHash(task.title, task.description) !== intent.taskSourceHash) throw new ServiceError('Task input changed', 'TASK_INPUT_CHANGED', 409);
    if (await tx.teamRun.findUnique({ where: { taskId: task.id } })) throw toConflict('Task already has a TeamRun');
    this.assertFrozenInitialMembers(intent);
    const team = await tx.teamRun.create({ data: { id: intent.plannedTeamRunId, taskId: task.id, mode: intent.mode, heartbeatTimeoutMinutes: intent.heartbeatTimeoutMinutes } });
    for (const m of intent.members) {
      // A removed preset must not be re-expanded or silently replaced.
      if (m.presetId && !await tx.memberPreset.findUnique({ where: { id: m.presetId } })) throw new ServiceError('Frozen preset unavailable', 'RECIPIENT_UNAVAILABLE', 409);
      await tx.teamMember.create({ data: { ...m, teamRunId: team.id, aliases: JSON.stringify(m.aliases), capabilities: JSON.stringify(m.capabilities), membershipStatus: 'ACTIVE' } });
    }
    const source = row.translationSourceId ? await tx.translationSource.findUnique({ where: { id: row.translationSourceId } }) : null;
    const attempt = source?.effectiveAttemptId ? await tx.translationAttempt.findUnique({ where: { id: source.effectiveAttemptId } }) : null;
    // Explicit retry_delivery keeps the committed translation across a disable.
    // The delivery epoch above still arbitrates a concurrent disable; the saved
    // source and attempt must agree with each other, not with newer settings.
    if (row.sentMode === 'TRANSLATED' && (!source || source.deletedAt || !attempt || source.sourceKind !== 'USER_DELIVERY' || source.deliveryId !== row.id || source.sourceKey !== row.id || source.scopeType !== 'TASK' || source.scopeId !== task.id || source.laneKey !== row.channelKey
      || source.sourceHash !== row.sourceHash || source.sourceRevision !== row.sourceRevision || attempt.sourceId !== source.id || attempt.sourceHash !== source.sourceHash
      || attempt.enableEpoch !== source.enableEpoch || row.requiresTranslation && source.enableEpoch !== config.enableEpoch || attempt.generation !== source.generation || attempt.attemptVersion !== source.currentAttemptVersion || attempt.sourceRevision !== source.sourceRevision || attempt.resultText !== row.acceptedText || !['SUCCESS','NOT_REQUIRED'].includes(attempt.status))) roomDeliveryIntegrityError();
    const snapshot = await tx.teamTaskInputSnapshot.create({ data: { teamRunId: team.id, taskId: task.id, taskSourceHash: intent.taskSourceHash,
      originalTitle: intent.originalTitle, originalDescription: intent.originalDescription, state: 'ACCEPTED', effectiveUserText: row.acceptedText, translationSourceId: row.translationSourceId,
      acceptedAttemptId: row.sentMode === 'TRANSLATED' ? attempt!.id : null, sentMode: row.sentMode, acceptedAt: new Date() } });
    // Link the initial delivery before validating its same-source snapshot evidence.
    await tx.messageDelivery.update({ where: { id: row.id }, data: { teamRunId: team.id, taskInputSnapshotId: snapshot.id } });
    await tx.teamRun.update({ where: { id: team.id }, data: { currentTaskInputSnapshotId: snapshot.id } });
    const message = await tx.roomMessage.create({ data: { deliveryId: row.id, teamRunId: team.id, senderType: 'user', kind: intent.kind, content: row.acceptedText, mentions: JSON.stringify(intent.mentions), artifactRefs: '[]', attachmentIds: row.attachmentIds, workRequestIds: '[]' } });
    const workRequestIds: string[] = [];
    for (const r of intent.resolvedRecipients) {
      const request = await tx.workRequest.create({ data: { teamRunId: team.id, requesterType: 'user', targetMemberId: r.memberId, triggerMessageId: message.id, instruction: this.contentPreview(row.acceptedText), ifBusy: r.ifBusy, cancelQueued: r.cancelQueued, status: team.mode === 'CONFIRM' ? 'PENDING_APPROVAL' : 'QUEUED', taskInputSnapshotId: snapshot.id } });
      workRequestIds.push(request.id);
    }
    await tx.roomMessage.update({ where: { id: message.id }, data: { workRequestIds: JSON.stringify(workRequestIds) } });
    const now = new Date(); const revision = row.revision + 1;
    await tx.deliveryReceipt.create({ data: { deliveryId: row.id, generation: revision, phase: 'SUBMITTED', evidence: 'ROOM_PUBLISHED', submittedAt: now } });
    const changed = await tx.messageDelivery.updateMany({ where: { id: row.id, revision: row.revision, state: row.state, enableEpoch: row.enableEpoch }, data: { state: 'SENT', actualSentText: row.acceptedText, sentAt: now, acceptedDestinationId: message.id, lastError: null, revision } });
    if (changed.count !== 1) throw new ServiceError('Delivery changed', 'DELIVERY_CONFLICT', 409);
    return verifyPublishedTeamDelivery(tx, await tx.messageDelivery.findUniqueOrThrow({ where: { id: row.id } }));
  }

  /** Freeze routing before translating; publication revalidates every saved recipient and target owner. */
  async prepareUserDelivery(tx: Prisma.TransactionClient, teamRunId: string, input: { mentions?: StructuredMention[]; artifactRefs?: string[]; kind?: string }) {
    const team = await tx.teamRun.findFirst({ where: { id: teamRunId, task: { deletedAt: null, project: { archivedAt: null } } }, include: { task: true } });
    if (!team) throw new NotFoundError('TeamRun', teamRunId);
    const members = await tx.teamMember.findMany({ where: activeTeamMembersWhere(teamRunId) });
    const mentions = input.mentions ?? [];
    assertMentionsReferenceMembers(mentions, new Set(members.map(m => m.id)));
    if (new Set(mentions.map(m => m.memberId)).size !== mentions.length) throw new ValidationError('Duplicate mentions');
    const recipients = resolveRoomMessageTargetRequests({ mentions, members, senderType: 'user', requesterMemberId: null });
    const resolvedRecipients = [];
    for (const r of recipients) {
      const target = await buildWorkRequestTargetData(tx, teamRunId, r.target);
      resolvedRecipients.push({ memberId: r.targetMemberId, ifBusy: r.ifBusy, cancelQueued: r.cancelQueued, target: r.target ?? null, targetSourceMemberId: target.targetSourceMemberId ?? null });
    }
    return { team, intent: { version: 1 as const, taskSourceHash: taskInputHash(team.task.title, team.task.description), kind: input.kind ?? (mentions.length ? 'work_request' : 'chat'), mentions, artifactRefs: input.artifactRefs ?? [], resolvedRecipients } };
  }

  /** Foundation only: no production caller until the entire Team input path is enabled. */
  async publishAcceptedUserDelivery(tx: Prisma.TransactionClient, envelope: {
    deliveryId: string; expectedRevision: number; enableEpoch: number; acceptedText: string; taskInput: TaskInputAcceptanceToken;
  }) {
    const row = await tx.messageDelivery.findUniqueOrThrow({ where: { id: envelope.deliveryId } });
    const intent = readTeamDeliveryIntent(row);
    // A lost commit response recovers the immutable facts, even if the Task/membership changed later.
    if (row.state === 'SENT') return verifyPublishedTeamDelivery(tx, row);
    if (await tx.roomMessage.count({ where: { deliveryId: row.id } }) || await tx.deliveryReceipt.count({ where: { deliveryId: row.id } })) roomDeliveryIntegrityError();
    if (row.origin !== 'TEAM_USER' || row.revision !== envelope.expectedRevision || !['READY', 'WAITING_PREDECESSOR'].includes(row.state)
      || row.acceptedText == null || row.acceptedText !== envelope.acceptedText || !row.sentMode || row.enableEpoch !== envelope.enableEpoch) throw new ServiceError('Delivery changed', 'DELIVERY_CONFLICT', 409);
    const config = await tx.translationSettings.findUniqueOrThrow({ where: { id: 'singleton' } });
    if (config.enableEpoch !== row.enableEpoch || row.requiresTranslation && !config.enabled) throw new ServiceError('Translation epoch changed', 'DELIVERY_DISABLED', 409);
    if (await tx.messageDelivery.count({ where: { channelKey: row.channelKey, sequence: { lt: row.sequence }, state: { notIn: ['SENT', 'CANCELLED'] } } })) throw new ServiceError('Waiting for an earlier delivery', 'DELIVERY_PREDECESSOR', 409);
    const team = await tx.teamRun.findUnique({ where: { id: row.teamRunId! }, include: { task: { include: { project: true } } } });
    if (!team || team.taskId !== row.taskId || team.task.deletedAt || team.task.project.archivedAt) throw new ServiceError('Delivery scope not found', 'NOT_FOUND', 404);
    if (intent.taskSourceHash !== envelope.taskInput.taskSourceHash) throw new ServiceError('Task input changed', 'TASK_INPUT_CHANGED', 409);
    const targets = [];
    for (const recipient of intent.resolvedRecipients) {
      if (!await tx.teamMember.findFirst({ where: { id: recipient.memberId, teamRunId: team.id, membershipStatus: 'ACTIVE' } })) throw new ServiceError('Frozen recipient unavailable', 'RECIPIENT_UNAVAILABLE', 409);
      try {
        const target = await buildWorkRequestTargetData(tx, team.id, recipient.target);
        if ((target.targetSourceMemberId ?? null) !== (recipient.targetSourceMemberId ?? null)) throw new Error('Target owner changed');
        targets.push(target);
      }
      catch { throw new ServiceError('Frozen target unavailable', 'TARGET_UNAVAILABLE', 409); }
    }
    const earlierInput = await tx.workRequest.findFirst({ where: { teamRunId: team.id, status: 'QUEUED', taskInputSnapshot: { state: 'PENDING', id: { not: envelope.taskInput.snapshotId } }, OR: [{ createdAt: { lt: row.createdAt } }, { createdAt: row.createdAt, id: { lt: row.id } }] }, select: { id: true } });
    if (earlierInput) throw new ServiceError('Waiting for an earlier task input', 'TASK_INPUT_PREDECESSOR', 409);
    const snapshotId = await adoptTaskInputInTransaction(tx, team.id, team.taskId, envelope.taskInput);
    const message = await tx.roomMessage.create({ data: { deliveryId: row.id, teamRunId: team.id, senderType: 'user', kind: intent.kind, visibility: 'PUBLIC', content: row.acceptedText, mentions: JSON.stringify(intent.mentions), artifactRefs: JSON.stringify(intent.artifactRefs), attachmentIds: row.attachmentIds, workRequestIds: '[]' } });
    const workRequestIds: string[] = [];
    for (const [index, recipient] of intent.resolvedRecipients.entries()) {
      const request = await tx.workRequest.create({ data: { teamRunId: team.id, requesterType: 'user', targetMemberId: recipient.memberId, ...targets[index], triggerMessageId: message.id, instruction: this.contentPreview(row.acceptedText), ifBusy: recipient.ifBusy, cancelQueued: recipient.cancelQueued, status: team.mode === 'CONFIRM' ? 'PENDING_APPROVAL' : 'QUEUED', taskInputSnapshotId: snapshotId } });
      workRequestIds.push(request.id);
    }
    await tx.roomMessage.update({ where: { id: message.id }, data: { workRequestIds: JSON.stringify(workRequestIds) } });
    const now = new Date(); const revision = row.revision + 1;
    await tx.deliveryReceipt.create({ data: { deliveryId: row.id, generation: revision, phase: 'SUBMITTED', evidence: 'ROOM_PUBLISHED', submittedAt: now } });
    const changed = await tx.messageDelivery.updateMany({ where: { id: row.id, revision: row.revision, state: row.state, enableEpoch: row.enableEpoch }, data: { state: 'SENT', actualSentText: row.acceptedText, sentAt: now, acceptedDestinationId: message.id, taskInputSnapshotId: snapshotId, lastError: null, revision } });
    if (changed.count !== 1) throw new ServiceError('Delivery changed', 'DELIVERY_CONFLICT', 409);
    return verifyPublishedTeamDelivery(tx, await tx.messageDelivery.findUniqueOrThrow({ where: { id: row.id } }));
  }

  async createRoomMessage(teamRunId: string, input: CreateRoomMessageInput): Promise<RoomMessage> {
    const teamRun = await prisma.teamRun.findUnique({
      where: { id: teamRunId },
      include: { task: true },
    });
    if (!teamRun) {
      throw new NotFoundError('TeamRun', teamRunId);
    }
    ensureTaskNotDeleted(teamRun.task);

    const mentions = input.mentions ?? [];
    const senderType = input.senderType ?? 'user';
    const normalizedSenderId = senderType === 'system' ? null : (input.senderId ?? null);
    const normalizedSenderInvocationId = senderType === 'agent' ? (input.senderInvocationId ?? null) : null;
    const kind = input.kind ?? (mentions.length > 0 ? 'work_request' : 'chat');
    const workRequestStatus: WorkRequestStatus = teamRun.mode === 'CONFIRM'
      ? 'PENDING_APPROVAL'
      : 'QUEUED';
    await appendAttachmentMarkdownContext(input.content, input.attachmentIds);
    const workRequestInstruction = this.contentPreview(input.content);

    let messageId = '';
    let senderInvocationCanDispatch = true;
    let shouldReconcileAgentRoomMessage = false;
    await prisma.$transaction(async (tx) => {
      const liveTeamRun = await tx.teamRun.findFirst({
        where: { id: teamRunId, task: { deletedAt: null } },
        select: { id: true },
      });
      if (!liveTeamRun) {
        throw new NotFoundError('Task', teamRun.taskId);
      }

      const members = await tx.teamMember.findMany({ where: activeTeamMembersWhere(teamRunId) });
      const memberIds = new Set(members.map((member) => member.id));
      assertMentionsReferenceMembers(mentions, memberIds);

      const requesterMemberId = senderType === 'agent'
        && input.senderId != null
        && memberIds.has(input.senderId)
        ? input.senderId
        : null;

      if (senderType === 'agent') {
        if (!input.senderId || !memberIds.has(input.senderId)) {
          throw new ValidationError('Agent RoomMessage senderId must be a TeamMember in this TeamRun');
        }

        if (normalizedSenderInvocationId) {
          const invocation = await tx.agentInvocation.findFirst({
            where: {
              id: normalizedSenderInvocationId,
              teamRunId,
              memberId: input.senderId,
            },
            select: { id: true, status: true, dispatchRevokedAt: true },
          });
          if (!invocation) {
            throw new ValidationError('Agent RoomMessage senderInvocationId must belong to the sender member in this TeamRun');
          }
          senderInvocationCanDispatch = invocation.dispatchRevokedAt == null
            && !TERMINAL_AGENT_INVOCATION_STATUSES.has(invocation.status as AgentInvocationStatus);
          shouldReconcileAgentRoomMessage = senderInvocationCanDispatch;
        }
      }

      // The message and its dispatch requests share the same durable admission
      // decision. Never use the worker's in-memory epoch or upsert settings here.
      const translationSettings = senderType === 'agent'
        ? await tx.translationSettings.findUnique({ where: { id: 'singleton' }, select: { enabled: true, enableEpoch: true } })
        : null;
      const message = await tx.roomMessage.create({
        data: {
          teamRunId,
          senderType,
          senderId: normalizedSenderId,
          senderInvocationId: normalizedSenderInvocationId,
          kind,
          visibility: 'PUBLIC',
          content: input.content,
          translationEligibilityEpoch: translationSettings?.enabled ? translationSettings.enableEpoch : null,
          mentions: stringifyJson(mentions),
          artifactRefs: stringifyJson(input.artifactRefs ?? []),
          attachmentIds: stringifyJson(input.attachmentIds ?? []),
          workRequestIds: stringifyJson([]),
        },
      });
      messageId = message.id;

      const targetRequests = senderInvocationCanDispatch
        ? resolveRoomMessageTargetRequests({
          mentions,
          members,
          senderType,
          requesterMemberId,
        })
        : [];

      const workRequestIds: string[] = [];
      for (const targetRequest of targetRequests) {
        const targetData = await buildWorkRequestTargetData(tx, teamRunId, targetRequest.target);
        const workRequest = await tx.workRequest.create({
          data: {
            teamRunId,
            requesterMemberId,
            requesterType: senderType as WorkRequestRequesterType,
            targetMemberId: targetRequest.targetMemberId,
            ...targetData,
            triggerMessageId: message.id,
            instruction: workRequestInstruction,
            ifBusy: targetRequest.ifBusy,
            cancelQueued: targetRequest.cancelQueued,
            status: workRequestStatus,
          },
        });
        workRequestIds.push(workRequest.id);
      }

      if (workRequestIds.length > 0) {
        await tx.roomMessage.update({
          where: { id: message.id },
          data: { workRequestIds: stringifyJson(workRequestIds) },
        });
      }
    });

    // Best-effort, bounded ID admission only. Durable eligibility repairs a lost
    // notification, including a crash or a later reconciler failure.
    if (senderType === 'agent') {
      try { getTranslationService().roomMessageCommitted(messageId); } catch { /* Original publication remains authoritative. */ }
    }

    // 成员（agent）就某次 invocation 发出 room message 后立即交给 reconciler 处理：
    // WAITING_ROOM_REPLY → 转 COMPLETED、释放锁、推进调度/review；RUNNING → 清零唤醒计数/绝对兜底并刷新心跳（不终态）。
    // user/system 消息不触发，避免误终态化或误清零。
    if (senderType === 'agent' && normalizedSenderInvocationId && shouldReconcileAgentRoomMessage) {
      await this.getReconciler().handleAgentRoomMessage(normalizedSenderInvocationId);
    }

    const message = await prisma.roomMessage.findUnique({ where: { id: messageId } });
    if (!message) {
      throw new NotFoundError('RoomMessage', messageId);
    }
    const serialized = this.serializeRoomMessage(message);
    await emitTeamRunInvalidated({
      teamRunId,
      taskId: teamRun.taskId,
      scopes: ['room-messages', 'work-requests', 'team-run'],
      reason: 'room-message-created',
    });

    return serialized;
  }

  async createPrivateRoomMessage(teamRunId: string, input: CreatePrivateRoomMessageInput): Promise<RoomMessage> {
    const teamRun = await prisma.teamRun.findUnique({ where: { id: teamRunId } });
    if (!teamRun) {
      throw new NotFoundError('TeamRun', teamRunId);
    }

    const recipientMemberIds = uniqueMemberIds(input.recipientMemberIds);
    if (recipientMemberIds.length === 0) {
      throw new ValidationError('At least one private message recipient is required');
    }

    const senderType = input.senderType ?? 'user';
    const workRequestStatus: WorkRequestStatus = teamRun.mode === 'CONFIRM'
      ? 'PENDING_APPROVAL'
      : 'QUEUED';
    const workRequestInstruction = this.contentPreview(input.content);

    let messageId = '';
    let senderInvocationCanDispatch = true;
    await prisma.$transaction(async (tx) => {
      const members = await tx.teamMember.findMany({ where: activeTeamMembersWhere(teamRunId) });
      const memberIds = new Set(members.map((member) => member.id));
      for (const recipientMemberId of recipientMemberIds) {
        if (!memberIds.has(recipientMemberId)) {
          throw new NotFoundError('TeamMember', recipientMemberId);
        }
      }

      const requesterMemberId = senderType === 'agent'
        && input.senderId != null
        && memberIds.has(input.senderId)
        ? input.senderId
        : null;
      let normalizedSenderId = input.senderId ?? null;
      let normalizedSenderInvocationId = input.senderInvocationId ?? null;
      let senderParticipantMemberId: string | null = null;

      if (senderType === 'agent') {
        if (!input.senderId || !memberIds.has(input.senderId)) {
          throw new ValidationError('Agent RoomMessage senderId must be a TeamMember in this TeamRun');
        }
        senderParticipantMemberId = input.senderId;

        if (input.senderInvocationId) {
          const invocation = await tx.agentInvocation.findFirst({
            where: {
              id: input.senderInvocationId,
              teamRunId,
              memberId: input.senderId,
            },
            select: { id: true, status: true, dispatchRevokedAt: true },
          });
          if (!invocation) {
            throw new ValidationError('Agent RoomMessage senderInvocationId must belong to the sender member in this TeamRun');
          }
          senderInvocationCanDispatch = invocation.dispatchRevokedAt == null
            && !TERMINAL_AGENT_INVOCATION_STATUSES.has(invocation.status as AgentInvocationStatus);
        }
      } else if (senderType === 'user') {
        if (input.senderInvocationId) {
          throw new ValidationError('Only agent private messages may include senderInvocationId');
        }
        if (input.senderId != null) {
          if (!memberIds.has(input.senderId)) {
            throw new ValidationError('Private message senderId must be a TeamMember in this TeamRun');
          }
          senderParticipantMemberId = input.senderId;
        }
        normalizedSenderInvocationId = null;
      } else {
        normalizedSenderId = null;
        normalizedSenderInvocationId = null;
      }

      const message = await tx.roomMessage.create({
        data: {
          teamRunId,
          senderType,
          senderId: normalizedSenderId,
          senderInvocationId: normalizedSenderInvocationId,
          kind: 'work_request',
          visibility: 'PRIVATE',
          content: input.content,
          mentions: stringifyJson([]),
          artifactRefs: stringifyJson(input.artifactRefs ?? []),
          attachmentIds: stringifyJson(input.attachmentIds ?? []),
          workRequestIds: stringifyJson([]),
        },
      });
      messageId = message.id;

      const participantByMemberId = new Map<string, RoomMessageParticipantRole>();
      if (senderParticipantMemberId && !recipientMemberIds.includes(senderParticipantMemberId)) {
        participantByMemberId.set(senderParticipantMemberId, 'sender');
      }
      for (const recipientMemberId of recipientMemberIds) {
        participantByMemberId.set(recipientMemberId, 'recipient');
      }

      if (participantByMemberId.size > 0) {
        await tx.roomMessageParticipant.createMany({
          data: Array.from(participantByMemberId.entries()).map(([memberId, role]) => ({
            teamRunId,
            roomMessageId: message.id,
            memberId,
            role,
          })),
        });
      }

      const workRequestIds: string[] = [];
      const targetData = senderInvocationCanDispatch
        ? await buildWorkRequestTargetData(tx, teamRunId, input.target)
        : {};
      for (const recipientMemberId of senderInvocationCanDispatch ? recipientMemberIds : []) {
        const workRequest = await tx.workRequest.create({
          data: {
            teamRunId,
            requesterMemberId,
            requesterType: senderType as WorkRequestRequesterType,
            targetMemberId: recipientMemberId,
            ...targetData,
            triggerMessageId: message.id,
            instruction: workRequestInstruction,
            ifBusy: input.ifBusy ?? 'queue',
            cancelQueued: input.cancelQueued ?? false,
            status: workRequestStatus,
          },
        });
        workRequestIds.push(workRequest.id);
      }

      await tx.roomMessage.update({
        where: { id: message.id },
        data: { workRequestIds: stringifyJson(workRequestIds) },
      });
    });

    const message = await prisma.roomMessage.findUnique({
      where: { id: messageId },
      include: { participants: true },
    });
    if (!message) {
      throw new NotFoundError('RoomMessage', messageId);
    }
    const serialized = this.serializeRoomMessage(message);
    await emitTeamRunInvalidated({
      teamRunId,
      taskId: teamRun.taskId,
      scopes: ['room-messages', 'work-requests', 'team-run'],
      reason: 'room-message-created',
    });

    return serialized;
  }

  private normalizeTeamTemplateMembers(input: CreateTeamTemplateInput | UpdateTeamTemplateInput): Array<{
    memberPresetId: string;
    position: number;
  }> {
    const members = input.members
      ?? input.memberPresetIds?.map((memberPresetId, index) => ({ memberPresetId, position: index }))
      ?? [];

    return members.map((member, index) => ({
      memberPresetId: member.memberPresetId,
      position: member.position ?? index,
    }));
  }

  private async buildTeamMemberSnapshots(input: CreateTeamRunInput, tx: Prisma.TransactionClient = prisma): Promise<TeamMemberSnapshot[]> {
    const snapshots: TeamMemberSnapshot[] = [];

    if (input.teamTemplateId) {
      const template = await tx.teamTemplate.findUnique({
        where: { id: input.teamTemplateId },
        include: { members: { orderBy: { position: 'asc' } } },
      });
      if (!template) {
        throw new NotFoundError('TeamTemplate', input.teamTemplateId);
      }
      const presets = await this.findMemberPresetsByIds(
        template.members.map((member) => member.memberPresetId), tx
      );
      snapshots.push(...presets.map((preset) => this.memberPresetToSnapshot(preset)));
    }

    if (input.memberPresetIds && input.memberPresetIds.length > 0) {
      const presets = await this.findMemberPresetsByIds(input.memberPresetIds, tx);
      snapshots.push(...presets.map((preset) => this.memberPresetToSnapshot(preset)));
    }

    if (input.members && input.members.length > 0) {
      snapshots.push(...input.members.map((member) => ({
        presetId: null,
        name: member.name,
        aliases: member.aliases,
        providerId: member.providerId,
        rolePrompt: member.rolePrompt,
        capabilities: member.capabilities,
        workspacePolicy: member.workspacePolicy,
        triggerPolicy: member.triggerPolicy,
        sessionPolicy: member.sessionPolicy,
        queueManagementPolicy: member.queueManagementPolicy,
        avatar: member.avatar ?? null,
      })));
    }

    return snapshots;
  }

  private async resolveHeartbeatTimeoutMinutes(input: CreateTeamRunInput, tx: Prisma.TransactionClient = prisma): Promise<number> {
    if (!input.teamTemplateId) {
      return 10;
    }
    const template = await tx.teamTemplate.findUnique({
      where: { id: input.teamTemplateId },
      select: { heartbeatTimeoutMinutes: true },
    });
    if (!template) {
      throw new NotFoundError('TeamTemplate', input.teamTemplateId);
    }
    return template.heartbeatTimeoutMinutes;
  }

  private async buildAddTeamRunMemberSnapshot(input: AddTeamRunMemberInput): Promise<TeamMemberSnapshot> {
    if (input.memberPresetId) {
      const preset = await prisma.memberPreset.findUnique({ where: { id: input.memberPresetId } });
      if (!preset) {
        throw new NotFoundError('MemberPreset', input.memberPresetId);
      }
      return this.memberPresetToSnapshot(preset);
    }

    if (!input.member) {
      throw new ValidationError('member is required when memberPresetId is not provided');
    }

    return {
      presetId: null,
      name: input.member.name,
      aliases: input.member.aliases,
      providerId: input.member.providerId,
      rolePrompt: input.member.rolePrompt,
      capabilities: input.member.capabilities,
      workspacePolicy: input.member.workspacePolicy,
      triggerPolicy: input.member.triggerPolicy,
      sessionPolicy: input.member.sessionPolicy,
      queueManagementPolicy: input.member.queueManagementPolicy,
      avatar: input.member.avatar ?? null,
    };
  }

  private resolveAddedMemberInstanceName(baseName: string, existingNames: string[]): string {
    const trimmedBaseName = baseName.trim();
    if (!existingNames.includes(trimmedBaseName)) {
      return trimmedBaseName;
    }

    let index = 2;
    while (existingNames.includes(`${trimmedBaseName} #${index}`)) {
      index += 1;
    }
    return `${trimmedBaseName} #${index}`;
  }

  private memberPresetToSnapshot(preset: PrismaMemberPreset): TeamMemberSnapshot {
    return {
      presetId: preset.id,
      name: preset.name,
      aliases: parseJsonField<string[]>(preset.aliases, []),
      providerId: preset.providerId,
      rolePrompt: preset.rolePrompt,
      capabilities: parseJsonField<TeamMemberCapabilities>(preset.capabilities, DEFAULT_CAPABILITIES),
      workspacePolicy: preset.workspacePolicy as WorkspacePolicy,
      triggerPolicy: preset.triggerPolicy as TeamMemberTriggerPolicy,
      sessionPolicy: preset.sessionPolicy as TeamMemberSessionPolicy || DEFAULT_SESSION_POLICY,
      queueManagementPolicy: this.resolveQueueManagementPolicy(preset.queueManagementPolicy),
      avatar: preset.avatar ?? null,
    };
  }

  private async findMemberPresetsByIds(ids: string[], tx: Prisma.TransactionClient = prisma): Promise<PrismaMemberPreset[]> {
    if (ids.length === 0) {
      return [];
    }

    const presets = await tx.memberPreset.findMany({
      where: { id: { in: ids } },
    });
    const presetById = new Map(presets.map((preset) => [preset.id, preset]));
    const missing = ids.find((id) => !presetById.has(id));
    if (missing) {
      throw new NotFoundError('MemberPreset', missing);
    }
    return ids.map((id) => presetById.get(id)!);
  }

  private async assertMemberPresetsExist(ids: string[]): Promise<void> {
    await this.findMemberPresetsByIds(ids);
  }

  private async assertTeamRunExists(id: string): Promise<void> {
    const count = await prisma.teamRun.count({ where: { id } });
    if (count === 0) {
      throw new NotFoundError('TeamRun', id);
    }
  }

  private async getTeamMemberOrThrow(teamRunId: string, memberId: string): Promise<PrismaTeamMember> {
    const member = await prisma.teamMember.findFirst({ where: { id: memberId, teamRunId } });
    if (member) {
      return member;
    }

    await this.assertTeamRunExists(teamRunId);
    throw new NotFoundError('TeamMember', memberId);
  }

  async resolveAgentInvocationIdentity(
    teamRunId: string,
    invocationId: string | null | undefined
  ): Promise<TeamRunAgentInvocationIdentity | null> {
    if (!invocationId) {
      return null;
    }

    const invocation = await prisma.agentInvocation.findFirst({
      where: { id: invocationId, teamRunId },
      select: { id: true, memberId: true },
    });

    return invocation
      ? { invocationId: invocation.id, memberId: invocation.memberId }
      : null;
  }

  async resolveViewerMemberIdFromInvocation(teamRunId: string, invocationId: string | null | undefined): Promise<string | null> {
    const identity = await this.resolveAgentInvocationIdentity(teamRunId, invocationId);
    return identity?.memberId ?? null;
  }

  private resolveQueueManagementPolicy(
    value: string | null | undefined
  ): TeamMemberQueueManagementPolicy {
    return value === 'team_pending' ? 'team_pending' : DEFAULT_QUEUE_MANAGEMENT_POLICY;
  }

  private contentPreview(content: string): string {
    return buildTextPreview(content);
  }

  private compactContentPreview(content: string): string {
    return buildTextPreview(content.replace(/\s+/g, ' '));
  }

  private serializePreviewField(content: string): { value: string; preview: string; isTruncated: boolean } {
    const preview = this.contentPreview(content);
    return {
      value: preview,
      preview,
      isTruncated: content !== preview,
    };
  }

  private teamRunInclude() {
    return {
      members: { orderBy: { createdAt: 'asc' as const } },
      messages: { orderBy: { createdAt: 'asc' as const }, include: { participants: true, delivery: { select: ownerDeliverySelect } } },
      workRequests: { orderBy: { createdAt: 'asc' as const } },
      invocations: { orderBy: { createdAt: 'asc' as const } },
    };
  }

  private serializeMemberPreset(preset: PrismaMemberPreset): MemberPreset {
    return {
      ...preset,
      aliases: parseJsonField<string[]>(preset.aliases, []),
      capabilities: parseJsonField<TeamMemberCapabilities>(preset.capabilities, DEFAULT_CAPABILITIES),
      workspacePolicy: preset.workspacePolicy as WorkspacePolicy,
      triggerPolicy: preset.triggerPolicy as TeamMemberTriggerPolicy,
      sessionPolicy: preset.sessionPolicy as TeamMemberSessionPolicy || DEFAULT_SESSION_POLICY,
      queueManagementPolicy: this.resolveQueueManagementPolicy(preset.queueManagementPolicy),
      avatar: preset.avatar ?? null,
      createdAt: toIso(preset.createdAt),
      updatedAt: toIso(preset.updatedAt),
    };
  }

  private async serializeTeamTemplate(template: PrismaTeamTemplateWithMembers): Promise<TeamTemplate> {
    const members = template.members ?? await prisma.teamTemplateMember.findMany({
      where: { teamTemplateId: template.id },
      orderBy: { position: 'asc' },
    });

    const presetIds = members.map((member) => member.memberPresetId);
    const presets = presetIds.length > 0
      ? await prisma.memberPreset.findMany({ where: { id: { in: presetIds } } })
      : [];
    const presetById = new Map(presets.map((preset) => [preset.id, preset]));

    return {
      ...template,
      createdAt: toIso(template.createdAt),
      updatedAt: toIso(template.updatedAt),
      members: members.map((member) => {
        const preset = presetById.get(member.memberPresetId);
        return {
          ...member,
          memberPreset: preset ? this.serializeMemberPreset(preset) : undefined,
        } satisfies TeamTemplateMember;
      }),
    };
  }

  private serializeTeamRun(teamRun: PrismaTeamRunWithRelations, options: TeamRunVisibilityOptions = {}): TeamRun {
    const visibleMessages = options.viewerMemberId
      ? (teamRun.messages ?? []).filter((message) => isRoomMessageVisibleToViewer(message, options.viewerMemberId))
      : teamRun.messages;
    const visibleWorkRequestIds = getVisibleWorkRequestIds(visibleMessages ?? [], options.viewerMemberId);
    const visibleWorkRequests = visibleWorkRequestIds
      ? (teamRun.workRequests ?? []).filter((workRequest) => visibleWorkRequestIds.has(workRequest.id))
      : teamRun.workRequests;
    const visibleInvocations = visibleWorkRequestIds
      ? (teamRun.invocations ?? []).filter((invocation) => visibleWorkRequestIds.has(invocation.workRequestId))
      : teamRun.invocations;

    const memberStatuses = this.deriveTeamMemberStatuses(
      teamRun.members ?? [],
      visibleInvocations ?? [],
      visibleWorkRequests ?? []
    );
    return {
      ...teamRun,
      mode: teamRun.mode as TeamRunMode,
      reviewReason: teamRun.reviewReason as TeamRunReviewReason | null,
      createdAt: toIso(teamRun.createdAt),
      updatedAt: toIso(teamRun.updatedAt),
      members: teamRun.members?.map((member) => this.serializeTeamMember(member, memberStatuses.get(member.id))),
      messages: visibleMessages?.map((message) => this.serializeRoomMessage(message, { owner: !options.viewerMemberId })),
      workRequests: visibleWorkRequests?.map((workRequest) => this.serializeWorkRequest(workRequest)),
      invocations: visibleInvocations?.map((invocation) => this.serializeAgentInvocation(invocation)),
    };
  }

  private deriveTeamMemberStatuses(
    members: PrismaTeamMember[],
    invocations: PrismaAgentInvocation[] = [],
    workRequests: PrismaWorkRequest[] = []
  ): Map<string, TeamMemberStatus> {
    const statuses = new Map<string, TeamMemberStatus>();

    for (const member of members) {
      statuses.set(member.id, this.deriveTeamMemberStatus(
        member.id,
        invocations,
        workRequests,
        member.membershipStatus
      ));
    }

    return statuses;
  }

  private deriveTeamMemberStatus(
    memberId: string,
    invocations: PrismaAgentInvocation[],
    workRequests: PrismaWorkRequest[],
    membershipStatus?: string
  ): TeamMemberStatus {
    if (!isActiveMembershipStatus(membershipStatus)) return 'REMOVED';

    const memberInvocations = invocations.filter((invocation) => invocation.memberId === memberId);
    const runningInvocations = memberInvocations.filter((invocation) => invocation.status === 'RUNNING');
    if (runningInvocations.some(
      (invocation) => invocation.sessionId && isRuntimeAwaitingPermission(invocation.sessionId),
    )) return 'PENDING_APPROVAL';
    if (runningInvocations.length > 0) return 'RUNNING';
    if (memberInvocations.some((invocation) => invocation.status === 'WAITING_ROOM_REPLY')) return 'WAITING_ROOM_REPLY';
    if (memberInvocations.some((invocation) => invocation.status === 'SESSION_ENDED')) return 'SESSION_ENDED';
    if (memberInvocations.some((invocation) => invocation.status === 'QUEUED')) return 'QUEUED';

    const memberWorkRequests = workRequests.filter((request) => request.targetMemberId === memberId);
    if (memberWorkRequests.some((request) => request.status === 'QUEUED')) return 'QUEUED';
    if (memberWorkRequests.some((request) => request.status === 'PENDING_APPROVAL')) return 'PENDING_APPROVAL';

    return 'IDLE';
  }

  private serializeTeamMember(member: PrismaTeamMember, status?: TeamMemberStatus): TeamMember {
    return {
      ...member,
      aliases: parseJsonField<string[]>(member.aliases, []),
      capabilities: parseJsonField<TeamMemberCapabilities>(member.capabilities, DEFAULT_CAPABILITIES),
      workspacePolicy: member.workspacePolicy as WorkspacePolicy,
      triggerPolicy: member.triggerPolicy as TeamMemberTriggerPolicy,
      sessionPolicy: member.sessionPolicy as TeamMemberSessionPolicy || DEFAULT_SESSION_POLICY,
      queueManagementPolicy: this.resolveQueueManagementPolicy(member.queueManagementPolicy),
      membershipStatus: (isActiveMembershipStatus(member.membershipStatus)
        ? ACTIVE_MEMBERSHIP_STATUS
        : REMOVED_MEMBERSHIP_STATUS),
      avatar: member.avatar ?? null,
      status: status ?? 'IDLE',
      createdAt: toIso(member.createdAt),
      updatedAt: toIso(member.updatedAt),
    };
  }

  private serializeRoomMessage(
    message: PrismaRoomMessageWithParticipants,
    options: { includeFullContent?: boolean; owner?: boolean } = {}
  ): RoomMessage {
    const participants = (message.participants ?? []).map((participant) => this.serializeRoomMessageParticipant(participant));
    const recipientMemberIds = participants
      .filter((participant) => participant.role === 'recipient')
      .map((participant) => participant.memberId);
    const participantMemberIds = participants.map((participant) => participant.memberId);

    const ownerDelivery = options.owner && message.senderType === 'user' ? message.delivery : null;
    const displayContent = ownerDelivery?.originalText ?? message.content;
    const serializedContent = this.serializePreviewField(displayContent);
    const contentMode: RoomMessageContentMode = options.includeFullContent || !serializedContent.isTruncated
      ? 'full'
      : 'preview';
    const { translationEligibilityEpoch: _eligibility, delivery: _delivery, ...publicMessage } = message;
    return {
      ...publicMessage,
      content: options.includeFullContent ? displayContent : serializedContent.value,
      ...(ownerDelivery ? { userDelivery: { operationId: ownerDelivery.id, clientSubmissionId: ownerDelivery.clientSubmissionId, revision: ownerDelivery.revision, sentMode: ownerDelivery.sentMode as 'ORIGINAL' | 'TRANSLATED', actualSentText: options.includeFullContent || (ownerDelivery.actualSentText?.length ?? 0) <= 240 ? ownerDelivery.actualSentText : this.contentPreview(ownerDelivery.actualSentText ?? ''), isTruncated: !options.includeFullContent && (ownerDelivery.actualSentText?.length ?? 0) > 240 } } : {}),
      contentPreview: serializedContent.preview,
      contentMode,
      fullContentAvailable: contentMode === 'preview',
      isTruncated: serializedContent.isTruncated,
      senderType: message.senderType as RoomMessageSenderType,
      kind: message.kind as RoomMessageKind,
      visibility: message.visibility as RoomMessageVisibility,
      mentions: parseJsonField<StructuredMention[]>(message.mentions, []),
      recipientMemberIds,
      participantMemberIds,
      participants,
      workRequestIds: parseJsonField<string[] | null>(message.workRequestIds, null),
      artifactRefs: parseJsonField<string[] | null>(message.artifactRefs, null),
      attachmentIds: parseJsonField<string[] | null>(message.attachmentIds, null),
      createdAt: toIso(message.createdAt),
    };
  }

  private serializeRoomMessageParticipant(participant: PrismaRoomMessageParticipant): RoomMessageParticipant {
    return {
      ...participant,
      role: participant.role as RoomMessageParticipantRole,
      createdAt: toIso(participant.createdAt),
    };
  }

  private serializeWorkRequest(workRequest: PrismaWorkRequest): WorkRequest {
    const serializedInstruction = this.serializePreviewField(workRequest.instruction);
    return {
      ...workRequest,
      instruction: serializedInstruction.value,
      instructionPreview: serializedInstruction.preview,
      isTruncated: serializedInstruction.isTruncated,
      requesterType: workRequest.requesterType as WorkRequestRequesterType,
      targetKind: serializeTargetKind(workRequest.targetKind),
      targetPurpose: serializeTargetPurpose(workRequest.targetPurpose),
      ifBusy: workRequest.ifBusy as IfBusyPolicy,
      status: workRequest.status as WorkRequestStatus,
      nextStartRetryAt: workRequest.nextStartRetryAt ? toIso(workRequest.nextStartRetryAt) : null,
      createdAt: toIso(workRequest.createdAt),
      updatedAt: toIso(workRequest.updatedAt),
    };
  }

  private serializeWorkRequestQueueItem(
    workRequest: PrismaWorkRequest,
    triggerMessage: PrismaRoomMessage | null,
    targetMember: Pick<PrismaTeamMember, 'id' | 'name'> | null
  ): WorkRequestQueueItem {
    return {
      ...this.serializeWorkRequest(workRequest),
      triggerMessage: triggerMessage
        ? {
          id: triggerMessage.id,
          senderType: triggerMessage.senderType as RoomMessageSenderType,
          senderId: triggerMessage.senderId,
          senderInvocationId: triggerMessage.senderInvocationId,
          kind: triggerMessage.kind as RoomMessageKind,
          contentPreview: this.compactContentPreview(triggerMessage.content),
          createdAt: toIso(triggerMessage.createdAt),
        }
        : null,
      targetMember: targetMember
        ? {
          id: targetMember.id,
          name: targetMember.name,
          label: targetMember.name,
        }
        : null,
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
      dispatchRevokedAt: invocation.dispatchRevokedAt ? toIso(invocation.dispatchRevokedAt) : null,
    };
  }
}
