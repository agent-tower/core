import { createHash } from 'node:crypto';
import type { MessageDelivery, Prisma } from '@prisma/client';
import { z } from 'zod';
import { assertAcceptedTaskInput, assertTaskInputSnapshot, taskInputHash, buildTaskUserText } from './team-task-input.js';
import { buildTextPreview } from '../utils/text-preview.js';
import { ServiceError } from '../errors.js';

const target = z.object({ kind: z.literal('WORKSPACE_COMMIT'), purpose: z.enum(['REVIEW', 'TEST']), sourceWorkspaceId: z.string().min(1), headSha: z.string().min(1), branchName: z.string().min(1), planItemId: z.string().nullable().optional() }).strict();
const mention = z.object({ memberId: z.string().min(1), label: z.string().optional(), ifBusy: z.enum(['queue', 'cancel_current_and_start']).optional(), cancelQueued: z.boolean().optional(), target: target.nullable().optional() }).strict();
const recipient = z.object({ memberId: z.string().min(1), ifBusy: z.enum(['queue', 'cancel_current_and_start']), cancelQueued: z.boolean(), target: target.nullable(), targetSourceMemberId: z.string().nullable().optional() }).strict();
const intentSchema = z.object({ version: z.literal(1), taskSourceHash: z.string().min(1), kind: z.enum(['chat', 'work_request', 'artifact', 'review', 'decision', 'system']), mentions: z.array(mention), artifactRefs: z.array(z.string()), resolvedRecipients: z.array(recipient) }).strict();
const memberSchema = z.object({
  id: z.string().uuid(), presetId: z.string().nullable(), name: z.string().min(1), aliases: z.array(z.string()), providerId: z.string().min(1), rolePrompt: z.string().min(1),
  capabilities: z.object({ readRoom: z.boolean(), postRoomMessage: z.boolean(), mentionMembers: z.boolean(), stopMemberWork: z.boolean(), markReadyForReview: z.boolean(), readFiles: z.boolean(), writeFiles: z.boolean(), runCommands: z.boolean(), readDiff: z.boolean(), mergeWorkspace: z.boolean() }).strict(),
  workspacePolicy: z.enum(['none','shared','dedicated']), triggerPolicy: z.enum(['MENTION_ONLY','USER_MESSAGES']), sessionPolicy: z.enum(['new_per_request','resume_last']), queueManagementPolicy: z.enum(['own_only','team_pending']), avatar: z.string().nullable(),
}).strict();
export const teamInitialIntentSchema = intentSchema.extend({ version: z.literal(2), plannedTeamRunId: z.string().uuid(), members: z.array(memberSchema).min(1), mode: z.enum(['AUTO','CONFIRM']), heartbeatTimeoutMinutes: z.number().int().min(1).max(120), originalTitle: z.string(), originalDescription: z.string().nullable(), sourceRevision: z.number().int().positive(), mentionTokenCount: z.number().int().nonnegative() }).strict();
export type TeamInitialDeliveryIntent = z.infer<typeof teamInitialIntentSchema>;
export type TeamUserDeliveryIntent = z.infer<typeof intentSchema>;
export function roomDeliveryIntegrityError(): never { throw new ServiceError('Room publication facts are inconsistent', 'ROOM_DELIVERY_INTEGRITY', 409); }
export function readTeamDeliveryIntent(row: MessageDelivery): TeamUserDeliveryIntent | TeamInitialDeliveryIntent {
  if (!['TEAM_USER', 'TEAM_INITIAL'].includes(row.origin) || row.sessionId !== null || !row.taskId || row.origin === 'TEAM_USER' && !row.teamRunId || row.channelKey !== `task:${row.taskId}:team-room`) roomDeliveryIntegrityError();
  let value: unknown;
  try { value = JSON.parse(row.intent); } catch { roomDeliveryIntegrityError(); }
  const parsed = row.origin === 'TEAM_INITIAL' ? teamInitialIntentSchema.safeParse(value) : intentSchema.safeParse(value);
  if (!parsed.success) roomDeliveryIntegrityError();
  const result = parsed.data;
  if (result.version === 2 && ((row.state === 'SENT') !== !!row.teamRunId || row.state !== 'SENT' && row.taskInputSnapshotId !== null || result.sourceRevision !== row.sourceRevision || row.sourceHash !== createHash('sha256').update(row.originalText).digest('hex') || result.taskSourceHash !== taskInputHash(result.originalTitle, result.originalDescription) || row.originalText !== buildTaskUserText(result.originalTitle, result.originalDescription) || new Set(result.members.map(m => m.id)).size !== result.members.length || row.teamRunId && row.teamRunId !== result.plannedTeamRunId || result.resolvedRecipients.some(r => !result.members.some(m => m.id === r.memberId)))) roomDeliveryIntegrityError();
  if (result.resolvedRecipients.some(r => r.target && !Object.hasOwn(r, 'targetSourceMemberId'))) roomDeliveryIntegrityError();
  if (new Set(result.resolvedRecipients.map(r => r.memberId)).size !== result.resolvedRecipients.length || new Set(result.mentions.map(r => r.memberId)).size !== result.mentions.length) roomDeliveryIntegrityError();
  if (result.mentions.length && (result.mentions.length !== result.resolvedRecipients.length || result.mentions.some(m => !result.resolvedRecipients.some(r => r.memberId === m.memberId && r.ifBusy === (m.ifBusy ?? 'queue') && r.cancelQueued === (m.cancelQueued ?? false) && JSON.stringify(r.target) === JSON.stringify(m.target ?? null))))) roomDeliveryIntegrityError();
  return result;
}

