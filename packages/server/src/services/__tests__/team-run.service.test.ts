import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { CreateMemberPresetInput } from '../team-run.service.js';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-team-run-'));
const dbPath = path.join(testDir, 'test.db');
process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;

const { appendAttachmentMarkdownContextMock } = vi.hoisted(() => ({
  appendAttachmentMarkdownContextMock: vi.fn(),
}));

vi.mock('../attachment-context.js', () => ({
  appendAttachmentMarkdownContext: appendAttachmentMarkdownContextMock,
}));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverRoot = path.resolve(__dirname, '../../..');
const schemaPath = path.join(serverRoot, 'prisma/schema.prisma');

let TeamRunService: typeof import('../team-run.service.js').TeamRunService;
let prisma: PrismaClient;
type TeamRunServiceInstance = InstanceType<typeof import('../team-run.service.js').TeamRunService>;

const capabilities = {
  readRoom: true,
  postRoomMessage: true,
  mentionMembers: true,
  stopMemberWork: false,
  markReadyForReview: true,
  readFiles: true,
  writeFiles: true,
  runCommands: false,
  readDiff: true,
  mergeWorkspace: false,
};

function presetInput(name: string, aliases: string[] = [name.toLowerCase()]): CreateMemberPresetInput {
  return {
    name,
    aliases,
    providerId: `provider-${name.toLowerCase()}`,
    rolePrompt: `${name} role`,
    capabilities,
    workspacePolicy: 'dedicated',
    triggerPolicy: 'MENTION_ONLY',
    sessionPolicy: 'new_per_request',
    queueManagementPolicy: 'own_only',
    avatar: null,
  };
}

function userMessagesPresetInput(name: string, aliases: string[] = [name.toLowerCase()]): CreateMemberPresetInput {
  return {
    ...presetInput(name, aliases),
    triggerPolicy: 'USER_MESSAGES',
  };
}

async function createTask(title = 'Team task') {
  const project = await prisma.project.create({
    data: {
      name: `${title} project`,
      repoPath: testDir,
    },
  });

  return prisma.task.create({
    data: {
      title,
      projectId: project.id,
    },
  });
}

