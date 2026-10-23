import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient, type TranslationSource as SourceRow, type TranslationAttempt as AttemptRow } from '@prisma/client';
import { sessionMsgStoreManager } from '../output/msg-store.js';
import type { NormalizedConversation } from '../output/types.js';
import { getTranslationTextBlocks, type TranslationTextBlock, TEAM_RUN_TRANSLATION_MAX_MESSAGE_IDS, TEAM_RUN_TRANSLATION_PREVIEW_LENGTH, type TeamRunTranslationOverlay, type TeamRunTranslationOverlaySummary, type TranslationInvalidatedPayload, type SessionTranslationOverlay, type TranslationBlockState, type TranslationDirection, type TranslationSettingsDraft } from '@agent-tower/shared';
import { ServiceError } from '../errors.js';
import { TranslationSettingsService, type TranslationExecutionConfig } from './translation-settings.service.js';
import { TranslationClient, TranslationError } from './translation-client.js';
import { prepareTranslation, TRANSLATION_PROTECTION_VERSION } from './translation-protection.js';
import { readTeamDeliveryIntent } from './team-room-delivery.js';
import { buildTaskUserText, assertTaskInputSnapshot } from './team-task-input.js';
import { TranslationQueue, type TranslationQueueRequest } from './translation-queue.js';

const enabledAdapters: Prisma.TranslationSourceWhereInput = { OR: [{ sourceKind: { in: ['SESSION_BLOCK', 'ROOM_MESSAGE', 'TASK_INPUT'] } }, { sourceKind: 'USER_DELIVERY', delivery: { origin: { in: ['TASK_INITIAL', 'TASK_FOLLOWUP', 'CONVERSATION', 'TEAM_USER', 'TEAM_INITIAL'] } } }] };
const ACTIVE = ['PENDING', 'RUNNING', 'RETRY_WAIT'];
const RETRYABLE = ['FAILED', 'CANCELLED', 'INTERRUPTED', 'QUEUE_FULL', 'PAUSED_DISABLED'];
type Db = Prisma.TransactionClient;
type SourceInput =
  | { kind: 'SESSION_BLOCK'; sessionId: string; turnId: string; blockId: string; semanticType: 'assistant_message'; text: string; state: TranslationBlockState; sourceRevision?: number; enableEpoch?: number }
  | { kind: 'ROOM_MESSAGE'; messageId: string }
  | { kind: 'USER_DELIVERY'; deliveryId: string }
  | { kind: 'TASK_INPUT'; snapshotId: string };
interface Limits { sources: number; displaySources: number; laneSources: number; attemptMs: number; chainMs: number; retryDelays: number[]; tickMs: number; leaseMs: number; renewMs: number }
const DEFAULT_LIMITS: Limits = { sources: 512, displaySources: 384, laneSources: 64, attemptMs: 180_000, chainMs: 300_000, retryDelays: [1_000, 4_000], tickMs: 1_000, leaseMs: 30_000, renewMs: 10_000 };
interface Handle { generation: number; controller: AbortController; done: Promise<void> }
type RoomOverlayRow = TeamRunTranslationOverlay & { originalTextTruncated: number | bigint; translatedTextTruncated: number | bigint };

function snapshotBlocks(snapshot: NormalizedConversation | null): Map<string, TranslationTextBlock> | null {
  if (!snapshot) return null;
  const blocks = new Map<string, TranslationTextBlock>();
  for (const entry of snapshot.entries ?? []) {
    if (entry.entryType !== 'assistant_message' || !entry.metadata?.textBlock) continue;
    for (const block of getTranslationTextBlocks(entry.content, entry.metadata.textBlock)) {
      blocks.set(JSON.stringify([block.turnId, block.blockId]), block);
    }
  }
  return blocks;
}

/** App-owned translation state machine; transcript facts remain in MsgStore/Session snapshots. */
export class TranslationService {
  private readonly owner = randomUUID();
  private readonly queue: TranslationQueue;
  private readonly client: TranslationClient;
  private readonly limits: Limits;
  private readonly running = new Map<string, Handle>();
  private readonly drafts = new Set<string>();
  private readonly draftControllers = new Set<AbortController>();
  private readonly circuits = new Set<number>();
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private closed = false;
  private started = false;
  private pumping?: Promise<void>;
  private checkpointOverflow = false;
  private pendingCheckpoints = new Set<string>();
  private checkpointDrain?: Promise<void>;
  private pendingRoomMessages = new Set<string>();
  private roomDrain?: Promise<void>;
  private roomCursor?: { translationEligibilityEpoch: number; id: string };
  private roomUpperBound?: { translationEligibilityEpoch: number; id: string };

  /** No text/config or unbounded promises enter the original publication path. */
  roomMessageCommitted(messageId: string): void {
    if (this.closed) return;
    if (this.pendingRoomMessages.size < 512) this.pendingRoomMessages.add(messageId);
    if (this.started && !this.roomDrain) void this.drainRoomMessages().catch(() => undefined);
  }

  private async registerRoomCandidate(messageId: string): Promise<void> {
    // registerSource repeats both checks in its serialized transaction. This
    // cheap path also avoids redundant invalidation for existing/tombstoned rows.
    const message = await this.db.roomMessage.findUnique({ where: { id: messageId }, select: { translationEligibilityEpoch: true } });
    if (message?.translationEligibilityEpoch == null) return;
    const old = await this.db.translationSource.findUnique({ where: { sourceKind_sourceKey_direction: { sourceKind: 'ROOM_MESSAGE', sourceKey: messageId, direction: 'DISPLAY' } }, select: { id: true } });
    if (!old && !this.closed) await this.registerSource({ kind: 'ROOM_MESSAGE', messageId });
  }

  private async recoverRoomMessages(): Promise<void> {
    if (!this.roomUpperBound) {
      const last = await this.db.roomMessage.findFirst({ where: { translationEligibilityEpoch: { not: null } }, orderBy: [{ translationEligibilityEpoch: 'desc' }, { id: 'desc' }], select: { id: true, translationEligibilityEpoch: true } });
      if (!last || last.translationEligibilityEpoch == null) return;
      this.roomUpperBound = { id: last.id, translationEligibilityEpoch: last.translationEligibilityEpoch };
    }
    const upper = this.roomUpperBound;
    const cursor = this.roomCursor;
    // Index keyset scan, bounded BEFORE the missing-source lookup. Never scan
    // existing history until enough missing sources have been found.
    const candidates = await this.db.$queryRaw<Array<{ id: string; translationEligibilityEpoch: number }>>(Prisma.sql`
      SELECT id, translationEligibilityEpoch FROM RoomMessage
      WHERE translationEligibilityEpoch IS NOT NULL
      AND (translationEligibilityEpoch, id) <= (${upper.translationEligibilityEpoch}, ${upper.id})
      ${cursor ? Prisma.sql`AND (translationEligibilityEpoch, id) > (${cursor.translationEligibilityEpoch}, ${cursor.id})` : Prisma.empty}
      ORDER BY translationEligibilityEpoch ASC, id ASC LIMIT 64`);
    const known = await this.db.translationSource.findMany({ where: { sourceKind: 'ROOM_MESSAGE', direction: 'DISPLAY', sourceKey: { in: candidates.map(row => row.id) } }, select: { sourceKey: true } });
    const present = new Set(known.map(row => row.sourceKey));
    for (const candidate of candidates) {
      if (this.closed) return;
      if (!present.has(candidate.id)) {
        try { await this.registerRoomCandidate(candidate.id); } catch { /* A poison row must not starve later candidates. */ }
      }
    }
    const last = candidates.at(-1);
    if (!last || candidates.length < 64 || last.id === upper.id && last.translationEligibilityEpoch === upper.translationEligibilityEpoch) {
      this.roomCursor = this.roomUpperBound = undefined;
    } else this.roomCursor = last;
  }

