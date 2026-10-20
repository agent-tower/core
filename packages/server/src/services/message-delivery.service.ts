import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import type { Prisma, PrismaClient, MessageDelivery as Row } from '@prisma/client';
import type { MessageDelivery, SessionMessageDelivery, MessageDeliveryAction, MessageDeliveryPage, SessionMessageDeliverySubmission, MessageDeliverySubmission, TeamMessageDelivery, MessageDeliveryInvalidatedPayload, StructuredMention } from '@agent-tower/shared';
import { ServiceError, ValidationError } from '../errors.js';
import { getProviderById } from '../executors/index.js';
import { getProviderRuntimeType } from '../executors/providers.js';
import { resolveDataDir } from '../utils/data-dir.js';
import type { SessionManager } from './session-manager.js';
import type { TranslationService } from './translation.service.js';
import type { TranslationSettingsService } from './translation-settings.service.js';
import { appendAttachmentMarkdownContext, splitAttachmentReferences } from './attachment-context.js';
import type { InputSubmissionEvidence, InputSubmissionObserver } from '../runtime/contracts.js';
import { taskInputHash, buildTaskUserText } from './team-task-input.js';
import type { CreateTeamRunInput, TeamRunService } from './team-run.service.js';
import type { TeamTaskInputService } from './team-task-input.service.js';
import { readTeamDeliveryIntent, verifyPublishedTeamDelivery } from './team-room-delivery.js';
import { ConflictAdmission, ConflictAdmissionGate, type ConflictAdmissionBudget } from './conflict-admission.js';
import { assertConflictAdmissionFreshness, conflictIntentIdentity, recoverConflictResolutionContext, resolveConflictInstructions } from './conflict-resolution-context.js';

const SESSION_DELIVERY_ORIGINS = ['TASK_INITIAL', 'TASK_FOLLOWUP', 'CONVERSATION'];
function requireSessionDelivery(row: Row): asserts row is Row & { sessionId: string } {
  if (!SESSION_DELIVERY_ORIGINS.includes(row.origin) || !row.sessionId || row.taskId || row.teamRunId || row.taskInputSnapshotId) throw new ServiceError('Delivery destination is not enabled', 'DELIVERY_DESTINATION_DISABLED', 409);
}
const ENABLED_DELIVERY_ORIGINS = [...SESSION_DELIVERY_ORIGINS, 'TEAM_USER', 'TEAM_INITIAL'];
const terminal = ['SENT', 'CANCELLED'];
const ready = ['READY', 'WAITING_PREDECESSOR'];
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const conflict = () => new ServiceError('Submission changed; refresh before continuing', 'DELIVERY_CONFLICT', 409);
type Tx = Prisma.TransactionClient;
type Intent = { providerId?: string; retryTask?: boolean; systemAction?: 'resolve_conflicts' };
type DispatchClaim = InputSubmissionObserver & { settle: () => Promise<void> };
type SessionSubmission = { sessionId: string; clientSubmissionId?: string; message?: string; providerId?: string; attachmentIds?: string[]; initial?: boolean; systemAction?: 'resolve_conflicts'; resolutionContextToken?: string; conflictActor?: string };
type Compensation = { generation: number; attempts: number; nextAttemptAt: number };
type ConflictSubmissions = { active: Set<ConflictAdmission>; uncertain: boolean; revision: number };

/** Owns submission identity, ordering and transport receipts. Conversation execution stays in its sole turn pump. */
export class MessageDeliveryService {
  private closed = false;
  private timer?: ReturnType<typeof setInterval>;
  private scan?: Promise<void>;
  private scanCursor?: string;
  private readonly admissions = new Set<ConflictAdmission>();
  private readonly conflictSubmissions = new Map<string, ConflictSubmissions>();
  private readonly preparationSlots = new ConflictAdmissionGate(2, 8);
  private readonly finalTicket = new ConflictAdmissionGate(1, 1);
  private mutationTail: Promise<unknown> = Promise.resolve();
  private readonly active = new Map<string, Promise<void>>();
  // Only claims whose transport has settled enter this queue. A live write waiting for ACK never does.
  private readonly compensations = new Map<string, Compensation>();
  private readonly listeners = new Set<(payload: MessageDeliveryInvalidatedPayload) => void>();
  constructor(private readonly db: PrismaClient, private readonly settings: TranslationSettingsService,
    private readonly translation: TranslationService, private readonly sessions: SessionManager,
    private readonly options: { taskInputs?: TeamTaskInputService; teamRuns?: TeamRunService; roomPublished?: (teamRunId: string, taskId: string) => Promise<void>; tickMs?: number; beforeConfirm?: () => Promise<void>; retryTask?: (taskId: string, workspaceId: string, sessionId: string) => Promise<unknown> } = {}) { this.sessions.setMessageDeliveryService(this); }