describe('TeamRunService', () => {
  let service: TeamRunServiceInstance;

  beforeAll(async () => {
    execFileSync(
      'pnpm',
      ['exec', 'prisma', 'db', 'push', '--skip-generate', `--schema=${schemaPath}`],
      {
        cwd: serverRoot,
        env: { ...process.env, AGENT_TOWER_DATABASE_URL: `file:${dbPath}` },
        stdio: 'pipe',
      }
    );

    const serviceModule = await import('../team-run.service.js');
    const utilsModule = await import('../../utils/index.js');
    TeamRunService = serviceModule.TeamRunService;
    prisma = utilsModule.prisma;
  });

  beforeEach(async () => {
    appendAttachmentMarkdownContextMock.mockImplementation(async (content: string, attachmentIds?: string[] | null) => {
      const ids = Array.from(new Set((attachmentIds ?? []).map((id) => id.trim()).filter(Boolean)));
      if (ids.length === 0) return content.trim();

      const attachments = await prisma.attachment.findMany({ where: { id: { in: ids } } });
      const attachmentById = new Map(attachments.map((attachment) => [attachment.id, attachment]));
      const lines: string[] = [];
      for (const id of ids) {
        const attachment = attachmentById.get(id);
        if (!attachment || content.includes(attachment.storagePath)) continue;
        const prefix = attachment.mimeType.startsWith('image/') ? '!' : '';
        lines.push(`${prefix}[${attachment.originalName}](${attachment.storagePath})`);
      }

      const attachmentContext = lines.length > 0 ? ['Attachments:', ...lines].join('\n') : '';
      return [content.trim(), attachmentContext].filter(Boolean).join('\n\n');
    });
    service = new TeamRunService();
    await prisma.agentInvocation.deleteMany();
    await prisma.workRequest.deleteMany();
    await prisma.roomMessageParticipant.deleteMany();
    await prisma.roomMessage.deleteMany();
    await prisma.teamMember.deleteMany();
    await prisma.teamRun.deleteMany();
    await prisma.teamTemplateMember.deleteMany();
    await prisma.teamTemplate.deleteMany();
    await prisma.memberPreset.deleteMany();
    await prisma.task.deleteMany();
    await prisma.project.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('returns structured aliases and capabilities after creating a MemberPreset', async () => {
    const preset = await service.createMemberPreset(presetInput('Reviewer', ['reviewer', 'review']));

    expect(preset.aliases).toEqual(['reviewer', 'review']);
    expect(preset.capabilities).toEqual(capabilities);
    expect(preset.sessionPolicy).toBe('new_per_request');
    expect(preset.queueManagementPolicy).toBe('own_only');
  });

  it('preserves session policy in MemberPreset and TeamMember snapshots', async () => {
    const preset = await service.createMemberPreset({
      ...presetInput('Implementer', ['impl']),
      sessionPolicy: 'resume_last',
    });
    const task = await createTask();

    const teamRun = await service.createTeamRun(task.id, {
      mode: 'AUTO',
      memberPresetIds: [preset.id],
    });

    expect(preset.sessionPolicy).toBe('resume_last');
    expect(teamRun.members?.[0]).toMatchObject({
      name: 'Implementer',
      sessionPolicy: 'resume_last',
    });
  });

  it('rejects deleting a MemberPreset that is referenced by a TeamTemplate', async () => {
    const preset = await service.createMemberPreset(presetInput('Reviewer'));
    await service.createTeamTemplate({
      name: 'Review team',
      memberPresetIds: [preset.id],
    });

    await expect(service.deleteMemberPreset(preset.id)).rejects.toMatchObject({
      code: 'CONFLICT',
      statusCode: 409,
    });

    await expect(service.getMemberPresetById(preset.id)).resolves.toMatchObject({
      id: preset.id,
      name: 'Reviewer',
    });
  });

  it('preserves repeated MemberPresets in TeamTemplate members', async () => {
    const preset = await service.createMemberPreset(presetInput('Implementer', ['impl']));

    const template = await service.createTeamTemplate({
      name: 'Parallel implementers',
      memberPresetIds: [preset.id, preset.id, preset.id],
    });

    expect(template.members).toHaveLength(3);
    expect(template.members?.map((member) => member.memberPresetId)).toEqual([preset.id, preset.id, preset.id]);
    expect(template.members?.map((member) => member.position)).toEqual([0, 1, 2]);
    expect(template.members?.map((member) => member.memberPreset?.name)).toEqual([
      'Implementer',
      'Implementer',
      'Implementer',
    ]);
  });

  it('updates TeamTemplate members with repeated MemberPresets in order', async () => {
    const first = await service.createMemberPreset(presetInput('Implementer', ['impl']));
    const second = await service.createMemberPreset(presetInput('Reviewer', ['review']));
    const template = await service.createTeamTemplate({
      name: 'Initial team',
      memberPresetIds: [second.id],
    });

    const updated = await service.updateTeamTemplate(template.id, {
      memberPresetIds: [first.id, second.id, first.id],
    });

    expect(updated.members).toHaveLength(3);
    expect(updated.members?.map((member) => member.memberPresetId)).toEqual([
      first.id,
      second.id,
      first.id,
    ]);
    expect(updated.members?.map((member) => member.position)).toEqual([0, 1, 2]);
  });

  it('creates TeamMember snapshots from multiple MemberPresets', async () => {
    const first = await service.createMemberPreset(presetInput('Planner', ['planner']));
    const second = await service.createMemberPreset(presetInput('Coder', ['coder']));
    const task = await createTask();

    const teamRun = await service.createTeamRun(task.id, {
      mode: 'CONFIRM',
      memberPresetIds: [first.id, second.id],
    });

    expect(teamRun.members).toHaveLength(2);
    expect(teamRun.members?.map((member) => member.name)).toEqual(['Planner', 'Coder']);
    expect(teamRun.members?.map((member) => member.presetId)).toEqual([first.id, second.id]);
  });

  it('creates stable instance names when the same MemberPreset is selected more than once', async () => {
    const preset = await service.createMemberPreset(presetInput('Implementer', ['impl']));
    const task = await createTask();

    const teamRun = await service.createTeamRun(task.id, {
      mode: 'AUTO',
      memberPresetIds: [preset.id, preset.id, preset.id],
    });

    expect(teamRun.members).toHaveLength(3);
    expect(teamRun.members?.map((member) => member.name)).toEqual([
      'Implementer #1',
      'Implementer #2',
      'Implementer #3',
    ]);
    expect(teamRun.members?.map((member) => member.presetId)).toEqual([preset.id, preset.id, preset.id]);
    expect(teamRun.members?.map((member) => member.aliases)).toEqual([['impl'], ['impl'], ['impl']]);
  });

  it('creates stable instance names for repeated explicit TeamRun members', async () => {
    const task = await createTask();

    const teamRun = await service.createTeamRun(task.id, {
      mode: 'AUTO',
      members: [
        presetInput('Implementer', ['impl']),
        presetInput('Implementer', ['impl']),
      ],
    });

    expect(teamRun.members).toHaveLength(2);
    expect(teamRun.members?.map((member) => member.name)).toEqual([
      'Implementer #1',
      'Implementer #2',
    ]);
    expect(teamRun.members?.map((member) => member.presetId)).toEqual([null, null]);
  });

  it('creates stable instance names across TeamTemplate and explicit MemberPreset duplicates', async () => {
    const preset = await service.createMemberPreset(presetInput('Implementer', ['impl']));
    const task = await createTask();
    const template = await service.createTeamTemplate({
      name: 'Three implementers',
      memberPresetIds: [preset.id, preset.id],
    });

    const teamRun = await service.createTeamRun(task.id, {
      mode: 'AUTO',
      teamTemplateId: template.id,
      memberPresetIds: [preset.id],
    });

    expect(teamRun.members).toHaveLength(3);
    expect(teamRun.members?.map((member) => member.name)).toEqual([
      'Implementer #1',
      'Implementer #2',
      'Implementer #3',
    ]);
  });

  it('keeps TeamMember snapshots unchanged after updating a MemberPreset', async () => {
    const preset = await service.createMemberPreset(presetInput('Implementer', ['impl']));
    const task = await createTask();
    const teamRun = await service.createTeamRun(task.id, {
      mode: 'AUTO',
      memberPresetIds: [preset.id],
    });

    await service.updateMemberPreset(preset.id, {
      name: 'Updated Implementer',
      aliases: ['updated'],
    });

    const reloaded = await service.getTeamRunById(teamRun.id);
    expect(reloaded.members?.[0]?.name).toBe('Implementer');
    expect(reloaded.members?.[0]?.aliases).toEqual(['impl']);
  });

  it('creates a RoomMessage without WorkRequests when mentions are omitted', async () => {
    const preset = await service.createMemberPreset(presetInput('Coder'));
    const task = await createTask();
    const teamRun = await service.createTeamRun(task.id, {
      mode: 'AUTO',
      memberPresetIds: [preset.id],
    });

    const message = await service.createRoomMessage(teamRun.id, {
      content: 'General note',
    });

    expect(message.senderType).toBe('user');
    expect(message.kind).toBe('chat');
    expect(message.mentions).toEqual([]);
    expect(message.workRequestIds).toEqual([]);
    await expect(service.listWorkRequests(teamRun.id)).resolves.toEqual([]);
  });

  it('creates WorkRequests for USER_MESSAGES members when a user message has no mentions', async () => {
    const leaderPreset = await service.createMemberPreset(userMessagesPresetInput('Leader'));
    const coderPreset = await service.createMemberPreset(presetInput('Coder'));
    const task = await createTask();
    const teamRun = await service.createTeamRun(task.id, {
      mode: 'AUTO',
      memberPresetIds: [leaderPreset.id, coderPreset.id],
    });
    const leader = teamRun.members?.find((member) => member.name === 'Leader');
    expect(leader).toBeDefined();

    const message = await service.createRoomMessage(teamRun.id, {
      content: 'General user request',
    });
    const requests = await service.listWorkRequests(teamRun.id);

    expect(message.kind).toBe('chat');
    expect(message.mentions).toEqual([]);
    expect(message.workRequestIds).toEqual([requests[0]?.id]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      requesterType: 'user',
      requesterMemberId: null,
      targetMemberId: leader!.id,
      triggerMessageId: message.id,
      instruction: 'General user request',
      ifBusy: 'queue',
      cancelQueued: false,
      status: 'QUEUED',
    });
  });

  it('creates initial TeamRun messages and WorkRequests with previews instead of full task description', async () => {
    const preset = await service.createMemberPreset(userMessagesPresetInput('Leader'));
    const project = await prisma.project.create({
      data: {
        name: 'Initial preview project',
        repoPath: testDir,
      },
    });
    const longDescription = `Full diagnostic logs\n${'line '.repeat(500)}`;
    const task = await prisma.task.create({
      data: {
        title: 'Investigate checkout logs',
        description: longDescription,
        projectId: project.id,
      },
    });

    const teamRun = await service.createTeamRunWithInitialRoomMessage(task.id, {
      mode: 'CONFIRM',
      memberPresetIds: [preset.id],
    });

    expect(teamRun.messages).toHaveLength(1);
    expect(teamRun.workRequests).toHaveLength(1);
    expect(teamRun.messages?.[0]?.content).toContain('Investigate checkout logs');
    expect(teamRun.messages?.[0]?.content).toContain('Full details are stored on the task description');
    expect(teamRun.messages?.[0]?.content).not.toContain('line '.repeat(100));
    expect(teamRun.workRequests?.[0]?.instruction).not.toContain('line '.repeat(100));

    const storedMessage = await prisma.roomMessage.findFirstOrThrow({ where: { teamRunId: teamRun.id } });
    const storedRequest = await prisma.workRequest.findFirstOrThrow({ where: { teamRunId: teamRun.id } });
    expect(storedMessage.content).not.toContain('line '.repeat(100));
    expect(storedRequest.instruction).not.toContain('line '.repeat(100));
  });

  it('parses initial TeamRun mentions from full task body while storing only previews', async () => {
    const leaderPreset = await service.createMemberPreset(userMessagesPresetInput('Leader'));
    const reviewerPreset = await service.createMemberPreset(presetInput('Reviewer', ['reviewer']));
    const project = await prisma.project.create({
      data: {
        name: 'Initial mention full body project',
        repoPath: testDir,
      },
    });
    const longDescription = [
      'Please inspect this incident.',
      'log-line '.repeat(300),
      '@Reviewer please review the failure handling.',
    ].join('\n');
    const task = await prisma.task.create({
      data: {
        title: 'Investigate checkout logs',
        description: longDescription,
        projectId: project.id,
      },
    });

    const teamRun = await service.createTeamRunWithInitialRoomMessage(task.id, {
      mode: 'CONFIRM',
      memberPresetIds: [leaderPreset.id, reviewerPreset.id],
    });
    const reviewer = teamRun.members?.find((member) => member.name === 'Reviewer');
    expect(reviewer).toBeDefined();

    expect(teamRun.messages).toHaveLength(1);
    expect(teamRun.messages?.[0]?.mentions).toEqual([
      expect.objectContaining({
        memberId: reviewer!.id,
        label: 'Reviewer',
      }),
    ]);
    expect(teamRun.workRequests).toHaveLength(1);
    expect(teamRun.workRequests?.[0]?.targetMemberId).toBe(reviewer!.id);
    expect(teamRun.messages?.[0]?.content).not.toContain('@Reviewer please review');
    expect(teamRun.workRequests?.[0]?.instruction).not.toContain('@Reviewer please review');

    const storedMessage = await prisma.roomMessage.findFirstOrThrow({ where: { teamRunId: teamRun.id } });
    const storedRequest = await prisma.workRequest.findFirstOrThrow({ where: { teamRunId: teamRun.id } });
    expect(storedMessage.content).not.toContain('@Reviewer please review');
    expect(storedRequest.instruction).not.toContain('@Reviewer please review');
  });

  it('rolls back RoomMessage and WorkRequest creation if the task is deleted before transaction writes', async () => {
    const preset = await service.createMemberPreset(userMessagesPresetInput('Leader'));
    const task = await createTask();
    const teamRun = await service.createTeamRun(task.id, {
      mode: 'AUTO',
      memberPresetIds: [preset.id],
    });
    appendAttachmentMarkdownContextMock.mockImplementationOnce(async (content: string) => {
      await prisma.task.update({
        where: { id: task.id },
        data: { deletedAt: new Date() },
      });
      return content;
    });

    await expect(service.createRoomMessage(teamRun.id, {
      content: 'General user request after delete',
    })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      statusCode: 404,
    });

    await expect(prisma.roomMessage.count({ where: { teamRunId: teamRun.id } })).resolves.toBe(0);
    await expect(prisma.workRequest.count({ where: { teamRunId: teamRun.id } })).resolves.toBe(0);
  });

  it('creates WorkRequests from RoomMessage mentions and writes workRequestIds back', async () => {
    const preset = await service.createMemberPreset(presetInput('Coder'));
    const task = await createTask();
    const teamRun = await service.createTeamRun(task.id, {
      mode: 'CONFIRM',
      memberPresetIds: [preset.id],
    });
    const member = teamRun.members?.[0];
    expect(member).toBeDefined();

    const message = await service.createRoomMessage(teamRun.id, {
      content: 'Please implement this',
      mentions: [{ memberId: member!.id, ifBusy: 'cancel_current_and_start', cancelQueued: true }],
    });
    const requests = await service.listWorkRequests(teamRun.id);

    expect(message.kind).toBe('work_request');
    expect(message.workRequestIds).toEqual([requests[0]?.id]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      requesterType: 'user',
      requesterMemberId: null,
      targetMemberId: member!.id,
      triggerMessageId: message.id,
      instruction: 'Please implement this',
      ifBusy: 'cancel_current_and_start',
      cancelQueued: true,
      status: 'PENDING_APPROVAL',
    });
  });

  it('creates private RoomMessages with participants and WorkRequests for recipients', async () => {
    const senderPreset = await service.createMemberPreset(presetInput('Sender'));
    const recipientPreset = await service.createMemberPreset(presetInput('Recipient'));
    const observerPreset = await service.createMemberPreset(presetInput('Observer'));
    const task = await createTask();
    const teamRun = await service.createTeamRun(task.id, {
      mode: 'AUTO',
      memberPresetIds: [senderPreset.id, recipientPreset.id, observerPreset.id],
    });
    const sender = teamRun.members?.find((member) => member.name === 'Sender');
    const recipient = teamRun.members?.find((member) => member.name === 'Recipient');
    const observer = teamRun.members?.find((member) => member.name === 'Observer');
    expect(sender).toBeDefined();
    expect(recipient).toBeDefined();
    expect(observer).toBeDefined();

    const message = await service.createPrivateRoomMessage(teamRun.id, {
      content: 'Private strategy',
      recipientMemberIds: [recipient!.id],
      senderType: 'agent',
      senderId: sender!.id,
    });
    const requests = await service.listWorkRequests(teamRun.id);

    expect(message).toMatchObject({
      senderType: 'agent',
      senderId: sender!.id,
      visibility: 'PRIVATE',
      mentions: [],
      recipientMemberIds: [recipient!.id],
      workRequestIds: [requests[0]?.id],
    });
    expect(new Set(message.participantMemberIds)).toEqual(new Set([sender!.id, recipient!.id]));
    expect(message.participants?.map((participant) => [participant.memberId, participant.role])).toEqual(
      expect.arrayContaining([
        [sender!.id, 'sender'],
        [recipient!.id, 'recipient'],
      ])
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      requesterType: 'agent',
      requesterMemberId: sender!.id,
      targetMemberId: recipient!.id,
      triggerMessageId: message.id,
      instruction: 'Private strategy',
      status: 'QUEUED',
    });

    await expect(service.listRoomMessages(teamRun.id)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: message.id })])
    );
    await expect(service.listRoomMessages(teamRun.id, { viewerMemberId: sender!.id })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: message.id })])
    );
    await expect(service.listRoomMessages(teamRun.id, { viewerMemberId: recipient!.id })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: message.id })])
    );
    await expect(service.listRoomMessages(teamRun.id, { viewerMemberId: observer!.id })).resolves.toEqual([]);
  });

  it('records user private message senderId as a sender participant when provided', async () => {
    const senderPreset = await service.createMemberPreset(presetInput('HostSender'));
    const recipientPreset = await service.createMemberPreset(presetInput('Recipient'));
    const observerPreset = await service.createMemberPreset(presetInput('Observer'));
    const task = await createTask();
    const teamRun = await service.createTeamRun(task.id, {
      mode: 'AUTO',
      memberPresetIds: [senderPreset.id, recipientPreset.id, observerPreset.id],
    });
    const sender = teamRun.members?.find((member) => member.name === 'HostSender');
    const recipient = teamRun.members?.find((member) => member.name === 'Recipient');
    const observer = teamRun.members?.find((member) => member.name === 'Observer');
    expect(sender).toBeDefined();
    expect(recipient).toBeDefined();
    expect(observer).toBeDefined();

    const message = await service.createPrivateRoomMessage(teamRun.id, {
      content: 'Host sent private note',
      recipientMemberIds: [recipient!.id],
      senderType: 'user',
      senderId: sender!.id,
    });

    expect(message).toMatchObject({
      senderType: 'user',
      senderId: sender!.id,
      visibility: 'PRIVATE',
      recipientMemberIds: [recipient!.id],
    });
    expect(new Set(message.participantMemberIds)).toEqual(new Set([sender!.id, recipient!.id]));
    expect(message.participants?.map((participant) => [participant.memberId, participant.role])).toEqual(
      expect.arrayContaining([
        [sender!.id, 'sender'],
        [recipient!.id, 'recipient'],
      ])
    );

    await expect(service.listRoomMessages(teamRun.id, { viewerMemberId: sender!.id })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: message.id })])
    );
    await expect(service.listRoomMessages(teamRun.id, { viewerMemberId: recipient!.id })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: message.id })])
    );
    await expect(service.listRoomMessages(teamRun.id, { viewerMemberId: observer!.id })).resolves.toEqual([]);
  });

  it('normalizes system private message senderId without granting sender visibility', async () => {
    const senderPreset = await service.createMemberPreset(presetInput('HostSender'));
    const recipientPreset = await service.createMemberPreset(presetInput('Recipient'));
    const observerPreset = await service.createMemberPreset(presetInput('Observer'));
    const task = await createTask();
    const teamRun = await service.createTeamRun(task.id, {
      mode: 'AUTO',
      memberPresetIds: [senderPreset.id, recipientPreset.id, observerPreset.id],
    });
    const sender = teamRun.members?.find((member) => member.name === 'HostSender');
    const recipient = teamRun.members?.find((member) => member.name === 'Recipient');
    const observer = teamRun.members?.find((member) => member.name === 'Observer');
    expect(sender).toBeDefined();
    expect(recipient).toBeDefined();
    expect(observer).toBeDefined();

    const message = await service.createPrivateRoomMessage(teamRun.id, {
      content: 'System sent private note',
      recipientMemberIds: [recipient!.id],
      senderType: 'system',
      senderId: sender!.id,
      senderInvocationId: 'forged-system-invocation',
    });

    expect(message).toMatchObject({
      senderType: 'system',
      senderId: null,
      senderInvocationId: null,
      visibility: 'PRIVATE',
      recipientMemberIds: [recipient!.id],
    });
    expect(message.participantMemberIds).toEqual([recipient!.id]);
    expect(message.participants?.map((participant) => [participant.memberId, participant.role])).toEqual([
      [recipient!.id, 'recipient'],
    ]);

    await expect(service.listRoomMessages(teamRun.id)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: message.id })])
    );
    await expect(service.listRoomMessages(teamRun.id, { viewerMemberId: sender!.id })).resolves.toEqual([]);
    await expect(service.listRoomMessages(teamRun.id, { viewerMemberId: recipient!.id })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: message.id })])
    );
    await expect(service.listRoomMessages(teamRun.id, { viewerMemberId: observer!.id })).resolves.toEqual([]);
  });

  it('filters TeamRun detail and member queues for private RoomMessage visibility', async () => {
    const managerPreset = await service.createMemberPreset({
      ...presetInput('Manager'),
      queueManagementPolicy: 'team_pending',
    });
    const senderPreset = await service.createMemberPreset(presetInput('Sender'));
    const recipientPreset = await service.createMemberPreset(presetInput('Recipient'));
    const task = await createTask();
    const teamRun = await service.createTeamRun(task.id, {
      mode: 'AUTO',
      memberPresetIds: [managerPreset.id, senderPreset.id, recipientPreset.id],
    });
    const manager = teamRun.members?.find((member) => member.name === 'Manager');
    const sender = teamRun.members?.find((member) => member.name === 'Sender');
    const recipient = teamRun.members?.find((member) => member.name === 'Recipient');
    expect(manager).toBeDefined();
    expect(sender).toBeDefined();
    expect(recipient).toBeDefined();

    const privateMessage = await service.createPrivateRoomMessage(teamRun.id, {
      content: 'Secret work',
      recipientMemberIds: [recipient!.id],
      senderType: 'agent',
      senderId: sender!.id,
    });

    const hostDetail = await service.getTeamRunById(teamRun.id);
    expect(hostDetail.messages?.map((message) => message.id)).toContain(privateMessage.id);
    expect(hostDetail.workRequests?.map((request) => request.id)).toEqual(privateMessage.workRequestIds);

    const managerDetail = await service.getTeamRunById(teamRun.id, { viewerMemberId: manager!.id });
    expect(managerDetail.messages ?? []).toEqual([]);
    expect(managerDetail.workRequests ?? []).toEqual([]);

    const recipientDetail = await service.getTeamRunById(teamRun.id, { viewerMemberId: recipient!.id });
    expect(recipientDetail.messages?.map((message) => message.id)).toEqual([privateMessage.id]);
    expect(recipientDetail.workRequests?.map((request) => request.id)).toEqual(privateMessage.workRequestIds);

    const managerQueue = await service.listQueuedWorkRequestsForMember(teamRun.id, manager!.id);
    expect(managerQueue.canManageTeamRunQueue).toBe(true);
    expect(managerQueue.workRequests).toEqual([]);

    const recipientQueue = await service.listQueuedWorkRequestsForMember(teamRun.id, recipient!.id);
    expect(recipientQueue.workRequests.map((request) => request.id)).toEqual(privateMessage.workRequestIds);
  });

  it('derives TeamMember status from active invocations and open WorkRequests', async () => {
    const runningPreset = await service.createMemberPreset(presetInput('Runner'));
    const pendingPreset = await service.createMemberPreset(presetInput('Pending'));
    const queuedPreset = await service.createMemberPreset(presetInput('Queued'));
    const task = await createTask();
    const teamRun = await service.createTeamRun(task.id, {
      mode: 'CONFIRM',
      memberPresetIds: [runningPreset.id, pendingPreset.id, queuedPreset.id],
    });
    const [runningMember, pendingMember, queuedMember] = teamRun.members ?? [];
    expect(runningMember).toBeDefined();
    expect(pendingMember).toBeDefined();
    expect(queuedMember).toBeDefined();

    const workspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'team-shared-status',
        worktreePath: testDir,
        status: 'ACTIVE',
      },
    });
    const runningRequest = await prisma.workRequest.create({
      data: {
        teamRunId: teamRun.id,
        requesterMemberId: null,
        requesterType: 'user',
        targetMemberId: runningMember!.id,
        triggerMessageId: 'running-trigger',
        instruction: 'Running work',
        status: 'STARTED',
      },
    });
    await prisma.agentInvocation.create({
      data: {
        teamRunId: teamRun.id,
        workRequestId: runningRequest.id,
        memberId: runningMember!.id,
        workspaceId: workspace.id,
        sessionId: null,
        status: 'RUNNING',
      },
    });
    await prisma.workRequest.create({
      data: {
        teamRunId: teamRun.id,
        requesterMemberId: null,
        requesterType: 'user',
        targetMemberId: pendingMember!.id,
        triggerMessageId: 'pending-trigger',
        instruction: 'Pending work',
        status: 'PENDING_APPROVAL',
      },
    });
    await prisma.workRequest.create({
      data: {
        teamRunId: teamRun.id,
        requesterMemberId: null,
        requesterType: 'user',
        targetMemberId: queuedMember!.id,
        triggerMessageId: 'queued-trigger',
        instruction: 'Queued work',
        status: 'QUEUED',
      },
    });

    const members = await service.listTeamMembers(teamRun.id);
    const statuses = new Map(members.map((member) => [member.id, member.status]));

    expect(statuses.get(runningMember!.id)).toBe('RUNNING');
    expect(statuses.get(pendingMember!.id)).toBe('PENDING_APPROVAL');
    expect(statuses.get(queuedMember!.id)).toBe('QUEUED');
  });

  it('lists only current member pending and queued WorkRequests by default', async () => {
    const firstPreset = await service.createMemberPreset(presetInput('First'));
    const secondPreset = await service.createMemberPreset(presetInput('Second'));
    const task = await createTask();
    const teamRun = await service.createTeamRun(task.id, {
      mode: 'AUTO',
      memberPresetIds: [firstPreset.id, secondPreset.id],
    });
    const [firstMember, secondMember] = teamRun.members ?? [];
    expect(firstMember).toBeDefined();
    expect(secondMember).toBeDefined();
    const firstMessage = await prisma.roomMessage.create({
      data: {
        teamRunId: teamRun.id,
        senderType: 'user',
        senderId: null,
        senderInvocationId: null,
        kind: 'chat',
        content: 'First queued request\n\nwith more context',
        mentions: '[]',
        workRequestIds: '[]',
        artifactRefs: '[]',
        attachmentIds: '[]',
      },
    });
    const secondMessage = await prisma.roomMessage.create({
      data: {
        teamRunId: teamRun.id,
        senderType: 'user',
        senderId: null,
        senderInvocationId: null,
        kind: 'chat',
        content: 'Second queued request',
        mentions: '[]',
        workRequestIds: '[]',
        artifactRefs: '[]',
        attachmentIds: '[]',
      },
    });
    const firstQueued = await prisma.workRequest.create({
      data: {
        teamRunId: teamRun.id,
        requesterMemberId: null,
        requesterType: 'user',
        targetMemberId: firstMember!.id,
        triggerMessageId: firstMessage.id,
        instruction: 'First queued request',
        status: 'QUEUED',
      },
    });
    await prisma.workRequest.create({
      data: {
        teamRunId: teamRun.id,
        requesterMemberId: null,
        requesterType: 'user',
        targetMemberId: firstMember!.id,
        triggerMessageId: firstMessage.id,
        instruction: 'Started request',
        status: 'STARTED',
      },
    });
    await prisma.workRequest.create({
      data: {
        teamRunId: teamRun.id,
        requesterMemberId: null,
        requesterType: 'user',
        targetMemberId: secondMember!.id,
        triggerMessageId: secondMessage.id,
        instruction: 'Second queued request',
        status: 'QUEUED',
      },
    });

    const queue = await service.listQueuedWorkRequestsForMember(teamRun.id, firstMember!.id);

    expect(queue).toMatchObject({
      teamRunId: teamRun.id,
      currentMemberId: firstMember!.id,
      queueManagementPolicy: 'own_only',
      canManageTeamRunQueue: false,
    });
    expect(queue.workRequests).toHaveLength(1);
    expect(queue.workRequests[0]).toMatchObject({
      id: firstQueued.id,
      targetMemberId: firstMember!.id,
      status: 'QUEUED',
      targetMember: {
        id: firstMember!.id,
        name: firstMember!.name,
        label: firstMember!.name,
      },
      triggerMessage: {
        id: firstMessage.id,
        senderType: 'user',
        kind: 'chat',
        contentPreview: 'First queued request with more context',
      },
    });
  });

  it('lists all pending and queued WorkRequests for members with team_pending queueManagementPolicy', async () => {
    const managerPreset = await service.createMemberPreset({
      ...presetInput('Manager'),
      queueManagementPolicy: 'team_pending',
    });
    const workerPreset = await service.createMemberPreset(presetInput('Worker'));
    const task = await createTask();
    const teamRun = await service.createTeamRun(task.id, {
      mode: 'CONFIRM',
      memberPresetIds: [managerPreset.id, workerPreset.id],
    });
    const [manager, worker] = teamRun.members ?? [];
    expect(manager).toBeDefined();
    expect(worker).toBeDefined();
    const message = await prisma.roomMessage.create({
      data: {
        teamRunId: teamRun.id,
        senderType: 'user',
        senderId: null,
        senderInvocationId: null,
        kind: 'chat',
        content: 'Queue visible to manager',
        mentions: '[]',
        workRequestIds: '[]',
        artifactRefs: '[]',
        attachmentIds: '[]',
      },
    });
    const workerPending = await prisma.workRequest.create({
      data: {
        teamRunId: teamRun.id,
        requesterMemberId: null,
        requesterType: 'user',
        targetMemberId: worker!.id,
        triggerMessageId: message.id,
        instruction: 'Worker pending',
        status: 'PENDING_APPROVAL',
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 1)),
      },
    });
    const managerQueued = await prisma.workRequest.create({
      data: {
        teamRunId: teamRun.id,
        requesterMemberId: null,
        requesterType: 'user',
        targetMemberId: manager!.id,
        triggerMessageId: message.id,
        instruction: 'Manager queued',
        status: 'QUEUED',
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 2)),
      },
    });

    const queue = await service.listQueuedWorkRequestsForMember(teamRun.id, manager!.id);

    expect(queue.canManageTeamRunQueue).toBe(true);
    expect(queue.queueManagementPolicy).toBe('team_pending');
    expect(queue.workRequests.map((request) => request.id)).toEqual([workerPending.id, managerQueued.id]);
    expect(queue.workRequests[0]).toMatchObject({
      targetMemberId: worker!.id,
      targetMember: {
        id: worker!.id,
        name: worker!.name,
        label: worker!.name,
      },
    });
  });

  it('creates WorkRequests only for the selected memberId when same-name members are mentioned', async () => {
    const task = await createTask();
    const teamRun = await service.createTeamRun(task.id, {
      mode: 'AUTO',
      members: [
        presetInput('Coder'),
        presetInput('Coder'),
      ],
    });
    const [firstCoder, secondCoder] = teamRun.members ?? [];
    expect(firstCoder).toBeDefined();
    expect(secondCoder).toBeDefined();

    const message = await service.createRoomMessage(teamRun.id, {
      content: '@Coder please implement this',
      mentions: [{ memberId: secondCoder!.id, label: secondCoder!.name }],
    });
    const requests = await service.listWorkRequests(teamRun.id);

    expect(message.mentions).toEqual([{ memberId: secondCoder!.id, label: secondCoder!.name }]);
    expect(message.workRequestIds).toEqual([requests[0]?.id]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      targetMemberId: secondCoder!.id,
      triggerMessageId: message.id,
      instruction: '@Coder please implement this',
      status: 'QUEUED',
    });
    expect(requests[0]?.targetMemberId).not.toBe(firstCoder!.id);
  });

  it('does not parse text @name into WorkRequests when structured mentions are omitted', async () => {
    const task = await createTask();
    const teamRun = await service.createTeamRun(task.id, {
      mode: 'AUTO',
      members: [
        presetInput('Coder'),
        presetInput('Coder'),
      ],
    });

    const message = await service.createRoomMessage(teamRun.id, {
      content: '@Coder please implement this',
    });

    expect(message.mentions).toEqual([]);
    expect(message.workRequestIds).toEqual([]);
    await expect(service.listWorkRequests(teamRun.id)).resolves.toEqual([]);
  });

  it('does not create USER_MESSAGES WorkRequests when a user message already has mentions', async () => {
    const leaderPreset = await service.createMemberPreset(userMessagesPresetInput('Leader'));
    const coderPreset = await service.createMemberPreset(presetInput('Coder'));
    const task = await createTask();
    const teamRun = await service.createTeamRun(task.id, {
      mode: 'CONFIRM',
      memberPresetIds: [leaderPreset.id, coderPreset.id],
    });
    const coder = teamRun.members?.find((member) => member.name === 'Coder');
    expect(coder).toBeDefined();

    const message = await service.createRoomMessage(teamRun.id, {
      content: 'Please implement this',
      mentions: [{ memberId: coder!.id }],
    });
    const requests = await service.listWorkRequests(teamRun.id);

    expect(message.workRequestIds).toEqual([requests[0]?.id]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.targetMemberId).toBe(coder!.id);
  });

  it('creates USER_MESSAGES WorkRequests for unmentioned agent messages from other members', async () => {
    const leaderPreset = await service.createMemberPreset(userMessagesPresetInput('Leader'));
    const coderPreset = await service.createMemberPreset(presetInput('Coder'));
    const task = await createTask();
    const teamRun = await service.createTeamRun(task.id, {
      mode: 'AUTO',
      memberPresetIds: [leaderPreset.id, coderPreset.id],
    });
    const leader = teamRun.members?.find((member) => member.name === 'Leader');
    const coder = teamRun.members?.find((member) => member.name === 'Coder');
    expect(leader).toBeDefined();
    expect(coder).toBeDefined();

    const message = await service.createRoomMessage(teamRun.id, {
      content: 'Agent result',
      senderType: 'agent',
      senderId: coder!.id,
    });
    const requests = await service.listWorkRequests(teamRun.id);

    expect(message.workRequestIds).toEqual([requests[0]?.id]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      requesterType: 'agent',
      requesterMemberId: coder!.id,
      targetMemberId: leader!.id,
      triggerMessageId: message.id,
      instruction: 'Agent result',
      ifBusy: 'queue',
      cancelQueued: false,
      status: 'QUEUED',
    });
  });

  it('does not create USER_MESSAGES WorkRequests for the sending member itself', async () => {
    const leaderPreset = await service.createMemberPreset(userMessagesPresetInput('Leader'));
    const task = await createTask();
    const teamRun = await service.createTeamRun(task.id, {
      mode: 'AUTO',
      memberPresetIds: [leaderPreset.id],
    });
    const leader = teamRun.members?.find((member) => member.name === 'Leader');
    expect(leader).toBeDefined();

    const message = await service.createRoomMessage(teamRun.id, {
      content: 'Leader summary',
      senderType: 'agent',
      senderId: leader!.id,
    });

    expect(message.workRequestIds).toEqual([]);
    await expect(service.listWorkRequests(teamRun.id)).resolves.toEqual([]);
  });

  it('adds, patches, and soft-removes TeamRun members without deleting history', async () => {
    const initialPreset = await service.createMemberPreset(presetInput('Lead'));
    const addedPreset = await service.createMemberPreset(presetInput('Coder'));
    const task = await createTask();
    const teamRun = await service.createTeamRun(task.id, {
      mode: 'AUTO',
      memberPresetIds: [initialPreset.id],
    });

    const added = await service.addTeamRunMember(teamRun.id, { memberPresetId: addedPreset.id });
    expect(added).toMatchObject({
      name: 'Coder',
      membershipStatus: 'ACTIVE',
      status: 'IDLE',
    });

    const patched = await service.patchTeamRunMember(teamRun.id, added.id, {
      name: 'Coder Prime',
      aliases: ['prime'],
    });
    expect(patched).toMatchObject({
      name: 'Coder Prime',
      aliases: ['prime'],
      membershipStatus: 'ACTIVE',
    });

    const message = await service.createPrivateRoomMessage(teamRun.id, {
      content: 'Private work',
      recipientMemberIds: [added.id],
    });
    expect(message.participantMemberIds).toEqual([added.id]);

    const removed = await service.softRemoveTeamRunMember(teamRun.id, added.id);
    expect(removed.member).toMatchObject({
      id: added.id,
      membershipStatus: 'REMOVED',
      status: 'REMOVED',
    });

    const members = await service.listTeamMembers(teamRun.id);
    expect(members.find((member) => member.id === added.id)).toMatchObject({
      membershipStatus: 'REMOVED',
      status: 'REMOVED',
    });
    const messages = await service.listRoomMessages(teamRun.id);
    expect(messages.find((item) => item.id === message.id)?.participantMemberIds).toEqual([added.id]);
  });

  it('excludes removed members from future mentions, private recipients, and USER_MESSAGES fallback', async () => {
    const leadPreset = await service.createMemberPreset(userMessagesPresetInput('Lead'));
    const coderPreset = await service.createMemberPreset(presetInput('Coder'));
    const task = await createTask();
    const teamRun = await service.createTeamRun(task.id, {
      mode: 'AUTO',
      memberPresetIds: [leadPreset.id, coderPreset.id],
    });
    const lead = teamRun.members?.find((member) => member.name === 'Lead');
    const coder = teamRun.members?.find((member) => member.name === 'Coder');
    expect(lead).toBeDefined();
    expect(coder).toBeDefined();

    await service.softRemoveTeamRunMember(teamRun.id, lead!.id);

    await expect(service.createRoomMessage(teamRun.id, {
      content: 'Please review',
      mentions: [{ memberId: lead!.id, label: 'Lead' }],
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(service.createPrivateRoomMessage(teamRun.id, {
      content: 'Private review',
      recipientMemberIds: [lead!.id],
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const message = await service.createRoomMessage(teamRun.id, {
      content: 'No fallback should target removed Lead',
      senderType: 'agent',
      senderId: coder!.id,
    });
    expect(message.workRequestIds).toEqual([]);
    const requests = await service.listWorkRequests(teamRun.id);
    expect(requests.filter((request) => request.targetMemberId === lead!.id)).toHaveLength(0);
  });

  it('rejects queue access for removed TeamRun members', async () => {
    const leadPreset = await service.createMemberPreset(presetInput('Lead'));
    const task = await createTask();
    const teamRun = await service.createTeamRun(task.id, {
      mode: 'AUTO',
      memberPresetIds: [leadPreset.id],
    });
    const lead = teamRun.members?.[0];
    expect(lead).toBeDefined();

    await service.softRemoveTeamRunMember(teamRun.id, lead!.id);

    await expect(service.listQueuedWorkRequestsForMember(teamRun.id, lead!.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      statusCode: 403,
    });
  });

  it('queues WorkRequests in AUTO mode and preserves senderInvocationId', async () => {
    const preset = await service.createMemberPreset(presetInput('Reviewer'));
    const task = await createTask();
    const teamRun = await service.createTeamRun(task.id, {
      mode: 'AUTO',
      memberPresetIds: [preset.id],
    });
    const member = teamRun.members?.[0];
    expect(member).toBeDefined();
    const workspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'team-shared',
        worktreePath: testDir,
        status: 'ACTIVE',
      },
    });
    const request = await prisma.workRequest.create({
      data: {
        teamRunId: teamRun.id,
        requesterMemberId: null,
        requesterType: 'user',
        targetMemberId: member!.id,
        triggerMessageId: 'trigger-message-1',
        instruction: 'Original work',
        status: 'STARTED',
      },
    });
    const session = await prisma.session.create({
      data: {
        workspaceId: workspace.id,
        agentType: 'CODEX',
        providerId: member!.providerId,
        prompt: 'Do the work',
        status: 'RUNNING',
      },
    });
    const invocation = await prisma.agentInvocation.create({
      data: {
        teamRunId: teamRun.id,
        workRequestId: request.id,
        memberId: member!.id,
        workspaceId: workspace.id,
        sessionId: session.id,
        status: 'RUNNING',
      },
    });

    const message = await service.createRoomMessage(teamRun.id, {
      content: 'Review this change',
      mentions: [{ memberId: member!.id }],
      senderType: 'agent',
      senderId: member!.id,
      senderInvocationId: invocation.id,
    });
    const requests = await service.listWorkRequests(teamRun.id);
    const createdRequest = requests.find((item) => item.triggerMessageId === message.id);

    expect(message.senderInvocationId).toBe(invocation.id);
    expect(createdRequest).toMatchObject({
      requesterType: 'agent',
      requesterMemberId: member!.id,
      status: 'QUEUED',
    });
  });

  it('rejects agent RoomMessages when senderInvocationId does not belong to the sender', async () => {
    const senderPreset = await service.createMemberPreset(presetInput('Sender'));
    const otherPreset = await service.createMemberPreset(presetInput('Other'));
    const task = await createTask();
    const teamRun = await service.createTeamRun(task.id, {
      mode: 'AUTO',
      memberPresetIds: [senderPreset.id, otherPreset.id],
    });
    const sender = teamRun.members?.find((member) => member.name === 'Sender');
    const other = teamRun.members?.find((member) => member.name === 'Other');
    expect(sender).toBeDefined();
    expect(other).toBeDefined();
    const workspace = await prisma.workspace.create({
      data: {
        taskId: task.id,
        branchName: 'team-shared',
        worktreePath: testDir,
        status: 'ACTIVE',
      },
    });
    const request = await prisma.workRequest.create({
      data: {
        teamRunId: teamRun.id,
        requesterMemberId: null,
        requesterType: 'user',
        targetMemberId: other!.id,
        triggerMessageId: 'trigger-message-2',
        instruction: 'Original work',
        status: 'STARTED',
      },
    });
    const session = await prisma.session.create({
      data: {
        workspaceId: workspace.id,
        agentType: 'CODEX',
        providerId: other!.providerId,
        prompt: 'Do the work',
        status: 'RUNNING',
      },
    });
    const invocation = await prisma.agentInvocation.create({
      data: {
        teamRunId: teamRun.id,
        workRequestId: request.id,
        memberId: other!.id,
        workspaceId: workspace.id,
        sessionId: session.id,
        status: 'RUNNING',
      },
    });

    await expect(service.createRoomMessage(teamRun.id, {
      content: 'Spoofed result',
      senderType: 'agent',
      senderId: sender!.id,
      senderInvocationId: invocation.id,
    })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
    });
  });

  it('saves and reads RoomMessage attachmentIds', async () => {
    const preset = await service.createMemberPreset(presetInput('Coder'));
    const task = await createTask();
    const teamRun = await service.createTeamRun(task.id, {
      mode: 'AUTO',
      memberPresetIds: [preset.id],
    });

    const message = await service.createRoomMessage(teamRun.id, {
      content: 'See attached',
      attachmentIds: ['attachment-1', 'attachment-2'],
    });
    const messages = await service.listRoomMessages(teamRun.id);

    expect(message.attachmentIds).toEqual(['attachment-1', 'attachment-2']);
    expect(messages[0]?.attachmentIds).toEqual(['attachment-1', 'attachment-2']);
  });

  it('adds attachment markdown context to WorkRequest instructions from RoomMessage attachmentIds', async () => {
    const preset = await service.createMemberPreset(presetInput('Coder'));
    const task = await createTask();
    const teamRun = await service.createTeamRun(task.id, {
      mode: 'AUTO',
      memberPresetIds: [preset.id],
    });
    const attachment = await prisma.attachment.create({
      data: {
        originalName: 'screenshot.png',
        mimeType: 'image/png',
        sizeBytes: 128,
        storagePath: path.join(testDir, 'screenshot.png'),
        hash: 'attachment-context-hash',
      },
    });

    const message = await service.createRoomMessage(teamRun.id, {
      content: 'Please inspect this UI',
      mentions: [{ memberId: teamRun.members![0]!.id, label: 'Coder' }],
      attachmentIds: [attachment.id],
    });
    const request = await prisma.workRequest.findUnique({
      where: { id: message.workRequestIds![0]! },
    });

    expect(request?.instruction).toBe('Please inspect this UI');
  });

  it('does not duplicate WorkRequest attachment context when content already includes the storage path', async () => {
    const preset = await service.createMemberPreset(presetInput('Coder'));
    const task = await createTask();
    const teamRun = await service.createTeamRun(task.id, {
      mode: 'AUTO',
      memberPresetIds: [preset.id],
    });
    const attachment = await prisma.attachment.create({
      data: {
        originalName: 'screenshot.png',
        mimeType: 'image/png',
        sizeBytes: 128,
        storagePath: path.join(testDir, 'screenshot-dedup.png'),
        hash: 'attachment-context-dedup-hash',
      },
    });
    const content = `Please inspect this UI\n\n![screenshot.png](${attachment.storagePath})`;

    const message = await service.createRoomMessage(teamRun.id, {
      content,
      mentions: [{ memberId: teamRun.members![0]!.id, label: 'Coder' }],
      attachmentIds: [attachment.id],
    });
    const request = await prisma.workRequest.findUnique({
      where: { id: message.workRequestIds![0]! },
    });

    expect(request?.instruction).toBe(content);
    expect(request?.instruction).not.toContain('Attachments:');
  });

  it('returns a clear conflict when creating a second TeamRun for one Task', async () => {
    const preset = await service.createMemberPreset(presetInput('Coder'));
    const task = await createTask();
    const input = {
      mode: 'AUTO' as const,
      memberPresetIds: [preset.id],
    };

    await service.createTeamRun(task.id, input);

    await expect(service.createTeamRun(task.id, input)).rejects.toMatchObject({
      code: 'CONFLICT',
      statusCode: 409,
    });
  });
});