  private async drainRoomMessages(): Promise<void> {
    if (this.closed) return;
    if (this.roomDrain) return this.roomDrain;
    this.roomDrain = (async () => {
      // Both lanes receive a fixed budget even under continuous hot traffic.
      for (const id of [...this.pendingRoomMessages].slice(0, 32)) {
        if (this.closed) return;
        this.pendingRoomMessages.delete(id);
        try { await this.registerRoomCandidate(id); } catch { /* Persistent scan repairs lost/failed admission. */ }
      }
      if (!this.closed) await this.recoverRoomMessages();
    })().finally(() => { this.roomDrain = undefined; });
    return this.roomDrain;
  }
  checkpointCommitted(sessionId: string): void {
    if (this.closed) return;
    if (this.pendingCheckpoints.size < 512) this.pendingCheckpoints.add(sessionId);
    else this.checkpointOverflow = true;
    void this.drainCheckpoints();
  }
  private async drainCheckpoints(): Promise<void> {
    if (this.closed || this.checkpointDrain) return;
    this.checkpointDrain = (async () => {
      for (const id of [...this.pendingCheckpoints].slice(0, 64)) {
        this.pendingCheckpoints.delete(id);
        try { await this.syncSessionCheckpoint(id); } catch {
          if (this.pendingCheckpoints.size < 512) this.pendingCheckpoints.add(id);
          else this.checkpointOverflow = true;
        }
      }
      if (this.checkpointOverflow && this.pendingCheckpoints.size < 448) {
        this.checkpointOverflow = false;
        try { await this.recoverSessionCheckpoints(); } catch { this.checkpointOverflow = true; }
      }
    })().finally(() => { this.checkpointDrain = undefined; });
    await this.checkpointDrain;
  }

  private enabledEpoch?: number;
  private listeners = new Set<(payload: TranslationInvalidatedPayload) => void>();
  getAdmissionEpoch = (): number | undefined => this.enabledEpoch;
  onInvalidated(listener: (payload: TranslationInvalidatedPayload) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  private async notify(sourceId: string): Promise<void> {
    const source = await this.db.translationSource.findUnique({ where: { id: sourceId } });
    if (!source) return;
    const revisions = { sourceId, sourceRevision: source.sourceRevision, overlayRevision: source.overlayRevision };
    let payload: TranslationInvalidatedPayload;
    if (source.sourceKind === 'ROOM_MESSAGE' && source.messageId && source.scopeType === 'TEAM_RUN') {
      payload = { teamRunId: source.scopeId, messageId: source.messageId, ...revisions };
    } else if (source.sessionId) payload = { sessionId: source.sessionId, ...revisions };
    else return;
    for (const listener of this.listeners) { try { listener(payload); } catch { /* Display invalidation is best effort. */ } }
  }

  private mutation: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: PrismaClient, private readonly settings: TranslationSettingsService, options: { client?: TranslationClient; queue?: TranslationQueue; limits?: Partial<Limits> } = {}) {
    this.client = options.client ?? new TranslationClient();
    this.queue = options.queue ?? new TranslationQueue({ maxConcurrency: 4 });
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.unsubscribe = settings.onChange((next) => {
      this.enabledEpoch = next.enabled ? next.enableEpoch : undefined;
      this.circuits.clear();
      this.queue.setConcurrency(next.maxConcurrency);
      if (!next.enabled) {
        for (const handle of this.running.values()) handle.controller.abort();
        void this.serial(() => this.pauseRevoked()).catch(() => undefined);
      }
      this.wake();
    });
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(action);
    this.mutation = result.catch(() => undefined);
    return result;
  }

  private async schedule<T>(request: TranslationQueueRequest, execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
    let execution: Promise<T> | undefined;
    try {
      return await this.queue.run(request, (signal) => { execution = execute(signal); return execution; });
    } finally {
      // Queue cancellation rejects the caller promptly, but the transport/claim still
      // owns its resources until it settles. Keep attempt timers and identity alive.
      await execution?.catch(() => undefined);
    }
  }

  async start(): Promise<void> {
    if (this.closed) throw new ServiceError('Translation service is closed', 'TRANSLATION_CLOSED', 409);
    if (this.started) return;
    this.started = true;
    const config = await this.settings.getPublic();
    this.queue.setConcurrency(config.maxConcurrency);
    this.enabledEpoch = config.enabled ? config.enableEpoch : undefined;
    await this.db.$transaction(async (tx) => {
      await tx.translationAttempt.updateMany({ where: { source: enabledAdapters, status: 'RUNNING' }, data: { status: 'INTERRUPTED', errorCode: 'INTERRUPTED', completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null } });
      // Preserve retry deadlines and budgets; an interrupted request is a new attempt with current configuration.
      await tx.translationSource.updateMany({ where: { AND: [enabledAdapters], jobState: 'RUNNING', deletedAt: null }, data: { overlayRevision: { increment: 1 }, jobState: 'PENDING', generation: { increment: 1 } } });
      await tx.translationSource.updateMany({ where: { AND: [enabledAdapters], jobState: { in: ACTIVE }, deletedAt: null, OR: [{ enableEpoch: { not: config.enableEpoch } }, ...(!config.enabled ? [{}] : [])] }, data: { overlayRevision: { increment: 1 }, jobState: 'PAUSED_DISABLED', nextRetryAt: null, generation: { increment: 1 }, errorCode: 'DISABLED' } });
    });
    await this.recoverSessionCheckpoints();
    await this.drainRoomMessages();
    this.timer = setInterval(() => { void this.drainCheckpoints(); if (!this.roomDrain) void this.drainRoomMessages().catch(() => undefined); this.wake(); }, this.limits.tickMs);
    this.timer.unref();
    await this.pump();
  }

  private async pauseRevoked(): Promise<void> {
    const config = await this.settings.getPublic();
    const ids = await this.db.$transaction(async (tx) => {
      const sources = await tx.translationSource.findMany({ where: { AND: [enabledAdapters], jobState: { in: ACTIVE }, deletedAt: null, OR: [{ enableEpoch: { not: config.enableEpoch } }, ...(!config.enabled ? [{}] : [])] }, select: { id: true }, take: 512 });
      const ids = sources.map((source) => source.id);
      await tx.translationSource.updateMany({ where: { id: { in: ids } }, data: { overlayRevision: { increment: 1 }, jobState: 'PAUSED_DISABLED', nextRetryAt: null, generation: { increment: 1 }, errorCode: 'DISABLED' } });
      await tx.translationAttempt.updateMany({ where: { sourceId: { in: ids }, status: 'RUNNING' }, data: { status: 'CANCELLED', errorCode: 'DISABLED', completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null } });
      return ids;
    });
    await Promise.all(ids.map(id => this.notify(id)));
  }