  onInvalidated(fn: (payload: MessageDeliveryInvalidatedPayload) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private async notify(id: string) {
    const row = await this.db.messageDelivery.findUnique({ where: { id } });
    if (!row) return;
    const payload: MessageDeliveryInvalidatedPayload | null = ['TEAM_USER','TEAM_INITIAL'].includes(row.origin) && row.taskId ? { taskId: row.taskId, ...(row.teamRunId ? { teamRunId: row.teamRunId } : {}), operationId: id, deliveryRevision: row.revision } : row.sessionId ? { sessionId: row.sessionId, operationId: id, deliveryRevision: row.revision } : null;
    if (payload) for (const fn of this.listeners) { try { fn(payload); } catch { /* REST recovers. */ } }
  }
  private sessionIdFor(row: Row) { requireSessionDelivery(row); return row.sessionId; }
  async assertSession(sessionId: string, tx: Tx = this.db) {
    const session = await tx.session.findUnique({ where: { id: sessionId }, include: { conversation: true, workspace: { include: { task: { include: { project: true } } } } } });
    if (!session || session.purpose !== 'CHAT' || session.conversation?.deletedAt || session.workspace?.task.deletedAt || session.workspace?.task.project.archivedAt || (!session.conversation && !session.workspace)) throw new ServiceError('Delivery scope not found', 'NOT_FOUND', 404);
    // Member sessions belong to TeamRun's admission path (P4), never this owner input adapter.
    if (await tx.agentInvocation.findFirst({ where: { sessionId }, select: { id: true } })) throw new ServiceError('Use the TeamRun room input', 'SESSION_NOT_ADMITTED', 409);
    return session;
  }
  private dto(row: Row, conversationId: string | null): SessionMessageDelivery {
    requireSessionDelivery(row);
    if ((row.origin === 'CONVERSATION') !== !!conversationId) throw conflict();
    const purpose = conversationId ? { origin: 'CONVERSATION' as const, destination: { kind: 'CONVERSATION' as const, sessionId: row.sessionId, conversationId }, conversationId }
      : { origin: row.origin as 'TASK_INITIAL' | 'TASK_FOLLOWUP', destination: { kind: 'SESSION' as const, sessionId: row.sessionId }, conversationId: null };
    return { ...purpose, id: row.id, clientSubmissionId: row.clientSubmissionId, sessionId: row.sessionId,
      channelKey: row.channelKey, sequence: row.sequence, originalText: row.originalText,
      attachmentIds: JSON.parse(row.attachmentIds), state: row.state as MessageDelivery['state'], sentMode: row.sentMode as MessageDelivery['sentMode'],
      acceptedText: row.acceptedText, actualSentText: row.actualSentText, sentAt: row.sentAt?.toISOString() ?? null,
      acceptedDestinationId: row.acceptedDestinationId, lastError: row.lastError, revision: row.revision, createdAt: row.createdAt.toISOString() };
  }
  async get(id: string): Promise<MessageDelivery> {
    const row = await this.db.messageDelivery.findUnique({ where: { id } });
    if (!row) throw new ServiceError('Delivery not found', 'NOT_FOUND', 404);
    if (['TEAM_USER','TEAM_INITIAL'].includes(row.origin)) return this.teamDto(row);
    const session = await this.assertSession(this.sessionIdFor(row));
    return this.dto(row, session.conversationId);
  }
  async list(scopeType: 'SESSION' | 'CONVERSATION' | 'TEAM_TASK', scopeId: string, cursor?: string, filter?: 'pending' | 'sent'): Promise<MessageDeliveryPage> {
    if (scopeType === 'TEAM_TASK') {
      await this.assertTeamTask(scopeId);
      const rows = await this.db.messageDelivery.findMany({ where: { origin: { in: ['TEAM_USER','TEAM_INITIAL'] }, taskId: scopeId, ...(filter === 'pending' ? { state: { notIn: terminal } } : filter === 'sent' ? { state: 'SENT' } : {}), ...(cursor ? { sequence: filter === 'sent' ? { lt: Number(cursor) } : { gt: Number(cursor) } } : {}) }, orderBy: { sequence: filter === 'sent' ? 'desc' : 'asc' }, take: 100 });
      return { items: await Promise.all(rows.map(row => this.teamDto(row))), nextCursor: rows.length === 100 ? String(rows[99].sequence) : null };
    }
    const sessionId = scopeType === 'SESSION' ? scopeId : (await this.db.session.findUnique({ where: { conversationId: scopeId }, select: { id: true } }))?.id;
    if (!sessionId) throw new ServiceError('Delivery scope not found', 'NOT_FOUND', 404);
    const session = await this.assertSession(sessionId);
    const rows = await this.db.messageDelivery.findMany({ where: { origin: { in: SESSION_DELIVERY_ORIGINS }, sessionId, ...(filter === 'pending' ? { state: { notIn: terminal } } : filter === 'sent' ? { state: 'SENT' } : {}), ...(cursor ? { sequence: filter === 'sent' ? { lt: Number(cursor) } : { gt: Number(cursor) } } : {}) }, orderBy: { sequence: filter === 'sent' ? 'desc' : 'asc' }, take: 100 });
    return { items: rows.map(row => this.dto(row, session.conversationId)), nextCursor: rows.length === 100 ? String(rows[99].sequence) : null };
  }
  private async result(id: string): Promise<SessionMessageDeliverySubmission> {
    const delivery = await this.get(id);
    if (delivery.origin === 'TEAM_USER' || delivery.origin === 'TEAM_INITIAL') throw conflict();
    return delivery.origin === 'CONVERSATION'
      ? { operationId: id, state: delivery.state, destination: delivery.destination, destinationId: delivery.conversationId, sessionId: delivery.sessionId, delivery }
      : { operationId: id, state: delivery.state, destination: delivery.destination, destinationId: delivery.sessionId, sessionId: delivery.sessionId, delivery };
  }
  private async assertTeamTask(taskId: string, tx: Tx = this.db) {
    const task = await tx.task.findFirst({ where: { id: taskId, deletedAt: null, project: { archivedAt: null } } });
    if (!task) throw new ServiceError('Delivery scope not found', 'NOT_FOUND', 404);
    return task;
  }
  private async teamDto(row: Row): Promise<TeamMessageDelivery> {
    const intent = readTeamDeliveryIntent(row);
    await this.assertTeamTask(row.taskId!);
    if (row.teamRunId && !await this.db.teamRun.findFirst({ where: { id: row.teamRunId!, taskId: row.taskId! } })) throw conflict();
    const dependency = row.taskInputSnapshotId ? await this.db.teamTaskInputSnapshot.findUnique({ where: { id: row.taskInputSnapshotId }, include: { translationSource: { select: { jobState: true, errorCode: true } } } }) : null;
    const purpose = row.origin === 'TEAM_INITIAL' ? row.teamRunId ? { origin: 'TEAM_INITIAL' as const, destination: { kind: 'TEAM_ROOM' as const, teamRunId: row.teamRunId, taskId: row.taskId! } } : intent.version === 2 ? { origin: 'TEAM_INITIAL' as const, destination: { kind: 'TEAM_ROOM_PENDING' as const, taskId: row.taskId!, plannedTeamRunId: intent.plannedTeamRunId } } : (() => { throw conflict(); })() : { origin: 'TEAM_USER' as const, destination: { kind: 'TEAM_ROOM' as const, teamRunId: row.teamRunId!, taskId: row.taskId! } };
    return { ...purpose,
      id: row.id, clientSubmissionId: row.clientSubmissionId, channelKey: row.channelKey, sequence: row.sequence, originalText: row.originalText,
      attachmentIds: JSON.parse(row.attachmentIds), state: row.state as MessageDelivery['state'], sentMode: row.sentMode as MessageDelivery['sentMode'],
      acceptedText: row.acceptedText, actualSentText: row.actualSentText, sentAt: row.sentAt?.toISOString() ?? null, acceptedDestinationId: row.acceptedDestinationId, lastError: row.lastError, revision: row.revision, createdAt: row.createdAt.toISOString(),
      taskInputSnapshotId: row.taskInputSnapshotId, dependencySummary: dependency ? { snapshotId: dependency.id, state: dependency.state === 'ACCEPTED' ? 'ACCEPTED' : dependency.translationSource?.jobState ?? 'PENDING', errorCode: dependency.translationSource?.errorCode ?? null } : null };
  }
  async submitTeamUser(input: { teamRunId: string; clientSubmissionId: string; content: string; mentions?: StructuredMention[]; artifactRefs?: string[]; attachmentIds?: string[]; kind?: string }): Promise<MessageDeliverySubmission> {
    if (this.closed || !this.options.teamRuns) throw conflict();
    await this.settings.getPublic();
    const fingerprint = sha(JSON.stringify(['TEAM_USER', input.teamRunId, input.content, input.attachmentIds ?? [], input.artifactRefs ?? [], input.mentions ?? [], input.kind ?? null]));
    const row = await this.transaction(async tx => {
      const team = await tx.teamRun.findFirst({ where: { id: input.teamRunId, task: { deletedAt: null, project: { archivedAt: null } } } });
      if (!team) throw new ServiceError('TeamRun not found', 'NOT_FOUND', 404);
      const old = await tx.messageDelivery.findUnique({ where: { clientSubmissionId: input.clientSubmissionId } });
      if (old) {
        await this.assertTeamTask(team.taskId, tx);
        if (old.origin !== 'TEAM_USER' || old.teamRunId !== team.id || old.requestFingerprint !== fingerprint) throw conflict();
        if (old.state === 'SENT') await verifyPublishedTeamDelivery(tx, old);
        return old;
      }
      const { intent } = await this.options.teamRuns!.prepareUserDelivery(tx, team.id, input);
      const channelKey = `task:${team.taskId}:team-room`;
      if (await tx.messageDelivery.count({ where: { channelKey, state: { notIn: terminal } } }) >= 64 || await tx.messageDelivery.count({ where: { origin: { in: ENABLED_DELIVERY_ORIGINS }, state: { notIn: terminal } } }) >= 512) throw new ServiceError('Delivery queue is full', 'DELIVERY_QUEUE_FULL', 429);
      const parts = await splitAttachmentReferences(input.content, tx);
      const attachments = [...new Set([...(input.attachmentIds ?? []), ...parts.attachmentIds])];
      if (await tx.attachment.count({ where: { id: { in: attachments } } }) !== attachments.length) throw new ServiceError('Attachment not found', 'NOT_FOUND', 404);
      const config = await tx.translationSettings.findUniqueOrThrow({ where: { id: 'singleton' } });
      const tail = await tx.messageDelivery.aggregate({ where: { channelKey }, _max: { sequence: true } });
      return tx.messageDelivery.create({ data: { clientSubmissionId: input.clientSubmissionId, requestFingerprint: fingerprint, origin: 'TEAM_USER', taskId: team.taskId, teamRunId: team.id, channelKey, sequence: (tail._max.sequence ?? 0) + 1, originalText: parts.text, sourceHash: sha(parts.text), attachmentIds: JSON.stringify(attachments), intent: JSON.stringify(intent), enableEpoch: config.enableEpoch, requiresTranslation: config.enabled, state: config.enabled ? 'WAITING_TRANSLATION' : 'READY', sentMode: config.enabled ? null : 'ORIGINAL', acceptedText: config.enabled ? null : parts.text } });
    });
    this.wake(); return this.teamResult(row.id);
  }
  async submitTeamInitial(taskId: string, input: CreateTeamRunInput & { clientSubmissionId: string }): Promise<MessageDeliverySubmission> {
    if (this.closed || !this.options.teamRuns) throw conflict();
    await this.settings.getPublic();
    const fingerprint = sha(JSON.stringify(['TEAM_INITIAL', taskId, input.mode, input.teamTemplateId ?? null, input.memberPresetIds ?? [], input.members ?? []]));
    const row = await this.transaction(async tx => {
      const task = await this.assertTeamTask(taskId, tx);
      const old = await tx.messageDelivery.findUnique({ where: { clientSubmissionId: input.clientSubmissionId } });
      if (old) {
        if (old.origin !== 'TEAM_INITIAL' || old.taskId !== taskId || old.requestFingerprint !== fingerprint) throw conflict();
        if (old.state === 'SENT') await verifyPublishedTeamDelivery(tx, old);
        return old;
      }
      if (await tx.teamRun.findUnique({ where: { taskId } })) throw new ServiceError('Task already has a TeamRun', 'TEAM_ALREADY_EXISTS', 409);
      const pending = await tx.messageDelivery.findFirst({ where: { origin: 'TEAM_INITIAL', taskId, state: { notIn: terminal } }, select: { id: true } });
      if (pending) throw new ServiceError(`Team creation already pending: ${pending.id}`, 'TEAM_CREATION_PENDING', 409);
      const channelKey = `task:${taskId}:team-room`;
      if (await tx.messageDelivery.count({ where: { channelKey, state: { notIn: terminal } } }) >= 64 || await tx.messageDelivery.count({ where: { origin: { in: ENABLED_DELIVERY_ORIGINS }, state: { notIn: terminal } } }) >= 512) throw new ServiceError('Delivery queue is full', 'DELIVERY_QUEUE_FULL', 429);
      const intent = await this.options.teamRuns!.prepareInitialDelivery(tx, task, input);
      const text = buildTaskUserText(task.title, task.description);
      if (!text.trim()) throw new ValidationError('Task title is required');
      const config = await tx.translationSettings.findUniqueOrThrow({ where: { id: 'singleton' } });
      const tail = await tx.messageDelivery.aggregate({ where: { channelKey }, _max: { sequence: true } });
      return tx.messageDelivery.create({ data: { clientSubmissionId: input.clientSubmissionId, requestFingerprint: fingerprint, origin: 'TEAM_INITIAL', taskId, channelKey, sequence: (tail._max.sequence ?? 0) + 1,
        originalText: text, sourceHash: sha(text), intent: JSON.stringify(intent), enableEpoch: config.enableEpoch, requiresTranslation: config.enabled,
        state: config.enabled ? 'WAITING_TRANSLATION' : 'READY', sentMode: config.enabled ? null : 'ORIGINAL', acceptedText: config.enabled ? null : text } });
    });
    if (row.state === 'READY' && !row.requiresTranslation) {
      let work = this.active.get(row.id);
      if (!work) {
        work = this.advanceInitial(row).finally(() => this.active.delete(row.id));
        this.active.set(row.id, work);
      }
      await work;
    }
    this.wake(); return this.teamResult(row.id);
  }
  private async teamResult(id: string): Promise<MessageDeliverySubmission> {
    const row = await this.db.messageDelivery.findUniqueOrThrow({ where: { id } });
    const delivery = await this.teamDto(row);
    if (delivery.destination.kind === 'TEAM_ROOM_PENDING' && delivery.origin === 'TEAM_INITIAL') return { operationId: id, state: delivery.state, destination: delivery.destination, delivery } as MessageDeliverySubmission;
    if (delivery.destination.kind !== 'TEAM_ROOM') throw conflict();
    return { operationId: id, state: delivery.state, destination: delivery.destination, destinationId: delivery.destination.teamRunId, delivery } as MessageDeliverySubmission;
  }
  private transaction<T>(fn: (tx: Tx, budget?: ConflictAdmissionBudget) => Promise<T>, admission?: ConflictAdmission): Promise<T> {
    const queued = admission?.budget.phase(2_000, 'tail');
    // SQLite read/modify/write claims are short and serialized; runtime/HTTP waits never hold this queue.
    const run = this.mutationTail.then(async () => {
      queued?.check(); queued?.dispose();
      for (let attempt = 0; ; attempt++) {
        const finalBlock = admission?.budget.phase(5_000, 'connection-and-transaction');
        try {
          return await this.db.$transaction(async tx => {
            const budget = finalBlock?.phase(4_000, 'transaction');
            try { budget?.check(); return await fn(tx, budget); } finally { budget?.dispose(); }
          }, finalBlock ? { maxWait: Math.min(1_000, finalBlock.remainingMs()), timeout: Math.min(4_000, finalBlock.remainingMs()) } : undefined);
        }
        catch (error) { if (admission || attempt >= 2 || !['P2002', 'P2034'].includes((error as { code?: string }).code ?? '')) throw error; }
        finally { finalBlock?.dispose(); }
      }
    }).finally(() => queued?.dispose());
    this.mutationTail = run.catch(() => undefined);
    return run;
  }
  private async duplicate(tx: Tx, clientSubmissionId: string, fingerprint: string) {
    const existing = await tx.messageDelivery.findUnique({ where: { clientSubmissionId } });
    if (!existing) return null;
    await this.assertSession(this.sessionIdFor(existing), tx);
    if (existing.requestFingerprint !== fingerprint) throw conflict();
    return existing;
  }
  private async insert(tx: Tx, input: { clientSubmissionId: string; fingerprint: string; sessionId: string; origin: string; text: string; attachmentIds?: string[]; intent?: Intent; beforeCreate?: () => Promise<unknown>; createGuard?: () => void }) {
    const session = await this.assertSession(input.sessionId, tx);
    const config = await tx.translationSettings.findUniqueOrThrow({ where: { id: 'singleton' } });
    const channelKey = session.conversationId ? `conversation:${session.conversationId}` : `session:${session.id}`;
    if (await tx.messageDelivery.count({ where: { channelKey, state: { notIn: terminal } } }) >= 64
      || await tx.messageDelivery.count({ where: { origin: { in: ENABLED_DELIVERY_ORIGINS }, state: { notIn: terminal } } }) >= 512) {
      throw new ServiceError('Too many pending messages; resolve an earlier submission first', 'DELIVERY_QUEUE_FULL', 429);
    }
    const tail = await tx.messageDelivery.aggregate({ where: { channelKey }, _max: { sequence: true } });
    const translate = config.enabled && !input.intent?.systemAction;
    await input.beforeCreate?.();
    input.createGuard?.();
    return tx.messageDelivery.create({ data: { clientSubmissionId: input.clientSubmissionId, requestFingerprint: input.fingerprint, sessionId: session.id,
      channelKey, sequence: (tail._max.sequence ?? 0) + 1, origin: input.origin, originalText: input.text, sourceHash: sha(input.text),
      attachmentIds: JSON.stringify(input.attachmentIds ?? []), intent: JSON.stringify(input.intent ?? {}), enableEpoch: config.enableEpoch,
      requiresTranslation: translate, state: translate ? 'WAITING_TRANSLATION' : 'READY', sentMode: translate ? null : 'ORIGINAL', acceptedText: translate ? null : input.text } });
  }
  async submitSession(input: SessionSubmission) {
    if (this.closed) throw new ServiceError('Delivery service is closed', 'DELIVERY_CLOSED', 409);
    if (input.systemAction) return this.submitConflict(input);
    await this.settings.getPublic();
    const id = input.clientSubmissionId ?? randomUUID();
    // Fingerprint the caller's intent, not mutable destination fields. Initial prompt is frozen at first submission.
    const requestFields = ['session', input.sessionId, !!input.initial, input.message ?? null, input.providerId ?? null, input.attachmentIds ?? [], input.systemAction ?? null];
    const fingerprint = sha(JSON.stringify(requestFields));
    const row = await this.transaction(async tx => {
      const session = await this.assertSession(input.sessionId, tx);
      // Authorization is checked by the Route before this lookup. Signature/expiry must
      // not strand an already accepted UUID after a process restart or key rotation.
      const existing = await tx.messageDelivery.findUnique({ where: { clientSubmissionId: id } });
      if (existing) {
        await this.assertSession(this.sessionIdFor(existing), tx);
        if (existing.sessionId !== input.sessionId || existing.requestFingerprint !== fingerprint) throw conflict();
        return existing;
      }
      if (input.initial && session.initialDeliveryId) {
        const existing = await tx.messageDelivery.findUniqueOrThrow({ where: { id: session.initialDeliveryId } });
        // A session's initial input can only be submitted once, regardless of retrying HTTP with a new ID.
        return existing;
      }
      const intent = session.inputIntent ? JSON.parse(session.inputIntent) : {};
      const parts = await splitAttachmentReferences(input.initial ? session.prompt : input.message ?? '', tx);
      const attachmentIds = [...new Set([...(input.initial ? intent.attachmentIds ?? [] : input.attachmentIds ?? []), ...parts.attachmentIds])] as string[];
      const row = await this.insert(tx, { clientSubmissionId: id, fingerprint, sessionId: session.id, origin: session.conversationId ? 'CONVERSATION' : input.initial ? 'TASK_INITIAL' : 'TASK_FOLLOWUP',
        text: parts.text, attachmentIds,
        intent: { providerId: input.providerId, retryTask: input.initial ? intent.retryTask : false } });
      if (input.initial) await tx.session.update({ where: { id: session.id }, data: { initialDeliveryId: row.id } });
      return row;
    });
    this.wake(); return this.result(row.id);
  }
  private async submitConflict(input: SessionSubmission): Promise<SessionMessageDeliverySubmission> {
    const admission = new ConflictAdmission();
    this.admissions.add(admission);
    let releasePreparation: (() => void) | undefined;
    let releaseFinal: (() => void) | undefined;
    const id = input.clientSubmissionId ?? randomUUID();
    // Register before any await: a failed PREPARE must see siblings that could still commit.
    const submissions = this.conflictSubmissions.get(id) ?? { active: new Set<ConflictAdmission>(), uncertain: false, revision: 0 };
    this.conflictSubmissions.set(id, submissions);
    submissions.active.add(admission);
    submissions.revision++;
    let writeAttempted = false;
    const actor = input.conflictActor ?? 'owner';
    const fields = ['session', input.sessionId, !!input.initial, input.message ?? null, input.providerId ?? null, input.attachmentIds ?? [], input.systemAction ?? null];
    const legacyFingerprint = sha(JSON.stringify([...fields, input.resolutionContextToken ?? null]));
    const fingerprint = sha(JSON.stringify([...fields, 'conflict-v2', conflictIntentIdentity(input.resolutionContextToken), actor]));
    const existingSubmission = async (tx: Tx) => {
      const existing = await tx.messageDelivery.findUnique({ where: { clientSubmissionId: id } });
      if (!existing) return null;
      await this.assertSession(this.sessionIdFor(existing), tx);
      if (existing.sessionId !== input.sessionId || ![fingerprint, legacyFingerprint, sha(JSON.stringify(fields))].includes(existing.requestFingerprint)) throw conflict();
      return existing;
    };
    try {
      const precheck = admission.budget.phase(1_000, 'precheck');
      let existing: Row | null;
      try {
        await this.assertSession(input.sessionId);
        existing = await existingSubmission(this.db);
        // Accepted identity wins over key/scene/expiry, capacity and internal cancellation.
        if (existing) { this.wake(); return await this.result(existing.id); }
        await this.settings.getPublic(); precheck.check();
      } finally { precheck.dispose(); }
      const slotWait = admission.budget.phase(2_000, 'slot');
      try { releasePreparation = await this.preparationSlots.acquire(slotWait); } finally { slotWait.dispose(); }
      const prepare = admission.budget.phase(6_000, 'prepare');
      let token: string; let text: string;
      try {
        token = input.resolutionContextToken ?? await recoverConflictResolutionContext(this.db, input.sessionId, actor, prepare);
        text = await resolveConflictInstructions(this.db, token, input.sessionId, actor, prepare);
        prepare.check();
      } finally { prepare.dispose(); }
      const ticketWait = admission.budget.phase(2_000, 'ticket');
      try { releaseFinal = await this.finalTicket.acquire(ticketWait); } finally { ticketWait.dispose(); }
      // The single ticket remains owned until the original queued closure has actually settled.
      const row = await this.transaction(async (tx, budget) => {
        const precheck = budget!.phase(500, 'transaction-precheck');
        let create: ConflictAdmissionBudget | undefined;
        try {
          const session = await this.assertSession(input.sessionId, tx);
          const existing = await existingSubmission(tx);
          if (existing) return existing;
          precheck.check();
          if (input.initial && session.initialDeliveryId) return tx.messageDelivery.findUniqueOrThrow({ where: { id: session.initialDeliveryId } });
          const intent = session.inputIntent ? JSON.parse(session.inputIntent) : {};
          const guard = () => { create!.check(); assertConflictAdmissionFreshness(token); };
          const row = await this.insert(tx, { clientSubmissionId: id, fingerprint, sessionId: session.id,
            origin: session.conversationId ? 'CONVERSATION' : input.initial ? 'TASK_INITIAL' : 'TASK_FOLLOWUP',
            text, attachmentIds: [], intent: { providerId: input.providerId, retryTask: input.initial ? intent.retryTask : false, systemAction: 'resolve_conflicts' },
            beforeCreate: async () => {
              precheck.check(); precheck.dispose();
              const final = budget!.phase(2_500, 'final');
              try { await resolveConflictInstructions(tx, token, session.id, actor, final); final.check(); }
              finally { final.dispose(); }
              create = budget!.phase(500, 'create');
            }, createGuard: () => { guard(); writeAttempted = true; } });
          guard();
          if (input.initial) await tx.session.update({ where: { id: session.id }, data: { initialDeliveryId: row.id } });
          guard();
          return row;
        } finally { precheck.dispose(); create?.dispose(); }
      }, admission);
      // A committed record is authoritative even if cancellation races the commit response.
      submissions.revision++;
      this.wake(); return await this.result(row.id);
    } catch (error) {
      // A sibling can commit while this call is outside the tail in PREPARE. A
      // failed/expired capability cannot invalidate its already frozen operation.
      submissions.uncertain ||= writeAttempted;
      let stableAbsence = false;
      // A sibling may commit and retire while SQLite's null result is in flight.
      // Recheck once after membership/acceptance changes; never reject using stale absence.
      for (let read = 0; read < 2; read++) {
        const revision = submissions.revision;
        await this.assertSession(input.sessionId);
        const existing = await existingSubmission(this.db);
        if (existing) { this.wake(); return await this.result(existing.id); }
        if (revision === submissions.revision) { stableAbsence = true; break; }
      }
      // Absence during another callback (or after an ambiguous write in this
      // overlapping group) is not evidence of rejection. Keep the original UUID.
      if (!stableAbsence || submissions.active.size > 1 || (submissions.uncertain && !writeAttempted)) {
        throw new ServiceError('Conflict admission result is not yet known; check the original submission before retrying', 'CONFLICT_ADMISSION_UNCERTAIN', 409);
      }
      // Git/Prisma may wrap an aborted I/O; retain the internal deadline's sanitized reason.
      admission.check(); throw error;
    } finally {
      releaseFinal?.(); releasePreparation?.();
      submissions.active.delete(admission);
      submissions.revision++;
      if (!submissions.active.size) this.conflictSubmissions.delete(id);
      this.admissions.delete(admission); admission.finish();
    }
  }
  async createConversation(input: { prompt: string; providerId: string; variant?: string; attachmentIds?: string[]; clientSubmissionId?: string }) {
    if (this.closed) throw new ServiceError('Delivery service is closed', 'DELIVERY_CLOSED', 409);
    if (!input.prompt.trim()) throw new ValidationError('Prompt is required');
    await this.settings.getPublic();
    const clientSubmissionId = input.clientSubmissionId ?? randomUUID();
    const fingerprint = sha(JSON.stringify(['conversation', input.prompt, input.providerId, input.variant ?? 'DEFAULT', input.attachmentIds ?? []]));
    const row = await this.transaction(async tx => {
      const old = await this.duplicate(tx, clientSubmissionId, fingerprint); if (old) return old;
      const provider = getProviderById(input.providerId); if (!provider) throw new ValidationError('Provider not found');
      const id = randomUUID(); const directoryName = `${Date.now()}-${id.slice(0, 8)}`;
      const conversation = await tx.conversation.create({ data: { id, directoryName, workingDir: path.join(resolveDataDir(), 'conversations', directoryName), title: input.prompt.replace(/\s+/g, ' ').trim().slice(0, 80),
        session: { create: { context: 'CONVERSATION', agentType: provider.agentType, runtimeType: getProviderRuntimeType(provider), providerId: provider.id, variant: input.variant ?? 'DEFAULT', prompt: input.prompt } } }, include: { session: true } });
      const row = await this.insert(tx, { clientSubmissionId, fingerprint, sessionId: conversation.session!.id, origin: 'CONVERSATION', text: input.prompt, attachmentIds: input.attachmentIds });
      await tx.session.update({ where: { id: conversation.session!.id }, data: { initialDeliveryId: row.id } });
      return row;
    });
    this.wake(); return this.result(row.id);
  }
  async start() {
    await this.settings.getPublic();
    // No automatically replayable external claim survives a process boundary.
    await this.transaction(async tx => {
      const publishedRooms = await tx.messageDelivery.findMany({ where: { origin: { in: ['TEAM_USER', 'TEAM_INITIAL'] }, OR: [{ state: 'SENT' }, { roomMessage: { isNot: null } }, { receipt: { isNot: null } }] } });
      for (const row of publishedRooms) await verifyPublishedTeamDelivery(tx, row);
      const interrupted = await tx.messageDelivery.findMany({ where: { origin: { in: SESSION_DELIVERY_ORIGINS }, state: 'DISPATCHING' }, include: { receipt: true } });
      for (const row of interrupted) await tx.messageDelivery.update({ where: { id: row.id }, data: row.receipt?.phase === 'SUBMITTED' && row.receipt.generation === row.revision && row.receipt.runtimeInstanceId && row.receipt.turnId && row.receipt.submittedAt && row.receipt.evidence
        ? { state: 'SENT', actualSentText: row.acceptedText, sentAt: row.receipt.submittedAt, revision: { increment: 1 } }
        : { state: 'DELIVERY_UNKNOWN', lastError: 'INTERRUPTED_DISPATCH', revision: { increment: 1 } } });
      await tx.deliveryReceipt.updateMany({ where: { delivery: { origin: { in: SESSION_DELIVERY_ORIGINS } }, phase: { in: ['CLAIMED', 'WRITING'] } }, data: { phase: 'UNKNOWN' } });
    });
    this.timer = setInterval(() => this.wake(), this.options.tickMs ?? 250); this.timer.unref(); this.wake();
  }
  private wake() { if (!this.closed) void this.pump().catch(() => undefined); }
  async pump() {
    if (this.closed || this.scan) return this.scan;
    this.scan = (async () => {
      await this.compensate();
      await this.options.taskInputs?.cancelUnused();
      if (this.active.size >= 64) return;
      const rows = await this.db.messageDelivery.findMany({ where: { origin: { in: ENABLED_DELIVERY_ORIGINS }, OR: [{ state: { in: ['WAITING_TRANSLATION', 'WAITING_TASK_INPUT', ...ready] } }, { origin: 'TEAM_INITIAL', state: { notIn: terminal } }], id: { ...(this.scanCursor ? { gt: this.scanCursor } : {}), ...(this.active.size ? { notIn: [...this.active.keys()] } : {}) } }, orderBy: { id: 'asc' }, take: 64 - this.active.size });
      // Round-robin keyset scan: blocked channels must not starve unrelated destinations.
      this.scanCursor = rows.length ? rows[rows.length - 1].id : undefined;
      for (const row of rows) {
        const work = this.advance(row).catch(async () => {
          await this.db.messageDelivery.updateMany({ where: { id: row.id, revision: row.revision, state: row.state }, data: { state: row.state === 'WAITING_TRANSLATION' ? 'TRANSLATION_FAILED' : 'DELIVERY_FAILED', lastError: 'PREPARATION_FAILED', revision: { increment: 1 } } });
          await this.notify(row.id);
        }).catch(() => undefined).finally(() => { this.active.delete(row.id); });
        this.active.set(row.id, work);
      }
    })().finally(() => { this.scan = undefined; });
    await this.scan;
  }
  private async advance(row: Row) {
    if (row.origin === 'TEAM_INITIAL') return this.advanceInitial(row);
    if (row.origin === 'TEAM_USER') return this.advanceTeam(row);
    requireSessionDelivery(row);
    try { await this.assertSession(this.sessionIdFor(row)); } catch {
      await this.db.messageDelivery.updateMany({ where: { id: row.id, state: { notIn: ['DISPATCHING', ...terminal] } }, data: { state: 'CANCELLED', lastError: 'SOURCE_DELETED', revision: { increment: 1 } } }); return;
    }
    if (row.state === 'WAITING_TRANSLATION') {
      let source = row.translationSourceId ? await this.db.translationSource.findUnique({ where: { id: row.translationSourceId } }) : null;
      if (!source) {
        source = await this.translation.registerSource({ kind: 'USER_DELIVERY', deliveryId: row.id });
        await this.db.messageDelivery.updateMany({ where: { id: row.id, state: 'WAITING_TRANSLATION', revision: row.revision }, data: { translationSourceId: source.id } });
      }
      if (['SUCCESS', 'NOT_REQUIRED'].includes(source.jobState) && source.effectiveAttemptId) {
        const attempt = await this.db.translationAttempt.findUnique({ where: { id: source.effectiveAttemptId } });
        if (attempt?.resultText != null) await this.db.messageDelivery.updateMany({ where: { id: row.id, state: 'WAITING_TRANSLATION', revision: row.revision }, data: { state: 'READY', acceptedText: attempt.resultText, sentMode: source.jobState === 'NOT_REQUIRED' ? 'ORIGINAL' : 'TRANSLATED', revision: { increment: 1 } } });
      } else if (['FAILED', 'QUEUE_FULL', 'CANCELLED', 'PAUSED_DISABLED'].includes(source.jobState)) {
        await this.db.messageDelivery.updateMany({ where: { id: row.id, state: 'WAITING_TRANSLATION', revision: row.revision }, data: { state: source.jobState === 'PAUSED_DISABLED' ? 'PAUSED_DISABLED' : 'TRANSLATION_FAILED', lastError: source.errorCode ?? source.jobState, revision: { increment: 1 } } });
      }
      const current = await this.db.messageDelivery.findUnique({ where: { id: row.id }, select: { revision: true } });
      if (current?.revision !== row.revision) await this.notify(row.id);
      return;
    }
    // A blocked follower needs no writer transaction until its predecessor settles.
    // The dispatch/admission transaction still rechecks ordering before any side effect.
    if (row.state === 'WAITING_PREDECESSOR' && await this.db.messageDelivery.count({ where: { channelKey: row.channelKey, sequence: { lt: row.sequence }, state: { notIn: terminal } } })) return;
    const session = await this.assertSession(this.sessionIdFor(row));
    if (session.conversationId) {
      await fs.mkdir(session.conversation!.workingDir, { recursive: true });
      const message = await appendAttachmentMarkdownContext(row.acceptedText!, JSON.parse(row.attachmentIds), true);
      const originalText = await appendAttachmentMarkdownContext(row.originalText, JSON.parse(row.attachmentIds), true);
      const admitted = await this.transaction(async tx => {
        if (!await this.canAdvance(tx, row)) return false;
        const turn = await tx.conversationTurn.upsert({ where: { deliveryId: row.id }, update: { status: 'QUEUED', message, originalText, deliveryRevision: row.revision + 1 }, create: { sessionId: row.sessionId, deliveryId: row.id, deliveryRevision: row.revision + 1, message, originalText, userEntryId: `user:${row.id}`, providerId: (JSON.parse(row.intent) as Intent).providerId } });
        await tx.messageDelivery.update({ where: { id: row.id }, data: { state: 'ACCEPTED', acceptedDestinationId: turn.id, revision: { increment: 1 } } });
        return true;
      });
      if (admitted) this.sessions.resumeConversationQueue(row.sessionId);
    } else {
      const observer = await this.claim(row.id, row.revision);
      if (!observer) return;
      try {
        const intent = JSON.parse(row.intent) as Intent;
        if (intent.retryTask && session.workspace) await this.options.retryTask?.(session.workspace.taskId, session.workspace.id, session.id);
        const message = await appendAttachmentMarkdownContext(row.acceptedText!, JSON.parse(row.attachmentIds), true);
        const originalText = await appendAttachmentMarkdownContext(row.originalText, JSON.parse(row.attachmentIds), true);
        if (row.origin === 'TASK_INITIAL' && session.runtimeLaunchClaimCount === 0) await this.sessions.start(row.sessionId, { ...observer, prompt: message, originalText, deliveryId: row.id });
        else await this.sessions.sendMessage(row.sessionId, message, intent.providerId, undefined, { ...observer, originalText, deliveryId: row.id, userEntryId: `user:${row.id}` });
        await observer.settle();
      } catch { await observer.settle(); }
    }
    await this.notify(row.id);
  }
  private async advanceInitial(row: Row) {
    if (!this.options.teamRuns) return;
    try { await this.assertTeamTask(row.taskId!); }
    catch (error) {
      if (!(error instanceof ServiceError) || error.code !== 'NOT_FOUND') throw error;
      const source = await this.transaction(async tx => {
        const changed = await tx.messageDelivery.updateMany({ where: { id: row.id, revision: row.revision, state: { notIn: terminal } }, data: { state: 'CANCELLED', lastError: 'SOURCE_DELETED', revision: { increment: 1 } } });
        if (!changed.count || !row.translationSourceId) return null;
        await tx.translationAttempt.updateMany({ where: { sourceId: row.translationSourceId, status: 'RUNNING' }, data: { status: 'CANCELLED', completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null } });
        return tx.translationSource.update({ where: { id: row.translationSourceId }, data: { jobState: 'CANCELLED', generation: { increment: 1 }, effectiveAttemptId: null, nextRetryAt: null } });
      });
      if (source) this.translation.abortSource(source.id, source.generation);
      return;
    }
    const refreshed = await this.transaction(async tx => {
      const live = await tx.messageDelivery.findUniqueOrThrow({ where: { id: row.id } });
      if (live.revision !== row.revision || terminal.includes(live.state)) return false;
      const task = await this.assertTeamTask(row.taskId!, tx);
      const intent = readTeamDeliveryIntent(live);
      if (intent.version !== 2) throw conflict();
      if (intent.taskSourceHash === taskInputHash(task.title, task.description)) return false;
      const config = await tx.translationSettings.findUniqueOrThrow({ where: { id: 'singleton' } });
      if (live.translationSourceId) {
        await tx.translationAttempt.updateMany({ where: { sourceId: live.translationSourceId, status: 'RUNNING' }, data: { status: 'SUPERSEDED', completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null } });
        await tx.translationSource.update({ where: { id: live.translationSourceId }, data: { jobState: 'CANCELLED', generation: { increment: 1 }, currentAttemptVersion: { increment: 1 }, effectiveAttemptId: null, nextRetryAt: null, ...(!config.enabled ? { originalText: buildTaskUserText(task.title, task.description), sourceHash: sha(buildTaskUserText(task.title, task.description)), sourceRevision: { increment: 1 } } : {}) } });
      }
      const text = buildTaskUserText(task.title, task.description);
      await tx.messageDelivery.update({ where: { id: row.id }, data: { intent: JSON.stringify(this.options.teamRuns!.refreshInitialIntent(intent, task)), originalText: text, sourceHash: sha(text), sourceRevision: { increment: 1 },
        acceptedText: null, sentMode: null, requiresTranslation: true, state: config.enabled ? 'WAITING_TRANSLATION' : 'PAUSED_DISABLED', enableEpoch: config.enableEpoch, lastError: null, revision: { increment: 1 } } });
      if (config.enabled) await this.translation.registerDeliveryInTransaction(tx, row.id);
      return true;
    });
    if (refreshed) {
      if (row.translationSourceId) { const source = await this.db.translationSource.findUnique({ where: { id: row.translationSourceId } }); if (source) this.translation.abortSource(source.id, source.generation); }
      await this.notify(row.id); return;
    }
    if (row.state === 'WAITING_TRANSLATION') {
      const source = row.translationSourceId ? await this.db.translationSource.findUnique({ where: { id: row.translationSourceId } }) : await this.translation.registerSource({ kind: 'USER_DELIVERY', deliveryId: row.id });
      if (!source) return;
      const attempt = source.effectiveAttemptId ? await this.db.translationAttempt.findUnique({ where: { id: source.effectiveAttemptId } }) : null;
      if (['SUCCESS','NOT_REQUIRED'].includes(source.jobState) && attempt?.resultText != null) await this.db.messageDelivery.updateMany({ where: { id: row.id, revision: row.revision, state: row.state }, data: { state: 'READY', acceptedText: attempt.resultText, sentMode: source.jobState === 'NOT_REQUIRED' ? 'ORIGINAL' : 'TRANSLATED', revision: { increment: 1 } } });
      else if (['FAILED','QUEUE_FULL','CANCELLED','PAUSED_DISABLED'].includes(source.jobState)) await this.db.messageDelivery.updateMany({ where: { id: row.id, revision: row.revision, state: row.state }, data: { state: source.jobState === 'PAUSED_DISABLED' ? 'PAUSED_DISABLED' : 'TRANSLATION_FAILED', lastError: source.errorCode ?? source.jobState, revision: { increment: 1 } } });
      await this.notify(row.id); return;
    }
    if (!ready.includes(row.state)) return;
    if (!await this.transaction(tx => this.canAdvance(tx, row))) { await this.notify(row.id); return; }
    try {
      const prepared = await this.options.teamRuns.prepareInitialPublication(row.taskId!);
      const result = await this.transaction(tx => this.options.teamRuns!.publishAcceptedInitialDelivery(tx, row.id, row.revision, prepared));
      const live = await this.db.messageDelivery.findUniqueOrThrow({ where: { id: row.id } });
      if (result && live.teamRunId) await this.options.roomPublished?.(live.teamRunId, row.taskId!);
    } catch (error) {
      const live = await this.db.messageDelivery.findUniqueOrThrow({ where: { id: row.id } });
      if (live.state === 'SENT') await this.db.$transaction(tx => verifyPublishedTeamDelivery(tx, live));
      else if (error instanceof ServiceError && ['TASK_INPUT_CHANGED','DELIVERY_PREDECESSOR','DELIVERY_CONFLICT'].includes(error.code)) return;
      else await this.db.messageDelivery.updateMany({ where: { id: row.id, revision: row.revision, state: row.state }, data: { state: 'DELIVERY_FAILED', lastError: error instanceof ServiceError ? error.code : 'ROOM_PUBLICATION_FAILED', revision: { increment: 1 } } });
    }
    await this.notify(row.id);
  }
  private async advanceTeam(row: Row) {
    if (!this.options.taskInputs || !this.options.teamRuns) return;
    try { await this.assertTeamTask(row.taskId!); }
    catch { await this.db.messageDelivery.updateMany({ where: { id: row.id, revision: row.revision }, data: { state: 'CANCELLED', lastError: 'SOURCE_DELETED', revision: { increment: 1 } } }); return; }
    if (row.state === 'WAITING_TRANSLATION') {
      const source = row.translationSourceId ? await this.db.translationSource.findUnique({ where: { id: row.translationSourceId } }) : await this.translation.registerSource({ kind: 'USER_DELIVERY', deliveryId: row.id });
      if (!source) return;
      const attempt = source.effectiveAttemptId ? await this.db.translationAttempt.findUnique({ where: { id: source.effectiveAttemptId } }) : null;
      if (['SUCCESS', 'NOT_REQUIRED'].includes(source.jobState) && attempt?.resultText != null) await this.db.messageDelivery.updateMany({ where: { id: row.id, revision: row.revision, state: row.state }, data: { state: 'WAITING_TASK_INPUT', acceptedText: attempt.resultText, sentMode: source.jobState === 'NOT_REQUIRED' ? 'ORIGINAL' : 'TRANSLATED', revision: { increment: 1 } } });
      else if (['FAILED', 'QUEUE_FULL', 'CANCELLED', 'PAUSED_DISABLED'].includes(source.jobState)) await this.db.messageDelivery.updateMany({ where: { id: row.id, revision: row.revision, state: row.state }, data: { state: source.jobState === 'PAUSED_DISABLED' ? 'PAUSED_DISABLED' : 'TRANSLATION_FAILED', lastError: source.errorCode ?? source.jobState, revision: { increment: 1 } } });
      await this.notify(row.id); return;
    }
    // All automatic paths, including waiting for a shared input, participate in the enable CAS.
    const allowed = await this.transaction(async tx => {
      const live = await tx.messageDelivery.findUniqueOrThrow({ where: { id: row.id } });
      if (live.revision !== row.revision || !['WAITING_TASK_INPUT', ...ready].includes(live.state)) return false;
      const config = await tx.translationSettings.findUniqueOrThrow({ where: { id: 'singleton' } });
      if (live.enableEpoch !== config.enableEpoch || live.requiresTranslation && !config.enabled) { await tx.messageDelivery.update({ where: { id: row.id }, data: { state: 'PAUSED_DISABLED', revision: { increment: 1 } } }); return false; }
      return true;
    });
    if (!allowed) { await this.notify(row.id); return; }
    const input = await this.options.taskInputs.ensureForDispatch(row.teamRunId!, { kind: 'DELIVERY', id: row.id });
    if (input.state === 'BLOCKED') {
      await this.db.messageDelivery.updateMany({ where: { id: row.id, revision: row.revision, state: { in: ready } }, data: { state: 'WAITING_TASK_INPUT', revision: { increment: 1 } } });
      await this.notify(row.id); return;
    }
    const intent = readTeamDeliveryIntent(row);
    if (row.state === 'WAITING_TASK_INPUT' || intent.taskSourceHash !== input.token.taskSourceHash) {
      await this.db.messageDelivery.updateMany({ where: { id: row.id, revision: row.revision, state: row.state }, data: { state: 'READY', intent: JSON.stringify({ ...intent, taskSourceHash: input.token.taskSourceHash }), revision: { increment: 1 } } });
      await this.notify(row.id); return;
    }
    try {
      const sent = await this.transaction(async tx => {
        if (!await this.canAdvance(tx, row)) return false;
        await this.options.taskInputs!.assertForClaim(tx, row.teamRunId!, { kind: 'DELIVERY', id: row.id }, input.token);
        await this.options.teamRuns!.publishAcceptedUserDelivery(tx, { deliveryId: row.id, expectedRevision: row.revision, enableEpoch: row.enableEpoch, acceptedText: row.acceptedText!, taskInput: input.token });
        return true;
      });
      if (sent) await this.options.roomPublished?.(row.teamRunId!, row.taskId!);
    } catch (error) {
      const live = await this.db.messageDelivery.findUniqueOrThrow({ where: { id: row.id } });
      if (live.state === 'SENT') await this.db.$transaction(tx => verifyPublishedTeamDelivery(tx, live));
      else if (error instanceof ServiceError && ['TASK_INPUT_CHANGED', 'TASK_INPUT_PREDECESSOR', 'DELIVERY_PREDECESSOR', 'DELIVERY_CONFLICT'].includes(error.code)) return;
      else await this.db.messageDelivery.updateMany({ where: { id: row.id, revision: row.revision, state: row.state }, data: { state: 'DELIVERY_FAILED', lastError: error instanceof ServiceError ? error.code : 'ROOM_PUBLICATION_FAILED', revision: { increment: 1 } } });
    }
    await this.notify(row.id);
  }
  private async canAdvance(tx: Tx, row: Row): Promise<boolean> {
    const live = await tx.messageDelivery.findUnique({ where: { id: row.id } });
    if (!live || live.revision !== row.revision || ![...ready, 'ACCEPTED'].includes(live.state)) return false;
    const config = await tx.translationSettings.findUniqueOrThrow({ where: { id: 'singleton' } });
    if (live.enableEpoch !== config.enableEpoch || live.requiresTranslation && !config.enabled) {
      await tx.messageDelivery.update({ where: { id: row.id }, data: { state: 'PAUSED_DISABLED', revision: { increment: 1 } } }); return false;
    }
    if (await tx.messageDelivery.count({ where: { channelKey: row.channelKey, sequence: { lt: row.sequence }, state: { notIn: terminal } } })) {
      if (live.state === 'READY') await tx.messageDelivery.update({ where: { id: row.id }, data: { state: 'WAITING_PREDECESSOR', revision: { increment: 1 } } });
      return false;
    }
    return true;
  }
  async claim(id: string, expectedRevision?: number): Promise<DispatchClaim | null> {
    const claimed = await this.transaction(async tx => {
      const row = await tx.messageDelivery.findUniqueOrThrow({ where: { id } });
      await this.assertSession(this.sessionIdFor(row), tx);
      if (expectedRevision !== undefined && row.revision !== expectedRevision) return null;
      if (!await this.canAdvance(tx, row)) return null;
      const revision = row.revision + 1;
      const changed = await tx.messageDelivery.updateMany({ where: { id, revision: row.revision, state: { in: [...ready, 'ACCEPTED'] } }, data: { state: 'DISPATCHING', revision, lastError: null } });
      if (!changed.count) return null;
      await tx.deliveryReceipt.upsert({ where: { deliveryId: id }, create: { deliveryId: id, generation: revision, phase: 'CLAIMED' }, update: { generation: revision, phase: 'CLAIMED', runtimeInstanceId: null, turnId: null, evidence: null, submittedAt: null } });
      if (row.origin === 'TASK_INITIAL') await tx.session.update({ where: { id: this.sessionIdFor(row) }, data: { prompt: row.acceptedText! } });
      return revision;
    });
    if (!claimed) return null;
    return {
      onSubmitting: evidence => this.recordWriting(id, claimed, evidence),
      onSubmitted: evidence => this.confirm(id, claimed, evidence),
      settle: () => this.settleDispatch(id, claimed),
    };
  }
  private async recordWriting(id: string, generation: number, evidence: InputSubmissionEvidence) {
    const updated = await this.db.deliveryReceipt.updateMany({ where: { deliveryId: id, generation, phase: 'CLAIMED' }, data: { phase: 'WRITING', runtimeInstanceId: evidence.runtimeInstanceId, turnId: evidence.turnId, evidence: evidence.transport } });
    if (!updated.count) throw conflict();
  }
  private async confirm(id: string, generation: number, evidence: InputSubmissionEvidence) {
    await this.options.beforeConfirm?.();
    await this.transaction(async tx => {
      const receipt = await tx.deliveryReceipt.findUniqueOrThrow({ where: { deliveryId: id } });
      if (receipt.generation !== generation || receipt.runtimeInstanceId !== evidence.runtimeInstanceId || receipt.turnId !== evidence.turnId || receipt.evidence !== evidence.transport) throw conflict();
      if (receipt.phase === 'SUBMITTED') return;
      if (receipt.phase !== 'WRITING') throw conflict();
      const row = await tx.messageDelivery.findUniqueOrThrow({ where: { id } });
      if (row.state !== 'DISPATCHING' || row.revision !== generation) throw conflict();
      const now = new Date();
      await tx.deliveryReceipt.update({ where: { deliveryId: id }, data: { phase: 'SUBMITTED', submittedAt: now } });
      await tx.messageDelivery.update({ where: { id }, data: { state: 'SENT', actualSentText: row.acceptedText, sentAt: now, revision: { increment: 1 } } });
    });
    if (this.compensations.get(id)?.generation === generation) this.compensations.delete(id);
    await this.notify(id); this.wake();
  }
  private scheduleCompensation(id: string, generation: number) {
    const existing = this.compensations.get(id);
    if (!existing || existing.generation < generation) this.compensations.set(id, { generation, attempts: 0, nextAttemptAt: 0 });
  }
  private async settleDispatch(id: string, generation: number) {
    this.scheduleCompensation(id, generation);
    const pending = this.compensations.get(id)!;
    if (pending.generation !== generation) return;
    try {
      await this.recoverDispatch(id, generation);
      if (this.compensations.get(id) === pending) this.compensations.delete(id);
      await this.notify(id);
    } catch {
      // Retry storage only, never the input write. Capacity is bounded by admitted pending intents;
      // backoff and batch limits bound work without discarding recovery when an outage lasts longer.
      pending.attempts = Math.min(pending.attempts + 1, 6);
      pending.nextAttemptAt = Date.now() + Math.min(1000, 25 * 2 ** pending.attempts);
    }
  }
  private async compensate() {
    const due = [...this.compensations].filter(([, item]) => item.nextAttemptAt <= Date.now()).slice(0, 64);
    for (const [id, item] of due) await this.settleDispatch(id, item.generation);
  }
  private async recoverDispatch(id: string, generation: number) {
    await this.transaction(async tx => {
      const row = await tx.messageDelivery.findUnique({ where: { id } });
      if (!row || !SESSION_DELIVERY_ORIGINS.includes(row.origin) || row.state !== 'DISPATCHING' || row.revision !== generation) return;
      const receipt = await tx.deliveryReceipt.findUnique({ where: { deliveryId: id } });
      if (receipt?.generation !== generation) return;
      const definitelyNotSubmitted = receipt?.phase === 'CLAIMED';
      await tx.messageDelivery.updateMany({ where: { id, revision: generation, state: 'DISPATCHING' }, data: { state: definitelyNotSubmitted ? 'DELIVERY_FAILED' : 'DELIVERY_UNKNOWN', lastError: definitelyNotSubmitted ? 'NOT_SUBMITTED' : 'SUBMISSION_UNCONFIRMED', revision: { increment: 1 } } });
      await tx.deliveryReceipt.updateMany({ where: { deliveryId: id, generation, phase: { not: 'SUBMITTED' } }, data: { phase: definitelyNotSubmitted ? 'NOT_SUBMITTED' : 'UNKNOWN' } });
    });
  }
  async action(id: string, action: MessageDeliveryAction, expectedRevision: number, actionId: string) {
    const fingerprint = sha(JSON.stringify([id, action, expectedRevision]));
    await this.transaction(async tx => {
      const row = await tx.messageDelivery.findUnique({ where: { id } });
      if (!row) throw new ServiceError('Delivery not found', 'NOT_FOUND', 404);
      if (['TEAM_USER','TEAM_INITIAL'].includes(row.origin)) { readTeamDeliveryIntent(row); await this.assertTeamTask(row.taskId!, tx); }
      else await this.assertSession(this.sessionIdFor(row), tx);
      const old = await tx.deliveryAction.findUnique({ where: { actionId } });
      if (old) { if (old.deliveryId !== id || old.fingerprint !== fingerprint) throw conflict(); return; }
      if (row.revision !== expectedRevision || terminal.includes(row.state) || row.state === 'DISPATCHING') throw conflict();
      const config = await tx.translationSettings.findUniqueOrThrow({ where: { id: 'singleton' } });
      let data: Prisma.MessageDeliveryUpdateManyMutationInput;
      if (row.state === 'DELIVERY_UNKNOWN') {
        if (action === 'confirm_not_sent') data = { state: 'READY' };
        else if (action === 'end_unknown') data = { state: 'CANCELLED' };
        else throw conflict();
      } else if (action === 'cancel') data = { state: 'CANCELLED' };
      else if (action === 'send_original' && ['TRANSLATION_FAILED', 'PAUSED_DISABLED', 'WAITING_TRANSLATION', 'WAITING_TASK_INPUT', ...ready, 'ACCEPTED'].includes(row.state)) data = { state: 'READY', requiresTranslation: false, acceptedText: row.originalText, sentMode: 'ORIGINAL' };
      else if (action === 'retry_delivery' && ['DELIVERY_FAILED', 'PAUSED_DISABLED'].includes(row.state) && row.acceptedText != null) data = { state: 'READY', requiresTranslation: false };
      else if (action === 'retry_translation' && ['TRANSLATION_FAILED', 'PAUSED_DISABLED'].includes(row.state) && config.enabled && !(JSON.parse(row.intent) as Intent).systemAction) {
        data = { state: 'WAITING_TRANSLATION', requiresTranslation: true, acceptedText: null, sentMode: null };
        if (row.translationSourceId) await this.translation.retryDeliverySource(tx, row.translationSourceId, config.enableEpoch);
      } else throw conflict();
      const changed = await tx.messageDelivery.updateMany({ where: { id, revision: expectedRevision, state: row.state }, data: { ...data, enableEpoch: config.enableEpoch, lastError: null, revision: { increment: 1 } } });
      if (!changed.count) throw conflict();
      // No queue claim can cross this transaction. Re-admission creates/reuses the same stable turn.
      await tx.conversationTurn.updateMany({ where: { deliveryId: id, status: { in: ['QUEUED', 'RUNNING', 'FAILED', 'PAUSED'] } }, data: { status: data.state === 'CANCELLED' ? 'CANCELLED' : 'PAUSED' } });
      if (row.translationSourceId && action !== 'retry_translation' && action !== 'retry_delivery' && action !== 'confirm_not_sent') {
        await tx.translationSource.update({ where: { id: row.translationSourceId }, data: { jobState: 'CANCELLED', generation: { increment: 1 }, currentAttemptVersion: { increment: 1 }, effectiveAttemptId: null, nextRetryAt: null } });
      }
      await tx.deliveryAction.create({ data: { actionId, deliveryId: id, fingerprint } });
    });
    const updated = await this.db.messageDelivery.findUniqueOrThrow({ where: { id } });
    if (updated.translationSourceId && !['retry_delivery', 'confirm_not_sent'].includes(action)) {
      const source = await this.db.translationSource.findUnique({ where: { id: updated.translationSourceId }, select: { generation: true } });
      if (source) this.translation.abortSource(updated.translationSourceId, source.generation);
    }
    await this.notify(id); this.wake();
    return ['TEAM_USER','TEAM_INITIAL'].includes(updated.origin) ? this.teamResult(id) : this.result(id);
  }
  async shutdown() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const admission of this.admissions) admission.cancel();
    await Promise.all([...this.admissions].map(admission => admission.settled));
    await this.scan;
    await Promise.allSettled([...this.active.values()]);
    this.compensations.clear(); this.listeners.clear();
  }
}
