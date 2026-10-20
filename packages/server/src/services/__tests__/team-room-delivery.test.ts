import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildTaskUserText, taskInputHash, type TaskInputAcceptanceToken } from '../team-task-input.js';
import type { TeamUserDeliveryIntent } from '../team-room-delivery.js';
import type { TeamRunService } from '../team-run.service.js';
import type { MessageDeliveryService } from '../message-delivery.service.js';
import type { TranslationService } from '../translation.service.js';
import type { TranslationSettingsService } from '../translation-settings.service.js';
import type { TranslationClient } from '../translation-client.js';
import type { SessionManager } from '../session-manager.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-room-delivery-'));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
process.env.AGENT_TOWER_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
process.env.AGENT_TOWER_DATA_DIR = dir;
const runtime = vi.hoisted(() => ({ start: vi.fn(), sendMessage: vi.fn(), setMessageDeliveryService: vi.fn(), getEventBus: vi.fn(), getTranslationService: vi.fn() }));
vi.mock('../../core/container.js', () => ({ getEventBus: runtime.getEventBus, getSessionManager: () => runtime, getTranslationService: runtime.getTranslationService }));

let db: PrismaClient;
let service: TeamRunService;
let settings: TranslationSettingsService;
let translation: TranslationService;
let delivery: MessageDeliveryService;
type WriteFault = { model: string; action: string; occurrence: number; seen: number; fired: boolean };
let fault: WriteFault | undefined;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

async function addMember(teamRunId: string, name: string) {
  return db.teamMember.create({ data: { teamRunId, name, aliases: '[]', providerId: 'never-executed', rolePrompt: 'Fixture only', capabilities: '{}', workspacePolicy: 'shared', triggerPolicy: 'USER_MESSAGES' } });
}