  /** Identity and lane are derived here, never accepted as untrusted scope/source keys. */
  private async resolve(input: SourceInput, tx: Db) {
    if (input.kind === 'SESSION_BLOCK') {
      if (input.semanticType !== 'assistant_message' || !input.turnId || !input.blockId) throw new ServiceError('Only assistant message bodies are eligible', 'INELIGIBLE_SOURCE', 400);
      const session = await this.readableSession(input.sessionId, tx);
      return { scopeType: session.conversationId ? 'CONVERSATION' : 'SESSION', scopeId: session.conversationId ?? session.id, laneKey: session.conversationId ? `conversation:${session.conversationId}` : `session:${session.id}`, sourceKind: input.kind, sourceKey: JSON.stringify([session.id, input.turnId, input.blockId]), sessionId: session.id, turnId: input.turnId, blockId: input.blockId, messageId: null, direction: 'DISPLAY', originalText: input.text, blockState: input.state };
    }
    if (input.kind === 'TASK_INPUT') {
      if (typeof input.snapshotId !== 'string' || !input.snapshotId) throw new ServiceError('Invalid task input source', 'INELIGIBLE_SOURCE', 400);
      const snapshot = await tx.teamTaskInputSnapshot.findUnique({ where: { id: input.snapshotId } });
      if (!snapshot || snapshot.state !== 'PENDING') throw new ServiceError('Input source not found', 'NOT_FOUND', 404);
      await this.assertReadableTeamRun(snapshot.teamRunId, tx);
      if (!await tx.workRequest.count({ where: { taskInputSnapshotId: snapshot.id, status: 'QUEUED' } }) && !await tx.messageDelivery.count({ where: { taskInputSnapshotId: snapshot.id, state: { notIn: ['SENT', 'CANCELLED'] } } })) throw new ServiceError('Input has no active consumer', 'NOT_FOUND', 404);
      await assertTaskInputSnapshot(tx, snapshot);
      return { scopeType: 'TEAM_RUN', scopeId: snapshot.teamRunId, laneKey: `team:${snapshot.teamRunId}`, sourceKind: input.kind, sourceKey: JSON.stringify([snapshot.teamRunId, snapshot.taskSourceHash]), sessionId: null, turnId: null, blockId: null, messageId: null, deliveryId: null, direction: 'SEND', originalText: buildTaskUserText(snapshot.originalTitle, snapshot.originalDescription), blockState: 'SEALED' };
    }
    if (input.kind === 'USER_DELIVERY') {
      const delivery = await tx.messageDelivery.findUnique({ where: { id: input.deliveryId } });
      if (!delivery || JSON.parse(delivery.intent).systemAction || ['CANCELLED', 'SENT'].includes(delivery.state)) throw new ServiceError('Delivery not found', 'NOT_FOUND', 404);
      if (delivery.origin === 'TEAM_INITIAL') readTeamDeliveryIntent(delivery);
      if (delivery.origin === 'TEAM_INITIAL' && delivery.taskId && !delivery.sessionId && !delivery.teamRunId) {
        if (!await tx.task.findFirst({ where: { id: delivery.taskId, deletedAt: null, project: { archivedAt: null } } })) throw new ServiceError('Delivery not found', 'NOT_FOUND', 404);
        return { sourceRevision: delivery.sourceRevision, scopeType: 'TASK', scopeId: delivery.taskId, laneKey: delivery.channelKey, sourceKind: input.kind, sourceKey: delivery.id, deliveryId: delivery.id, sessionId: null, turnId: null, blockId: null, messageId: null, direction: 'SEND', originalText: delivery.originalText, blockState: 'SEALED' };
      }
      if (delivery.origin === 'TEAM_USER' && delivery.taskId && delivery.teamRunId && !delivery.sessionId) {
        await this.assertReadableTeamRun(delivery.teamRunId, tx);
        return { scopeType: 'TEAM_RUN', scopeId: delivery.teamRunId, laneKey: `team:${delivery.teamRunId}`, sourceKind: input.kind, sourceKey: delivery.id, deliveryId: delivery.id, sessionId: null, turnId: null, blockId: null, messageId: null, direction: 'SEND', originalText: delivery.originalText, blockState: 'SEALED' };
      }
      if (!['TASK_INITIAL', 'TASK_FOLLOWUP', 'CONVERSATION'].includes(delivery.origin) || !delivery.sessionId || delivery.taskId || delivery.teamRunId || delivery.taskInputSnapshotId) throw new ServiceError('Delivery destination is not enabled', 'DELIVERY_DESTINATION_DISABLED', 409);
      const session = await this.readableSession(delivery.sessionId, tx);
      return { scopeType: session.conversationId ? 'CONVERSATION' : 'SESSION', scopeId: session.conversationId ?? session.id, laneKey: delivery.channelKey, sourceKind: input.kind, sourceKey: delivery.id, deliveryId: delivery.id, sessionId: session.id, turnId: null, blockId: null, messageId: null, direction: 'SEND', originalText: delivery.originalText, blockState: 'SEALED' };
    }
    if (input.kind !== 'ROOM_MESSAGE') throw new ServiceError('Translation adapter is not enabled', 'INELIGIBLE_SOURCE', 400);
    const message = await tx.roomMessage.findUnique({ where: { id: input.messageId }, include: { teamRun: { include: { task: { include: { project: true } } } } } });
    if (!message || message.senderType !== 'agent' || message.visibility !== 'PUBLIC' || message.teamRun.task.deletedAt || message.teamRun.task.project.archivedAt) throw new ServiceError('Translation source not found', 'NOT_FOUND', 404);
    return { scopeType: 'TEAM_RUN', scopeId: message.teamRunId, laneKey: `team:${message.teamRunId}`, sourceKind: input.kind, sourceKey: message.id, sessionId: null, turnId: null, blockId: null, messageId: message.id, direction: 'DISPLAY', originalText: message.content, blockState: 'SEALED', enableEpoch: message.translationEligibilityEpoch };
  }

  async assertReadableTeamTask(taskId: string) {
    if (!await this.db.task.findFirst({ where: { id: taskId, deletedAt: null, project: { archivedAt: null } } })) throw new ServiceError('Task not found', 'NOT_FOUND', 404);
  }

  private async sourceState(source: SourceRow, tx: Db): Promise<'CURRENT' | 'STALE' | 'DELETED'> {
    try {
      if (source.sourceKind === 'SESSION_BLOCK' && source.sessionId) {
        const session = await this.readableSession(source.sessionId, tx);
        const snapshot = this.sessionSnapshot(session);
        const blocks = snapshotBlocks(snapshot);
        if (blocks && !blocks.has(JSON.stringify([source.turnId, source.blockId]))) {
          const parentId = source.blockId?.replace(/:p\d+$/, '');
          return snapshot?.entries.some(entry => entry.metadata?.textBlock?.turnId === source.turnId
            && entry.metadata.textBlock.blockId === parentId) ? 'STALE' : 'DELETED';
        }
        return this.matchesSnapshot(source, blocks) ? 'CURRENT' : 'STALE';
      }
      else if (source.sourceKind === 'ROOM_MESSAGE' && source.messageId) {
        const live = await this.resolve({ kind: 'ROOM_MESSAGE', messageId: source.messageId }, tx);
        if (source.scopeType !== live.scopeType || source.scopeId !== live.scopeId || source.sourceKey !== live.sourceKey || source.laneKey !== live.laneKey || source.direction !== 'DISPLAY' || source.sessionId !== null || source.deliveryId !== null || source.turnId !== null || source.blockId !== null || source.blockState !== 'SEALED') return 'DELETED';
        if (live.originalText !== source.originalText) return 'STALE';
      } else if (source.sourceKind === 'USER_DELIVERY') {
        const live = await this.resolve({ kind: 'USER_DELIVERY', deliveryId: source.sourceKey }, tx);
        if (live.originalText !== source.originalText || 'sourceRevision' in live && live.sourceRevision !== source.sourceRevision) return 'STALE';
      } else if (source.sourceKind === 'TASK_INPUT') {
        const snapshot = await tx.teamTaskInputSnapshot.findUnique({ where: { translationSourceId: source.id } });
        if (!snapshot || snapshot.state !== 'PENDING') return 'DELETED';
        const live = await this.resolve({ kind: 'TASK_INPUT', snapshotId: snapshot.id }, tx);
        if (live.originalText !== source.originalText || live.sourceKey !== source.sourceKey || live.scopeId !== source.scopeId || live.laneKey !== source.laneKey || source.direction !== 'SEND') return 'DELETED';
      } else return 'DELETED'; // No permissive fallback for unknown adapters.
      return 'CURRENT';
    } catch (error) { if (error instanceof ServiceError && error.code === 'NOT_FOUND') return 'DELETED'; throw error; }
  }

