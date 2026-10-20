import { createHash } from 'node:crypto';
import type { Prisma, TeamTaskInputSnapshot } from '@prisma/client';
import { ServiceError } from '../errors.js';

/** Versioned exact user fields: status/priority and previews are not input versions. */
export function taskInputHash(title: string, description: string | null): string {
  return createHash('sha256').update(JSON.stringify(['team-task-input-v1', title, description]), 'utf8').digest('hex');
}
export function buildTaskUserText(title: string, description: string | null): string {
  return description == null || description === '' ? title : `${title}\n\n${description}`;
}

export interface TaskInputAcceptanceToken {
  snapshotId: string;
  revision: number;
  taskSourceHash: string;
  effectiveUserText: string;
  sentMode: 'ORIGINAL' | 'TRANSLATED';
  acceptedAttemptId: string | null;
}
function changed(): never { throw new ServiceError('Task input changed; prepare it again', 'TASK_INPUT_CHANGED', 409); }

/** Shared by publication, dependency recovery and the pre-worker startup barrier. */
export async function assertTaskInputSnapshot(tx: Prisma.TransactionClient, snapshot: TeamTaskInputSnapshot) {
  if (snapshot.taskSourceHash !== taskInputHash(snapshot.originalTitle, snapshot.originalDescription)) changed();
  const original = buildTaskUserText(snapshot.originalTitle, snapshot.originalDescription);
  const source = snapshot.translationSourceId ? await tx.translationSource.findUnique({ where: { id: snapshot.translationSourceId } }) : null;
  // These fields identify the saved input. Retry/config/lease state is mutable
  // and must never invalidate an already accepted attempt.
  const initial = source?.sourceKind === 'USER_DELIVERY' && source.deliveryId ? await tx.messageDelivery.findUnique({ where: { id: source.deliveryId } }) : null;
  if (initial && (initial.origin !== 'TEAM_INITIAL' || initial.state !== 'SENT' || initial.acceptedText !== snapshot.effectiveUserText || initial.sentMode !== snapshot.sentMode || source!.sourceRevision !== initial.sourceRevision || initial.teamRunId !== snapshot.teamRunId || initial.taskId !== snapshot.taskId || initial.taskInputSnapshotId !== snapshot.id || initial.originalText !== original || source!.scopeType !== 'TASK' || source!.scopeId !== snapshot.taskId || source!.sourceKey !== initial.id || source!.laneKey !== initial.channelKey || source!.direction !== 'SEND' || source!.originalText !== original || source!.sourceHash !== createHash('sha256').update(original).digest('hex') || source!.sessionId !== null || source!.messageId !== null || source!.turnId !== null || source!.blockId !== null || source!.blockState !== 'SEALED')) changed();
  if (snapshot.translationSourceId && !initial && (!source || source.scopeType !== 'TEAM_RUN' || source.scopeId !== snapshot.teamRunId
    || source.direction !== 'SEND' || source.sourceKind !== 'TASK_INPUT'
    || source.sourceKey !== JSON.stringify([snapshot.teamRunId, snapshot.taskSourceHash]) || source.laneKey !== `team:${snapshot.teamRunId}`
    || source.sessionId !== null || source.messageId !== null || source.turnId !== null || source.blockId !== null || source.deliveryId !== null
    || source.blockState !== 'SEALED' || source.originalText !== original || source.sourceHash !== createHash('sha256').update(original).digest('hex'))) changed();
  if (snapshot.state === 'PENDING') {
    if (snapshot.effectiveUserText !== null || snapshot.sentMode !== null || snapshot.acceptedAttemptId !== null || snapshot.acceptedAt !== null) changed();
    return;
  }
  if (snapshot.state !== 'ACCEPTED' || !snapshot.acceptedAt || snapshot.effectiveUserText == null) changed();
  if (snapshot.sentMode === 'ORIGINAL') {
    if (snapshot.effectiveUserText !== original || snapshot.acceptedAttemptId !== null) changed();
  } else if (snapshot.sentMode === 'TRANSLATED') {
    const attempt = snapshot.acceptedAttemptId ? await tx.translationAttempt.findUnique({ where: { id: snapshot.acceptedAttemptId } }) : null;
    if (!snapshot.translationSourceId || !attempt || attempt.sourceId !== snapshot.translationSourceId || !['SUCCESS','NOT_REQUIRED'].includes(attempt.status) || attempt.resultText !== snapshot.effectiveUserText || attempt.sourceHash !== createHash('sha256').update(original).digest('hex')) changed();
  } else changed();
}

