import { TASK_HANDOFF_MAX_LENGTH, type TaskHandoff, type UpdateTaskHandoffInput } from '@agent-tower/shared';
import type { EventBus } from '../core/event-bus.js';
import { NotFoundError, ServiceError } from '../errors.js';
import { prisma } from '../utils/index.js';
import { ensureProjectIsMutable } from './project-guards.js';

export type TaskHandoffCaller =
  | { kind: 'browser' | 'internal' }
  | { kind: 'agent'; sessionId: string; invocationId: string | null };

export class TaskHandoffService {
  constructor(private readonly eventBus: EventBus) {}

  private async authorize(taskId: string, caller: TaskHandoffCaller): Promise<void> {
    if (caller.kind !== 'agent') return;
    const session = await prisma.session.findUnique({
      where: { id: caller.sessionId },
      select: { context: true, purpose: true, workspace: { select: { id: true, taskId: true } } },
    });
    if (session?.context !== 'WORKSPACE' || session.purpose !== 'CHAT' || session.workspace?.taskId !== taskId) {
      throw new ServiceError('This Agent cannot access the task handoff.', 'HANDOFF_ACCESS_DENIED', 403);
    }
    const invocation = await prisma.agentInvocation.findFirst({
      where: { sessionId: caller.sessionId },
    });
    if (!invocation && !caller.invocationId) return;
    if (!invocation || invocation.id !== caller.invocationId || invocation.workspaceId !== session.workspace.id || invocation.dispatchRevokedAt) {
      throw new ServiceError('The Agent invocation is no longer authorized.', 'HANDOFF_ACCESS_DENIED', 403);
    }
    const [member, teamRun] = await Promise.all([
      prisma.teamMember.findUnique({ where: { id: invocation.memberId } }),
      prisma.teamRun.findUnique({ where: { id: invocation.teamRunId }, select: { taskId: true } }),
    ]);
    if (!member || member.membershipStatus === 'REMOVED' || member.teamRunId !== invocation.teamRunId || teamRun?.taskId !== taskId) {
      throw new ServiceError('The Agent is not an active member of this task.', 'HANDOFF_ACCESS_DENIED', 403);
    }
  }

  private async requireTask(taskId: string, caller: TaskHandoffCaller) {
    await this.authorize(taskId, caller);
    const task = await prisma.task.findFirst({
      where: { id: taskId, deletedAt: null },
      select: { id: true, handoff: true, projectId: true, status: true, project: { select: { name: true, archivedAt: true, repoDeletedAt: true } } },
    });
    if (!task) throw new NotFoundError('Task', taskId);
    return task;
  }

  async get(taskId: string, caller: TaskHandoffCaller): Promise<TaskHandoff> {
    const task = await this.requireTask(taskId, caller);
    return { taskId, content: task.handoff ?? '' };
  }

  async update(taskId: string, input: UpdateTaskHandoffInput, caller: TaskHandoffCaller): Promise<TaskHandoff> {
    const task = await this.requireTask(taskId, caller);
    ensureProjectIsMutable(task.project, 'edit the task handoff');
    const current = task.handoff ?? '';
    const { oldString, newString } = input;
    let content: string;
    if (oldString === '') {
      if (current !== '') {
        throw new ServiceError('The handoff is not empty. Read it and provide the exact text to replace.', 'HANDOFF_NOT_EMPTY', 409);
      }
      content = newString;
    } else {
      const index = current.indexOf(oldString);
      if (index < 0) {
        throw new ServiceError('The text to replace was not found. Read the latest handoff and try again.', 'HANDOFF_TEXT_NOT_FOUND', 409);
      }
      if (current.indexOf(oldString, index + 1) >= 0) {
        throw new ServiceError('The text matches more than once. Include more surrounding context.', 'HANDOFF_TEXT_AMBIGUOUS', 409);
      }
      // Slice instead of String.replace so $&, $1, and other replacement patterns stay literal.
      content = current.slice(0, index) + newString + current.slice(index + oldString.length);
    }
    if (content.length > TASK_HANDOFF_MAX_LENGTH) {
      throw new ServiceError(`Keep the handoff within ${TASK_HANDOFF_MAX_LENGTH} characters.`, 'HANDOFF_TOO_LARGE', 400);
    }
    const updated = await prisma.task.updateMany({
      where: { id: taskId, deletedAt: null, handoff: task.handoff, project: { archivedAt: null } },
      data: { handoff: content },
    });
    if (updated.count !== 1) {
      throw new ServiceError('The task or handoff changed while saving. Read it again before editing.', 'HANDOFF_CHANGED', 409);
    }
    this.eventBus.emit('task:updated', { taskId, projectId: task.projectId, status: task.status });
    return { taskId, content };
  }
}