  private async readableSession(sessionId: string, tx: Db) {
    const session = await tx.session.findUnique({ where: { id: sessionId }, include: { workspace: { include: { task: { include: { project: true } } } }, conversation: true } });
    if (!session || session.purpose !== 'CHAT' || session.conversation?.deletedAt || session.workspace?.task.deletedAt || session.workspace?.task.project.archivedAt || (!session.workspace && !session.conversation)) throw new ServiceError('Translation source not found', 'NOT_FOUND', 404);
    return session;
  }

  private sessionSnapshot(session: { id: string; logSnapshot: string | null }): NormalizedConversation | null {
    const live = sessionMsgStoreManager.get(session.id)?.getSnapshot();
    if (live) return live;
    if (!session.logSnapshot) return null;
    try { return JSON.parse(session.logSnapshot) as NormalizedConversation; } catch { return { entries: [] }; }
  }

  private matchesSnapshot(source: SourceRow, blocks: Map<string, TranslationTextBlock> | null): boolean {
    // Internal pre-lifecycle callers have no snapshot. Runtime sources always have a durable checkpoint.
    if (!blocks) return true;
    const block = blocks.get(JSON.stringify([source.turnId, source.blockId]));
    return !!block && block.content === source.originalText && block.sourceRevision === source.sourceRevision && block.state === source.blockState;
  }

  async assertReadableSession(sessionId: string): Promise<void> {
    await this.readableSession(sessionId, this.db);
  }

  /** Called only after the single Session snapshot writer has committed a boundary. */
  async syncSessionCheckpoint(sessionId: string): Promise<void> {
    const session = await this.db.session.findUnique({ where: { id: sessionId }, select: { logSnapshot: true, purpose: true } });
    if (!session?.logSnapshot || session.purpose !== 'CHAT') return;
    let snapshot: NormalizedConversation;
    try { snapshot = JSON.parse(session.logSnapshot) as NormalizedConversation; } catch { return; }
    if (!Array.isArray(snapshot.entries)) return;
    const known = await this.db.translationSource.findMany({ where: { sessionId, sourceKind: 'SESSION_BLOCK' }, select: { id: true, turnId: true, blockId: true, sourceRevision: true, sourceHash: true, blockState: true, jobState: true, deletedAt: true } });
    const versions = new Map(known.map(row => [JSON.stringify([row.turnId, row.blockId]), row]));
    const blocks = snapshotBlocks(snapshot)!;
    // A revised parent may have fewer/different paragraph boundaries. Cancel old
    // sources without tombstoning identities that a later revision can reuse.
    const parents = new Map(snapshot.entries.flatMap(entry => entry.metadata?.textBlock
      ? [[JSON.stringify([entry.metadata.textBlock.turnId, entry.metadata.textBlock.blockId]), entry.metadata.textBlock] as const] : []));
    for (const row of known) {
      if (row.deletedAt || !row.blockId || blocks.has(JSON.stringify([row.turnId, row.blockId]))) continue;
      const parent = parents.get(JSON.stringify([row.turnId, row.blockId.replace(/:p\d+$/, '')]));
      if (!parent || row.jobState !== 'CANCELLED') await this.cancel(row.id, !parent);
    }
    for (const block of blocks.values()) {
      if (block.translationEpoch === undefined) continue;
      const old = versions.get(JSON.stringify([block.turnId, block.blockId]));
      if (old?.deletedAt || old && old.sourceRevision === block.sourceRevision && old.sourceHash === createHash('sha256').update(block.content).digest('hex') && old.blockState === block.state) continue;
      await this.registerSource({ kind: 'SESSION_BLOCK', sessionId, turnId: block.turnId, blockId: block.blockId, semanticType: 'assistant_message', text: block.content, state: block.state, sourceRevision: block.sourceRevision, enableEpoch: block.translationEpoch });
    }
  }

  private async recoverSessionCheckpoints(): Promise<void> {
    let cursor: string | undefined;
    while (true) {
      // Only explicitly marked live output, never static history.
      const sessions = await this.db.session.findMany({ where: { purpose: 'CHAT', logSnapshot: { contains: '"translationEpoch":' }, ...(cursor ? { id: { gt: cursor } } : {}) }, select: { id: true }, orderBy: { id: 'asc' }, take: 64 });
      for (const session of sessions) {
        try { await this.syncSessionCheckpoint(session.id); } catch (error) {
          if (!(error instanceof ServiceError && error.code === 'NOT_FOUND') && this.pendingCheckpoints.size < 512) this.pendingCheckpoints.add(session.id);
        }
      }
      if (sessions.length < 64) break;
      cursor = sessions[sessions.length - 1].id;
    }
  }

  async listSessionOverlays(sessionId: string, options: { blockIds?: string[]; cursor?: string } = {}): Promise<{ items: SessionTranslationOverlay[]; nextCursor: string | null }> {
    const session = await this.readableSession(sessionId, this.db);
    const blocks = snapshotBlocks(this.sessionSnapshot(session));
    const rows = await this.db.translationSource.findMany({ where: { sessionId, sourceKind: 'SESSION_BLOCK', deletedAt: null, ...(options.blockIds ? { blockId: { in: options.blockIds } } : {}), ...(options.cursor ? { id: { gt: options.cursor } } : {}) }, include: { attempts: { where: { status: 'SUCCESS' }, orderBy: { attemptVersion: 'desc' }, take: 1 } }, orderBy: { id: 'asc' }, take: 100 });
    const items: SessionTranslationOverlay[] = [];
    for (const row of rows) {
      if (!this.matchesSnapshot(row, blocks)) continue;
      const attempt = row.attempts.find(a => a.id === row.effectiveAttemptId && a.sourceRevision === row.sourceRevision && a.sourceHash === row.sourceHash);
      items.push({ sourceId: row.id, sessionId, turnId: row.turnId!, blockId: row.blockId!, sourceRevision: row.sourceRevision, overlayRevision: row.overlayRevision, state: row.jobState as SessionTranslationOverlay['state'], originalText: row.originalText, translatedText: attempt?.resultText ?? null, targetLanguage: attempt?.targetLanguage ?? null, errorCode: row.errorCode });
    }
    return { items, nextCursor: rows.length === 100 ? rows[rows.length - 1].id : null };
  }

  async retrySessionOverlay(sessionId: string, sourceId: string, revision: number): Promise<void> {
    await this.assertReadableSession(sessionId);
    const source = await this.db.translationSource.findFirst({ where: { id: sourceId, sessionId, sourceKind: 'SESSION_BLOCK', deletedAt: null } });
    if (!source) throw new ServiceError('Translation source not found', 'NOT_FOUND', 404);
    await this.retry(sourceId, revision);
  }

  async assertReadableTeamRun(teamRunId: string, tx: Db = this.db): Promise<void> {
    const room = await tx.teamRun.findFirst({ where: { id: teamRunId, task: { deletedAt: null, project: { archivedAt: null } } }, select: { id: true } });
    if (!room) throw new ServiceError('Translation source not found', 'NOT_FOUND', 404);
  }