/** Accepted history validates saved evidence, never current Task/config/source generation. */
export async function assertAcceptedTaskInput(tx: Prisma.TransactionClient, snapshot: TeamTaskInputSnapshot) {
  if (snapshot.state !== 'ACCEPTED') changed();
  await assertTaskInputSnapshot(tx, snapshot);
}

/** Internal transaction boundary only. Does not register sources or perform translation. */
export async function adoptTaskInputInTransaction(tx: Prisma.TransactionClient, teamRunId: string, taskId: string, token: TaskInputAcceptanceToken) {
  const task = await tx.task.findUnique({ where: { id: taskId } });
  if (!task || task.deletedAt || taskInputHash(task.title, task.description) !== token.taskSourceHash) changed();
  const snapshot = await acceptTaskInputCandidate(tx, teamRunId, taskId, token);
  await tx.teamRun.update({ where: { id: teamRunId }, data: { currentTaskInputSnapshotId: snapshot.id } });
  return snapshot.id;
}

/** Resolving an older dependency preserves history without changing the team's current input. */
export async function acceptTaskInputCandidate(tx: Prisma.TransactionClient, teamRunId: string, taskId: string, token: TaskInputAcceptanceToken) {
  const snapshot = await tx.teamTaskInputSnapshot.findUnique({ where: { id: token.snapshotId } });
  if (!snapshot || snapshot.teamRunId !== teamRunId || snapshot.taskId !== taskId || snapshot.revision !== token.revision || snapshot.taskSourceHash !== token.taskSourceHash) changed();
  await assertTaskInputSnapshot(tx, snapshot);
  if (!['ORIGINAL', 'TRANSLATED'].includes(token.sentMode)) changed();
  if (token.sentMode === 'ORIGINAL' && (token.effectiveUserText !== buildTaskUserText(snapshot.originalTitle, snapshot.originalDescription) || token.acceptedAttemptId !== null)) changed();
  if (snapshot.state === 'ACCEPTED') {
    if (snapshot.effectiveUserText !== token.effectiveUserText || snapshot.sentMode !== token.sentMode || snapshot.acceptedAttemptId !== token.acceptedAttemptId || !snapshot.acceptedAt) changed();
  } else {
    if (snapshot.state !== 'PENDING') changed();
    if (token.sentMode === 'ORIGINAL') {
      if (token.effectiveUserText !== buildTaskUserText(snapshot.originalTitle, snapshot.originalDescription) || token.acceptedAttemptId !== null) changed();
    } else {
      const config = await tx.translationSettings.findUniqueOrThrow({ where: { id: 'singleton' } });
      const source = snapshot.translationSourceId ? await tx.translationSource.findUnique({ where: { id: snapshot.translationSourceId } }) : null;
      const attempt = token.acceptedAttemptId ? await tx.translationAttempt.findUnique({ where: { id: token.acceptedAttemptId } }) : null;
      if (!source || source.deletedAt || !['SUCCESS', 'NOT_REQUIRED'].includes(source.jobState) || !attempt || source.effectiveAttemptId !== attempt.id || attempt.sourceId !== source.id
        || !config.enabled || source.enableEpoch !== config.enableEpoch || attempt.enableEpoch !== config.enableEpoch || attempt.generation !== source.generation || attempt.attemptVersion !== source.currentAttemptVersion
        || attempt.sourceHash !== source.sourceHash || attempt.sourceRevision !== source.sourceRevision || attempt.resultText !== token.effectiveUserText || !['SUCCESS', 'NOT_REQUIRED'].includes(attempt.status)) changed();
    }
    const updated = await tx.teamTaskInputSnapshot.updateMany({ where: { id: snapshot.id, revision: token.revision, state: 'PENDING' }, data: { state: 'ACCEPTED', effectiveUserText: token.effectiveUserText, sentMode: token.sentMode, acceptedAttemptId: token.acceptedAttemptId, acceptedAt: new Date(), revision: { increment: 1 } } });
    if (updated.count !== 1) changed();
  }
  return tx.teamTaskInputSnapshot.findUniqueOrThrow({ where: { id: snapshot.id } });
}
