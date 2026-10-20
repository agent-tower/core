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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tower-team-initial-full-'));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
process.env.AGENT_TOWER_DATABASE_URL = `file:${path.join(dir, 'test.db')}`;
process.env.AGENT_TOWER_DATA_DIR = dir;
const container = vi.hoisted(() => ({ settings: null as any, translation: null as any, deliveries: null as any, inputs: null as any, bus: null as any, runtime: null as any }));
vi.mock('../../executors/index.js', () => ({ getProviderById: (id: string) => id === 'controlled-executor' ? { id, agentType: 'CODEX' } : null }));
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
describe('TEAM_INITIAL atomic creation with real REST and isolated SQLite', () => {
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
    await db.session.deleteMany(); await db.messageDelivery.deleteMany(); await db.translationSource.deleteMany(); await db.project.deleteMany(); await db.translationSettings.deleteMany(); await db.accessAuthSettings.deleteMany();
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


  async function initial(title = '任务 initial', description: string | null = '精确 description  ', mode = 'CONFIRM') {
    const repoPath = path.join(dir, randomUUID()); fs.mkdirSync(repoPath);
    execFileSync('git', ['init', '-q', repoPath]); execFileSync('git', ['-C', repoPath, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
    const project = await db.project.create({ data: { name: 'Initial project', repoPath } });
    const task = await db.task.create({ data: { projectId: project.id, title, description } });
    const capabilities = Object.fromEntries(['readRoom','postRoomMessage','mentionMembers','stopMemberWork','markReadyForReview','readFiles','writeFiles','runCommands','readDiff','mergeWorkspace'].map(key => [key, false]));
    const body = { clientSubmissionId: randomUUID(), mode, members: ['A','B'].map(name => ({ name, aliases: [name.toLowerCase()], providerId: 'controlled-executor', rolePrompt: 'Fixed role', capabilities, workspacePolicy: 'none', triggerPolicy: 'USER_MESSAGES', sessionPolicy: 'new_per_request', queueManagementPolicy: 'own_only' })) };
    const post = (value: any = body) => app.inject({ method: 'POST', url: `/api/tasks/${task.id}/team-runs`, payload: value });
    return { task, body, post };
  }
  async function accepted(r: Awaited<ReturnType<typeof initial>>) {
    const response = await r.post(); expect([201,202], response.body).toContain(response.statusCode);
    if (response.statusCode === 202) return response.json();
    const row = await db.messageDelivery.findUniqueOrThrow({ where: { clientSubmissionId: r.body.clientSubmissionId } });
    const delivery = await deliveries.get(row.id);
    return { operationId: row.id, state: row.state, destination: delivery.destination, delivery };
  }

  it.each(['CONFIRM','AUTO'])('creates %s once, translates exact Task once and reuses snapshot for scheduler/HTTP/MCP', async mode => {
    await enable(); held.set('任务 initial', []); const r = await initial('任务 initial', '精确 description  ', mode);
    const a = await accepted(r); expect(a.destination.kind).toBe('TEAM_ROOM_PENDING'); expect(a).not.toHaveProperty('destinationId');
    const before = await db.messageDelivery.findUniqueOrThrow({ where: { id: a.operationId } }); const intent = JSON.parse(before.intent);
    expect(await db.teamRun.count()).toBe(0); expect(await db.teamMember.count()).toBe(0); expect(await db.workRequest.count()).toBe(0); expect(await db.session.count()).toBe(0); expect(await db.agentInvocation.count()).toBe(0);
    held.get('任务 initial')!.forEach(fn => fn()); held.delete('任务 initial'); const row = await sent(a.operationId);
    expect(row.teamRunId).toBe(intent.plannedTeamRunId); expect(row.actualSentText).toBe('Task initial\n\n精确 description  ');
    expect((await db.teamMember.findMany()).map(m => m.id).sort()).toEqual(intent.members.map((m: any) => m.id).sort());
    expect(await db.translationSource.count({ where: { sourceKind: 'TASK_INPUT' } })).toBe(0); expect(requests).toHaveLength(1);
    const snapshot = await db.teamTaskInputSnapshot.findUniqueOrThrow({ where: { id: row.taskInputSnapshotId! } }); expect(snapshot.effectiveUserText).toBe(row.actualSentText); expect(snapshot.translationSourceId).toBe(row.translationSourceId); expect(snapshot.acceptedAttemptId).toBe((await db.translationSource.findUniqueOrThrow({ where: { id: row.translationSourceId! } })).effectiveAttemptId);
    expect(await db.task.findUniqueOrThrow({ where: { id: r.task.id } })).toEqual(r.task);
    const team = await db.teamRun.findUniqueOrThrow({ where: { id: row.teamRunId! } }); const members = await db.teamMember.findMany();
    const workspace = await db.workspace.create({ data: { taskId: r.task.id, branchName: 'fixture', worktreePath: dir, workingDir: dir } }); await db.teamRun.update({ where: { id: team.id }, data: { mainWorkspaceId: workspace.id } });
    if (mode === 'CONFIRM') { expect((await db.workRequest.findMany()).every(w => w.status === 'PENDING_APPROVAL')).toBe(true); await db.workRequest.updateMany({ data: { status: 'QUEUED' } }); }
    const runtime = scheduler({ team, task: r.task, members, workspace }); await runtime.service.startNextSessions(team.id); expect(runtime.runtime.start).toHaveBeenCalledTimes(2);
    expect((await db.session.findMany()).every(s => s.prompt.includes(row.actualSentText!) && !s.prompt.includes('任务 initial'))).toBe(true);
    const invocation = await db.agentInvocation.findFirstOrThrow(); expect(invocation.taskInputSnapshotId).toBe(snapshot.id);
    const apiCredential = credentials.createAgentApiCredential({ sessionId: invocation.sessionId!, invocationId: invocation.id });
    const response = await app.inject({ url: `/api/team-runs/${team.id}/task-input?view=full`, headers: { 'x-agent-tower-agent-credential': apiCredential } }); expect(response.statusCode, response.body).toBe(200); expect(response.json().effectiveUserText).toBe(row.actualSentText);
    await app.listen({ port: 0, host: '127.0.0.1' }); const prior = { ...process.env };
    Object.assign(process.env, { AGENT_TOWER_TEAM_RUN_ID: team.id, AGENT_TOWER_MEMBER_ID: invocation.memberId, AGENT_TOWER_INVOCATION_ID: invocation.id, AGENT_TOWER_SESSION_ID: invocation.sessionId });
    const server = await (await import('../../mcp/server.js')).createMcpServer(`http://127.0.0.1:${(app.server.address() as { port: number }).port}`, { agentApiCredential: apiCredential });
    const client = new Client({ name: 'initial-controlled', version: '1' }); const [left, right] = InMemoryTransport.createLinkedPair(); await server.connect(right); await client.connect(left);
    try { const result = await client.callTool({ name: 'get_team_task_input', arguments: { view: 'full' } }); expect(result.isError).not.toBe(true); expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toEqual(response.json()); }
    finally { await client.close(); await server.close(); for (const key of ['AGENT_TOWER_TEAM_RUN_ID','AGENT_TOWER_MEMBER_ID','AGENT_TOWER_INVOCATION_ID','AGENT_TOWER_SESSION_ID']) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; } }
    expect((await r.post()).json().id).toBe(row.teamRunId); expect(await db.teamRun.count()).toBe(1); expect(requests).toHaveLength(1);
  });
  it('deduplicates parallel UUID, rejects changed client intent and competing task creation, preserves identity over restart/task edit', async () => {
    await enable(); held.set('任务 initial', []); const r = await initial();
    const responses = await Promise.all([r.post(), r.post()]); expect(responses.map(x => x.statusCode)).toEqual([202,202]); const id = responses[0].json().operationId; expect(responses[1].json().operationId).toBe(id);
    const first = await db.messageDelivery.findUniqueOrThrow({ where: { id } }); const frozen = JSON.parse(first.intent);
    expect((await r.post({ ...r.body, mode: 'AUTO' })).statusCode).toBe(409); expect((await r.post({ ...r.body, clientSubmissionId: randomUUID() })).json().code).toBe('TEAM_CREATION_PENDING');
    await until(async () => held.get('任务 initial')!.length > 0);
    await db.task.update({ where: { id: r.task.id }, data: { title: '任务 changed @b' } });
    await until(async () => (await db.messageDelivery.findUniqueOrThrow({ where: { id } })).sourceRevision === 2);
    const changed = await db.messageDelivery.findUniqueOrThrow({ where: { id } }); expect(changed.requestFingerprint).toBe(first.requestFingerprint); const next = JSON.parse(changed.intent); expect(next.members).toEqual(frozen.members); expect(next.resolvedRecipients.map((x: any) => x.memberId)).toEqual([frozen.members[1].id]);
    expect((await r.post()).statusCode).toBe(202);
    held.get('任务 initial')!.forEach(fn => fn()); held.delete('任务 initial'); const row = await sent(id); expect(row.actualSentText).toContain('changed @b'); expect(await db.workRequest.count()).toBe(1);
    await deliveries.shutdown(); deliveries = new MessageDeliveryService(db, settings, translation, container.runtime, { taskInputs: inputs, teamRuns }); container.deliveries = deliveries; await deliveries.start(); expect((await r.post()).json().id).toBe(frozen.plannedTeamRunId); expect((await deliveries.get(id)).destination).toEqual({ kind: 'TEAM_ROOM', teamRunId: frozen.plannedTeamRunId, taskId: r.task.id });
  });
  it.each(['send_original','retry_translation','cancel','disabled'] as const)('recovers initial translation failure via %s without early team creation', async action => {
    await enable(); failed.add('任务 initial'); const r = await initial(); const a = await accepted(r);
    await until(async () => (await deliveries.get(a.operationId)).state === 'TRANSLATION_FAILED'); expect(await db.teamRun.count()).toBe(0);
    if (action === 'disabled') { await enable(false); const d = await deliveries.get(a.operationId); await deliveries.action(d.id, 'send_original', d.revision, randomUUID()); await sent(d.id); }
    else { const d = await deliveries.get(a.operationId); failed.clear(); await deliveries.action(d.id, action, d.revision, randomUUID()); if (action === 'cancel') { await wait(40); expect(await db.teamRun.count()).toBe(0); expect((await r.post()).json().state).toBe('CANCELLED'); const fresh = await r.post({ ...r.body, clientSubmissionId: randomUUID() }); expect(fresh.statusCode).toBe(202); expect(fresh.json().operationId).not.toBe(d.id); await sent(fresh.json().operationId); } else await sent(d.id); }
    expect(await db.teamRun.count()).toBe(1);
  });
  it('returns immediate 201 without translation and recovers the same team after a lost response', async () => {
    const r = await initial(); const [first, parallel] = await Promise.all([r.post(), r.post()]); expect(first.statusCode, first.body).toBe(201); expect(parallel.statusCode).toBe(201); expect(parallel.json().id).toBe(first.json().id);
    const retry = await r.post(); expect(retry.statusCode).toBe(201); expect(retry.json().id).toBe(first.json().id);
    expect(await db.teamRun.count()).toBe(1); expect(await db.messageDelivery.count({ where: { state: 'SENT' } })).toBe(1); expect(requests).toHaveLength(0);
  });
  it('explicitly reuses completed translation across disable without translating again', async () => {
    await enable(); const r = await initial(); fault = { model: 'TeamRun', action: 'create' }; const a = await accepted(r);
    await until(async () => (await deliveries.get(a.operationId)).state === 'DELIVERY_FAILED');
    const before = await db.messageDelivery.findUniqueOrThrow({ where: { id: a.operationId } });
    const source = await db.translationSource.findUniqueOrThrow({ where: { id: before.translationSourceId! } });
    expect(before.sentMode).toBe('TRANSLATED'); await enable(false);
    const d = await deliveries.get(before.id); await deliveries.action(d.id, 'retry_delivery', d.revision, randomUUID()); const done = await sent(d.id);
    const snapshot = await db.teamTaskInputSnapshot.findUniqueOrThrow({ where: { id: done.taskInputSnapshotId! } });
    expect(snapshot.effectiveUserText).toBe(before.acceptedText); expect(snapshot.acceptedAttemptId).toBe(source.effectiveAttemptId); expect(snapshot.translationSourceId).toBe(source.id); expect(requests).toHaveLength(1);
    await deliveries.shutdown(); deliveries = new MessageDeliveryService(db, settings, translation, container.runtime, { taskInputs: inputs, teamRuns }); container.deliveries = deliveries; await deliveries.start(); expect((await r.post()).statusCode).toBe(201);
  });
  it.each(['task','project'])('cancels deleted pending %s scope once and revokes late translation', async scope => {
    await enable(); held.set('任务 initial', []); const r = await initial(); const a = await accepted(r); await until(async () => held.get('任务 initial')!.length > 0);
    if (scope === 'task') await db.task.update({ where: { id: r.task.id }, data: { deletedAt: new Date() } });
    else await db.project.update({ where: { id: r.task.projectId }, data: { archivedAt: new Date() } });
    await until(async () => (await db.messageDelivery.findUniqueOrThrow({ where: { id: a.operationId } })).state === 'CANCELLED');
    const cancelled = await db.messageDelivery.findUniqueOrThrow({ where: { id: a.operationId } }); expect(cancelled.lastError).toBe('SOURCE_DELETED');
    held.get('任务 initial')!.forEach(fn => fn()); held.delete('任务 initial'); await wait(60); await deliveries.pump();
    expect((await db.messageDelivery.findUniqueOrThrow({ where: { id: a.operationId } })).revision).toBe(cancelled.revision); expect(await db.teamRun.count()).toBe(0); expect(await db.workRequest.count()).toBe(0);
  });
  it('revises canonical Task fields even when combined text bytes remain equal', async () => {
    await enable(); held.set('任务 initial', []); const r = await initial('任务 initial\n\nb', null); const a = await accepted(r);
    await until(async () => held.get('任务 initial')!.length > 0); const first = await db.messageDelivery.findUniqueOrThrow({ where: { id: a.operationId } });
    await db.task.update({ where: { id: r.task.id }, data: { title: '任务 initial', description: 'b' } });
    await until(async () => (await db.messageDelivery.findUniqueOrThrow({ where: { id: first.id } })).sourceRevision === 2);
    const revised = await db.messageDelivery.findUniqueOrThrow({ where: { id: first.id } }); expect(revised.sourceHash).toBe(first.sourceHash); expect(revised.requestFingerprint).toBe(first.requestFingerprint); expect(JSON.parse(revised.intent).taskSourceHash).not.toBe(JSON.parse(first.intent).taskSourceHash);
    held.get('任务 initial')!.forEach(fn => fn()); held.delete('任务 initial'); const done = await sent(first.id); expect(JSON.parse(done.intent).members).toEqual(JSON.parse(first.intent).members);
    const source = await db.translationSource.findUniqueOrThrow({ where: { id: done.translationSourceId! } }); expect(source.sourceRevision).toBe(2); expect(await db.translationSource.count({ where: { sourceKind: 'TASK_INPUT' } })).toBe(0);
  });
  it('unmatched original mention never broadcasts and frozen preset changes do not alter members', async () => {
    await enable(); held.set('任务 initial', []); const r = await initial('任务 initial @missing');
    const preset = await teamRuns.createMemberPreset(r.body.members[0] as never); r.body = { ...r.body, members: undefined, memberPresetIds: [preset.id] } as any;
    const response = await r.post(r.body); expect(response.statusCode).toBe(202); const a = response.json(); await db.memberPreset.update({ where: { id: preset.id }, data: { name: 'Changed', aliases: '["missing"]', rolePrompt: 'Changed role' } });
    held.get('任务 initial')!.forEach(fn => fn()); held.delete('任务 initial'); await sent(a.operationId); expect(await db.workRequest.count()).toBe(0); expect((await db.teamMember.findFirstOrThrow()).name).toBe('A'); expect((await db.teamMember.findFirstOrThrow()).rolePrompt).toBe('Fixed role');
  });
  it.each([['TeamRun','create'],['TeamMember','create'],['TeamTaskInputSnapshot','create'],['TeamRun','update'],['RoomMessage','create'],['WorkRequest','create'],['RoomMessage','update'],['DeliveryReceipt','create'],['MessageDelivery','update'],['MessageDelivery','updateMany']])('rolls back final %s.%s failure and retries same accepted input/identity', async (model, action) => {
    const r = await initial(); fault = { model, action, ...(model === 'MessageDelivery' ? { predicate: (args: any) => action === 'updateMany' ? args.data.state === 'SENT' : args.data.teamRunId != null } : {}) }; const a = await accepted(r);
    await until(async () => (await deliveries.get(a.operationId)).state === 'DELIVERY_FAILED');
    for (const name of ['teamRun','teamMember','teamTaskInputSnapshot','roomMessage','workRequest','deliveryReceipt','session','agentInvocation'] as const) expect(await (db[name] as any).count(), name).toBe(0);
    const d = await deliveries.get(a.operationId); await deliveries.action(d.id, 'retry_delivery', d.revision, randomUUID()); const done = await sent(d.id); expect(done.teamRunId).toBe(a.destination.plannedTeamRunId); expect(requests).toHaveLength(0);
  });
  it('restarts while pending with the same planned identities and never auto-sends a disabled creation', async () => {
    await enable(); held.set('任务 initial', []); const r = await initial(); const a = await accepted(r);
    await until(async () => held.get('任务 initial')!.length > 0);
    const first = await db.messageDelivery.findUniqueOrThrow({ where: { id: a.operationId } });
    await enable(false); await until(async () => (await deliveries.get(first.id)).state === 'PAUSED_DISABLED');
    held.get('任务 initial')!.forEach(fn => fn()); held.delete('任务 initial'); await deliveries.shutdown();
    deliveries = new MessageDeliveryService(db, settings, translation, container.runtime, { taskInputs: inputs, teamRuns, tickMs: 10 }); container.deliveries = deliveries; await deliveries.start();
    expect((await r.post()).json().destination.plannedTeamRunId).toBe(a.destination.plannedTeamRunId); expect(await db.teamRun.count()).toBe(0);
    await db.task.update({ where: { id: r.task.id }, data: { title: '任务 revised while disabled' } }); await until(async () => (await db.messageDelivery.findUniqueOrThrow({ where: { id: first.id } })).sourceRevision === 2);
    await enable(); const d = await deliveries.get(first.id); await deliveries.action(d.id, 'retry_translation', d.revision, randomUUID()); const done = await sent(d.id);
    expect(done.teamRunId).toBe(a.destination.plannedTeamRunId); expect(done.actualSentText).toContain('revised while disabled'); expect(JSON.parse(done.intent).members).toEqual(JSON.parse(first.intent).members);
  });
  it('rejects simultaneous different UUIDs on one Task and checks capacity before preset expansion', async () => {
    await enable(); held.set('任务 initial', []); const r = await initial(); const results = await Promise.all([r.post(), r.post({ ...r.body, clientSubmissionId: randomUUID() })]);
    expect(results.map(x => x.statusCode).sort()).toEqual([202,409]); expect(await db.messageDelivery.count()).toBe(1); expect(await db.teamRun.count()).toBe(0);
  });
  it.each([['TeamMember', 'create'], ['WorkRequest', 'create']])('rolls back the second %s write with no partial members or requests', async (model, action) => {
    const r = await initial(); let seen = 0; fault = { model, action, predicate: () => ++seen === 2 }; const a = await accepted(r);
    await until(async () => (await deliveries.get(a.operationId)).state === 'DELIVERY_FAILED'); expect(await db.teamRun.count()).toBe(0); expect(await db.teamMember.count()).toBe(0); expect(await db.workRequest.count()).toBe(0); expect(await db.deliveryReceipt.count()).toBe(0);
  });
  it('rejects managed Agent creation and detects damaged committed publication instead of rebuilding', async () => {
    const r = await initial(); const solo = await db.session.create({ data: { context: 'CONVERSATION', agentType: 'CODEX', prompt: 'Managed', status: 'RUNNING' } }); const credential = credentials.createAgentApiCredential({ sessionId: solo.id, invocationId: null }); expect((await app.inject({ method: 'POST', url: `/api/tasks/${r.task.id}/team-runs`, headers: { 'x-agent-tower-agent-credential': credential }, payload: r.body })).statusCode).toBe(403); const a = await accepted(r); const row = await sent(a.operationId); await db.deliveryReceipt.delete({ where: { deliveryId: row.id } }); expect((await r.post()).statusCode).toBe(409); expect(await db.teamRun.count()).toBe(1);
  });
});
