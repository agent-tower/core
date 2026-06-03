import type {
  AgentInvocation,
  AgentInvocationStatus,
  IfBusyPolicy,
  MemberPreset,
  RoomMessage,
  RoomMessageKind,
  RoomMessageParticipant,
  RoomMessageParticipantRole,
  RoomMessageSenderType,
  RoomMessageVisibility,
  StructuredMention,
  TeamMember,
  TeamMemberCapabilities,
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
  WorkspacePolicy,
} from '@agent-tower/shared';
import type {
  AgentInvocation as PrismaAgentInvocation,
  MemberPreset as PrismaMemberPreset,
  RoomMessage as PrismaRoomMessage,
  RoomMessageParticipant as PrismaRoomMessageParticipant,
  TeamMember as PrismaTeamMember,
  TeamRun as PrismaTeamRun,
  TeamTemplate as PrismaTeamTemplate,
  TeamTemplateMember as PrismaTeamTemplateMember,
  WorkRequest as PrismaWorkRequest,
} from '@prisma/client';
import { ServiceError, NotFoundError, ValidationError } from '../errors.js';
import { prisma } from '../utils/index.js';
import { appendAttachmentMarkdownContext } from './attachment-context.js';
import { emitTeamRunInvalidated } from './team-run-events.js';

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
  memberPresetIds?: string[];
  members?: TeamTemplateMemberInput[];
}

