import type {
  AgentInvocation,
  AgentInvocationStatus,
  IfBusyPolicy,
  MemberPreset,
  RoomMessage,
  RoomMessageKind,
  RoomMessageSenderType,
  StructuredMention,
  TeamMember,
  TeamMemberCapabilities,
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
  avatar: string | null;
}

type PrismaTeamTemplateWithMembers = PrismaTeamTemplate & {
  members?: PrismaTeamTemplateMember[];
};

type PrismaTeamRunWithRelations = PrismaTeamRun & {
  members?: PrismaTeamMember[];
  messages?: PrismaRoomMessage[];
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

  async getTaskTeamRun(taskId: string): Promise<TeamRun> {
    const teamRun = await prisma.teamRun.findUnique({
      where: { taskId },
      include: this.teamRunInclude(),
    });
    if (!teamRun) {
      throw new NotFoundError('TeamRun for task', taskId);
    }
    return this.serializeTeamRun(teamRun);
  }

  async getTeamRunById(id: string): Promise<TeamRun> {
    const teamRun = await prisma.teamRun.findUnique({
      where: { id },
      include: this.teamRunInclude(),
    });
    if (!teamRun) {
      throw new NotFoundError('TeamRun', id);
    }
    return this.serializeTeamRun(teamRun);
  }

  async listTeamMembers(teamRunId: string): Promise<TeamMember[]> {
    await this.assertTeamRunExists(teamRunId);
    const [members, invocations, workRequests] = await Promise.all([
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
    ]);
    const memberStatuses = this.deriveTeamMemberStatuses(members, invocations, workRequests);
    return members.map((member) => this.serializeTeamMember(member, memberStatuses.get(member.id)));
  }

  async listRoomMessages(teamRunId: string): Promise<RoomMessage[]> {
    await this.assertTeamRunExists(teamRunId);
    const messages = await prisma.roomMessage.findMany({
      where: { teamRunId },
      orderBy: { createdAt: 'asc' },
    });
    return messages.map((message) => this.serializeRoomMessage(message));
  }

  async listWorkRequests(teamRunId: string): Promise<WorkRequest[]> {
    await this.assertTeamRunExists(teamRunId);
    const workRequests = await prisma.workRequest.findMany({
      where: { teamRunId },
      orderBy: { createdAt: 'asc' },
    });
    return workRequests.map((workRequest) => this.serializeWorkRequest(workRequest));
  }

  async listAgentInvocations(teamRunId: string): Promise<AgentInvocation[]> {
    await this.assertTeamRunExists(teamRunId);
    const invocations = await prisma.agentInvocation.findMany({
      where: { teamRunId },
      orderBy: { createdAt: 'asc' },
    });
    return invocations.map((invocation) => this.serializeAgentInvocation(invocation));
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

      for (const mention of mentions) {
        if (!memberIds.has(mention.memberId)) {
          throw new NotFoundError('TeamMember', mention.memberId);
        }
      }

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
          content: input.content,
          mentions: stringifyJson(mentions),
          artifactRefs: stringifyJson(input.artifactRefs ?? []),
          attachmentIds: stringifyJson(input.attachmentIds ?? []),
          workRequestIds: stringifyJson([]),
        },
      });
      messageId = message.id;

      const targetRequests = mentions.length > 0
        ? mentions.map((mention) => ({
          targetMemberId: mention.memberId,
          ifBusy: mention.ifBusy ?? 'queue',
          cancelQueued: mention.cancelQueued ?? false,
        }))
        : senderType === 'user' || senderType === 'agent'
          ? members
            .filter((member) => member.triggerPolicy === 'USER_MESSAGES')
            .filter((member) => member.id !== requesterMemberId)
            .map((member) => ({
              targetMemberId: member.id,
              ifBusy: 'queue' as const,
              cancelQueued: false,
            }))
          : [];

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

  private teamRunInclude() {
    return {
      members: { orderBy: { createdAt: 'asc' as const } },
      messages: { orderBy: { createdAt: 'asc' as const } },
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

  private serializeTeamRun(teamRun: PrismaTeamRunWithRelations): TeamRun {
    const memberStatuses = this.deriveTeamMemberStatuses(
      teamRun.members ?? [],
      teamRun.invocations ?? [],
      teamRun.workRequests ?? []
    );

    return {
      ...teamRun,
      mode: teamRun.mode as TeamRunMode,
      reviewReason: teamRun.reviewReason as TeamRunReviewReason | null,
      createdAt: toIso(teamRun.createdAt),
      updatedAt: toIso(teamRun.updatedAt),
      members: teamRun.members?.map((member) => this.serializeTeamMember(member, memberStatuses.get(member.id))),
      messages: teamRun.messages?.map((message) => this.serializeRoomMessage(message)),
      workRequests: teamRun.workRequests?.map((workRequest) => this.serializeWorkRequest(workRequest)),
      invocations: teamRun.invocations?.map((invocation) => this.serializeAgentInvocation(invocation)),
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
      avatar: member.avatar ?? null,
      status: status ?? 'IDLE',
      createdAt: toIso(member.createdAt),
      updatedAt: toIso(member.updatedAt),
    };
  }

  private serializeRoomMessage(message: PrismaRoomMessage): RoomMessage {
    return {
      ...message,
      senderType: message.senderType as RoomMessageSenderType,
      kind: message.kind as RoomMessageKind,
      mentions: parseJsonField<StructuredMention[]>(message.mentions, []),
      workRequestIds: parseJsonField<string[] | null>(message.workRequestIds, null),
      artifactRefs: parseJsonField<string[] | null>(message.artifactRefs, null),
      attachmentIds: parseJsonField<string[] | null>(message.attachmentIds, null),
      createdAt: toIso(message.createdAt),
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