  /** One bounded projection over loaded message IDs; never registers or recovers history. */
  private async roomOverlays(tx: Db, teamRunId: string, messageIds: string[], full = false, sourceId?: string): Promise<RoomOverlayRow[]> {
    if (!messageIds.length) return [];
    const limit = TEAM_RUN_TRANSLATION_PREVIEW_LENGTH;
    return tx.$queryRaw<RoomOverlayRow[]>(Prisma.sql`
      SELECT s.id AS sourceId, m.teamRunId, m.id AS messageId, s.sourceRevision, s.overlayRevision,
        s.jobState AS state, s.errorCode,
        ${full ? Prisma.sql`s.originalText` : Prisma.sql`substr(s.originalText, 1, ${limit})`} AS originalText,
        ${full ? Prisma.sql`a.resultText` : Prisma.sql`substr(a.resultText, 1, ${limit})`} AS translatedText,
        length(s.originalText) > ${limit} AS originalTextTruncated,
        coalesce(length(a.resultText), 0) > ${limit} AS translatedTextTruncated,
        a.targetLanguage
      FROM TranslationSource s
      JOIN RoomMessage m ON m.id = s.messageId AND m.id = s.sourceKey AND m.teamRunId = s.scopeId
      JOIN TeamRun r ON r.id = m.teamRunId
      JOIN Task t ON t.id = r.taskId
      JOIN Project p ON p.id = t.projectId
      LEFT JOIN TranslationAttempt a ON a.id = s.effectiveAttemptId AND a.sourceId = s.id
        AND a.sourceRevision = s.sourceRevision AND a.sourceHash = s.sourceHash AND a.status = 'SUCCESS'
      WHERE m.teamRunId = ${teamRunId} AND m.id IN (${Prisma.join(messageIds)})
        AND m.visibility = 'PUBLIC' AND m.senderType = 'agent' AND t.deletedAt IS NULL AND p.archivedAt IS NULL
        AND s.scopeType = 'TEAM_RUN' AND s.sourceKind = 'ROOM_MESSAGE' AND s.direction = 'DISPLAY'
        AND s.laneKey = ${`team:${teamRunId}`} AND s.sessionId IS NULL AND s.deliveryId IS NULL
        AND s.turnId IS NULL AND s.blockId IS NULL AND s.blockState = 'SEALED' AND s.deletedAt IS NULL
        AND s.originalText = m.content ${sourceId ? Prisma.sql`AND s.id = ${sourceId}` : Prisma.empty}
      ORDER BY s.id LIMIT ${TEAM_RUN_TRANSLATION_MAX_MESSAGE_IDS}
    `);
  }

  async listTeamRunOverlays(teamRunId: string, messageIds: string[]): Promise<{ items: TeamRunTranslationOverlaySummary[] }> {
    const ids = [...new Set(messageIds)];
    if (ids.length > TEAM_RUN_TRANSLATION_MAX_MESSAGE_IDS) throw new ServiceError('Too many message IDs', 'VALIDATION_ERROR', 400);
    return this.db.$transaction(async tx => {
      await this.assertReadableTeamRun(teamRunId, tx);
      const rows = await this.roomOverlays(tx, teamRunId, ids);
      return { items: rows.map(({ originalText, translatedText, originalTextTruncated, translatedTextTruncated, ...metadata }) => ({
        ...metadata, originalTextPreview: originalText, translatedTextPreview: translatedText,
        originalTextTruncated: Boolean(originalTextTruncated), translatedTextTruncated: Boolean(translatedTextTruncated),
      })) };
    });
  }

  async getTeamRunOverlay(teamRunId: string, messageId: string): Promise<TeamRunTranslationOverlay> {
    return this.db.$transaction(async tx => {
      await this.assertReadableTeamRun(teamRunId, tx);
      const [row] = await this.roomOverlays(tx, teamRunId, [messageId], true);
      if (!row) throw new ServiceError('Translation source not found', 'NOT_FOUND', 404);
      const { originalTextTruncated: _original, translatedTextTruncated: _translated, ...overlay } = row;
      return overlay;
    });
  }

  async assertReadableRoomTranslation(teamRunId: string, messageId: string, sourceId: string): Promise<void> {
    const [row] = await this.roomOverlays(this.db, teamRunId, [messageId], false, sourceId);
    if (!row) throw new ServiceError('Translation source not found', 'NOT_FOUND', 404);
  }

  async retryTeamRunOverlay(teamRunId: string, sourceId: string, revision: number): Promise<void> {
    await this.retry(sourceId, revision, teamRunId);
  }

  private async hasCapacity(tx: Db, laneKey: string, direction: string, excluding?: string): Promise<boolean> {
    const where = { AND: [enabledAdapters], deletedAt: null, jobState: { in: ACTIVE }, ...(excluding ? { id: { not: excluding } } : {}) };
    const total = await tx.translationSource.count({ where });
    if (total >= this.limits.sources || await tx.translationSource.count({ where: { ...where, laneKey } }) >= this.limits.laneSources) return false;
    return direction !== 'DISPLAY' || await tx.translationSource.count({ where: { ...where, direction: 'DISPLAY' } }) < this.limits.displaySources;
  }

  async retryDeliverySource(tx: Db, sourceId: string, enableEpoch: number): Promise<void> {
    const source = await tx.translationSource.findUnique({ where: { id: sourceId } });
    if (!source || !['USER_DELIVERY', 'TASK_INPUT'].includes(source.sourceKind) || source.deletedAt) throw new ServiceError('Delivery source not found', 'NOT_FOUND', 404);
    if (source.sourceKind === 'USER_DELIVERY') await this.resolve({ kind: 'USER_DELIVERY', deliveryId: source.deliveryId ?? source.sourceKey }, tx);
    else {
      const snapshot = await tx.teamTaskInputSnapshot.findUnique({ where: { translationSourceId: source.id } });
      if (!snapshot) throw new ServiceError('Input not found', 'NOT_FOUND', 404);
      await this.resolve({ kind: 'TASK_INPUT', snapshotId: snapshot.id }, tx);
    }
    if (!await this.hasCapacity(tx, source.laneKey, 'SEND', source.id)) throw new ServiceError('Translation queue is full', 'QUEUE_FULL', 429);
    await tx.translationSource.update({ where: { id: sourceId }, data: { jobState: 'PENDING', enableEpoch, generation: { increment: 1 }, currentAttemptVersion: { increment: 1 }, effectiveAttemptId: null, retryChainId: randomUUID(), retryCount: 0, budgetStartedAt: null, nextRetryAt: null, errorCode: null, overlayRevision: { increment: 1 } } });
  }

  async registerSource(input: SourceInput): Promise<SourceRow> {
    if (this.closed) throw new ServiceError('Translation service is closed', 'TRANSLATION_CLOSED', 409);
    const result = await this.serial(() => this.db.$transaction(async (tx) => {
      return this.registerSourceInTransaction(tx, input);
    }));
    await this.notify(result.id);
    this.wake();
    return result;
  }

  async registerDeliveryInTransaction(tx: Prisma.TransactionClient, deliveryId: string) { return this.registerSourceInTransaction(tx, { kind: 'USER_DELIVERY', deliveryId }); }