export interface UpdateTeamTemplateInput {
  name?: string;
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

type PrismaRoomMessageWithParticipants = PrismaRoomMessage & {
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
const ACTIVE_INVOCATION_STATUSES: AgentInvocationStatus[] = [
  'QUEUED',
  'RUNNING',
  'SESSION_ENDED',
  'WAITING_ROOM_REPLY',
];
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
  const title = task.title.trim();
  if (title.length === 0) {
    throw new ValidationError('Task title is required to create a TeamRun');
  }

  const description = task.description?.trim() ?? '';
  return [title, description].filter(Boolean).join('\n\n');
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
}): Array<{ targetMemberId: string; ifBusy: IfBusyPolicy; cancelQueued: boolean }> {
  if (mentions.length > 0) {
    return mentions.map((mention) => ({
      targetMemberId: mention.memberId,
      ifBusy: mention.ifBusy ?? 'queue',
      cancelQueued: mention.cancelQueued ?? false,
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
    }));
}

export class TeamRunService {
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
      if (input.name !== undefined) {
        await tx.teamTemplate.update({
          where: { id },
          data: { name: input.name },
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
    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task) {
      throw new NotFoundError('Task', taskId);
    }
    buildInitialTaskRoomMessageContent(task);

    const existing = await prisma.teamRun.findUnique({ where: { taskId } });
    if (existing) {
      throw toConflict(`Task already has a TeamRun: ${taskId}`);
    }

    const snapshots = applyStableInstanceNames(await this.buildTeamMemberSnapshots(input));
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
    if (snapshots.length === 0) {
      throw new ValidationError('TeamRun must include at least one member');
    }

    let teamRunId = '';
    let projectId = '';
    let createdTeamRun: PrismaTeamRunWithRelations | null = null;

    try {
      createdTeamRun = await prisma.$transaction(async (tx) => {
        const task = await tx.task.findUnique({ where: { id: taskId } });
        if (!task) {
          throw new NotFoundError('Task', taskId);
        }
        projectId = task.projectId;
        const initialContent = buildInitialTaskRoomMessageContent(task);

        const existing = await tx.teamRun.findUnique({ where: { taskId } });
        if (existing) {
          throw toConflict(`Task already has a TeamRun: ${taskId}`);
        }

        const teamRun = await tx.teamRun.create({
          data: {
            taskId,
            mode: input.mode,
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
              avatar: snapshot.avatar,
            },
          });
          members.push(member);
        }

        const initialMentionParse = deriveStructuredMentionsFromContent(initialContent, members);
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
          const workRequest = await tx.workRequest.create({
            data: {
              teamRunId: teamRun.id,
              requesterMemberId: null,
              requesterType: 'user',
              targetMemberId: targetRequest.targetMemberId,
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

  async listRoomMessages(teamRunId: string, options: TeamRunVisibilityOptions = {}): Promise<RoomMessage[]> {
    await this.assertTeamRunExists(teamRunId);
    const messages = await prisma.roomMessage.findMany({
      where: buildRoomMessageVisibilityWhere(teamRunId, options.viewerMemberId),
      include: { participants: true },
      orderBy: { createdAt: 'asc' },
    });
    return messages.map((message) => this.serializeRoomMessage(message));
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

  async createRoomMessage(teamRunId: string, input: CreateRoomMessageInput): Promise<RoomMessage> {
    const teamRun = await prisma.teamRun.findUnique({ where: { id: teamRunId } });
    if (!teamRun) {
      throw new NotFoundError('TeamRun', teamRunId);
    }

    const mentions = input.mentions ?? [];
    const senderType = input.senderType ?? 'user';
    const kind = input.kind ?? (mentions.length > 0 ? 'work_request' : 'chat');
    const workRequestStatus: WorkRequestStatus = teamRun.mode === 'CONFIRM'
      ? 'PENDING_APPROVAL'
      : 'QUEUED';
    const workRequestInstruction = await appendAttachmentMarkdownContext(input.content, input.attachmentIds);

    let messageId = '';
    await prisma.$transaction(async (tx) => {
      const members = await tx.teamMember.findMany({ where: { teamRunId } });
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

        if (input.senderInvocationId) {
          const invocation = await tx.agentInvocation.findFirst({
            where: {
              id: input.senderInvocationId,
              teamRunId,
              memberId: input.senderId,
            },
            select: { id: true },
          });
          if (!invocation) {
            throw new ValidationError('Agent RoomMessage senderInvocationId must belong to the sender member in this TeamRun');
          }
        }
      }

      const message = await tx.roomMessage.create({
        data: {
          teamRunId,
          senderType,
          senderId: input.senderId ?? null,
          senderInvocationId: input.senderInvocationId ?? null,
          kind,
          visibility: 'PUBLIC',
          content: input.content,
          mentions: stringifyJson(mentions),
          artifactRefs: stringifyJson(input.artifactRefs ?? []),
          attachmentIds: stringifyJson(input.attachmentIds ?? []),
          workRequestIds: stringifyJson([]),
        },
      });
      messageId = message.id;

      const targetRequests = resolveRoomMessageTargetRequests({
        mentions,
        members,
        senderType,
        requesterMemberId,
      });

      const workRequestIds: string[] = [];
      for (const targetRequest of targetRequests) {
        const workRequest = await tx.workRequest.create({
          data: {
            teamRunId,
            requesterMemberId,
            requesterType: senderType as WorkRequestRequesterType,
            targetMemberId: targetRequest.targetMemberId,
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
    const workRequestInstruction = await appendAttachmentMarkdownContext(input.content, input.attachmentIds);

    let messageId = '';
    await prisma.$transaction(async (tx) => {
      const members = await tx.teamMember.findMany({ where: { teamRunId } });
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
            select: { id: true },
          });
          if (!invocation) {
            throw new ValidationError('Agent RoomMessage senderInvocationId must belong to the sender member in this TeamRun');
          }
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
      for (const recipientMemberId of recipientMemberIds) {
        const workRequest = await tx.workRequest.create({
          data: {
            teamRunId,
            requesterMemberId,
            requesterType: senderType as WorkRequestRequesterType,
            targetMemberId: recipientMemberId,
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

  private async buildTeamMemberSnapshots(input: CreateTeamRunInput): Promise<TeamMemberSnapshot[]> {
    const snapshots: TeamMemberSnapshot[] = [];

    if (input.teamTemplateId) {
      const template = await prisma.teamTemplate.findUnique({
        where: { id: input.teamTemplateId },
        include: { members: { orderBy: { position: 'asc' } } },
      });
      if (!template) {
        throw new NotFoundError('TeamTemplate', input.teamTemplateId);
      }
      const presets = await this.findMemberPresetsByIds(
        template.members.map((member) => member.memberPresetId)
      );
      snapshots.push(...presets.map((preset) => this.memberPresetToSnapshot(preset)));
    }

    if (input.memberPresetIds && input.memberPresetIds.length > 0) {
      const presets = await this.findMemberPresetsByIds(input.memberPresetIds);
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

  private async findMemberPresetsByIds(ids: string[]): Promise<PrismaMemberPreset[]> {
    if (ids.length === 0) {
      return [];
    }

    const presets = await prisma.memberPreset.findMany({
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
    const compact = content.replace(/\s+/g, ' ').trim();
    return compact.length <= 240 ? compact : `${compact.slice(0, 237)}...`;
  }

  private teamRunInclude() {
    return {
      members: { orderBy: { createdAt: 'asc' as const } },
      messages: { orderBy: { createdAt: 'asc' as const }, include: { participants: true } },
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
      messages: visibleMessages?.map((message) => this.serializeRoomMessage(message)),
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
      statuses.set(member.id, this.deriveTeamMemberStatus(member.id, invocations, workRequests));
    }

    return statuses;
  }

  private deriveTeamMemberStatus(
    memberId: string,
    invocations: PrismaAgentInvocation[],
    workRequests: PrismaWorkRequest[]
  ): TeamMemberStatus {
    const memberInvocations = invocations.filter((invocation) => invocation.memberId === memberId);
    if (memberInvocations.some((invocation) => invocation.status === 'RUNNING')) return 'RUNNING';
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
      avatar: member.avatar ?? null,
      status: status ?? 'IDLE',
      createdAt: toIso(member.createdAt),
      updatedAt: toIso(member.updatedAt),
    };
  }

  private serializeRoomMessage(message: PrismaRoomMessageWithParticipants): RoomMessage {
    const participants = (message.participants ?? []).map((participant) => this.serializeRoomMessageParticipant(participant));
    const recipientMemberIds = participants
      .filter((participant) => participant.role === 'recipient')
      .map((participant) => participant.memberId);
    const participantMemberIds = participants.map((participant) => participant.memberId);

    return {
      ...message,
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
    return {
      ...workRequest,
      requesterType: workRequest.requesterType as WorkRequestRequesterType,
      ifBusy: workRequest.ifBusy as IfBusyPolicy,
      status: workRequest.status as WorkRequestStatus,
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
          contentPreview: this.contentPreview(triggerMessage.content),
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
      status: invocation.status as AgentInvocationStatus,
      createdAt: toIso(invocation.createdAt),
      updatedAt: toIso(invocation.updatedAt),
      nextRoomReplyReminderAt: invocation.nextRoomReplyReminderAt
        ? toIso(invocation.nextRoomReplyReminderAt)
        : null,
    };
  }
}
