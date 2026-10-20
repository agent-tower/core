import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient, TeamTaskInputSnapshot } from '@prisma/client';
import type { TeamTaskInputSummary, TeamTaskInputDetail, AgentTeamTaskInput } from '@agent-tower/shared';
import { ServiceError } from '../errors.js';
import { buildTextPreview } from '../utils/text-preview.js';
import type { TranslationService } from './translation.service.js';
import { acceptTaskInputCandidate, adoptTaskInputInTransaction, assertAcceptedTaskInput, buildTaskUserText, taskInputHash, type TaskInputAcceptanceToken } from './team-task-input.js';

type Tx = Prisma.TransactionClient;
export type TaskInputConsumer = { kind: 'DELIVERY' | 'WORK_REQUEST'; id: string };
export type TaskInputPreflight = { state: 'READY'; token: TaskInputAcceptanceToken } | { state: 'BLOCKED'; snapshotId: string };
const pendingDelivery = { state: { notIn: ['SENT', 'CANCELLED'] } };
const changed = () => new ServiceError('Task input changed; prepare again', 'TASK_INPUT_CHANGED', 409);

/** A shared dependency, owned by real dispatch consumers; Task edits do not enqueue work. */
export class TeamTaskInputService {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly db: PrismaClient, private readonly translation: TranslationService) {}
  private transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      for (let attempt = 0; ; attempt++) {
        try { return await this.db.$transaction(fn); }
        catch (error) { if (attempt >= 2 || !['P2002', 'P2034'].includes((error as { code?: string }).code ?? '')) throw error; }
      }
    });
    this.tail = result.catch(() => undefined); return result;
  }
  async assertTeam(teamRunId: string, tx: Tx = this.db) {
    const team = await tx.teamRun.findFirst({ where: { id: teamRunId, task: { deletedAt: null, project: { archivedAt: null } } }, include: { task: true } });
    if (!team) throw new ServiceError('Team input not found', 'NOT_FOUND', 404);
    return team;
  }
  /** The first still-active consumer defines order, never a reusable snapshot's creation date. */
  async head(tx: Tx, teamRunId: string, before?: { id: string; createdAt: Date }) {
    const order = before ? { OR: [{ createdAt: { lt: before.createdAt } }, { createdAt: before.createdAt, id: { lte: before.id } }] } : {};
    const [wr, md] = await Promise.all([
      tx.workRequest.findFirst({ where: { teamRunId, ...order, status: 'QUEUED', taskInputSnapshot: { state: 'PENDING' } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, createdAt: true, taskInputSnapshotId: true } }),
      tx.messageDelivery.findFirst({ where: { teamRunId, ...order, ...pendingDelivery, taskInputSnapshot: { state: 'PENDING' } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, createdAt: true, taskInputSnapshotId: true } }),
    ]);
    return [wr, md].filter((item): item is NonNullable<typeof item> => !!item).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))[0]?.taskInputSnapshotId ?? null;
  }
  async ensureForDispatch(teamRunId: string, consumer: TaskInputConsumer): Promise<TaskInputPreflight> {
    // Resolve an older dependency before considering the current exact Task version.
    for (let pass = 0; pass < 3; pass++) {
      const selected = await this.transaction(async tx => {
        const team = await this.assertTeam(teamRunId, tx);
        const row = consumer.kind === 'DELIVERY' ? await tx.messageDelivery.findUnique({ where: { id: consumer.id } }) : await tx.workRequest.findUnique({ where: { id: consumer.id } });
        if (!row || row.teamRunId !== teamRunId || (consumer.kind === 'DELIVERY' ? ['SENT', 'CANCELLED'].includes((row as { state: string }).state) : (row as { status: string }).status !== 'QUEUED')) throw changed();
        const previous = row.taskInputSnapshotId ? await tx.teamTaskInputSnapshot.findUnique({ where: { id: row.taskInputSnapshotId } }) : null;
        const hash = taskInputHash(team.task.title, team.task.description);
        const existing = previous?.state === 'PENDING' ? previous : await tx.teamTaskInputSnapshot.findUnique({ where: { teamRunId_taskSourceHash: { teamRunId, taskSourceHash: hash } } });
        let snapshot = existing ?? await tx.teamTaskInputSnapshot.create({ data: { teamRunId, taskId: team.taskId, taskSourceHash: hash, originalTitle: team.task.title, originalDescription: team.task.description } });
        if (snapshot.state === 'PENDING') {
          const config = await tx.translationSettings.findUnique({ where: { id: 'singleton' } });
          // Check ownership before binding: an abandoned candidate is a new
          // dependency, but even this consumer's repeated preflight is not.
          // Read ownership/config and accept in the same transaction as binding.
          if (!config?.enabled && !await tx.workRequest.count({ where: { taskInputSnapshotId: snapshot.id, status: 'QUEUED' } })
            && !await tx.messageDelivery.count({ where: { taskInputSnapshotId: snapshot.id, ...pendingDelivery } })) {
            snapshot = await acceptTaskInputCandidate(tx, teamRunId, snapshot.taskId, this.originalToken(snapshot));
          }
        }
        if (consumer.kind === 'DELIVERY') await tx.messageDelivery.update({ where: { id: consumer.id }, data: { taskInputSnapshotId: snapshot.id } });
        else await tx.workRequest.update({ where: { id: consumer.id }, data: { taskInputSnapshotId: snapshot.id } });
        if (snapshot.state === 'PENDING' && !snapshot.translationSourceId) {
          await this.translation.registerTaskInputInTransaction(tx, snapshot.id);
          snapshot = await tx.teamTaskInputSnapshot.findUniqueOrThrow({ where: { id: snapshot.id } });
        }
        const headId = await this.head(tx, teamRunId, row);
        return { snapshot: headId && headId !== snapshot.id ? await tx.teamTaskInputSnapshot.findUniqueOrThrow({ where: { id: headId } }) : snapshot, ownId: snapshot.id, currentHash: hash };
      });
      let snapshot = selected.snapshot;
      if (snapshot.state === 'PENDING' && snapshot.translationSourceId) {
        const source = await this.db.translationSource.findUniqueOrThrow({ where: { id: snapshot.translationSourceId } });
        if (['SUCCESS', 'NOT_REQUIRED'].includes(source.jobState) && source.effectiveAttemptId) {
          const attempt = await this.db.translationAttempt.findUniqueOrThrow({ where: { id: source.effectiveAttemptId } });
          if (attempt.resultText != null) snapshot = await this.transaction(tx => acceptTaskInputCandidate(tx, teamRunId, snapshot.taskId, { snapshotId: snapshot.id, revision: snapshot.revision, taskSourceHash: snapshot.taskSourceHash, effectiveUserText: attempt.resultText!, acceptedAttemptId: source.jobState === 'NOT_REQUIRED' ? null : attempt.id, sentMode: source.jobState === 'NOT_REQUIRED' ? 'ORIGINAL' : 'TRANSLATED' }));
        }
      }
      if (snapshot.state === 'PENDING') return { state: 'BLOCKED', snapshotId: snapshot.id };
      if (snapshot.id !== selected.ownId || snapshot.taskSourceHash !== selected.currentHash) continue;
      await assertAcceptedTaskInput(this.db, snapshot);
      return { state: 'READY', token: this.token(snapshot) };
    }
    const head = await this.head(this.db, teamRunId);
    return { state: 'BLOCKED', snapshotId: head ?? '' };
  }
  private originalToken(s: TeamTaskInputSnapshot): TaskInputAcceptanceToken { return { snapshotId: s.id, revision: s.revision, taskSourceHash: s.taskSourceHash, effectiveUserText: buildTaskUserText(s.originalTitle, s.originalDescription), sentMode: 'ORIGINAL', acceptedAttemptId: null }; }
  private token(s: TeamTaskInputSnapshot): TaskInputAcceptanceToken { return { snapshotId: s.id, revision: s.revision, taskSourceHash: s.taskSourceHash, effectiveUserText: s.effectiveUserText!, sentMode: s.sentMode as 'ORIGINAL' | 'TRANSLATED', acceptedAttemptId: s.acceptedAttemptId }; }
  async assertForClaim(tx: Tx, teamRunId: string, consumer: TaskInputConsumer, token: TaskInputAcceptanceToken) {
    const team = await this.assertTeam(teamRunId, tx);
    const row = consumer.kind === 'WORK_REQUEST' ? await tx.workRequest.findUnique({ where: { id: consumer.id } }) : await tx.messageDelivery.findUnique({ where: { id: consumer.id } });
    if (!row || row.teamRunId !== teamRunId || (consumer.kind === 'WORK_REQUEST' ? (row as { status: string }).status !== 'QUEUED' : ['SENT', 'CANCELLED'].includes((row as { state: string }).state)) || row.taskInputSnapshotId !== token.snapshotId || await this.head(tx, teamRunId, row)) throw changed();
    const snapshot = await tx.teamTaskInputSnapshot.findUniqueOrThrow({ where: { id: token.snapshotId } });
    await assertAcceptedTaskInput(tx, snapshot);
    return adoptTaskInputInTransaction(tx, teamRunId, team.taskId, token);
  }
  private summarySelect = {
    id: true, teamRunId: true, taskId: true, taskSourceHash: true, state: true, revision: true, sentMode: true, acceptedAt: true,
    translationSource: { select: { jobState: true, errorCode: true } },
    _count: { select: { workRequests: { where: { status: 'QUEUED' } }, deliveries: { where: pendingDelivery } } },
  } satisfies Prisma.TeamTaskInputSnapshotSelect;
  private summary(s: Prisma.TeamTaskInputSnapshotGetPayload<{ select: TeamTaskInputService['summarySelect'] }>): TeamTaskInputSummary {
    const { translationSource, _count, acceptedAt, ...rest } = s;
    return { ...rest, state: s.state as 'PENDING' | 'ACCEPTED', sentMode: s.sentMode as 'ORIGINAL' | 'TRANSLATED' | null, acceptedAt: acceptedAt?.toISOString() ?? null, translationState: translationSource?.jobState ?? null, errorCode: translationSource?.errorCode ?? null, consumerCount: _count.workRequests + _count.deliveries };
  }
  async list(teamRunId: string, cursor?: string): Promise<{ items: TeamTaskInputSummary[]; nextCursor: string | null }> {
    await this.assertTeam(teamRunId);
    if (cursor && !await this.db.teamTaskInputSnapshot.findFirst({ where: { id: cursor, teamRunId }, select: { id: true } })) throw new ServiceError('Input cursor not found', 'NOT_FOUND', 404);
    const rows = await this.db.teamTaskInputSnapshot.findMany({ where: { teamRunId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 51,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), select: this.summarySelect });
    return { items: rows.slice(0, 50).map(s => this.summary(s)), nextCursor: rows.length > 50 ? rows[49]!.id : null };
  }
  async get(teamRunId: string, id: string): Promise<TeamTaskInputDetail> {
    await this.assertTeam(teamRunId);
    const s = await this.db.teamTaskInputSnapshot.findFirst({ where: { id, teamRunId }, select: { ...this.summarySelect, originalTitle: true, originalDescription: true, effectiveUserText: true } });
    if (!s) throw new ServiceError('Input not found', 'NOT_FOUND', 404);
    const { originalTitle, originalDescription, effectiveUserText, ...summary } = s;
    return { ...this.summary(summary), originalText: buildTaskUserText(originalTitle, originalDescription), effectiveUserText };
  }
  async action(teamRunId: string, id: string, action: 'retry_translation' | 'send_original', revision: number, actionId: string) {
    const fingerprint = createHash('sha256').update(JSON.stringify([teamRunId, id, action, revision])).digest('hex');
    await this.transaction(async tx => {
      await this.assertTeam(teamRunId, tx);
      const s = await tx.teamTaskInputSnapshot.findFirst({ where: { id, teamRunId } });
      if (!s) throw new ServiceError('Input not found', 'NOT_FOUND', 404);
      const previous = await tx.teamTaskInputAction.findUnique({ where: { actionId } });
      if (previous) { if (previous.snapshotId !== id || previous.fingerprint !== fingerprint) throw changed(); return; }
      if (s.revision !== revision || s.state !== 'PENDING') throw changed();
      if (!await tx.workRequest.count({ where: { taskInputSnapshotId: id, status: 'QUEUED' } }) && !await tx.messageDelivery.count({ where: { taskInputSnapshotId: id, ...pendingDelivery } })) throw changed();
      if (action === 'send_original') {
        await acceptTaskInputCandidate(tx, teamRunId, s.taskId, this.originalToken(s));
        if (s.translationSourceId) await tx.translationSource.update({ where: { id: s.translationSourceId }, data: { jobState: 'CANCELLED', generation: { increment: 1 }, currentAttemptVersion: { increment: 1 }, effectiveAttemptId: null, nextRetryAt: null } });
      } else {
        const config = await tx.translationSettings.findUnique({ where: { id: 'singleton' } });
        if (!config?.enabled || !s.translationSourceId) throw changed();
        const source = await tx.translationSource.findUniqueOrThrow({ where: { id: s.translationSourceId } });
        if (!['FAILED', 'CANCELLED', 'PAUSED_DISABLED', 'QUEUE_FULL', 'INTERRUPTED'].includes(source.jobState)) throw changed();
        await this.translation.retryDeliverySource(tx, source.id, config.enableEpoch);
        await tx.teamTaskInputSnapshot.update({ where: { id }, data: { revision: { increment: 1 } } });
      }
      await tx.teamTaskInputAction.create({ data: { actionId, snapshotId: id, fingerprint } });
    });
    const s = await this.db.teamTaskInputSnapshot.findUniqueOrThrow({ where: { id } });
    if (s.translationSourceId) { const source = await this.db.translationSource.findUniqueOrThrow({ where: { id: s.translationSourceId } }); this.translation.abortSource(source.id, source.generation); }
    return this.get(teamRunId, id);
  }
  async cancelUnused() {
    const rows = await this.db.teamTaskInputSnapshot.findMany({ where: { state: 'PENDING', translationSource: { deletedAt: null, jobState: { in: ['PENDING', 'RUNNING', 'RETRY_WAIT'] } }, workRequests: { none: { status: 'QUEUED' } }, deliveries: { none: pendingDelivery } }, select: { id: true }, take: 64 });
    for (const row of rows) await this.transaction(async tx => {
      const snapshot = await tx.teamTaskInputSnapshot.findFirst({ where: { id: row.id, state: 'PENDING', workRequests: { none: { status: 'QUEUED' } }, deliveries: { none: pendingDelivery } } });
      if (snapshot?.translationSourceId) {
        const source = await tx.translationSource.update({ where: { id: snapshot.translationSourceId }, data: { jobState: 'CANCELLED', generation: { increment: 1 }, currentAttemptVersion: { increment: 1 }, effectiveAttemptId: null, nextRetryAt: null } });
        this.translation.abortSource(source.id, source.generation);
      }
    });
  }
  async getForAgent(teamRunId: string, identity: { sessionId: string; invocationId?: string | null }, full: boolean): Promise<AgentTeamTaskInput> {
    return this.db.$transaction(async tx => {
      const invocation = identity.invocationId ? await tx.agentInvocation.findUnique({ where: { id: identity.invocationId }, include: { teamRun: { include: { task: { include: { project: true } } } }, taskInputSnapshot: true } }) : null;
      const member = invocation ? await tx.teamMember.findUnique({ where: { id: invocation.memberId } }) : null;
      const session = await tx.session.findUnique({ where: { id: identity.sessionId } });
      if (!invocation || !member || !session || invocation.sessionId !== identity.sessionId || invocation.dispatchRevokedAt || member.membershipStatus !== 'ACTIVE') throw new ServiceError('Agent identity is invalid', 'FORBIDDEN', 403);
      if (invocation.teamRunId !== teamRunId || member.teamRunId !== teamRunId || invocation.teamRun.task.deletedAt || invocation.teamRun.task.project.archivedAt) throw new ServiceError('Input not found', 'NOT_FOUND', 404);
      const s = invocation.taskInputSnapshot;
      if (!s) throw new ServiceError('Legacy invocation has no saved input', 'LEGACY_TASK_INPUT_NOT_SNAPSHOTTED', 409);
      if (s.teamRunId !== teamRunId || s.taskId !== invocation.teamRun.taskId) throw changed();
      await assertAcceptedTaskInput(tx, s);
      return { teamRunId, taskId: s.taskId, invocationId: invocation.id, snapshotId: s.id, taskSourceHash: s.taskSourceHash, acceptedAt: s.acceptedAt!.toISOString(), sentMode: s.sentMode as 'ORIGINAL' | 'TRANSLATED', effectiveUserText: full ? s.effectiveUserText! : buildTextPreview(s.effectiveUserText!), isTruncated: !full && s.effectiveUserText!.length > 240, fullContentAvailable: !full && s.effectiveUserText!.length > 240 };
    });
  }
}
