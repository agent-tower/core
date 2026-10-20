import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { TranslationSettingsDraft } from '@agent-tower/shared';
import { EventBus } from '../../core/event-bus.js';
import type { TranslationSettingsService as TranslationSettingsServiceType } from '../translation-settings.service.js';
let TranslationSettingsService: typeof import('../translation-settings.service.js').TranslationSettingsService;
import type { TranslationService as TranslationServiceType } from '../translation.service.js';
let TranslationService: typeof import('../translation.service.js').TranslationService;
import type { TeamTaskInputService as TeamTaskInputServiceType } from '../team-task-input.service.js';
let TeamTaskInputService: typeof import('../team-task-input.service.js').TeamTaskInputService;
import type { MessageDeliveryService as MessageDeliveryServiceType } from '../message-delivery.service.js';
let MessageDeliveryService: typeof import('../message-delivery.service.js').MessageDeliveryService;
let TeamLockService: typeof import('../team-lock.service.js').TeamLockService;
import { taskInputHash } from '../team-task-input.js';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-team-user-full-'));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
process.env.AGENT_TOWER_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
process.env.AGENT_TOWER_DATA_DIR = dir;
const container = vi.hoisted(() => ({ settings: null as any, translation: null as any, deliveries: null as any, inputs: null as any, bus: null as any, runtime: null as any }));
vi.mock('../../core/container.js', () => ({ getTranslationSettingsService: () => container.settings, getTranslationService: () => container.translation, getMessageDeliveryService: () => container.deliveries, getTeamTaskInputService: () => container.inputs, getEventBus: () => container.bus, getSessionManager: () => container.runtime }));
let db: PrismaClient;
let teamRuns: InstanceType<typeof import('../team-run.service.js').TeamRunService>;
let Scheduler: typeof import('../team-scheduler.service.js').TeamSchedulerService;
let settings: TranslationSettingsServiceType, translation: TranslationServiceType, inputs: TeamTaskInputServiceType, deliveries: MessageDeliveryServiceType;
let auth: typeof import('../access-auth.service.js').AccessAuthService;
let credentials: typeof import('../../utils/agent-api-credential.js');
let app: FastifyInstance;
let translator: Server, baseUrl: string;
const requests: string[] = [];
const failed = new Set<string>();
const held = new Map<string, Array<() => void>>();
let fault: { model: string; action: string; predicate?: (args: any) => boolean } | undefined;
let notify: ReturnType<typeof vi.fn<(teamRunId: string, taskId: string) => Promise<void>>>;
const wait = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 8000;
  while (!await check()) { await translation.pump(); await deliveries.pump(); if (Date.now() > deadline) throw new Error('Controlled full path timeout'); await wait(); }
}
async function enable(enabled = true) { const current = await settings.getPublic(); const draft: TranslationSettingsDraft = { enabled, apiBaseUrl: baseUrl, model: 'controlled', apiKey: { action: 'replace', value: '' }, sendTargetLanguage: 'English', displayTargetLanguage: 'Chinese', promptTemplate: '{{target_language}}\n{{text}}', maxConcurrency: 4 }; await settings.save({ ...draft, expectedRevision: current.revision }); }
async function room(mode = 'CONFIRM') {
  const project = await db.project.create({ data: { name: 'Isolated project', repoPath: dir } });
  const task = await db.task.create({ data: { projectId: project.id, title: '任务 Task T', description: '精确 task description  ' } });
  const team = await db.teamRun.create({ data: { taskId: task.id, mode } });
  const members = [];
  for (const name of ['A', 'B']) members.push(await db.teamMember.create({ data: { teamRunId: team.id, name, aliases: '[]', providerId: 'controlled-executor', rolePrompt: 'Fixed role', capabilities: '{}', workspacePolicy: 'none', triggerPolicy: 'USER_MESSAGES' } }));
  const workspace = await db.workspace.create({ data: { taskId: task.id, branchName: 'controlled', worktreePath: dir, workingDir: dir } });
  await db.teamRun.update({ where: { id: team.id }, data: { mainWorkspaceId: workspace.id } });
  return { team, task, members, workspace };
}
async function submit(r: Awaited<ReturnType<typeof room>>, content = '用户 hello', extra: object = {}) {
  const clientSubmissionId = randomUUID();
  const body = { clientSubmissionId, content, ...extra };
  const response = await app.inject({ method: 'POST', url: `/api/team-runs/${r.team.id}/messages`, payload: body });
  expect(response.statusCode, response.body).toBe(202);
  return { body, operation: response.json() as { operationId: string; state: string; delivery: any } };
}
async function sent(id: string) { await until(async () => (await db.messageDelivery.findUniqueOrThrow({ where: { id } })).state === 'SENT'); return db.messageDelivery.findUniqueOrThrow({ where: { id } }); }
function scheduler(r: Awaited<ReturnType<typeof room>>, createHook?: () => Promise<void>) {
  const runtime = { create: vi.fn(async (_workspaceId, agentType, prompt) => { const s = await db.session.create({ data: { workspaceId: r.workspace.id, agentType, prompt, status: 'PENDING' } }); await createHook?.(); return s; }), start: vi.fn(async id => { await db.session.update({ where: { id }, data: { status: 'RUNNING' } }); }), isRuntimeCleanupConfirmed: vi.fn(async () => true) };
  const locks = new TeamLockService();
  const service = new Scheduler(locks, { taskInputs: inputs, workspaceService: { create: async () => r.workspace, getOrCreateMainWorkspace: async () => r.workspace }, sessionManager: runtime, getProviderById: () => ({ agentType: 'CODEX' } as never), teamRunReviewAdvancer: { maybeAdvanceTeamRunToReview: async () => false } });
  return { service, runtime, locks };
}
async function queued(r: Awaited<ReturnType<typeof room>>, memberIndex = 0) {
  const message = await db.roomMessage.create({ data: { teamRunId: r.team.id, senderType: 'agent', kind: 'chat', content: 'Agent original', mentions: '[]' } });
  return db.workRequest.create({ data: { teamRunId: r.team.id, triggerMessageId: message.id, targetMemberId: r.members[memberIndex]!.id, requesterType: 'agent', instruction: 'Agent original', status: 'QUEUED' } });
}
describe('TEAM_USER complete production path: real isolated HTTP, local translator and controlled executor', () => {
  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'db', 'push', '--skip-generate', '--schema=prisma/schema.prisma'], { cwd: root, stdio: 'pipe', env: process.env });
    db = (await import('../../utils/index.js')).prisma;
    TranslationSettingsService = (await import('../translation-settings.service.js')).TranslationSettingsService;
    TranslationService = (await import('../translation.service.js')).TranslationService;
    TeamTaskInputService = (await import('../team-task-input.service.js')).TeamTaskInputService;
    MessageDeliveryService = (await import('../message-delivery.service.js')).MessageDeliveryService;
    TeamLockService = (await import('../team-lock.service.js')).TeamLockService;
    auth = (await import('../access-auth.service.js')).AccessAuthService;
    credentials = await import('../../utils/agent-api-credential.js');
    Scheduler = (await import('../team-scheduler.service.js')).TeamSchedulerService;
    db.$use(async (params, next) => { const result = await next(params); const current = fault; if (current && current.model === params.model && current.action === params.action && (!current.predicate || current.predicate(params.args))) { fault = undefined; throw new Error('Controlled atomic write failure'); } return result; });
    translator = createServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      const prompt = JSON.parse(body).messages.at(-1).content as string;
      const text = prompt.slice(prompt.indexOf('\n') + 1); requests.push(text);
      const key = [...held.keys()].find(key => text.includes(key));
      if (key) await new Promise<void>(resolve => held.get(key)!.push(resolve));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: [...failed].some(key => text.includes(key)) ? ' ' : text.replaceAll('用户', 'User').replaceAll('任务', 'Task') } }] }));
    });
    await new Promise<void>(resolve => translator.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(translator.address() as { port: number }).port}/v1`;
  }, 30000);
  beforeEach(async () => {
    await db.messageDelivery.deleteMany(); await db.translationSource.deleteMany(); await db.project.deleteMany(); await db.translationSettings.deleteMany(); await db.accessAuthSettings.deleteMany();
    auth.__test.resetSettingsCache(); credentials.clearAgentApiCredentials(); requests.length = 0; failed.clear(); held.clear(); fault = undefined;
    settings = new TranslationSettingsService(db); await settings.getPublic();
    translation = new TranslationService(db, settings, { limits: { tickMs: 10 } }); inputs = new TeamTaskInputService(db, translation);
    teamRuns = new (await import('../team-run.service.js')).TeamRunService();
    notify = vi.fn(async () => undefined); const runtime = { setMessageDeliveryService: vi.fn(), start: vi.fn(), sendMessage: vi.fn() };
    deliveries = new MessageDeliveryService(db, settings, translation, runtime as never, { tickMs: 10, taskInputs: inputs, teamRuns, roomPublished: notify });
    Object.assign(container, { settings, translation, inputs, deliveries, runtime, bus: new EventBus() });
    app = Fastify(); app.addHook('onRequest', (await import('../../middleware/access-auth.js')).accessAuthHook);
    await app.register((await import('../../routes/team-runs.js')).teamRunRoutes, { prefix: '/api', service: teamRuns, workspaceService: {} as never, scheduler: { startNextSessions: vi.fn(async () => []) } as never });
    await app.register((await import('../../routes/translations.js')).translationRoutes, { prefix: '/api' });
    await app.register((await import('../../routes/system.js')).systemRoutes, { prefix: '/api' });
    await translation.start(); await deliveries.start();
  });
  afterEach(async () => { fault = undefined; for (const resolves of held.values()) resolves.forEach(fn => fn()); held.clear(); await deliveries.shutdown(); await translation.shutdown(); await app.close(); credentials.clearAgentApiCredentials(); });
  afterAll(async () => { await new Promise<void>(resolve => translator.close(() => resolve())); await db.$disconnect(); fs.rmSync(dir, { recursive: true, force: true }); });

  it.each(['CONFIRM', 'AUTO'])('202 → translation → atomic %s publication, fixed no-mention recipients, owner/Agent models and unchanged Task', async mode => {
    const r = await room(mode); await enable(); held.set('用户 hello', []);
    const accepted = await submit(r); expect(accepted.operation.state).toBe('WAITING_TRANSLATION');
    expect(await db.roomMessage.count()).toBe(0); expect(await db.agentInvocation.count()).toBe(0);
    await db.teamMember.create({ data: { ...r.members[0]!, id: randomUUID(), name: 'Late member' } });
    held.get('用户 hello')!.forEach(fn => fn()); held.delete('用户 hello');
    const row = await sent(accepted.operation.operationId);
    const message = await db.roomMessage.findUniqueOrThrow({ where: { deliveryId: row.id } });
    const wrs = await db.workRequest.findMany({ where: { triggerMessageId: message.id } });
    expect(wrs.map(w => w.targetMemberId).sort()).toEqual(r.members.map(m => m.id).sort());
    expect(wrs.every(w => w.status === (mode === 'AUTO' ? 'QUEUED' : 'PENDING_APPROVAL'))).toBe(true);
    expect(message.content).toBe('User hello'); expect(row.actualSentText).toBe(message.content);
    expect((await teamRuns.getRoomMessage(r.team.id, message.id)).content).toBe('用户 hello');
    expect(await teamRuns.getRoomMessage(r.team.id, message.id, { viewerMemberId: r.members[0]!.id })).not.toHaveProperty('userDelivery');
    expect((await db.task.findUniqueOrThrow({ where: { id: r.task.id } }))).toEqual(r.task);
    expect(await db.translationSource.count({ where: { sourceKind: 'TASK_INPUT' } })).toBe(1);
    expect(await db.deliveryReceipt.findUnique({ where: { deliveryId: row.id } })).toMatchObject({ phase: 'SUBMITTED', evidence: 'ROOM_PUBLISHED', generation: row.revision });
    const duplicate = await app.inject({ method: 'POST', url: `/api/team-runs/${r.team.id}/messages`, payload: accepted.body });
    expect(duplicate.statusCode).toBe(202); expect(duplicate.json().operationId).toBe(row.id); expect(await db.roomMessage.count()).toBe(1);
    const conflict = await app.inject({ method: 'POST', url: `/api/team-runs/${r.team.id}/messages`, payload: { ...accepted.body, content: 'changed' } }); expect(conflict.statusCode).toBe(409);
  });
  it('keeps failed body and closed-era messages behind the task channel predecessor and restores same UUID after lost response/restart', async () => {
    const r = await room(); await enable(); failed.add('用户 fail');
    const a = await submit(r, '用户 fail'); const b = await submit(r, '用户 second');
    await until(async () => (await deliveries.get(a.operation.operationId)).state === 'TRANSLATION_FAILED');
    await until(async () => ['READY', 'WAITING_PREDECESSOR'].includes((await deliveries.get(b.operation.operationId)).state));
    await enable(false); const c = await submit(r, '用户 closed'); await wait(40); expect(await db.roomMessage.count()).toBe(0);
    const latest = await deliveries.get(a.operation.operationId); await deliveries.action(latest.id, 'cancel', latest.revision, randomUUID());
    const paused = await deliveries.get(b.operation.operationId); if (paused.state !== 'PAUSED_DISABLED') await until(async () => (await deliveries.get(paused.id)).state === 'PAUSED_DISABLED');
    const revision = (await deliveries.get(paused.id)).revision;
    await deliveries.action(paused.id, 'retry_delivery', revision, randomUUID()); await sent(paused.id); await sent(c.operation.operationId);
    await deliveries.shutdown(); deliveries = new MessageDeliveryService(db, settings, translation, container.runtime, { taskInputs: inputs, teamRuns, tickMs: 10 }); container.deliveries = deliveries; await deliveries.start();
    const retry = await app.inject({ method: 'POST', url: `/api/team-runs/${r.team.id}/messages`, payload: c.body }); expect(retry.statusCode).toBe(202); expect(retry.json().operationId).toBe(c.operation.operationId); expect(await db.roomMessage.count()).toBe(2);
  });
  it.each(['startNext', 'startNextSessions'] as const)('%s blocks before admission/session/claim and shares one task input for concurrent consumers', async method => {
    const r = await room('AUTO'); await enable(); held.set('任务 Task T', []);
    const first = await queued(r); const second = await queued(r, 1); const s = scheduler(r);
    const lock = vi.spyOn(s.locks, 'acquire');
    const { acquireTeamMemberAdmission } = await import('../team-member-admission-barrier.js');
    const releases = await Promise.all(r.members.map(m => acquireTeamMemberAdmission(r.team.id, m.id)));
    let timedOut = false;
    try {
      const blocked = await Promise.race([s.service[method](r.team.id), wait(150).then(() => { timedOut = true; return null; })]);
      expect(blocked).toEqual([]); expect(timedOut).toBe(false); expect(lock).not.toHaveBeenCalled();
    } finally { releases.forEach(release => release()); }
    expect(s.runtime.create).not.toHaveBeenCalled(); expect(await db.agentInvocation.count()).toBe(0);
    expect((await db.workRequest.findUniqueOrThrow({ where: { id: first.id } })).startAttemptCount).toBe(0);
    expect(await db.teamTaskInputSnapshot.count()).toBe(1); expect(await db.translationSource.count({ where: { sourceKind: 'TASK_INPUT' } })).toBe(1);
    held.get('任务 Task T')!.forEach(fn => fn()); held.delete('任务 Task T');
    await until(async () => (await db.translationSource.findFirst({ where: { sourceKind: 'TASK_INPUT' } }))?.jobState === 'SUCCESS');
    const started = await s.service[method](r.team.id); expect(started).toHaveLength(2);
    const invocations = await db.agentInvocation.findMany(); expect(new Set(invocations.map(i => i.taskInputSnapshotId)).size).toBe(1); expect(invocations.every(i => !!i.taskInputSnapshotId)).toBe(true);
    expect((await db.workRequest.findUniqueOrThrow({ where: { id: second.id } })).status).toBe('STARTED');
    if (method === 'startNextSessions') { const sessions = await db.session.findMany(); expect(sessions.every(s => s.prompt.includes('Task Task T') && !s.prompt.includes('任务 Task T') && s.prompt.includes('Fixed role') && s.prompt.includes('Agent original'))).toBe(true); }
  });
  it('retains old failed task dependency across edit+disable, and cancellation respects remaining consumers', async () => {
    const r = await room('AUTO'); await enable(); failed.add('任务 Task T');
    const first = await queued(r); const second = await queued(r, 1); const s = scheduler(r);
    await s.service.startNext(r.team.id);
    await until(async () => (await db.translationSource.findFirst({ where: { sourceKind: 'TASK_INPUT' } }))?.jobState === 'FAILED');
    const old = await db.teamTaskInputSnapshot.findFirstOrThrow();
    await db.task.update({ where: { id: r.task.id }, data: { title: '任务 Task U' } }); await enable(false);
    expect(await s.service.startNext(r.team.id)).toEqual([]); expect(await db.teamTaskInputSnapshot.count()).toBe(1);
    await db.workRequest.update({ where: { id: first.id }, data: { status: 'CANCELLED' } }); await inputs.cancelUnused();
    expect((await db.translationSource.findFirstOrThrow()).jobState).toBe('FAILED');
    expect(await s.service.startNext(r.team.id)).toEqual([]);
    const result = await inputs.action(r.team.id, old.id, 'send_original', old.revision, randomUUID()); expect(result.state).toBe('ACCEPTED');
    const started = await s.service.startNext(r.team.id); expect(started).toHaveLength(1);
    const invocation = await db.agentInvocation.findFirstOrThrow({ where: { workRequestId: second.id } });
    const adopted = await db.teamTaskInputSnapshot.findUniqueOrThrow({ where: { id: invocation.taskInputSnapshotId! } }); expect(adopted.taskSourceHash).toBe(taskInputHash('任务 Task U', r.task.description));
  });
  it.each([
    ['FAILED', 'WORK_REQUEST'], ['FAILED', 'DELIVERY'],
    ['CANCELLED', 'WORK_REQUEST'], ['CANCELLED', 'DELIVERY'],
  ] as const)('releases an abandoned %s input after its last delivery is cancelled, for a new %s', async (sourceState, kind) => {
    const r = await room('AUTO'); await enable();
    if (sourceState === 'FAILED') failed.add('任务 Task T');
    else held.set('任务 Task T', []);
    const first = await submit(r);
    await until(async () => (await db.translationSource.findFirst({ where: { sourceKind: 'TASK_INPUT' } }))?.jobState === (sourceState === 'FAILED' ? 'FAILED' : 'RUNNING'));
    const old = await db.teamTaskInputSnapshot.findFirstOrThrow();
    const current = await deliveries.get(first.operation.operationId);
    await deliveries.action(current.id, 'cancel', current.revision, randomUUID());
    await inputs.cancelUnused();
    expect((await db.translationSource.findUniqueOrThrow({ where: { id: old.translationSourceId! } })).jobState).toBe(sourceState);
    await enable(false);
    const before = requests.length;
    if (kind === 'WORK_REQUEST') {
      const next = await queued(r);
      expect(await inputs.ensureForDispatch(r.team.id, { kind, id: next.id })).toMatchObject({ state: 'READY', token: { snapshotId: old.id, sentMode: 'ORIGINAL' } });
    } else {
      const next = await submit(r, '用户 after abandoning last delivery');
      expect(await sent(next.operation.operationId)).toMatchObject({ taskInputSnapshotId: old.id, sentMode: 'ORIGINAL', actualSentText: next.body.content });
      expect(await db.roomMessage.count({ where: { senderType: 'user' } })).toBe(1);
    }
    for (const resolve of held.get('任务 Task T') ?? []) resolve(); held.delete('任务 Task T');
    await wait(20); await translation.pump(); await deliveries.pump();
    expect(requests).toHaveLength(before);
    expect(await db.teamTaskInputSnapshot.count()).toBe(1);
    expect(await db.teamTaskInputSnapshot.findUniqueOrThrow({ where: { id: old.id } })).toMatchObject({ state: 'ACCEPTED', sentMode: 'ORIGINAL', revision: old.revision + 1, acceptedAttemptId: null, effectiveUserText: `${r.task.title}\n\n${r.task.description}` });
    expect((await db.messageDelivery.findUniqueOrThrow({ where: { id: current.id } })).state).toBe('CANCELLED');
    expect(await db.task.findUniqueOrThrow({ where: { id: r.task.id } })).toEqual(r.task);
  });
  it.each(['WORK_REQUEST', 'DELIVERY'] as const)('retains a shared failed barrier while an old %s remains active, including after Task edits', async survivor => {
    const r = await room('AUTO'); await enable(); failed.add('任务 Task T');
    const first = await queued(r); const second = await queued(r, 1); const s = scheduler(r);
    await s.service.startNext(r.team.id);
    await until(async () => (await db.translationSource.findFirst({ where: { sourceKind: 'TASK_INPUT' } }))?.jobState === 'FAILED');
    const delivery = await submit(r);
    await until(async () => !!(await db.messageDelivery.findUniqueOrThrow({ where: { id: delivery.operation.operationId } })).taskInputSnapshotId);
    const old = await db.teamTaskInputSnapshot.findFirstOrThrow();
    await s.service.cancelWorkRequest(first.id, { teamRunId: r.team.id, requesterMemberId: r.members[0]!.id });
    if (survivor === 'DELIVERY') await s.service.cancelWorkRequest(second.id, { teamRunId: r.team.id, requesterMemberId: r.members[1]!.id });
    else { const row = await deliveries.get(delivery.operation.operationId); await deliveries.action(row.id, 'cancel', row.revision, randomUUID()); }
    await enable(false); await inputs.cancelUnused();
    const next = await queued(r);
    expect(await inputs.ensureForDispatch(r.team.id, { kind: 'WORK_REQUEST', id: next.id })).toEqual({ state: 'BLOCKED', snapshotId: old.id });
    const message = await submit(r, '用户 closed behind remaining consumer');
    await until(async () => !!(await db.messageDelivery.findUniqueOrThrow({ where: { id: message.operation.operationId } })).taskInputSnapshotId);
    await db.task.update({ where: { id: r.task.id }, data: { title: 'Task edit must not bypass active input' } });
    expect(await inputs.ensureForDispatch(r.team.id, { kind: 'WORK_REQUEST', id: next.id })).toEqual({ state: 'BLOCKED', snapshotId: old.id });
    expect(await inputs.ensureForDispatch(r.team.id, { kind: 'DELIVERY', id: message.operation.operationId })).toEqual({ state: 'BLOCKED', snapshotId: old.id });
    expect((await deliveries.get(message.operation.operationId)).state).toBe('WAITING_TASK_INPUT');
    expect(await db.roomMessage.count({ where: { senderType: 'user' } })).toBe(0);
    expect(await db.teamTaskInputSnapshot.count()).toBe(1);
    expect(await db.teamTaskInputSnapshot.findUniqueOrThrow({ where: { id: old.id } })).toEqual(old);
    expect(await s.service.startNextSessions(r.team.id)).toEqual([]); expect(s.runtime.create).not.toHaveBeenCalled();
  });
  it('counts a newly bound consumer on repeated preflight after the older consumer is cancelled', async () => {
    const r = await room('AUTO'); await enable(); failed.add('任务 Task T');
    const first = await queued(r); const s = scheduler(r);
    await s.service.startNext(r.team.id);
    await until(async () => (await db.translationSource.findFirst({ where: { sourceKind: 'TASK_INPUT' } }))?.jobState === 'FAILED');
    await enable(false);
    const next = await queued(r, 1); const otherInputs = new TeamTaskInputService(db, translation);
    const blocked = await otherInputs.ensureForDispatch(r.team.id, { kind: 'WORK_REQUEST', id: next.id });
    expect(blocked.state).toBe('BLOCKED');
    await s.service.cancelWorkRequest(first.id, { teamRunId: r.team.id, requesterMemberId: r.members[0]!.id });
    await inputs.cancelUnused();
    expect(await inputs.ensureForDispatch(r.team.id, { kind: 'WORK_REQUEST', id: next.id })).toEqual(blocked);
    expect(await otherInputs.ensureForDispatch(r.team.id, { kind: 'WORK_REQUEST', id: next.id })).toEqual(blocked);
    await s.service.cancelWorkRequest(next.id, { teamRunId: r.team.id, requesterMemberId: r.members[1]!.id });
    const fresh = await queued(r);
    expect(await inputs.ensureForDispatch(r.team.id, { kind: 'WORK_REQUEST', id: fresh.id })).toMatchObject({ state: 'READY', token: { sentMode: 'ORIGINAL' } });
  });
  it('atomically adopts one abandoned same-hash candidate across concurrent service instances and repeated preflights', async () => {
    const r = await room('AUTO'); await enable(); failed.add('任务 Task T');
    const first = await queued(r); const s = scheduler(r);
    await s.service.startNext(r.team.id);
    await until(async () => (await db.translationSource.findFirst({ where: { sourceKind: 'TASK_INPUT' } }))?.jobState === 'FAILED');
    const old = await db.teamTaskInputSnapshot.findFirstOrThrow();
    await s.service.cancelWorkRequest(first.id, { teamRunId: r.team.id, requesterMemberId: r.members[0]!.id });
    await enable(false);
    const consumers = await Promise.all([queued(r), queued(r, 1), queued(r)]);
    const otherInputs = new TeamTaskInputService(db, translation);
    fault = { model: 'WorkRequest', action: 'update', predicate: args => args.where.id === consumers[0]!.id };
    await expect(otherInputs.ensureForDispatch(r.team.id, { kind: 'WORK_REQUEST', id: consumers[0]!.id })).rejects.toThrow('Controlled atomic write failure');
    expect(await db.teamTaskInputSnapshot.findUniqueOrThrow({ where: { id: old.id } })).toEqual(old);
    expect((await db.workRequest.findUniqueOrThrow({ where: { id: consumers[0]!.id } })).taskInputSnapshotId).toBeNull();
    const [results, message] = await Promise.all([
      Promise.all(consumers.map((w, i) => (i % 2 ? inputs : otherInputs).ensureForDispatch(r.team.id, { kind: 'WORK_REQUEST', id: w.id }))),
      submit(r, '用户 concurrent candidate reuse'),
    ]);
    expect(results.every(result => result.state === 'READY')).toBe(true);
    expect(results[0]).toEqual(results[1]); expect(results[1]).toEqual(results[2]);
    const accepted = await db.teamTaskInputSnapshot.findUniqueOrThrow({ where: { id: old.id } });
    expect(accepted).toMatchObject({ state: 'ACCEPTED', sentMode: 'ORIGINAL', revision: old.revision + 1 });
    await sent(message.operation.operationId);
    await Promise.all(consumers.map(w => otherInputs.ensureForDispatch(r.team.id, { kind: 'WORK_REQUEST', id: w.id })));
    expect(await db.teamTaskInputSnapshot.findUniqueOrThrow({ where: { id: old.id } })).toEqual(accepted);
    expect(await db.teamTaskInputSnapshot.count()).toBe(1); expect(await db.translationSource.count({ where: { sourceKind: 'TASK_INPUT' } })).toBe(1);
    expect((await db.workRequest.findUniqueOrThrow({ where: { id: first.id } })).status).toBe('CANCELLED');
  });
  it('preserves accepted translation evidence and the frozen Invocation when new consumers revisit its hash', async () => {
    const r = await room('AUTO'); await enable(); const first = await queued(r); const s = scheduler(r);
    await s.service.startNextSessions(r.team.id);
    await until(async () => (await db.translationSource.findFirst({ where: { sourceKind: 'TASK_INPUT' } }))?.jobState === 'SUCCESS');
    expect(await s.service.startNextSessions(r.team.id)).toHaveLength(1);
    const invocation = await db.agentInvocation.findFirstOrThrow();
    const snapshot = await db.teamTaskInputSnapshot.findUniqueOrThrow({ where: { id: invocation.taskInputSnapshotId! } });
    const attempt = await db.translationAttempt.findUniqueOrThrow({ where: { id: snapshot.acceptedAttemptId! } });
    const session = await db.session.findUniqueOrThrow({ where: { id: invocation.sessionId! } });
    expect(snapshot.sentMode).toBe('TRANSLATED');
    await enable(false);
    await db.task.update({ where: { id: r.task.id }, data: { title: 'Another input version' } });
    const next = await queued(r, 1);
    expect((await inputs.ensureForDispatch(r.team.id, { kind: 'WORK_REQUEST', id: next.id })).state).toBe('READY');
    await db.task.update({ where: { id: r.task.id }, data: { title: r.task.title } });
    const otherInputs = new TeamTaskInputService(db, translation);
    const results = await Promise.all([inputs, otherInputs].map(service => service.ensureForDispatch(r.team.id, { kind: 'WORK_REQUEST', id: next.id })));
    expect(results[0]).toEqual(results[1]); expect(results[0]).toMatchObject({ state: 'READY', token: { snapshotId: snapshot.id, sentMode: 'TRANSLATED', acceptedAttemptId: attempt.id } });
    expect(await db.teamTaskInputSnapshot.findUniqueOrThrow({ where: { id: snapshot.id } })).toEqual(snapshot);
    expect(await db.translationAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toEqual(attempt);
    expect(await db.agentInvocation.findUniqueOrThrow({ where: { id: invocation.id } })).toEqual(invocation);
    expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toEqual(session);
    expect((await db.workRequest.findUniqueOrThrow({ where: { id: first.id } })).taskInputSnapshotId).toBe(snapshot.id);
  });
  it('claim race after Session creation deletes unspawned Session and leaves QUEUED without start failures', async () => {
    const r = await room('AUTO'); await queued(r);
    const s = scheduler(r, async () => { await db.task.update({ where: { id: r.task.id }, data: { title: 'Task changed at final claim' } }); });
    expect(await s.service.startNextSessions(r.team.id)).toEqual([]); expect(await db.session.count()).toBe(0); expect(s.runtime.start).not.toHaveBeenCalled();
    expect(await db.workRequest.findFirstOrThrow()).toMatchObject({ status: 'QUEUED', startAttemptCount: 0, lastStartError: null });
    expect(await db.agentInvocation.count()).toBe(0);
  });
  it.each(['RoomMessage', 'WorkRequest', 'DeliveryReceipt', 'MessageDelivery'])('rolls back %s publication fault and retries delivery without retranslating', async model => {
    const r = await room(); await enable();
    fault = { model, action: model === 'MessageDelivery' ? 'updateMany' : 'create', predicate: model === 'MessageDelivery' ? args => args.data?.state === 'SENT' : undefined };
    const accepted = await submit(r);
    await until(async () => (await deliveries.get(accepted.operation.operationId)).state === 'DELIVERY_FAILED');
    expect(await db.roomMessage.count()).toBe(0); expect(await db.workRequest.count()).toBe(0); expect(await db.deliveryReceipt.count()).toBe(0);
    expect((await db.teamRun.findUniqueOrThrow({ where: { id: r.team.id } })).currentTaskInputSnapshotId).toBeNull();
    const before = requests.length; const row = await deliveries.get(accepted.operation.operationId);
    await deliveries.action(row.id, 'retry_delivery', row.revision, randomUUID()); await sent(row.id); expect(requests).toHaveLength(before); expect(await db.roomMessage.count()).toBe(1); expect(await db.workRequest.count()).toBe(2);
  });
  it('concurrent duplicate HTTP and two workers keep one publication after a post-commit failure', async () => {
    const r = await room(); await enable();
    const other = new MessageDeliveryService(db, settings, translation, container.runtime, { taskInputs: inputs, teamRuns, tickMs: 10 });
    await other.start(); notify.mockRejectedValueOnce(new Error('Controlled response lost after commit'));
    try {
      const body = { clientSubmissionId: randomUUID(), content: '用户 concurrent' };
      const replies = await Promise.all(Array.from({ length: 4 }, () => app.inject({ method: 'POST', url: `/api/team-runs/${r.team.id}/messages`, payload: body })));
      expect(replies.every(reply => reply.statusCode === 202)).toBe(true);
      const ids = new Set(replies.map(reply => reply.json().operationId)); expect(ids.size).toBe(1);
      const row = await sent([...ids][0]);
      expect(await db.messageDelivery.count()).toBe(1); expect(await db.roomMessage.count()).toBe(1); expect(await db.deliveryReceipt.count()).toBe(1); expect(await db.workRequest.count()).toBe(2);
      expect((await other.get(row.id)).state).toBe('SENT');
    } finally { await other.shutdown(); }
  }, 15000);
  it('freezes explicit mentions, target owner and attachments; an invalid recipient cannot partially publish', async () => {
    const r = await room(); await enable(); failed.add('用户 route');
    const attachment = await db.attachment.create({ data: { hash: randomUUID(), originalName: 'proof.txt', mimeType: 'text/plain', sizeBytes: 4, storagePath: path.join(dir, 'proof.txt') } });
    const target = { kind: 'WORKSPACE_COMMIT', purpose: 'REVIEW', sourceWorkspaceId: r.workspace.id, headSha: 'a'.repeat(40), branchName: 'controlled' };
    const accepted = await submit(r, '用户 route', { attachmentIds: [attachment.id], mentions: r.members.map((m, index) => ({ memberId: m.id, ...(index ? {} : { target }) })) });
    await until(async () => (await deliveries.get(accepted.operation.operationId)).state === 'TRANSLATION_FAILED');
    await db.teamMember.update({ where: { id: r.members[1]!.id }, data: { membershipStatus: 'REMOVED' } });
    let row = await deliveries.get(accepted.operation.operationId);
    await deliveries.action(row.id, 'send_original', row.revision, randomUUID());
    await until(async () => (await deliveries.get(row.id)).state === 'DELIVERY_FAILED');
    expect((await deliveries.get(row.id)).lastError).toBe('RECIPIENT_UNAVAILABLE');
    expect(await db.roomMessage.count()).toBe(0); expect(await db.workRequest.count()).toBe(0);
    await db.teamMember.update({ where: { id: r.members[1]!.id }, data: { membershipStatus: 'ACTIVE' } });
    row = await deliveries.get(row.id); await deliveries.action(row.id, 'retry_delivery', row.revision, randomUUID());
    const published = await sent(row.id); const message = await db.roomMessage.findUniqueOrThrow({ where: { deliveryId: row.id } });
    expect(message.attachmentIds).toBe(JSON.stringify([attachment.id]));
    expect((await db.workRequest.findFirstOrThrow({ where: { triggerMessageId: message.id, targetMemberId: r.members[0]!.id } })).targetHeadSha).toBe(target.headSha);
    expect(published.sentMode).toBe('ORIGINAL');
  });
  it('shared owner actions are scoped, revision checked and idempotent; final claim rechecks an older input consumer', async () => {
    const r = await room('AUTO'); await enable(); failed.add('任务 Task T');
    const first = await queued(r); await inputs.ensureForDispatch(r.team.id, { kind: 'WORK_REQUEST', id: first.id });
    await until(async () => (await db.translationSource.findFirst({ where: { sourceKind: 'TASK_INPUT' } }))?.jobState === 'FAILED');
    const old = await db.teamTaskInputSnapshot.findFirstOrThrow(); const other = await room();
    const action = { action: 'send_original', expectedRevision: old.revision, actionId: randomUUID() };
    const url = `/api/team-runs/${r.team.id}/task-inputs/${old.id}/actions`;
    expect((await app.inject({ method: 'POST', url: url.replace(r.team.id, other.team.id), payload: action })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url, payload: action })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url, payload: action })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url, payload: { ...action, actionId: randomUUID() } })).statusCode).toBe(409);
    await db.task.update({ where: { id: r.task.id }, data: { title: 'Task U' } }); await enable(false);
    const next = await queued(r, 1); const prepared = await inputs.ensureForDispatch(r.team.id, { kind: 'WORK_REQUEST', id: next.id }); expect(prepared.state).toBe('READY');
    if (prepared.state !== 'READY') throw new Error('Expected current input');
    // Simulate an older consumer acquiring a different unresolved input after preflight.
    const blocked = await db.teamTaskInputSnapshot.create({ data: { teamRunId: r.team.id, taskId: r.task.id, taskSourceHash: taskInputHash('Older input', null), originalTitle: 'Older input' } });
    await db.workRequest.update({ where: { id: first.id }, data: { taskInputSnapshotId: blocked.id } });
    await expect(db.$transaction(tx => inputs.assertForClaim(tx, r.team.id, { kind: 'WORK_REQUEST', id: next.id }, prepared.token))).rejects.toMatchObject({ code: 'TASK_INPUT_CHANGED' });
    expect((await db.workRequest.findUniqueOrThrow({ where: { id: next.id } })).startAttemptCount).toBe(0);
  });
  it('uses actual owner/authKind with password on/off, explicit internal user origin and same-origin enforcement', async () => {
    const r = await room(); const payload = () => ({ content: '用户 auth', clientSubmissionId: randomUUID() });
    const url = `/api/team-runs/${r.team.id}/messages`;
    expect((await app.inject({ method: 'POST', url, headers: { host: 'local.test', origin: 'https://other.test' }, payload: payload() })).statusCode).toBe(403);
    const internal = randomUUID(); const prior = process.env.AGENT_TOWER_INTERNAL_TOKEN; process.env.AGENT_TOWER_INTERNAL_TOKEN = internal;
    try {
      const headers = { 'x-agent-tower-internal-token': internal };
      expect((await app.inject({ method: 'POST', url, headers, payload: payload() })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url, headers: { ...headers, 'x-agent-tower-input-origin': 'user' }, payload: payload() })).statusCode).toBe(202);
      const login = await auth.updateSettings({ enabled: true, newPassword: 'controlled-only-password' });
      expect((await app.inject({ method: 'POST', url, payload: payload() })).statusCode).toBe(401);
      expect((await app.inject({ method: 'POST', url, headers: { cookie: `${auth.cookieName}=${login.sessionToken}` }, payload: payload() })).statusCode).toBe(202);
    } finally { if (prior === undefined) delete process.env.AGENT_TOWER_INTERNAL_TOKEN; else process.env.AGENT_TOWER_INTERNAL_TOKEN = prior; }
  });
  it('strict real credentials: solo Agent cannot fall back to user; snapshot GET and MCP are fixed, legacy is 409; owner originals stay private', async () => {
    const r = await room('AUTO');
    await db.task.update({ where: { id: r.task.id }, data: { description: 'Long fixed input. '.repeat(30) } });
    await enable(); const accepted = await submit(r); const delivered = await sent(accepted.operation.operationId);
    const s = scheduler(r); await s.service.startNextSessions(r.team.id);
    const invocation = await db.agentInvocation.findFirstOrThrow({ where: { memberId: r.members[0]!.id } });
    const credential = credentials.createAgentApiCredential({ sessionId: invocation.sessionId!, invocationId: invocation.id });
    const headers = { 'x-agent-tower-agent-credential': credential };
    const fullUrl = `/api/team-runs/${r.team.id}/task-input?view=full`;
    const full = await app.inject({ url: fullUrl, headers }); expect(full.statusCode, full.body).toBe(200); expect(full.json().effectiveUserText).toContain('Task Task T');
    const preview = await app.inject({ url: fullUrl.replace('full', 'preview'), headers });
    expect(preview.json()).toMatchObject({ snapshotId: full.json().snapshotId, taskSourceHash: full.json().taskSourceHash, isTruncated: true, fullContentAvailable: true });
    expect(preview.json().effectiveUserText.length).toBeLessThanOrEqual(240);
    await db.task.update({ where: { id: r.task.id }, data: { title: 'New task version' } });
    expect((await app.inject({ url: fullUrl, headers })).json()).toEqual(full.json());
    expect((await app.inject({ url: `/api/team-runs/${r.team.id}/messages/${delivered.acceptedDestinationId}`, headers })).json().content).toBe('User hello');
    expect((await app.inject({ url: `/api/team-runs/${r.team.id}/messages/${delivered.acceptedDestinationId}`, headers })).json()).not.toHaveProperty('userDelivery');
    const posted = await app.inject({ method: 'POST', url: `/api/team-runs/${r.team.id}/messages`, headers, payload: { content: 'Agent body stays original' } });
    expect(posted.statusCode, posted.body).toBe(201); expect(posted.json().content).toBe('Agent body stays original');
    const otherTeam = await room();
    expect((await app.inject({ url: fullUrl.replace(r.team.id, otherTeam.team.id), headers })).statusCode).toBe(404);
    await db.teamMember.update({ where: { id: invocation.memberId }, data: { membershipStatus: 'REMOVED' } });
    expect((await app.inject({ url: fullUrl, headers })).statusCode).toBe(403);
    await db.teamMember.update({ where: { id: invocation.memberId }, data: { membershipStatus: 'ACTIVE' } });
    await db.agentInvocation.update({ where: { id: invocation.id }, data: { dispatchRevokedAt: new Date() } });
    expect((await app.inject({ url: fullUrl, headers })).statusCode).toBe(403);
    await db.agentInvocation.update({ where: { id: invocation.id }, data: { dispatchRevokedAt: null } });
    for (const url of [`/api/team-runs/${r.team.id}/task-inputs`, `/api/message-deliveries/${delivered.id}`]) expect((await app.inject({ url, headers })).statusCode).toBe(403);
    const solo = await db.session.create({ data: { workspaceId: r.workspace.id, agentType: 'CODEX', prompt: 'Solo', status: 'RUNNING' } });
    const soloCredential = credentials.createAgentApiCredential({ sessionId: solo.id, invocationId: null });
    expect((await app.inject({ method: 'POST', url: `/api/team-runs/${r.team.id}/messages`, headers: { 'x-agent-tower-agent-credential': soloCredential }, payload: { content: 'forged', clientSubmissionId: randomUUID() } })).statusCode).toBe(403);
    expect((await app.inject({ url: fullUrl, headers: { ...headers, 'x-agent-tower-invocation-id': randomUUID() } })).statusCode).toBe(401);
    expect((await app.inject({ url: fullUrl, headers: { 'x-agent-tower-agent-credential': 'invalid' } })).statusCode).toBe(401);
    expect((await app.inject({ url: fullUrl })).statusCode).toBe(403);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const prior = { ...process.env };
    Object.assign(process.env, { AGENT_TOWER_TEAM_RUN_ID: r.team.id, AGENT_TOWER_MEMBER_ID: invocation.memberId, AGENT_TOWER_INVOCATION_ID: invocation.id, AGENT_TOWER_SESSION_ID: invocation.sessionId });
    const server = await (await import('../../mcp/server.js')).createMcpServer(`http://127.0.0.1:${(app.server.address() as { port: number }).port}`, { agentApiCredential: credential });
    const client = new Client({ name: 'team-input-controlled', version: '1' }); const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
    try {
      const result = await client.callTool({ name: 'get_team_task_input', arguments: { view: 'full' } }); expect(result.isError).not.toBe(true); expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toEqual(full.json());
      await db.agentInvocation.update({ where: { id: invocation.id }, data: { taskInputSnapshotId: null } });
      expect((await app.inject({ url: fullUrl, headers })).statusCode).toBe(409);
      const legacy = await client.callTool({ name: 'get_team_task_input', arguments: { view: 'preview' } });
      expect(legacy.isError).toBe(true); expect(JSON.stringify(legacy.content)).toContain('LEGACY_TASK_INPUT_NOT_SNAPSHOTTED');
    } finally { await client.close(); await server.close(); for (const key of ['AGENT_TOWER_TEAM_RUN_ID', 'AGENT_TOWER_MEMBER_ID', 'AGENT_TOWER_INVOCATION_ID', 'AGENT_TOWER_SESSION_ID']) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; } }
  });
});