/** Database facts only: safe before runtime initialization, no notifications or repair writes. */
export async function verifyPublishedTeamDelivery(tx: Prisma.TransactionClient, row: MessageDelivery) {
  const intent = readTeamDeliveryIntent(row);
  const [message, receipt, snapshot, team] = await Promise.all([
    tx.roomMessage.findUnique({ where: { deliveryId: row.id } }), tx.deliveryReceipt.findUnique({ where: { deliveryId: row.id } }),
    row.taskInputSnapshotId ? tx.teamTaskInputSnapshot.findUnique({ where: { id: row.taskInputSnapshotId } }) : null,
    tx.teamRun.findUnique({ where: { id: row.teamRunId! } }),
  ]);
  if (!['ORIGINAL','TRANSLATED'].includes(row.sentMode ?? '') || row.sourceHash !== createHash('sha256').update(row.originalText).digest('hex') || row.sentMode === 'ORIGINAL' && row.acceptedText !== row.originalText || row.state !== 'SENT' || !message || !receipt || !snapshot || team?.taskId !== row.taskId || row.acceptedText == null || row.actualSentText !== row.acceptedText || !row.sentAt
    || receipt.phase !== 'SUBMITTED' || receipt.evidence !== 'ROOM_PUBLISHED' || receipt.runtimeInstanceId !== null || receipt.turnId !== null || receipt.generation !== row.revision || receipt.submittedAt?.getTime() !== row.sentAt.getTime()
    || snapshot.state !== 'ACCEPTED' || snapshot.teamRunId !== row.teamRunId || snapshot.taskId !== row.taskId || snapshot.taskSourceHash !== intent.taskSourceHash || snapshot.effectiveUserText == null || !snapshot.acceptedAt
    || message.id !== row.acceptedDestinationId || message.teamRunId !== row.teamRunId || message.senderType !== 'user' || message.senderId !== null || message.senderInvocationId !== null || message.visibility !== 'PUBLIC' || message.kind !== intent.kind || message.content !== row.acceptedText
    || message.mentions !== JSON.stringify(intent.mentions) || message.artifactRefs !== JSON.stringify(intent.artifactRefs) || message.attachmentIds !== row.attachmentIds || message.translationEligibilityEpoch !== null) roomDeliveryIntegrityError();
  try { await assertAcceptedTaskInput(tx, snapshot); } catch { roomDeliveryIntegrityError(); }
  if (intent.version === 2) {
    const members = await tx.teamMember.findMany({ where: { teamRunId: row.teamRunId! } });
    if (team?.id !== intent.plannedTeamRunId || snapshot.effectiveUserText !== row.acceptedText || snapshot.translationSourceId !== row.translationSourceId || intent.members.some(m => !members.some(saved => saved.id === m.id))) roomDeliveryIntegrityError();
  }
  const [requests, participants] = await Promise.all([tx.workRequest.findMany({ where: { triggerMessageId: message.id } }), tx.roomMessageParticipant.count({ where: { roomMessageId: message.id } })]);
  let ids: unknown;
  try { ids = JSON.parse(message.workRequestIds ?? 'null'); } catch { roomDeliveryIntegrityError(); }
  if (!Array.isArray(ids) || new Set(ids).size !== ids.length || ids.length !== requests.length || requests.length !== intent.resolvedRecipients.length || participants !== 0) roomDeliveryIntegrityError();
  for (const r of intent.resolvedRecipients) {
    const matching = requests.filter(w => w.targetMemberId === r.memberId);
    if (matching.length !== 1) roomDeliveryIntegrityError();
    const w = matching[0]; const t = r.target;
    if (!ids.includes(w.id) || w.teamRunId !== row.teamRunId || w.requesterType !== 'user' || w.requesterMemberId !== null || w.ifBusy !== r.ifBusy || w.cancelQueued !== r.cancelQueued
      || w.instruction !== buildTextPreview(row.acceptedText)
      || w.targetKind !== (t?.kind ?? null) || w.targetPurpose !== (t?.purpose ?? null) || w.targetSourceWorkspaceId !== (t?.sourceWorkspaceId ?? null) || w.targetHeadSha !== (t?.headSha.trim() ?? null) || w.targetBranchName !== (t?.branchName.trim() ?? null) || w.targetPlanItemId !== (t?.planItemId?.trim() || null)) roomDeliveryIntegrityError();
    if (w.targetSourceMemberId !== (r.targetSourceMemberId ?? null)) roomDeliveryIntegrityError();
    // The delivery keeps its publication input forever. A waiting WR instead
    // follows a same-team/task dependency, which may still await acceptance.
    const dependency = w.taskInputSnapshotId ? await tx.teamTaskInputSnapshot.findUnique({ where: { id: w.taskInputSnapshotId } }) : null;
    if (!dependency || dependency.teamRunId !== row.teamRunId || dependency.taskId !== row.taskId
      || dependency.state === 'PENDING' && !['PENDING_APPROVAL', 'QUEUED', 'REJECTED', 'CANCELLED'].includes(w.status)) roomDeliveryIntegrityError();
    try { await assertTaskInputSnapshot(tx, dependency); } catch { roomDeliveryIntegrityError(); }
    const claims = await tx.agentInvocation.findMany({ where: { workRequestId: w.id }, include: { taskInputSnapshot: true } });
    for (const claim of claims) {
      const terminal = ['COMPLETED', 'FAILED', 'CANCELLED'].includes(claim.status);
      // Preserve legacy terminal NULL history, but never filter away an active
      // claim before checking its ownership and fixed accepted input.
      if (terminal && claim.taskInputSnapshotId === null) continue;
      const input = claim.taskInputSnapshot;
      if (claim.teamRunId !== row.teamRunId || claim.memberId !== w.targetMemberId || !input || input.teamRunId !== row.teamRunId || input.taskId !== row.taskId
        || !terminal && input.id !== dependency.id) roomDeliveryIntegrityError();
      // Start failure can requeue the WR for a new input version. Its prior
      // terminal invocation still owns the old, immutable accepted input.
      try { await assertAcceptedTaskInput(tx, input); } catch { roomDeliveryIntegrityError(); }
    }
  }
  return { messageId: message.id, workRequestIds: requests.map(w => w.id), snapshotId: snapshot.id };
}
