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


  it('review: cancelled last consumer must release an old same-hash input when disabled', async () => {
    const r = await room('AUTO'); await enable(); failed.add('任务 Task T');
    const first = await queued(r); const s = scheduler(r);
    await s.service.startNext(r.team.id);
    await until(async () => (await db.translationSource.findFirst({ where: { sourceKind: 'TASK_INPUT' } }))?.jobState === 'FAILED');
    const snapshot = await db.teamTaskInputSnapshot.findFirstOrThrow();
    await s.service.cancelWorkRequest(first.id, { teamRunId: r.team.id, requesterMemberId: r.members[0]!.id });
    await inputs.cancelUnused(); await enable(false);
    expect(await db.workRequest.count({ where: { status: 'QUEUED', taskInputSnapshotId: snapshot.id } })).toBe(0);
    expect(await db.messageDelivery.count({ where: { taskInputSnapshotId: snapshot.id, state: { notIn: ['SENT', 'CANCELLED'] } } })).toBe(0);
    const next = await queued(r, 1);
    const result = await inputs.ensureForDispatch(r.team.id, { kind: 'WORK_REQUEST', id: next.id });
    console.log('REVIEW_CANCELLED_DEPENDENCY', JSON.stringify({ result, oldState: (await db.workRequest.findUniqueOrThrow({ where: { id: first.id } })).status, input: await inputs.get(r.team.id, snapshot.id) }));
    expect(result.state).toBe('READY');
  });
  it('review control: a different hash after cancelling all consumers is ready when disabled', async () => {
    const r = await room('AUTO'); await enable(); failed.add('任务 Task T');
    const first = await queued(r); const s = scheduler(r);
    await s.service.startNext(r.team.id);
    await until(async () => (await db.translationSource.findFirst({ where: { sourceKind: 'TASK_INPUT' } }))?.jobState === 'FAILED');
    await s.service.cancelWorkRequest(first.id, { teamRunId: r.team.id, requesterMemberId: r.members[0]!.id }); await inputs.cancelUnused(); await enable(false);
    await db.task.update({ where: { id: r.task.id }, data: { title: 'Different task version' } });
    const next = await queued(r, 1);
    expect((await inputs.ensureForDispatch(r.team.id, { kind: 'WORK_REQUEST', id: next.id })).state).toBe('READY');
  });

  it('review: owner HTTP send after cancelling the last dependency remains stuck with translation disabled', async () => {
    const r = await room('AUTO'); await enable(); failed.add('任务 Task T');
    const first = await queued(r); const s = scheduler(r);
    await s.service.startNext(r.team.id);
    await until(async () => (await db.translationSource.findFirst({ where: { sourceKind: 'TASK_INPUT' } }))?.jobState === 'FAILED');
    await s.service.cancelWorkRequest(first.id, { teamRunId: r.team.id, requesterMemberId: r.members[0]!.id });
    await inputs.cancelUnused(); await enable(false);
    expect(await db.workRequest.count({ where: { status: 'QUEUED' } })).toBe(0);
    expect(await db.messageDelivery.count()).toBe(0);
    const accepted = await submit(r, '用户 new submission after cancelling');
    await until(async () => ['WAITING_TASK_INPUT', 'SENT'].includes((await deliveries.get(accepted.operation.operationId)).state));
    for (let n = 0; n < 5; n++) { await deliveries.pump(); await wait(10); }
    const state = (await deliveries.get(accepted.operation.operationId)).state;
    const published = await db.roomMessage.count({ where: { senderType: 'user' } });
    console.log('REVIEW_HTTP_CANCELLED_DEPENDENCY', JSON.stringify({ state, published, oldRequest: (await db.workRequest.findUniqueOrThrow({ where: { id: first.id } })).status, translationEnabled: (await settings.getPublic()).enabled }));
    expect(state).toBe('SENT');
    expect(published).toBe(1);
  });
});