async function fixture(options: { mode?: 'AUTO' | 'CONFIRM'; state?: 'PENDING' | 'ACCEPTED'; recipients?: number } = {}) {
  const project = await db.project.create({ data: { name: 'Isolated publication', repoPath: dir } });
  const task = await db.task.create({ data: { projectId: project.id, title: '完整原始任务标题', description: '  Full task description\nincluding exact whitespace.  ' } });
  const team = await db.teamRun.create({ data: { taskId: task.id, mode: options.mode ?? 'CONFIRM' } });
  const members = await Promise.all([addMember(team.id, 'First'), addMember(team.id, 'Second')]);
  const taskSourceHash = taskInputHash(task.title, task.description);
  const state = options.state ?? 'ACCEPTED';
  const effectiveUserText = buildTaskUserText(task.title, task.description);
  const snapshot = await db.teamTaskInputSnapshot.create({ data: {
    teamRunId: team.id, taskId: task.id, taskSourceHash, originalTitle: task.title, originalDescription: task.description,
    state, ...(state === 'ACCEPTED' ? { effectiveUserText, sentMode: 'ORIGINAL', acceptedAt: new Date() } : {}),
  } });
  const intent: TeamUserDeliveryIntent = { version: 1, taskSourceHash, kind: 'work_request', mentions: [], artifactRefs: ['artifact:fixture'], resolvedRecipients: members.slice(0, options.recipients ?? 2).map((member, index) => ({ memberId: member.id, ifBusy: index ? 'cancel_current_and_start' : 'queue', cancelQueued: !!index, target: null, targetSourceMemberId: null })) };
  const row = await db.messageDelivery.create({ data: {
    clientSubmissionId: randomUUID(), requestFingerprint: hash(randomUUID()), taskId: task.id, teamRunId: team.id,
    channelKey: `task:${task.id}:team-room`, sequence: 1, origin: 'TEAM_USER', originalText: '原始跟进正文', sourceHash: hash('原始跟进正文'),
    attachmentIds: '[]', intent: JSON.stringify(intent), enableEpoch: 0, requiresTranslation: false, state: 'READY', sentMode: 'ORIGINAL', acceptedText: '原始跟进正文',
  } });
  const taskInput: TaskInputAcceptanceToken = { snapshotId: snapshot.id, revision: snapshot.revision, taskSourceHash, effectiveUserText, sentMode: 'ORIGINAL', acceptedAttemptId: null };
  const envelope = { deliveryId: row.id, expectedRevision: row.revision, enableEpoch: row.enableEpoch, acceptedText: row.acceptedText!, taskInput };
  return { project, task, team, members, snapshot, row, envelope, intent };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const publish = (f: Fixture) => db.$transaction(tx => service.publishAcceptedUserDelivery(tx, f.envelope));
async function translatedTaskInput(f: Fixture) {
  await db.translationSettings.update({ where: { id: 'singleton' }, data: { enabled: true, apiBaseUrl: 'http://fixture.invalid/v1', model: 'fixture', apiKey: '' } });
  const original = buildTaskUserText(f.task.title, f.task.description);
  const source = await db.translationSource.create({ data: { scopeType: 'TEAM_RUN', scopeId: f.team.id, sourceKind: 'TASK_INPUT', sourceKey: JSON.stringify([f.team.id, f.envelope.taskInput.taskSourceHash]), laneKey: `team:${f.team.id}`, direction: 'SEND', originalText: original, sourceHash: hash(original), blockState: 'SEALED', jobState: 'SUCCESS', currentAttemptVersion: 1, generation: 1, enableEpoch: 0 } });
  const attempt = await db.translationAttempt.create({ data: { sourceId: source.id, sourceRevision: source.sourceRevision, sourceHash: source.sourceHash, attemptVersion: 1, configRevision: 0, credentialRevision: 0, targetLanguage: 'English', sanitizedConfigSnapshot: '{}', protectionVersion: 'fixture', status: 'SUCCESS', resultText: 'Accepted translated complete task input', generation: 1, enableEpoch: 0, completedAt: new Date() } });
  await db.translationSource.update({ where: { id: source.id }, data: { effectiveAttemptId: attempt.id } });
  await db.teamTaskInputSnapshot.update({ where: { id: f.snapshot.id }, data: { translationSourceId: source.id } });
  f.envelope.taskInput = { ...f.envelope.taskInput, effectiveUserText: attempt.resultText!, sentMode: 'TRANSLATED', acceptedAttemptId: attempt.id };
  return { source, attempt };
}
async function unchanged(f: Fixture) {
  expect(await db.roomMessage.count({ where: { deliveryId: f.row.id } })).toBe(0);
  expect(await db.deliveryReceipt.count({ where: { deliveryId: f.row.id } })).toBe(0);
  expect(await db.workRequest.count({ where: { teamRunId: f.team.id } })).toBe(0);
  expect(await db.messageDelivery.findUniqueOrThrow({ where: { id: f.row.id } })).toEqual(f.row);
  expect(await db.teamTaskInputSnapshot.findUniqueOrThrow({ where: { id: f.snapshot.id } })).toEqual(f.snapshot);
  expect((await db.teamRun.findUniqueOrThrow({ where: { id: f.team.id } })).currentTaskInputSnapshotId).toBeNull();
}

describe('isolated atomic TeamRun publication foundation', () => {
  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--schema=prisma/schema.prisma'], { cwd: root, env: process.env, stdio: 'pipe' });
    const utils = await import('../../utils/index.js');
    db = utils.prisma;
    await utils.initializeDatabaseRuntime();
    db.$use(async (params, next) => {
      const result = await next(params);
      if (fault && params.model === fault.model && params.action === fault.action && ++fault.seen === fault.occurrence) {
        fault.fired = true;
        throw new Error(`injected after ${fault.model}.${fault.action} #${fault.occurrence}`);
      }
      return result;
    });
  }, 30_000);
  beforeEach(async () => {
    fault = undefined;
    await db.messageDelivery.deleteMany();
    await db.translationSource.deleteMany();
    await db.project.deleteMany();
    await db.translationSettings.deleteMany();
    vi.clearAllMocks();
    const { TeamRunService: Service } = await import('../team-run.service.js');
    const { TranslationSettingsService: Settings } = await import('../translation-settings.service.js');
    const { TranslationService: Translation } = await import('../translation.service.js');
    const { MessageDeliveryService: Delivery } = await import('../message-delivery.service.js');
    service = new Service(); settings = new Settings(db); translation = new Translation(db, settings);
    delivery = new Delivery(db, settings, translation, runtime as unknown as SessionManager, { tickMs: 100_000 });
    await settings.getPublic();
  });
  afterEach(async () => { fault = undefined; await delivery.shutdown(); await translation.shutdown(); });
  afterAll(async () => { await db.$disconnect(); fs.rmSync(dir, { recursive: true, force: true }); });

  it.each(['AUTO', 'CONFIRM'] as const)('publishes all frozen recipients in %s and preserves originals', async mode => {
    const f = await fixture({ mode });
    await addMember(f.team.id, 'Joined after acceptance');
    await db.teamMember.updateMany({ where: { id: { in: f.members.map(m => m.id) } }, data: { triggerPolicy: 'MENTION_ONLY' } });
    const result = await publish(f);
    const message = await db.roomMessage.findUniqueOrThrow({ where: { id: result.messageId } });
    const requests = await db.workRequest.findMany({ where: { triggerMessageId: message.id }, orderBy: { targetMemberId: 'asc' } });
    expect(requests.map(r => r.targetMemberId)).toEqual(f.members.map(m => m.id).sort());
    expect(requests.every(r => r.status === (mode === 'CONFIRM' ? 'PENDING_APPROVAL' : 'QUEUED') && r.taskInputSnapshotId === f.snapshot.id)).toBe(true);
    expect(requests.map(r => [r.targetMemberId, r.ifBusy, r.cancelQueued]).sort()).toEqual(f.intent.resolvedRecipients.map(r => [r.memberId, r.ifBusy, r.cancelQueued]).sort());
    const sent = await db.messageDelivery.findUniqueOrThrow({ where: { id: f.row.id } });
    const receipt = await db.deliveryReceipt.findUniqueOrThrow({ where: { deliveryId: f.row.id } });
    expect(sent).toMatchObject({ state: 'SENT', revision: 2, acceptedDestinationId: message.id, actualSentText: f.row.acceptedText, taskInputSnapshotId: f.snapshot.id });
    expect(receipt).toMatchObject({ phase: 'SUBMITTED', evidence: 'ROOM_PUBLISHED', generation: sent.revision, runtimeInstanceId: null, turnId: null, submittedAt: sent.sentAt });
    expect(message).toMatchObject({ deliveryId: f.row.id, content: f.row.acceptedText, senderType: 'user', senderId: null, senderInvocationId: null, visibility: 'PUBLIC', translationEligibilityEpoch: null });
    expect(await db.roomMessageParticipant.count()).toBe(0);
    expect(await db.task.findUniqueOrThrow({ where: { id: f.task.id } })).toEqual(f.task);
    expect(runtime.start).not.toHaveBeenCalled(); expect(runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('atomically adopts a PENDING original snapshot and keeps a zero-recipient publication empty', async () => {
    const f = await fixture({ state: 'PENDING', recipients: 0 });
    await addMember(f.team.id, 'Would receive an unfrozen broadcast');
    const result = await publish(f);
    expect(result.workRequestIds).toEqual([]);
    expect(await db.workRequest.count()).toBe(0);
    expect(await db.teamTaskInputSnapshot.findUniqueOrThrow({ where: { id: f.snapshot.id } })).toMatchObject({ state: 'ACCEPTED', revision: 2, effectiveUserText: f.envelope.taskInput.effectiveUserText, sentMode: 'ORIGINAL', acceptedAttemptId: null, acceptedAt: expect.any(Date) });
    expect((await db.teamRun.findUniqueOrThrow({ where: { id: f.team.id } })).currentTaskInputSnapshotId).toBe(f.snapshot.id);
  });

  it('publishes the normalized target and retains its frozen owner after ownership changes', async () => {
    const f = await fixture();
    const source = await db.workspace.create({ data: { taskId: f.task.id, ownerMemberId: f.members[0]!.id, branchName: 'source', worktreePath: path.join(dir, 'target-fixture') } });
    f.intent.resolvedRecipients[1]!.target = { kind: 'WORKSPACE_COMMIT', purpose: 'REVIEW', sourceWorkspaceId: source.id, headSha: ` ${'a'.repeat(40)} `, branchName: ' source ', planItemId: ' plan-1 ' };
    f.intent.resolvedRecipients[1]!.targetSourceMemberId = f.members[0]!.id;
    await db.messageDelivery.update({ where: { id: f.row.id }, data: { intent: JSON.stringify(f.intent) } });
    const result = await publish(f);
    expect(await db.workRequest.findFirstOrThrow({ where: { triggerMessageId: result.messageId, targetMemberId: f.members[1]!.id } })).toMatchObject({ targetKind: 'WORKSPACE_COMMIT', targetPurpose: 'REVIEW', targetSourceWorkspaceId: source.id, targetSourceMemberId: f.members[0]!.id, targetHeadSha: 'a'.repeat(40), targetBranchName: 'source', targetPlanItemId: 'plan-1' });
    await db.workspace.update({ where: { id: source.id }, data: { ownerMemberId: f.members[1]!.id } });
    expect(await publish(f)).toEqual(result);
  });

  it('adopts a PENDING translated snapshot from exact current source evidence and preserves accepted history', async () => {
    const f = await fixture({ state: 'PENDING' }); const evidence = await translatedTaskInput(f);
    const result = await publish(f);
    expect(await db.teamTaskInputSnapshot.findUniqueOrThrow({ where: { id: f.snapshot.id } })).toMatchObject({ state: 'ACCEPTED', revision: 2, effectiveUserText: evidence.attempt.resultText, sentMode: 'TRANSLATED', acceptedAttemptId: evidence.attempt.id });
    // Current config/source advancement does not invalidate the immutable accepted attempt.
    await db.translationSettings.update({ where: { id: 'singleton' }, data: { enabled: false, enableEpoch: 1 } });
    await db.translationSource.update({ where: { id: evidence.source.id }, data: { generation: 9, sourceRevision: 8, enableEpoch: 1, currentAttemptVersion: 2, effectiveAttemptId: null, jobState: 'SUPERSEDED' } });
    expect(await publish(f)).toEqual(result);
  });

  it.each(['source-key', 'source-scope', 'source-lane', 'source-kind', 'source-text', 'source-hash', 'source-open', 'source-deleted', 'source-not-success', 'effective-attempt', 'attempt-hash', 'attempt-revision', 'attempt-version', 'attempt-generation', 'source-epoch', 'attempt-epoch', 'config-disabled', 'result-text', 'attempt-status'] as const)('rejects PENDING translated evidence with stale or foreign %s', async invalid => {
    const f = await fixture({ state: 'PENDING' }); const { source, attempt } = await translatedTaskInput(f);
    if (invalid === 'source-key') await db.translationSource.update({ where: { id: source.id }, data: { sourceKey: JSON.stringify([f.team.id, 'other-input']) } });
    else if (invalid === 'source-scope') await db.translationSource.update({ where: { id: source.id }, data: { scopeId: 'another-team' } });
    else if (invalid === 'source-lane') await db.translationSource.update({ where: { id: source.id }, data: { laneKey: 'team:another-team' } });
    else if (invalid === 'source-kind') await db.translationSource.update({ where: { id: source.id }, data: { sourceKind: 'ROOM_MESSAGE' } });
    else if (invalid === 'source-text') await db.translationSource.update({ where: { id: source.id }, data: { originalText: 'Another original' } });
    else if (invalid === 'source-hash') {
      await db.translationSource.update({ where: { id: source.id }, data: { sourceHash: hash('Another original') } });
      await db.translationAttempt.update({ where: { id: attempt.id }, data: { sourceHash: hash('Another original') } });
    } else if (invalid === 'source-open') await db.translationSource.update({ where: { id: source.id }, data: { blockState: 'OPEN' } });
    else if (invalid === 'source-deleted') await db.translationSource.update({ where: { id: source.id }, data: { deletedAt: new Date() } });
    else if (invalid === 'source-not-success') await db.translationSource.update({ where: { id: source.id }, data: { jobState: 'FAILED' } });
    else if (invalid === 'effective-attempt') await db.translationSource.update({ where: { id: source.id }, data: { effectiveAttemptId: null } });
    else if (invalid === 'attempt-hash') await db.translationAttempt.update({ where: { id: attempt.id }, data: { sourceHash: 'wrong-hash' } });
    else if (invalid === 'attempt-revision') await db.translationAttempt.update({ where: { id: attempt.id }, data: { sourceRevision: 7 } });
    else if (invalid === 'attempt-version') await db.translationAttempt.update({ where: { id: attempt.id }, data: { attemptVersion: 7 } });
    else if (invalid === 'attempt-generation') await db.translationAttempt.update({ where: { id: attempt.id }, data: { generation: 7 } });
    else if (invalid === 'source-epoch') await db.translationSource.update({ where: { id: source.id }, data: { enableEpoch: 7 } });
    else if (invalid === 'attempt-epoch') await db.translationAttempt.update({ where: { id: attempt.id }, data: { enableEpoch: 7 } });
    else if (invalid === 'config-disabled') await db.translationSettings.update({ where: { id: 'singleton' }, data: { enabled: false } });
    else if (invalid === 'result-text') await db.translationAttempt.update({ where: { id: attempt.id }, data: { resultText: 'Unaccepted text' } });
    else await db.translationAttempt.update({ where: { id: attempt.id }, data: { status: 'FAILED' } });
    const before = await db.teamTaskInputSnapshot.findUniqueOrThrow({ where: { id: f.snapshot.id } });
    await expect(publish(f)).rejects.toMatchObject({ code: 'TASK_INPUT_CHANGED' });
    expect(await db.teamTaskInputSnapshot.findUniqueOrThrow({ where: { id: f.snapshot.id } })).toEqual(before);
    expect(await db.roomMessage.count()).toBe(0); expect(await db.workRequest.count()).toBe(0); expect(await db.deliveryReceipt.count()).toBe(0);
    expect((await db.teamRun.findUniqueOrThrow({ where: { id: f.team.id } })).currentTaskInputSnapshotId).toBeNull();
  });

  it.each([
    ['TeamTaskInputSnapshot', 'updateMany', 1], ['TeamRun', 'update', 1], ['RoomMessage', 'create', 1],
    ['WorkRequest', 'create', 1], ['WorkRequest', 'create', 2], ['RoomMessage', 'update', 1],
    ['DeliveryReceipt', 'create', 1], ['MessageDelivery', 'updateMany', 1],
  ] as const)('rolls back every publication fact after %s.%s #%i fails', async (model, action, occurrence) => {
    const f = await fixture({ state: 'PENDING' });
    fault = { model, action, occurrence, seen: 0, fired: false };
    await expect(publish(f)).rejects.toThrow('injected after');
    expect(fault.fired).toBe(true); fault = undefined;
    await unchanged(f);
    await publish(f);
    expect(await db.workRequest.count({ where: { teamRunId: f.team.id } })).toBe(2);
  });

  it('recovers a committed receipt after a lost response and later task/member changes without replay', async () => {
    const f = await fixture();
    const result = await publish(f); // Treat the successful response as lost by the caller.
    await db.task.update({ where: { id: f.task.id }, data: { title: 'Edited after publication' } });
    await db.teamMember.updateMany({ where: { teamRunId: f.team.id }, data: { membershipStatus: 'REMOVED' } });
    await db.workRequest.updateMany({ where: { triggerMessageId: result.messageId }, data: { status: 'COMPLETED' } });
    expect(await publish(f)).toEqual(result);
    await delivery.start(); await delivery.pump();
    expect(await db.roomMessage.count({ where: { deliveryId: f.row.id } })).toBe(1);
    expect(await db.workRequest.count({ where: { teamRunId: f.team.id } })).toBe(2);
    expect((await db.deliveryReceipt.findUniqueOrThrow({ where: { deliveryId: f.row.id } })).evidence).toBe('ROOM_PUBLISHED');
  });

  it.each(['extra-request', 'missing-request', 'receipt-evidence', 'receipt-generation', 'receipt-runtime', 'message-body', 'message-request-ids', 'participant', 'target-source-owner', 'snapshot-text', 'snapshot-mode', 'snapshot-original-hash'] as const)('fails closed when recovery detects %s', async corrupt => {
    const f = await fixture();
    if (corrupt === 'target-source-owner') {
      const source = await db.workspace.create({ data: { taskId: f.task.id, ownerMemberId: f.members[0]!.id, branchName: 'source', worktreePath: path.join(dir, 'tampered-target-fixture') } });
      f.intent.resolvedRecipients[0]!.target = { kind: 'WORKSPACE_COMMIT', purpose: 'REVIEW', sourceWorkspaceId: source.id, headSha: 'a'.repeat(40), branchName: 'source' };
      f.intent.resolvedRecipients[0]!.targetSourceMemberId = f.members[0]!.id;
      await db.messageDelivery.update({ where: { id: f.row.id }, data: { intent: JSON.stringify(f.intent) } });
    }
    const result = await publish(f);
    const requests = await db.workRequest.findMany({ where: { triggerMessageId: result.messageId } });
    if (corrupt === 'extra-request') {
      const { id: _id, createdAt: _created, updatedAt: _updated, ...data } = requests[0]!;
      await db.workRequest.create({ data });
    } else if (corrupt === 'missing-request') await db.workRequest.delete({ where: { id: requests[0]!.id } });
    else if (corrupt === 'receipt-evidence') await db.deliveryReceipt.update({ where: { deliveryId: f.row.id }, data: { evidence: 'CLI_WRITE' } });
    else if (corrupt === 'receipt-generation') await db.deliveryReceipt.update({ where: { deliveryId: f.row.id }, data: { generation: 99 } });
    else if (corrupt === 'receipt-runtime') await db.deliveryReceipt.update({ where: { deliveryId: f.row.id }, data: { runtimeInstanceId: 'unexpected' } });
    else if (corrupt === 'message-body') await db.roomMessage.update({ where: { id: result.messageId }, data: { content: 'Corrupted body' } });
    else if (corrupt === 'message-request-ids') await db.roomMessage.update({ where: { id: result.messageId }, data: { workRequestIds: JSON.stringify([requests[0]!.id, requests[0]!.id]) } });
    else if (corrupt === 'participant') await db.roomMessageParticipant.create({ data: { teamRunId: f.team.id, roomMessageId: result.messageId, memberId: f.members[0]!.id, role: 'recipient' } });
    else if (corrupt === 'target-source-owner') await db.workRequest.update({ where: { id: requests.find(r => r.targetMemberId === f.members[0]!.id)!.id }, data: { targetSourceMemberId: f.members[1]!.id } });
    else if (corrupt === 'snapshot-text') await db.teamTaskInputSnapshot.update({ where: { id: f.snapshot.id }, data: { effectiveUserText: 'Corrupted accepted text' } });
    else if (corrupt === 'snapshot-mode') await db.teamTaskInputSnapshot.update({ where: { id: f.snapshot.id }, data: { sentMode: null } });
    else await db.teamTaskInputSnapshot.update({ where: { id: f.snapshot.id }, data: { originalTitle: 'Corrupted saved original' } });
    const counts = [await db.roomMessage.count(), await db.workRequest.count(), await db.deliveryReceipt.count()];
    await expect(publish(f)).rejects.toMatchObject({ code: 'ROOM_DELIVERY_INTEGRITY' });
    await expect(delivery.start()).rejects.toMatchObject({ code: 'ROOM_DELIVERY_INTEGRITY' });
    expect([await db.roomMessage.count(), await db.workRequest.count(), await db.deliveryReceipt.count()]).toEqual(counts);
  });

  it.each(['revision', 'accepted-text', 'envelope-epoch', 'current-epoch', 'task-hash', 'snapshot-revision', 'snapshot-original', 'removed-member', 'foreign-target', 'target-owner', 'predecessor', 'deleted-task', 'archived-project'] as const)('rejects stale or unavailable %s before publication', async invalid => {
    const f = await fixture({ state: 'PENDING' });
    if (invalid === 'revision') f.envelope.expectedRevision++;
    else if (invalid === 'accepted-text') f.envelope.acceptedText = 'Not accepted';
    else if (invalid === 'envelope-epoch') f.envelope.enableEpoch++;
    else if (invalid === 'current-epoch') await db.translationSettings.update({ where: { id: 'singleton' }, data: { enableEpoch: 1 } });
    else if (invalid === 'task-hash') await db.task.update({ where: { id: f.task.id }, data: { description: 'Changed input' } });
    else if (invalid === 'snapshot-revision') f.envelope.taskInput.revision++;
    else if (invalid === 'snapshot-original') await db.teamTaskInputSnapshot.update({ where: { id: f.snapshot.id }, data: { originalTitle: 'Wrong original' } });
    else if (invalid === 'removed-member') await db.teamMember.update({ where: { id: f.members[1]!.id }, data: { membershipStatus: 'REMOVED' } });
    else if (invalid === 'foreign-target') {
      f.intent.resolvedRecipients[1]!.target = { kind: 'WORKSPACE_COMMIT', purpose: 'REVIEW', sourceWorkspaceId: 'not-in-this-team', headSha: 'a'.repeat(40), branchName: 'feature' };
      await db.messageDelivery.update({ where: { id: f.row.id }, data: { intent: JSON.stringify(f.intent) } });
    } else if (invalid === 'target-owner') {
      const source = await db.workspace.create({ data: { taskId: f.task.id, ownerMemberId: f.members[0]!.id, branchName: 'source', worktreePath: path.join(dir, 'changed-owner-fixture') } });
      f.intent.resolvedRecipients[1]!.target = { kind: 'WORKSPACE_COMMIT', purpose: 'TEST', sourceWorkspaceId: source.id, headSha: 'a'.repeat(40), branchName: 'source' };
      f.intent.resolvedRecipients[1]!.targetSourceMemberId = f.members[1]!.id;
      await db.messageDelivery.update({ where: { id: f.row.id }, data: { intent: JSON.stringify(f.intent) } });
    } else if (invalid === 'predecessor') {
      await db.messageDelivery.update({ where: { id: f.row.id }, data: { sequence: 2 } });
      const { id: _id, createdAt: _created, updatedAt: _updated, ...data } = f.row;
      await db.messageDelivery.create({ data: { ...data, clientSubmissionId: randomUUID(), sequence: 1, state: 'DELIVERY_UNKNOWN' } });
    } else if (invalid === 'deleted-task') await db.task.update({ where: { id: f.task.id }, data: { deletedAt: new Date() } });
    else await db.project.update({ where: { id: f.project.id }, data: { archivedAt: new Date() } });
    const snapshotBefore = await db.teamTaskInputSnapshot.findUniqueOrThrow({ where: { id: f.snapshot.id } });
    await expect(publish(f)).rejects.toMatchObject({ statusCode: expect.any(Number) });
    expect(await db.roomMessage.count()).toBe(0); expect(await db.workRequest.count()).toBe(0); expect(await db.deliveryReceipt.count()).toBe(0);
    expect(await db.teamTaskInputSnapshot.findUniqueOrThrow({ where: { id: f.snapshot.id } })).toEqual(snapshotBefore);
    expect((await db.teamRun.findUniqueOrThrow({ where: { id: f.team.id } })).currentTaskInputSnapshotId).toBeNull();
    expect((await db.messageDelivery.findUniqueOrThrow({ where: { id: f.row.id } })).state).toBe('READY');
  });

  it('concurrent attempts and their retries produce one complete publication', async () => {
    const f = await fixture();
    await db.$queryRawUnsafe('PRAGMA busy_timeout = 100');
    try {
      const attempts = await Promise.allSettled([publish(f), publish(f)]);
      for (const result of attempts) if (result.status === 'rejected') expect(['P1008', 'P2028', 'P2034', 'P2002']).toContain((result.reason as { code?: string }).code);
      expect(attempts.some(result => result.status === 'fulfilled')).toBe(true);
      const first = await publish(f); const second = await publish(f);
      expect(second).toEqual(first);
      expect(await db.roomMessage.count({ where: { deliveryId: f.row.id } })).toBe(1);
      expect(await db.workRequest.count({ where: { triggerMessageId: first.messageId } })).toBe(2);
      expect(await db.deliveryReceipt.count({ where: { deliveryId: f.row.id } })).toBe(1);
    } finally { await db.$queryRawUnsafe('PRAGMA busy_timeout = 5000'); }
  }, 15_000);

  it.each([1, 2])('holds newer original input U until all %i queued consumers of pending T are cancelled', async consumers => {
    const f = await fixture({ mode: 'AUTO', state: 'PENDING' });
    await db.messageDelivery.delete({ where: { id: f.row.id } });
    const pendingT = f.snapshot;
    const trigger = await db.roomMessage.create({ data: { teamRunId: f.team.id, senderType: 'user', kind: 'work_request', visibility: 'PUBLIC', content: buildTaskUserText(f.task.title, f.task.description), mentions: '[]', workRequestIds: '[]' } });
    const earlier = [];
    for (const member of f.members.slice(0, consumers)) earlier.push(await db.workRequest.create({ data: { teamRunId: f.team.id, requesterType: 'user', targetMemberId: member.id, triggerMessageId: trigger.id, instruction: 'Earlier input T waits for a decision', status: 'QUEUED', taskInputSnapshotId: pendingT.id, createdAt: new Date(Date.now() - 1000) } }));
    await db.roomMessage.update({ where: { id: trigger.id }, data: { workRequestIds: JSON.stringify(earlier.map(w => w.id)) } });
    f.task = await db.task.update({ where: { id: f.task.id }, data: { title: 'Newer original task U', description: 'U must wait while a consumer still requires pending T' } });
    const taskSourceHash = taskInputHash(f.task.title, f.task.description);
    f.snapshot = await db.teamTaskInputSnapshot.create({ data: { teamRunId: f.team.id, taskId: f.task.id, taskSourceHash, originalTitle: f.task.title, originalDescription: f.task.description, state: 'PENDING' } });
    f.intent.taskSourceHash = taskSourceHash;
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...deliveryData } = f.row;
    f.row = await db.messageDelivery.create({ data: { ...deliveryData, clientSubmissionId: randomUUID(), intent: JSON.stringify(f.intent) } });
    f.envelope = { deliveryId: f.row.id, expectedRevision: f.row.revision, enableEpoch: f.row.enableEpoch, acceptedText: f.row.acceptedText!, taskInput: { snapshotId: f.snapshot.id, revision: f.snapshot.revision, taskSourceHash, effectiveUserText: buildTaskUserText(f.task.title, f.task.description), sentMode: 'ORIGINAL', acceptedAttemptId: null } };
    expect((await settings.getPublic()).enabled).toBe(false);
    const assertBlocked = async () => {
      await expect(publish(f)).rejects.toMatchObject({ code: 'TASK_INPUT_PREDECESSOR' });
      expect(await db.roomMessage.count({ where: { deliveryId: f.row.id } })).toBe(0);
      expect(await db.deliveryReceipt.count({ where: { deliveryId: f.row.id } })).toBe(0);
      expect(await db.messageDelivery.findUniqueOrThrow({ where: { id: f.row.id } })).toEqual(f.row);
      expect(await db.teamTaskInputSnapshot.findUniqueOrThrow({ where: { id: f.snapshot.id } })).toEqual(f.snapshot);
      expect(await db.teamTaskInputSnapshot.findUniqueOrThrow({ where: { id: pendingT.id } })).toEqual(pendingT);
      expect((await db.teamRun.findUniqueOrThrow({ where: { id: f.team.id } })).currentTaskInputSnapshotId).toBeNull();
      expect(await db.workRequest.count({ where: { teamRunId: f.team.id } })).toBe(consumers);
    };
    await assertBlocked();
    for (const [index, request] of earlier.entries()) {
      await db.workRequest.update({ where: { id: request.id }, data: { status: 'CANCELLED' } });
      if (index < earlier.length - 1) await assertBlocked();
    }
    const result = await publish(f);
    expect(await db.roomMessage.count({ where: { deliveryId: f.row.id } })).toBe(1);
    expect(result.workRequestIds).toHaveLength(2);
    expect(await db.teamTaskInputSnapshot.findUniqueOrThrow({ where: { id: f.snapshot.id } })).toMatchObject({ state: 'ACCEPTED', sentMode: 'ORIGINAL', effectiveUserText: f.envelope.taskInput.effectiveUserText });
    expect(await db.teamTaskInputSnapshot.findUniqueOrThrow({ where: { id: pendingT.id } })).toEqual(pendingT);
    expect((await db.teamRun.findUniqueOrThrow({ where: { id: f.team.id } })).currentTaskInputSnapshotId).toBe(f.snapshot.id);
  });

  it.each(['TEAM_INITIAL'] as const)('malformed legacy %s intent cannot enter the enabled creation adapter', async origin => {
    const f = await fixture();
    await db.messageDelivery.update({ where: { id: f.row.id }, data: { origin, state: 'WAITING_TRANSLATION', requiresTranslation: true } });
    const before = await db.messageDelivery.findUniqueOrThrow({ where: { id: f.row.id } });
    await delivery.start(); await delivery.pump();
    await expect(delivery.get(f.row.id)).rejects.toMatchObject({ code: 'ROOM_DELIVERY_INTEGRITY' });
    await expect(delivery.action(f.row.id, 'send_original', before.revision, randomUUID())).rejects.toMatchObject({ code: 'ROOM_DELIVERY_INTEGRITY' });
    await expect(delivery.claim(f.row.id, before.revision)).rejects.toMatchObject({ code: 'DELIVERY_DESTINATION_DISABLED' });
    await expect(translation.registerSource({ kind: 'USER_DELIVERY', deliveryId: f.row.id })).rejects.toMatchObject({ code: 'ROOM_DELIVERY_INTEGRITY' });
    expect(await db.messageDelivery.findUniqueOrThrow({ where: { id: f.row.id } })).toEqual(before);
    expect(await db.translationSource.count()).toBe(0); expect(await db.deliveryAction.count()).toBe(0);
    expect(await db.roomMessage.count()).toBe(0); expect(await db.workRequest.count()).toBe(0);
    expect(runtime.start).not.toHaveBeenCalled(); expect(runtime.sendMessage).not.toHaveBeenCalled();
  });

  it.each(['TASK_INPUT', 'unknown-adapter'])('rejects runtime adapter injection for %s before looking up a valid room message', async kind => {
    const f = await fixture();
    const message = await db.roomMessage.create({ data: { teamRunId: f.team.id, senderType: 'agent', senderId: f.members[0]!.id, kind: 'chat', visibility: 'PUBLIC', content: 'Eligible PUBLIC agent message', translationEligibilityEpoch: 0, mentions: '[]' } });
    const injected = { kind, messageId: message.id } as unknown as Parameters<TranslationService['registerSource']>[0];
    await expect(translation.registerSource(injected)).rejects.toMatchObject({ code: 'INELIGIBLE_SOURCE' });
    expect(await db.translationSource.count()).toBe(0);
  });

  // Original independent review counterexamples, retained in the evidence directory.
  async function startupBarrier() {
    const { synchronizeDatabaseSchema } = await import('../../utils/database-schema.js');
    await synchronizeDatabaseSchema({dataDir: dir, dbPath: path.join(dir, 'test.db'), schemaPath:path.join(root, 'prisma/schema.prisma'),entryDir:path.join(root,'src')});
  }

  it('review: rejects reuse of an ACCEPTED snapshot tied to another team source', async () => {
    const f = await fixture({state:'PENDING'});
    const other = await fixture({state:'PENDING'});
    const {source,attempt}=await translatedTaskInput(other);
    await db.teamTaskInputSnapshot.update({where:{id:other.snapshot.id},data:{translationSourceId:null}});
    await db.teamTaskInputSnapshot.update({where:{id:f.snapshot.id},data:{state:'ACCEPTED',translationSourceId:source.id,acceptedAttemptId:attempt.id,sentMode:'TRANSLATED',effectiveUserText:attempt.resultText,acceptedAt:new Date()}});
    f.envelope.taskInput={...f.envelope.taskInput, sentMode:'TRANSLATED',effectiveUserText:attempt.resultText!,acceptedAttemptId:attempt.id};
    f.snapshot = await db.teamTaskInputSnapshot.findUniqueOrThrow({ where: { id: f.snapshot.id } });
    // A valid hash/text does not make another team's translation this snapshot's provenance.
    const result = await publish(f).then(value=>({published:value}),error=>({code:error.code}));
    const startup = await startupBarrier().then(()=>({ok:true}),error=>({error:error.message}));
    console.log('FOREIGN_ACCEPTED_SOURCE',JSON.stringify({result,startup}));
    expect(result).toEqual({code:'TASK_INPUT_CHANGED'});
    await unchanged(f);
    expect(startup).toHaveProperty('error');
  });

  it('review: startup rejects a RoomMessage linked to a SESSION delivery', async () => {
    const f=await fixture();
    await db.messageDelivery.delete({where:{id:f.row.id}});
    const workspace=await db.workspace.create({data:{taskId:f.task.id,branchName:'fixture',worktreePath:dir}});
    const session=await db.session.create({data:{workspaceId:workspace.id,agentType:'CODEX',prompt:'fixture',status:'COMPLETED'}});
    const d=await db.messageDelivery.create({data:{clientSubmissionId:randomUUID(),requestFingerprint:'frozen',sessionId:session.id,channelKey:`session:${session.id}`,sequence:1,origin:'TASK_FOLLOWUP',originalText:'Original',sourceHash:hash('Original'),enableEpoch:0,requiresTranslation:false,state:'READY',sentMode:'ORIGINAL',acceptedText:'Original'}});
    await db.roomMessage.create({data:{deliveryId:d.id,teamRunId:f.team.id,senderType:'agent',senderId:f.members[0].id,kind:'chat',visibility:'PUBLIC',content:'Unrelated agent room message',mentions:'[]'}});
    await expect(startupBarrier()).rejects.toThrow();
  });

  it('review: startup rejects invalid ACCEPTED ORIGINAL snapshot outside delivery history', async () => {
    const f=await fixture();
    await db.messageDelivery.delete({where:{id:f.row.id}});
    await db.teamTaskInputSnapshot.update({where:{id:f.snapshot.id},data:{effectiveUserText:'Not the original task input'}});
    await db.teamRun.update({where:{id:f.team.id},data:{currentTaskInputSnapshotId:f.snapshot.id}});
    await expect(startupBarrier()).rejects.toThrow();
  });

  it('review: receipt recovery tolerates valid WR input rebinding before claim', async () => {
    const f=await fixture({mode:'AUTO'});const result=await publish(f);
    const title='New task title before queued work is claimed';
    await db.task.update({where:{id:f.task.id},data:{title}});
    const next=await db.teamTaskInputSnapshot.create({data:{teamRunId:f.team.id,taskId:f.task.id,taskSourceHash:taskInputHash(title,f.task.description),originalTitle:title,originalDescription:f.task.description,state:'ACCEPTED',sentMode:'ORIGINAL',effectiveUserText:buildTaskUserText(title,f.task.description),acceptedAt:new Date()}});
    await db.workRequest.update({where:{id:result.workRequestIds[0]},data:{taskInputSnapshotId:next.id}});
    const recovery = await publish(f).then(value=>({value}), error=>({code:error.code}));
    const startup = await startupBarrier().then(()=>({ok:true}), error=>({error:error.message}));
    console.log('WR_REBINDING',JSON.stringify({recovery,startup}));
    expect(recovery).toEqual({value:result});
    expect(startup).toEqual({ok:true});
  });

  it.each(['current', 'invocation', 'unreferenced'] as const)('checks independent ORIGINAL acceptance referenced by %s before workers', async reference => {
    const f = await fixture();
    await db.messageDelivery.delete({ where: { id: f.row.id } });
    if (reference === 'current') await db.teamRun.update({ where: { id: f.team.id }, data: { currentTaskInputSnapshotId: f.snapshot.id } });
    if (reference === 'invocation') await db.agentInvocation.create({ data: { teamRunId: f.team.id, memberId: f.members[0].id, workRequestId: 'historical-reference', taskInputSnapshotId: f.snapshot.id, status: 'COMPLETED' } });
    await db.teamTaskInputSnapshot.update({ where: { id: f.snapshot.id }, data: { effectiveUserText: 'Corrupted original acceptance' } });
    await expect(startupBarrier()).rejects.toThrow('Team task input facts are invalid');
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it.each(['source-scope-type', 'source-scope', 'source-kind', 'source-key', 'source-lane', 'source-direction', 'source-anchor', 'source-original', 'source-hash', 'source-open', 'attempt-source', 'attempt-hash', 'attempt-status', 'attempt-result', 'snapshot-hash', 'snapshot-mode'] as const)('publishing and startup reject immutable ACCEPTED evidence corruption: %s', async corrupt => {
    const f = await fixture({ state: 'PENDING' });
    const { source, attempt } = await translatedTaskInput(f);
    await db.teamTaskInputSnapshot.update({ where: { id: f.snapshot.id }, data: { state: 'ACCEPTED', effectiveUserText: attempt.resultText, acceptedAttemptId: attempt.id, sentMode: 'TRANSLATED', acceptedAt: new Date() } });
    if (corrupt === 'source-scope-type') await db.translationSource.update({ where: { id: source.id }, data: { scopeType: 'SESSION' } });
    else if (corrupt === 'source-scope') await db.translationSource.update({ where: { id: source.id }, data: { scopeId: 'other-team' } });
    else if (corrupt === 'source-kind') await db.translationSource.update({ where: { id: source.id }, data: { sourceKind: 'ROOM_MESSAGE' } });
    else if (corrupt === 'source-key') await db.translationSource.update({ where: { id: source.id }, data: { sourceKey: JSON.stringify([f.team.id, 'other-version']) } });
    else if (corrupt === 'source-lane') await db.translationSource.update({ where: { id: source.id }, data: { laneKey: 'team:other-team' } });
    else if (corrupt === 'source-direction') await db.translationSource.update({ where: { id: source.id }, data: { direction: 'DISPLAY' } });
    else if (corrupt === 'source-anchor') await db.translationSource.update({ where: { id: source.id }, data: { messageId: 'another-anchor' } });
    else if (corrupt === 'source-original') await db.translationSource.update({ where: { id: source.id }, data: { originalText: 'Other original' } });
    else if (corrupt === 'source-hash') await db.translationSource.update({ where: { id: source.id }, data: { sourceHash: hash('Other original') } });
    else if (corrupt === 'source-open') await db.translationSource.update({ where: { id: source.id }, data: { blockState: 'OPEN' } });
    else if (corrupt === 'attempt-source') {
      const other = await fixture({ state: 'PENDING' });
      const foreign = await translatedTaskInput(other);
      await db.teamTaskInputSnapshot.update({ where: { id: f.snapshot.id }, data: { acceptedAttemptId: foreign.attempt.id } });
    } else if (corrupt === 'attempt-hash') await db.translationAttempt.update({ where: { id: attempt.id }, data: { sourceHash: hash('Other original') } });
    else if (corrupt === 'attempt-status') await db.translationAttempt.update({ where: { id: attempt.id }, data: { status: 'FAILED' } });
    else if (corrupt === 'attempt-result') await db.translationAttempt.update({ where: { id: attempt.id }, data: { resultText: 'Other result' } });
    else if (corrupt === 'snapshot-hash') await db.teamTaskInputSnapshot.update({ where: { id: f.snapshot.id }, data: { taskSourceHash: 'wrong-hash' } });
    else await db.teamTaskInputSnapshot.update({ where: { id: f.snapshot.id }, data: { sentMode: 'ORIGINAL' } });
    f.snapshot = await db.teamTaskInputSnapshot.findUniqueOrThrow({ where: { id: f.snapshot.id } });
    await expect(publish(f)).rejects.toMatchObject({ code: 'TASK_INPUT_CHANGED' });
    await unchanged(f);
    await expect(startupBarrier()).rejects.toThrow('Team task input facts are invalid');
  });

  it('preserves accepted history across config, source revision/generation and a newer successful attempt', async () => {
    const f = await fixture({ state: 'PENDING' });
    const { source, attempt } = await translatedTaskInput(f);
    const result = await publish(f);
    const later = await db.translationAttempt.create({ data: { sourceId: source.id, sourceRevision: 9, sourceHash: source.sourceHash, attemptVersion: 2, configRevision: 10, credentialRevision: 10, targetLanguage: 'French', sanitizedConfigSnapshot: '{}', protectionVersion: 'fixture', status: 'SUCCESS', resultText: 'A different later translation', generation: 9, enableEpoch: 8 } });
    await db.translationSettings.update({ where: { id: 'singleton' }, data: { enabled: false, revision: 10, credentialRevision: 10, enableEpoch: 8, sendTargetLanguage: 'French' } });
    await db.translationSource.update({ where: { id: source.id }, data: { generation: 9, sourceRevision: 9, currentAttemptVersion: 2, effectiveAttemptId: later.id, enableEpoch: 8, deletedAt: new Date(), jobState: 'SUPERSEDED' } });
    await db.task.update({ where: { id: f.task.id }, data: { title: 'Later task version' } });
    expect(await publish(f)).toEqual(result);
    await startupBarrier();
    expect(await db.teamTaskInputSnapshot.findUniqueOrThrow({ where: { id: f.snapshot.id } })).toMatchObject({ acceptedAttemptId: attempt.id, effectiveUserText: attempt.resultText });
  });

  it.each([['PENDING', 'AUTO'], ['ACCEPTED', 'AUTO'], ['PENDING', 'CONFIRM'], ['ACCEPTED', 'CONFIRM']] as const)('recovers original publication identity while WR follows a new %s input in %s', async (state, mode) => {
    const f = await fixture({ mode }); const result = await publish(f);
    const title = 'Next actual task version';
    await db.task.update({ where: { id: f.task.id }, data: { title, description: null } });
    const next = await db.teamTaskInputSnapshot.create({ data: { teamRunId: f.team.id, taskId: f.task.id, taskSourceHash: taskInputHash(title, null), originalTitle: title, state, ...(state === 'ACCEPTED' ? { sentMode: 'ORIGINAL', effectiveUserText: title, acceptedAt: new Date() } : {}) } });
    await db.workRequest.update({ where: { id: result.workRequestIds[0] }, data: { taskInputSnapshotId: next.id } });
    if (state === 'ACCEPTED' && mode === 'AUTO') {
      const claimed = await db.workRequest.update({ where: { id: result.workRequestIds[0] }, data: { status: 'STARTED' } });
      await db.agentInvocation.create({ data: { teamRunId: f.team.id, workRequestId: claimed.id, memberId: claimed.targetMemberId, taskInputSnapshotId: next.id, status: 'RUNNING' } });
    }
    expect(await publish(f)).toEqual(result);
    await startupBarrier();
    await delivery.start();
    expect((await db.messageDelivery.findUniqueOrThrow({ where: { id: f.row.id } })).taskInputSnapshotId).toBe(f.snapshot.id);
    expect((await db.workRequest.findUniqueOrThrow({ where: { id: result.workRequestIds[0] } })).taskInputSnapshotId).toBe(next.id);
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it.each(['PENDING', 'ACCEPTED'] as const)('keeps a failed invocation on its old input while the requeued WR awaits %s', async state => {
    const f = await fixture({ mode: 'AUTO' }); const result = await publish(f);
    const request = await db.workRequest.findUniqueOrThrow({ where: { id: result.workRequestIds[0] } });
    const failed = await db.agentInvocation.create({ data: { teamRunId: f.team.id, memberId: request.targetMemberId, workRequestId: request.id, taskInputSnapshotId: f.snapshot.id, status: 'FAILED' } });
    await db.task.update({ where: { id: f.task.id }, data: { title: 'Retry after task edit', description: null } });
    const next = await db.teamTaskInputSnapshot.create({ data: { teamRunId: f.team.id, taskId: f.task.id, taskSourceHash: taskInputHash('Retry after task edit', null), originalTitle: 'Retry after task edit', state, ...(state === 'ACCEPTED' ? { sentMode: 'ORIGINAL', effectiveUserText: 'Retry after task edit', acceptedAt: new Date() } : {}) } });
    await db.workRequest.update({ where: { id: request.id }, data: { taskInputSnapshotId: next.id, startAttemptCount: 1 } });
    expect(await publish(f)).toEqual(result);
    await startupBarrier();
    expect((await db.agentInvocation.findUniqueOrThrow({ where: { id: failed.id } })).taskInputSnapshotId).toBe(f.snapshot.id);
  });

  it.each(['null', 'foreign', 'invalid-accepted', 'claimed-pending', 'invocation-mismatch'] as const)('rejects an invalid WR input dependency after publication: %s', async corrupt => {
    const f = await fixture({ mode: 'AUTO' }); const result = await publish(f);
    const requestId = result.workRequestIds[0];
    let dependencyId = f.snapshot.id;
    if (corrupt === 'null') await db.workRequest.update({ where: { id: requestId }, data: { taskInputSnapshotId: null } });
    else if (corrupt === 'foreign') {
      const other = await fixture();
      await db.workRequest.update({ where: { id: requestId }, data: { taskInputSnapshotId: other.snapshot.id } });
    } else if (corrupt === 'invalid-accepted') await db.teamTaskInputSnapshot.update({ where: { id: f.snapshot.id }, data: { effectiveUserText: 'Corrupted acceptance' } });
    else {
      const next = await db.teamTaskInputSnapshot.create({ data: { teamRunId: f.team.id, taskId: f.task.id, taskSourceHash: taskInputHash('Next version', null), originalTitle: 'Next version', ...(corrupt === 'invocation-mismatch' ? { state: 'ACCEPTED', sentMode: 'ORIGINAL', effectiveUserText: 'Next version', acceptedAt: new Date() } : {}) } });
      dependencyId = next.id;
      if (corrupt === 'claimed-pending') await db.workRequest.update({ where: { id: requestId }, data: { status: 'STARTED', taskInputSnapshotId: next.id } });
      await db.agentInvocation.create({ data: { teamRunId: f.team.id, workRequestId: requestId, memberId: (await db.workRequest.findUniqueOrThrow({ where: { id: requestId } })).targetMemberId, taskInputSnapshotId: dependencyId, status: 'RUNNING' } });
    }
    const counts = [await db.roomMessage.count(), await db.workRequest.count(), await db.deliveryReceipt.count()];
    await expect(publish(f)).rejects.toMatchObject({ code: 'ROOM_DELIVERY_INTEGRITY' });
    await expect(startupBarrier()).rejects.toThrow();
    expect([await db.roomMessage.count(), await db.workRequest.count(), await db.deliveryReceipt.count()]).toEqual(counts);
  });

  const activeStatuses = ['QUEUED', 'RUNNING', 'SESSION_ENDED', 'WAITING_ROOM_REPLY'] as const;
  const claimFaults = ['null', 'foreign-team-null', 'wrong-member-null', 'foreign-team', 'wrong-member', 'other-wr', 'foreign-input', 'pending-input', 'invalid-accepted', 'version-mismatch', 'deleted-input', 'revoked-null', 'second-null'] as const;
  async function nextInput(f: Fixture, state: 'PENDING' | 'ACCEPTED') {
    const title = 'Next input after publication';
    return db.teamTaskInputSnapshot.create({ data: {
      teamRunId: f.team.id, taskId: f.task.id, taskSourceHash: taskInputHash(title, null), originalTitle: title, state,
      ...(state === 'ACCEPTED' ? { sentMode: 'ORIGINAL', effectiveUserText: title, acceptedAt: new Date() } : {}),
    } });
  }
  const savedFacts = () => Promise.all([
    db.messageDelivery.findMany(), db.roomMessage.findMany(), db.workRequest.findMany(), db.agentInvocation.findMany(),
    db.deliveryReceipt.findMany(), db.teamTaskInputSnapshot.findMany(), db.teamRun.findMany(),
  ]);

  it.each(activeStatuses.flatMap(status => claimFaults.map(corrupt => [status, corrupt] as const)))('rejects every active claim at recovery and startup: %s / %s', async (status, corrupt) => {
    const f = await fixture({ mode: 'AUTO' }); const result = await publish(f);
    const request = await db.workRequest.findUniqueOrThrow({ where: { id: result.workRequestIds[0] } });
    const next = await nextInput(f, corrupt === 'pending-input' ? 'PENDING' : 'ACCEPTED');
    await db.workRequest.update({ where: { id: request.id }, data: { status: corrupt === 'pending-input' ? 'QUEUED' : 'STARTED', taskInputSnapshotId: next.id } });
    const foreign = corrupt.startsWith('foreign-') ? await fixture() : f;
    const claim = await db.agentInvocation.create({ data: {
      teamRunId: corrupt.startsWith('foreign-team') ? foreign.team.id : f.team.id,
      memberId: corrupt.startsWith('foreign-team') ? foreign.members[0].id : corrupt.startsWith('wrong-member') ? f.members[1].id : request.targetMemberId,
      workRequestId: corrupt === 'other-wr' ? result.workRequestIds[1] : request.id,
      taskInputSnapshotId: corrupt.endsWith('null') && corrupt !== 'second-null' ? null : corrupt === 'foreign-input' ? foreign.snapshot.id : corrupt === 'version-mismatch' ? f.snapshot.id : next.id,
      status, ...(corrupt === 'revoked-null' ? { dispatchRevokedAt: new Date() } : {}),
    } });
    if (corrupt === 'invalid-accepted') await db.teamTaskInputSnapshot.update({ where: { id: next.id }, data: { effectiveUserText: 'Corrupted accepted evidence' } });
    if (corrupt === 'deleted-input') {
      // Delete a separate claim input: FK SET NULL must not hide lost evidence.
      const removed = await db.teamTaskInputSnapshot.create({ data: { ...next, id: randomUUID(), taskSourceHash: taskInputHash('Removed input', null), originalTitle: 'Removed input', effectiveUserText: 'Removed input' } });
      await db.agentInvocation.update({ where: { id: claim.id }, data: { taskInputSnapshotId: removed.id } });
      await db.teamTaskInputSnapshot.delete({ where: { id: removed.id } });
    }
    if (corrupt === 'second-null') await db.agentInvocation.create({ data: { teamRunId: f.team.id, memberId: request.targetMemberId, workRequestId: request.id, taskInputSnapshotId: null, status } });
    const before = await savedFacts();
    await expect(publish(f)).rejects.toMatchObject({ code: 'ROOM_DELIVERY_INTEGRITY' });
    await expect(startupBarrier()).rejects.toThrow();
    expect(await savedFacts()).toEqual(before);
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it.each(activeStatuses)('allows a complete active claim on the WR new ACCEPTED version: %s', async status => {
    const f = await fixture({ mode: 'AUTO' }); const result = await publish(f);
    const next = await nextInput(f, 'ACCEPTED');
    const request = await db.workRequest.update({ where: { id: result.workRequestIds[0] }, data: { status: 'STARTED', taskInputSnapshotId: next.id } });
    await db.agentInvocation.create({ data: { teamRunId: f.team.id, memberId: request.targetMemberId, workRequestId: request.id, taskInputSnapshotId: next.id, status } });
    const before = await savedFacts();
    expect(await publish(f)).toEqual(result);
    await startupBarrier();
    expect(await savedFacts()).toEqual(before);
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it.each((['COMPLETED', 'FAILED', 'CANCELLED'] as const).flatMap(status => (['PENDING', 'ACCEPTED'] as const).map(state => [status, state] as const)))('preserves terminal input and NULL history while requeued WR uses a new input: %s / %s', async (status, state) => {
    const f = await fixture({ mode: 'AUTO' }); const result = await publish(f);
    const next = await nextInput(f, state);
    const request = await db.workRequest.update({ where: { id: result.workRequestIds[0] }, data: { taskInputSnapshotId: next.id } });
    for (const taskInputSnapshotId of [f.snapshot.id, null]) await db.agentInvocation.create({ data: { teamRunId: f.team.id, memberId: request.targetMemberId, workRequestId: request.id, taskInputSnapshotId, status } });
    const before = await savedFacts();
    expect(await publish(f)).toEqual(result);
    await startupBarrier();
    expect(await savedFacts()).toEqual(before);
  });

  it.each([...activeStatuses, 'COMPLETED', 'FAILED', 'CANCELLED'] as const)('preserves unlinked legacy message/WR/Invocation NULL history: %s', async status => {
    const legacy = await fixture();
    const message = await db.roomMessage.create({ data: { teamRunId: legacy.team.id, senderType: 'user', kind: 'chat', content: 'Legacy original', mentions: '[]' } });
    const request = await db.workRequest.create({ data: { teamRunId: legacy.team.id, requesterType: 'user', targetMemberId: legacy.members[0].id, triggerMessageId: message.id, instruction: 'Legacy original', status: 'STARTED' } });
    await db.agentInvocation.create({ data: { teamRunId: legacy.team.id, memberId: request.targetMemberId, workRequestId: request.id, status } });
    const f = await fixture(); const result = await publish(f);
    const before = await savedFacts();
    expect(await publish(f)).toEqual(result);
    await startupBarrier();
    expect(await savedFacts()).toEqual(before);
  });

  it.each(['agent', 'private', 'foreign-team', 'missing-receipt', 'wrong-origin'] as const)('startup checks every reverse room publication claim: %s', async corrupt => {
    const f = await fixture(); const result = await publish(f);
    if (corrupt === 'agent') await db.roomMessage.update({ where: { id: result.messageId }, data: { senderType: 'agent', senderId: f.members[0].id } });
    else if (corrupt === 'private') await db.roomMessage.update({ where: { id: result.messageId }, data: { visibility: 'PRIVATE' } });
    else if (corrupt === 'foreign-team') {
      const other = await fixture();
      await db.roomMessage.update({ where: { id: result.messageId }, data: { teamRunId: other.team.id } });
    } else if (corrupt === 'missing-receipt') await db.deliveryReceipt.delete({ where: { deliveryId: f.row.id } });
    else await db.messageDelivery.update({ where: { id: f.row.id }, data: { origin: 'TASK_FOLLOWUP' } });
    await expect(startupBarrier()).rejects.toThrow();
    expect(runtime.start).not.toHaveBeenCalled();
  });
});
