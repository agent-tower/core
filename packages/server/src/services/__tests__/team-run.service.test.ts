import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { CreateMemberPresetInput } from '../team-run.service.js';

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-team-run-'));
const dbPath = path.join(testDir, 'test.db');
process.env.AGENT_TOWER_DATABASE_URL = `file:${dbPath}`;

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
    avatar: null,
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
    service = new TeamRunService();
    await prisma.agentInvocation.deleteMany();
    await prisma.workRequest.deleteMany();
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

  it('queues WorkRequests in AUTO mode and preserves senderInvocationId', async () => {
    const preset = await service.createMemberPreset(presetInput('Reviewer'));
    const task = await createTask();
    const teamRun = await service.createTeamRun(task.id, {
      mode: 'AUTO',
      memberPresetIds: [preset.id],
    });
    const member = teamRun.members?.[0];
    expect(member).toBeDefined();

    const message = await service.createRoomMessage(teamRun.id, {
      content: 'Review this change',
      mentions: [{ memberId: member!.id }],
      senderType: 'agent',
      senderId: member!.id,
      senderInvocationId: 'invocation-1',
    });
    const requests = await service.listWorkRequests(teamRun.id);

    expect(message.senderInvocationId).toBe('invocation-1');
    expect(requests[0]).toMatchObject({
      requesterType: 'agent',
      requesterMemberId: member!.id,
      status: 'QUEUED',
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