  /** Candidate creation and translation eligibility share one durable transaction. */
  async registerTaskInputInTransaction(tx: Prisma.TransactionClient, snapshotId: string): Promise<SourceRow> {
    if (this.closed) throw new ServiceError('Translation service is closed', 'TRANSLATION_CLOSED', 409);
    return this.registerSourceInTransaction(tx, { kind: 'TASK_INPUT', snapshotId });
  }
  private async registerSourceInTransaction(tx: Prisma.TransactionClient, input: SourceInput): Promise<SourceRow> {
      const data = await this.resolve(input, tx);
      const linkDelivery = async (source: SourceRow) => {
        if (input.kind === 'USER_DELIVERY') {
          const linked = await tx.messageDelivery.updateMany({ where: { id: input.deliveryId, state: 'WAITING_TRANSLATION' }, data: { translationSourceId: source.id } });
          if (!linked.count) throw new ServiceError('Delivery changed', 'DELIVERY_CONFLICT', 409);
        }
        if (input.kind === 'TASK_INPUT') {
          const linked = await tx.teamTaskInputSnapshot.updateMany({ where: { id: input.snapshotId, state: 'PENDING' }, data: { translationSourceId: source.id } });
          if (!linked.count) throw new ServiceError('Task input changed', 'TASK_INPUT_CHANGED', 409);
        }
        return source;
      };
      const config = await tx.translationSettings.findUnique({ where: { id: 'singleton' } });
      const key = { sourceKind: data.sourceKind, sourceKey: data.sourceKey, direction: data.direction };
      const old = await tx.translationSource.findUnique({ where: { sourceKind_sourceKey_direction: key } });
      // Room messages are immutable publication facts. Automatic admission must
      // never reset failure/capacity/success state or resurrect a tombstone.
      if (input.kind === 'TASK_INPUT' && old) return linkDelivery(old);
      if (input.kind === 'ROOM_MESSAGE') {
        if (old) return old;
        if (!('enableEpoch' in data) || data.enableEpoch == null) throw new ServiceError('Message has no translation eligibility', 'INELIGIBLE_SOURCE', 400);
      }
      if (old && input.kind === 'SESSION_BLOCK' && input.sourceRevision !== undefined && input.sourceRevision < old.sourceRevision) return old;
      if (old?.deletedAt) throw new ServiceError('Translation source was deleted', 'NOT_FOUND', 404);
      const sourceHash = createHash('sha256').update(data.originalText).digest('hex');
      if (old && old.sourceHash === sourceHash && old.blockState === data.blockState && (!('sourceRevision' in data) || old.sourceRevision === data.sourceRevision) && (input.kind !== 'SESSION_BLOCK' || input.sourceRevision === undefined || old.sourceRevision === input.sourceRevision)) return linkDelivery(old);
      const eligible = data.blockState === 'SEALED';
      const delivery = input.kind === 'USER_DELIVERY' ? await tx.messageDelivery.findUnique({ where: { id: input.deliveryId } }) : null;
      const roomEpoch = 'enableEpoch' in data ? data.enableEpoch : undefined;
      const epochValid = input.kind === 'USER_DELIVERY' ? delivery != null && delivery.enableEpoch === config?.enableEpoch && delivery.state === 'WAITING_TRANSLATION' : input.kind === 'ROOM_MESSAGE' ? roomEpoch === config?.enableEpoch : input.kind === 'TASK_INPUT' || input.enableEpoch === undefined || input.enableEpoch === config?.enableEpoch;
      const admitted = eligible && config?.enabled && epochValid && await this.hasCapacity(tx, data.laneKey, data.direction, old?.id);
      const jobState = data.blockState === 'ABORTED' ? 'CANCELLED' : !eligible ? 'OPEN' : !config?.enabled || !epochValid ? 'PAUSED_DISABLED' : admitted ? 'PENDING' : 'QUEUE_FULL';
      if (old) {
        this.running.get(old.id)?.controller.abort();
        await tx.translationAttempt.updateMany({ where: { sourceId: old.id, status: 'RUNNING' }, data: { status: 'SUPERSEDED', completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null } });
      }
      const reset = { ...data, ...(input.kind === 'SESSION_BLOCK' && input.sourceRevision !== undefined ? { sourceRevision: input.sourceRevision } : {}), sourceHash, jobState, enableEpoch: input.kind === 'ROOM_MESSAGE' ? roomEpoch! : input.kind === 'SESSION_BLOCK' ? input.enableEpoch ?? config?.enableEpoch ?? 0 : config?.enableEpoch ?? 0, effectiveAttemptId: null, retryChainId: randomUUID(), retryCount: 0, budgetStartedAt: null, nextRetryAt: null, errorCode: jobState === 'QUEUE_FULL' ? 'QUEUE_FULL' : null };
      const saved = await (old ? tx.translationSource.update({ where: { id: old.id }, data: { ...reset, sourceRevision: input.kind === 'SESSION_BLOCK' && input.sourceRevision !== undefined ? input.sourceRevision : 'sourceRevision' in data ? data.sourceRevision : { increment: 1 }, generation: { increment: 1 }, currentAttemptVersion: { increment: 1 }, overlayRevision: { increment: 1 } } }) : tx.translationSource.create({ data: reset }));
      return linkDelivery(saved);
  }

  async retry(sourceId: string, expectedRevision: number, teamRunId?: string): Promise<SourceRow> {
    const result = await this.serial(() => this.db.$transaction(async (tx) => {
      const source = await tx.translationSource.findUnique({ where: { id: sourceId } });
      if (teamRunId !== undefined && (!source || source.sourceKind !== 'ROOM_MESSAGE' || source.scopeType !== 'TEAM_RUN' || source.scopeId !== teamRunId)) throw new ServiceError('Translation source not found', 'NOT_FOUND', 404);
      if (!source || source.deletedAt || await this.sourceState(source, tx) !== 'CURRENT') throw new ServiceError('Translation source not found', 'NOT_FOUND', 404);
      if (source.sourceRevision !== expectedRevision || source.blockState !== 'SEALED' || !RETRYABLE.includes(source.jobState)) throw new ServiceError('Translation source changed', 'TRANSLATION_CONFLICT', 409);
      const config = await tx.translationSettings.findUnique({ where: { id: 'singleton' } });
      if (!config?.enabled) throw new ServiceError('Translation is disabled', 'TRANSLATION_DISABLED', 409);
      if (!await this.hasCapacity(tx, source.laneKey, source.direction, source.id)) throw new ServiceError('Translation queue is full', 'QUEUE_FULL', 429);
      return tx.translationSource.update({ where: { id: source.id }, data: { overlayRevision: { increment: 1 }, jobState: 'PENDING', enableEpoch: config.enableEpoch, generation: { increment: 1 }, currentAttemptVersion: { increment: 1 }, effectiveAttemptId: null, retryChainId: randomUUID(), retryCount: 0, budgetStartedAt: null, nextRetryAt: null, errorCode: null } });
    }));
    await this.notify(result.id);
    this.wake();
    return result;
  }

  abortSource(sourceId: string, beforeGeneration: number): void {
    const handle = this.running.get(sourceId);
    if (handle && handle.generation < beforeGeneration) handle.controller.abort();
  }

  async cancel(sourceId: string, deleted = false): Promise<void> {
    await this.serial(() => this.db.$transaction(async (tx) => {
      await tx.translationSource.updateMany({ where: { id: sourceId, deletedAt: null }, data: { overlayRevision: { increment: 1 }, jobState: 'CANCELLED', generation: { increment: 1 }, currentAttemptVersion: { increment: 1 }, effectiveAttemptId: null, nextRetryAt: null, errorCode: 'CANCELLED', ...(deleted ? { deletedAt: new Date() } : {}) } });
      await tx.translationAttempt.updateMany({ where: { sourceId, status: 'RUNNING' }, data: { status: 'CANCELLED', errorCode: 'CANCELLED', completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null } });
    }));
    this.running.get(sourceId)?.controller.abort();
    await this.notify(sourceId);
    this.wake();
  }

  private wake(): void {
    if (!this.closed && this.started) void this.pump().catch(() => undefined); // Tick retries storage failures; never log text/config.
  }

  async pump(): Promise<void> {
    if (this.closed || !this.started) return;
    if (this.pumping) return this.pumping;
    this.pumping = (async () => {
      const config = await this.settings.getPublic();
      if (!config.enabled) return;
      this.queue.setConcurrency(config.maxConcurrency);
      await this.recoverExpiredLeases();
      // Queued claims remain PENDING until a request slot is acquired. Exclude
      // these bounded, already-owned sources before paging so later lanes enter
      // the fair queue even while earlier lanes keep their requests open.
      const heldSourceIds = [...this.running.keys()];
      const sources = await this.db.translationSource.findMany({ where: { AND: [enabledAdapters], deletedAt: null, jobState: { in: ['PENDING', 'RETRY_WAIT'] }, ...(heldSourceIds.length ? { id: { notIn: heldSourceIds } } : {}), OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date() } }] }, orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }], take: 64 });
      for (const source of sources) {
        if (this.running.has(source.id)) continue;
        const controller = new AbortController();
        const handle: Handle = { generation: source.generation, controller, done: Promise.resolve() };
        this.running.set(source.id, handle);
        handle.done = this.runSource(source, controller).catch(() => undefined).finally(() => {
          if (this.running.get(source.id) === handle) this.running.delete(source.id);
          this.wake();
        });
      }
    })().finally(() => { this.pumping = undefined; });
    return this.pumping;
  }

  private async recoverExpiredLeases(): Promise<void> {
    const expired = await this.db.translationAttempt.findMany({ where: { source: enabledAdapters, status: 'RUNNING', leaseExpiresAt: { lte: new Date() } }, orderBy: [{ leaseExpiresAt: 'asc' }, { id: 'asc' }], take: 64 });
    for (const attempt of expired) {
      const revoked = await this.serial(() => this.db.$transaction(async (tx) => {
        const changed = await tx.translationAttempt.updateMany({ where: { id: attempt.id, status: 'RUNNING', leaseExpiresAt: { lte: new Date() } }, data: { status: 'INTERRUPTED', errorCode: 'LEASE_EXPIRED', completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null } });
        if (!changed.count) return false;
        await tx.translationSource.updateMany({ where: { id: attempt.sourceId, deletedAt: null, jobState: 'RUNNING', generation: attempt.generation, currentAttemptVersion: attempt.attemptVersion }, data: { overlayRevision: { increment: 1 }, jobState: 'PENDING', generation: { increment: 1 }, errorCode: 'LEASE_EXPIRED' } });
        return true;
      }));
      if (revoked) this.running.get(attempt.sourceId)?.controller.abort();
    }
  }

  private async runSource(source: SourceRow, controller: AbortController): Promise<void> {
    let attempt: AttemptRow | undefined;
    let attemptTimer: ReturnType<typeof setTimeout> | undefined;
    let renewTimer: ReturnType<typeof setInterval> | undefined;
    let timedOut = false;
    try {
      // Queue admission precedes attempt creation and configuration snapshotting.
      const execution = await this.schedule({ id: `${source.id}:claim:${source.generation}`, laneKey: source.laneKey, direction: source.direction as TranslationDirection, signal: controller.signal }, async () => {
        if (this.closed || controller.signal.aborted) throw new TranslationError('CANCELLED');
        const config = await this.settings.getExecutionConfig();
        const claimed = await this.serial(() => this.db.$transaction(async (tx) => {
          const live = await tx.translationSource.findUnique({ where: { id: source.id } });
          const settings = await tx.translationSettings.findUnique({ where: { id: 'singleton' } });
          if (!live || live.deletedAt || live.generation !== source.generation || !['PENDING', 'RETRY_WAIT'].includes(live.jobState)) return null;
          if (!settings?.enabled || settings.enableEpoch !== live.enableEpoch) {
            await tx.translationSource.update({ where: { id: live.id }, data: { overlayRevision: { increment: 1 }, jobState: 'PAUSED_DISABLED', errorCode: 'DISABLED', nextRetryAt: null } });
            return null;
          }
          if (settings.revision !== config.revision) return null; // Retry claim with the current configuration, never an obsolete queued snapshot.
          const sourceState = await this.sourceState(live, tx);
          if (sourceState !== 'CURRENT') {
            // Memory can advance before the serialized original checkpoint. Retire
            // this version without tombstoning the canonical source: its next
            // checkpoint must still be able to register the revised block.
            await tx.translationSource.update({ where: { id: live.id }, data: { overlayRevision: { increment: 1 }, jobState: 'CANCELLED', ...(sourceState === 'DELETED' ? { deletedAt: new Date() } : {}), generation: { increment: 1 }, effectiveAttemptId: null, nextRetryAt: null, errorCode: sourceState === 'DELETED' ? 'SOURCE_DELETED' : 'SOURCE_CHANGED' } });
            return null;
          }
          if (live.budgetStartedAt && Date.now() - live.budgetStartedAt.getTime() >= this.limits.chainMs || live.retryCount >= 3) {
            await tx.translationSource.update({ where: { id: live.id }, data: { overlayRevision: { increment: 1 }, jobState: 'FAILED', errorCode: 'RETRY_BUDGET_EXHAUSTED', nextRetryAt: null } });
            return null;
          }
          if (this.circuits.has(config.revision)) {
            await tx.translationSource.update({ where: { id: live.id }, data: { overlayRevision: { increment: 1 }, jobState: 'FAILED', errorCode: 'CONFIG_CIRCUIT_OPEN', nextRetryAt: null } });
            return null;
          }
          const { apiKey: _secret, ...sanitized } = config;
          const row = await tx.translationAttempt.create({ data: { sourceId: live.id, sourceRevision: live.sourceRevision, sourceHash: live.sourceHash, attemptVersion: live.currentAttemptVersion + 1, configRevision: config.revision, credentialRevision: config.credentialRevision, targetLanguage: live.direction === 'SEND' ? config.sendTargetLanguage : config.displayTargetLanguage, sanitizedConfigSnapshot: JSON.stringify(sanitized), protectionVersion: String(TRANSLATION_PROTECTION_VERSION), status: 'RUNNING', generation: live.generation, enableEpoch: live.enableEpoch, retryIndex: live.retryCount, leaseOwner: this.owner, leaseExpiresAt: new Date(Date.now() + this.limits.leaseMs) } });
          await tx.translationSource.update({ where: { id: live.id }, data: { overlayRevision: { increment: 1 }, jobState: 'RUNNING', currentAttemptVersion: row.attemptVersion, effectiveAttemptId: null, budgetStartedAt: live.budgetStartedAt ?? new Date(), retryCount: { increment: 1 }, nextRetryAt: null } });
          return row;
        }));
        if (!claimed) return null;
        attempt = claimed;
        await this.notify(source.id);
        if (controller.signal.aborted || this.closed) throw new TranslationError('CANCELLED');
        attemptTimer = setTimeout(() => { timedOut = true; controller.abort(); }, this.limits.attemptMs);
        renewTimer = setInterval(() => {
          void this.db.translationAttempt.updateMany({ where: { id: claimed.id, status: 'RUNNING', leaseOwner: this.owner, leaseExpiresAt: { gt: new Date() } }, data: { leaseExpiresAt: new Date(Date.now() + this.limits.leaseMs) } }).then((result) => { if (!result.count) controller.abort(); }).catch(() => controller.abort());
        }, this.limits.renewMs);
        renewTimer.unref();
        const prepared = prepareTranslation(source.originalText);
        const results: string[] = [];
        if (prepared.hasTranslatableText) results.push(await this.translateSegment(config, claimed.targetLanguage, prepared.segments[0], controller.signal));
        return { config, prepared, results };
      });
      if (!execution || !attempt) { await this.notify(source.id); return; }
      if (execution.prepared.hasTranslatableText) {
        for (let index = 1; index < execution.prepared.segments.length; index++) {
          const text = execution.prepared.segments[index];
          const config = execution.config;
          const target = attempt.targetLanguage;
          execution.results.push(await this.schedule({ id: `${attempt.id}:${index}`, laneKey: source.laneKey, direction: source.direction as TranslationDirection, signal: controller.signal }, (signal) => this.translateSegment(config, target, text, signal)));
        }
      }
      const resultText = execution.prepared.hasTranslatableText ? execution.prepared.restore(execution.results) : source.originalText;
      if (controller.signal.aborted || this.closed) throw new TranslationError(timedOut ? 'TIMEOUT' : 'CANCELLED');
      await this.complete(source, attempt, resultText, execution.prepared.hasTranslatableText ? 'SUCCESS' : 'NOT_REQUIRED');
    } catch (error) {
      if (attempt) await this.fail(source, attempt, timedOut ? new TranslationError('TIMEOUT', { retryable: true }) : error, controller.signal.aborted);
    } finally {
      if (attemptTimer) clearTimeout(attemptTimer);
      if (renewTimer) clearInterval(renewTimer);
    }
  }

  private translateSegment(config: TranslationExecutionConfig, targetLanguage: string, text: string, signal: AbortSignal) {
    return this.client.translate({ apiBaseUrl: config.apiBaseUrl, model: config.model, apiKey: config.apiKey, promptTemplate: config.promptTemplate, targetLanguage, text, signal });
  }

  private async owns(tx: Db, source: SourceRow, attempt: AttemptRow): Promise<SourceRow | null> {
    const live = await tx.translationSource.findUnique({ where: { id: source.id } });
    const lease = await tx.translationAttempt.findUnique({ where: { id: attempt.id } });
    const config = await tx.translationSettings.findUnique({ where: { id: 'singleton' } });
    if (!live || live.deletedAt || live.jobState !== 'RUNNING' || live.sourceRevision !== attempt.sourceRevision || live.sourceHash !== attempt.sourceHash || live.currentAttemptVersion !== attempt.attemptVersion || live.generation !== attempt.generation || live.enableEpoch !== attempt.enableEpoch || !config?.enabled || config.enableEpoch !== attempt.enableEpoch || lease?.status !== 'RUNNING' || lease.leaseOwner !== this.owner || !lease.leaseExpiresAt || lease.leaseExpiresAt.getTime() <= Date.now() || await this.sourceState(live, tx) !== 'CURRENT') return null;
    return live;
  }

  private async complete(source: SourceRow, attempt: AttemptRow, resultText: string, state: string): Promise<void> {
    await this.serial(() => this.db.$transaction(async (tx) => {
      if (!await this.owns(tx, source, attempt)) {
        await this.retireStale(tx, source, attempt);
        return;
      }
      await tx.translationAttempt.update({ where: { id: attempt.id }, data: { status: 'SUCCESS', resultText, completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null } });
      await tx.translationSource.update({ where: { id: source.id }, data: { overlayRevision: { increment: 1 }, jobState: state, effectiveAttemptId: attempt.id, errorCode: null } });
    }));
    await this.notify(source.id);
  }

  private async retireStale(tx: Db, source: SourceRow, attempt: AttemptRow): Promise<void> {
    await tx.translationAttempt.updateMany({ where: { id: attempt.id, status: 'RUNNING', leaseOwner: this.owner }, data: { status: 'SUPERSEDED', completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null } });
    const config = await tx.translationSettings.findUnique({ where: { id: 'singleton' } });
    const paused = !config?.enabled || config.enableEpoch !== attempt.enableEpoch;
    await tx.translationSource.updateMany({ where: { id: source.id, jobState: 'RUNNING', generation: attempt.generation, sourceRevision: attempt.sourceRevision, currentAttemptVersion: attempt.attemptVersion }, data: { overlayRevision: { increment: 1 }, jobState: paused ? 'PAUSED_DISABLED' : 'FAILED', nextRetryAt: null, errorCode: paused ? 'DISABLED' : 'SOURCE_OR_LEASE_REVOKED' } });
  }

  private async fail(source: SourceRow, attempt: AttemptRow, error: unknown, aborted: boolean): Promise<void> {
    const failure = error instanceof TranslationError ? error : new TranslationError(aborted ? 'CANCELLED' : 'INTERNAL_ERROR');
    if (['AUTH_FAILED', 'MODEL_CONFIG_ERROR'].includes(failure.errorCode) && (await this.settings.getPublic()).revision === attempt.configRevision) this.circuits.add(attempt.configRevision);
    await this.serial(() => this.db.$transaction(async (tx) => {
      const live = await this.owns(tx, source, attempt);
      if (!live) {
        await this.retireStale(tx, source, attempt);
        return;
      }
      const canRetry = !this.closed && failure.retryable && live.retryCount < 3 && Date.now() - live.budgetStartedAt!.getTime() < this.limits.chainMs;
      const delay = Math.max((this.limits.retryDelays[live.retryCount - 1] ?? 4_000) * (1 + Math.random() * .2), Math.min(failure.retryAfterMs ?? 0, 30_000));
      const nextRetryAt = canRetry ? new Date(Date.now() + delay) : null;
      await tx.translationAttempt.update({ where: { id: attempt.id }, data: { status: this.closed ? 'INTERRUPTED' : 'FAILED', errorCode: this.closed ? 'INTERRUPTED' : failure.errorCode, nextRetryAt, completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null } });
      await tx.translationSource.update({ where: { id: source.id }, data: { overlayRevision: { increment: 1 }, jobState: this.closed ? 'INTERRUPTED' : canRetry ? 'RETRY_WAIT' : 'FAILED', nextRetryAt, errorCode: this.closed ? 'INTERRUPTED' : failure.errorCode } });
    }));
    await this.notify(source.id);
  }

  async testDraft(identity: string, draft: TranslationSettingsDraft, text: string, direction: TranslationDirection): Promise<{ resultText: string }> {
    if (this.closed) throw new ServiceError('Translation service is closed', 'TRANSLATION_CLOSED', 409);
    if (this.drafts.has(identity) || this.drafts.size >= 8) throw new ServiceError('Translation test queue is full', 'QUEUE_FULL', 429);
    this.drafts.add(identity);
    const controller = new AbortController();
    this.draftControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.limits.attemptMs);
    try {
      const config = await this.settings.resolveDraft(draft);
      const prepared = prepareTranslation(text);
      if (!prepared.hasTranslatableText) return { resultText: text };
      const translated: string[] = [];
      const id = randomUUID();
      for (let index = 0; index < prepared.segments.length; index++) {
        translated.push(await this.schedule({ id: `test:${id}:${index}`, laneKey: `test:${identity}`, direction: 'SEND', signal: controller.signal }, (signal) => this.translateSegment(config, direction === 'SEND' ? config.sendTargetLanguage : config.displayTargetLanguage, prepared.segments[index], signal)));
      }
      const saved = await this.settings.getExecutionConfig();
      if (saved.revision === config.revision && saved.apiBaseUrl === config.apiBaseUrl && saved.model === config.model && saved.apiKey === config.apiKey) this.circuits.delete(config.revision);
      return { resultText: prepared.restore(translated) };
    } finally {
      clearTimeout(timer);
      this.drafts.delete(identity);
      this.draftControllers.delete(controller);
    }
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.enabledEpoch = undefined;
    this.listeners.clear();
    if (this.timer) clearInterval(this.timer);
    this.unsubscribe?.();
    for (const handle of this.running.values()) handle.controller.abort();
    for (const controller of this.draftControllers) controller.abort();
    await this.checkpointDrain;
    this.pendingCheckpoints.clear();
    await this.roomDrain?.catch(() => undefined);
    this.pendingRoomMessages.clear();
    this.roomCursor = this.roomUpperBound = undefined;
    await this.pumping;
    await this.queue.shutdown();
    await Promise.allSettled([...this.running.values()].map((handle) => handle.done));
    await this.mutation;
    // Interrupted attempts with a valid epoch resume on the next application instance.
    await this.db.translationSource.updateMany({ where: { AND: [enabledAdapters], jobState: 'INTERRUPTED', deletedAt: null }, data: { overlayRevision: { increment: 1 }, jobState: 'PENDING', generation: { increment: 1 } } });
  }
}
