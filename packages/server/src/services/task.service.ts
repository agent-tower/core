import { prisma } from '../utils/index.js';
import { TaskStatus, SessionStatus, SessionPurpose, WorkspaceStatus } from '../types/index.js';
import { getWorkspaceWorkingDir } from './workspace-kind.js';
import {
  NotFoundError,
  ValidationError,
  InvalidStateTransitionError,
} from '../errors.js';
import type { EventBus } from '../core/event-bus.js';
import type { SessionManager } from './session-manager.js';
import type { TaskCleanupService, TaskCleanupSnapshot } from './task-cleanup.service.js';
import type { WorkspaceGitWatcherService } from './workspace-git-watcher.service.js';
import { getWorkspaceGitWatcherService } from '../core/container.js';
import { ensureProjectIsMutable } from './project-guards.js';
import { defaultTeamLockService } from './team-lock.service.js';

interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: number;
}

interface UpdateTaskInput {
  title?: string;
  description?: string;
  priority?: number;
}

interface FindTasksParams {
  status?: TaskStatus;
  page?: number;
  limit?: number;
}

/**
 * 合法的状态流转规则
 * 看板拖拽场景下允许任意状态互转，状态变更无危险副作用
 */
const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  [TaskStatus.TODO]: [TaskStatus.IN_PROGRESS, TaskStatus.IN_REVIEW, TaskStatus.DONE, TaskStatus.CANCELLED],
  [TaskStatus.IN_PROGRESS]: [TaskStatus.TODO, TaskStatus.IN_REVIEW, TaskStatus.DONE, TaskStatus.CANCELLED],
  [TaskStatus.IN_REVIEW]: [TaskStatus.TODO, TaskStatus.IN_PROGRESS, TaskStatus.DONE, TaskStatus.CANCELLED],
  [TaskStatus.DONE]: [TaskStatus.TODO, TaskStatus.IN_PROGRESS, TaskStatus.IN_REVIEW, TaskStatus.CANCELLED],
  [TaskStatus.CANCELLED]: [TaskStatus.TODO, TaskStatus.IN_PROGRESS, TaskStatus.IN_REVIEW, TaskStatus.DONE],
};
const CANCELLABLE_DELETE_WORK_REQUEST_STATUSES = ['PENDING_APPROVAL', 'QUEUED', 'STARTED'];
const CANCELLABLE_DELETE_INVOCATION_STATUSES = ['QUEUED', 'RUNNING', 'SESSION_ENDED', 'WAITING_ROOM_REPLY'];

function normalizeTaskTitle(title: string): string {
  const normalized = title.trim();
  if (normalized.length === 0) {
    throw new ValidationError('Task title is required');
  }
  return normalized;
}

export class TaskService {
  constructor(
    private readonly eventBus: EventBus,
    private readonly sessionManager: SessionManager,
    private readonly cleanupService: Pick<TaskCleanupService, 'trigger'> | undefined = undefined,
    private readonly workspaceGitWatcher: Pick<WorkspaceGitWatcherService, 'unwatchWorkspace'> = getWorkspaceGitWatcherService(),
  ) {}

  /**
   * 获取项目的任务列表（支持按状态过滤和分页）
   */
  async findByProjectId(projectId: string, params: FindTasksParams = {}) {
    // 校验项目存在
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) {
      throw new NotFoundError('Project', projectId);
    }

    const page = Math.max(1, params.page || 1);
    const limit = Math.min(1000, Math.max(1, params.limit || 200));
    const skip = (page - 1) * limit;

    const where: any = { projectId, deletedAt: null };
    if (params.status) {
      where.status = params.status;
    }

    // Active tasks first (IN_PROGRESS → IN_REVIEW → TODO), then completed (DONE → CANCELLED).
    // Raw SQL CASE needed because Prisma orderBy doesn't support custom sort functions.
    const statusOrder: Record<string, number> = {
      [TaskStatus.IN_PROGRESS]: 0,
      [TaskStatus.IN_REVIEW]: 1,
      [TaskStatus.TODO]: 2,
      [TaskStatus.DONE]: 3,
      [TaskStatus.CANCELLED]: 4,
    };

    const [data, total] = await Promise.all([
      prisma.task.findMany({
        where,
        include: { workspaces: true, project: true },
        orderBy: [{ updatedAt: 'desc' }],
        skip,
        take: limit,
      }),
      prisma.task.count({ where }),
    ]);

    data.sort((a, b) => {
      const sa = statusOrder[a.status] ?? 99;
      const sb = statusOrder[b.status] ?? 99;
      if (sa !== sb) return sa - sb;
      return (a.position ?? 0) - (b.position ?? 0);
    });

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * 获取任务详情
   */
  async findById(id: string) {
    const task = await prisma.task.findFirst({
      where: { id, deletedAt: null },
      include: { workspaces: { include: { sessions: { where: { purpose: { not: SessionPurpose.COMMIT_MSG } } } } } },
    });

    if (!task) {
      throw new NotFoundError('Task', id);
    }

    return task;
  }

  /**
   * 创建任务
   * - 校验项目存在
   * - 自动计算 position（同状态下最大 position + 1）
   */
  async create(projectId: string, input: CreateTaskInput) {
    const title = normalizeTaskTitle(input.title);

    // 校验项目存在
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) {
      throw new NotFoundError('Project', projectId);
    }
    ensureProjectIsMutable(project, 'create tasks');

    // 自动计算 position
    const maxPosition = await prisma.task.aggregate({
      where: { projectId, status: TaskStatus.TODO, deletedAt: null },
      _max: { position: true },
    });

    return prisma.task.create({
      data: {
        title,
        description: input.description,
        priority: input.priority ?? 0,
        position: (maxPosition._max.position ?? 0) + 1,
        projectId,
      },
    });
  }

  /**
   * 更新任务基本信息
   */
  async update(id: string, input: UpdateTaskInput) {
    const normalizedInput = {
      ...input,
      ...(input.title !== undefined ? { title: normalizeTaskTitle(input.title) } : {}),
    };
    const task = await prisma.task.findFirst({
      where: { id, deletedAt: null },
      include: { project: true },
    });
    if (!task) {
      throw new NotFoundError('Task', id);
    }
    ensureProjectIsMutable(task.project, 'update tasks');

    return prisma.task.update({
      where: { id },
      data: normalizedInput,
    });
  }

  /**
   * 更新任务状态（含状态流转校验）
   * 更新后通过 EventBus 发射 task:updated 事件，通知前端实时更新
   */
  async updateStatus(id: string, status: TaskStatus) {
    const task = await prisma.task.findFirst({
      where: { id, deletedAt: null },
      include: { project: true },
    });
    if (!task) {
      throw new NotFoundError('Task', id);
    }
    ensureProjectIsMutable(task.project, 'change task status');

    const currentStatus = task.status as TaskStatus;

    // 如果状态没有变化，直接返回
    if (currentStatus === status) {
      return task;
    }

    // 校验状态流转是否合法
    const allowedTransitions = VALID_TRANSITIONS[currentStatus];
    if (!allowedTransitions || !allowedTransitions.includes(status)) {
      throw new InvalidStateTransitionError(currentStatus, status);
    }

    // 切换状态时自动计算新列的 position
    const maxPosition = await prisma.task.aggregate({
      where: { projectId: task.projectId, status, deletedAt: null },
      _max: { position: true },
    });

    const updated = await prisma.task.update({
      where: { id },
      data: {
        status,
        position: (maxPosition._max.position ?? 0) + 1,
      },
    });

    // 通知前端
    this.emitTaskUpdated(id, task.projectId, status);

    return updated;
  }

  /**
   * 更新任务位置（用于拖拽排序）
   * 如果同时传了 status，会进行状态流转并通知前端
   */
  async updatePosition(id: string, position: number, status?: TaskStatus) {
    const task = await prisma.task.findFirst({
      where: { id, deletedAt: null },
      include: { project: true },
    });
    if (!task) {
      throw new NotFoundError('Task', id);
    }
    ensureProjectIsMutable(task.project, 'reorder tasks');

    // 如果同时传了 status，进行状态流转校验
    if (status && status !== task.status) {
      const currentStatus = task.status as TaskStatus;
      const allowedTransitions = VALID_TRANSITIONS[currentStatus];
      if (!allowedTransitions || !allowedTransitions.includes(status)) {
        throw new InvalidStateTransitionError(currentStatus, status);
      }
    }

    const updated = await prisma.task.update({
      where: { id },
      data: { position, ...(status && { status }) },
    });

    // 如果状态发生了变化，通知前端
    if (status && status !== task.status) {
      this.emitTaskUpdated(id, task.projectId, status);
    }

    return updated;
  }

  /**
   * 快速删除任务
   *
   * 1. 原子标记 Task 为 deletedAt，使普通列表立即隐藏
   * 2. 保存后台清理快照
   * 3. 通过 EventBus 通知前端实时删除
   * 4. 后台 worker 再停止 Session、删除 worktree/branch，并最终硬删除 Task
   */
  async delete(id: string) {
    const deletedAt = new Date();
    const taskForGuard = await prisma.task.findUnique({
      where: { id },
      include: { project: true },
    });
    if (!taskForGuard || taskForGuard.deletedAt) {
      throw new NotFoundError('Task', id);
    }
    ensureProjectIsMutable(taskForGuard.project, 'delete tasks');

    const marked = await prisma.task.updateMany({
      where: {
        id,
        deletedAt: null,
        project: { archivedAt: null },
      },
      data: { deletedAt },
    });
    if (marked.count === 0) {
      const current = await prisma.task.findUnique({
        where: { id },
        include: { project: true },
      });
      if (!current || current.deletedAt) {
        throw new NotFoundError('Task', id);
      }
      ensureProjectIsMutable(current.project, 'delete tasks');
      throw new NotFoundError('Task', id);
    }

    let deleteResult: { projectId: string; cancelledInvocationIds: string[] };
    let cleanupJobCreated = false;
    try {
      const taskForCleanup = await prisma.task.findUnique({
        where: { id },
        include: {
          project: true,
          teamRun: {
            include: {
              invocations: {
                where: { status: { in: CANCELLABLE_DELETE_INVOCATION_STATUSES } },
                select: { id: true },
              },
            },
          },
          workspaces: {
            include: { sessions: true },
          },
        },
      });
      if (!taskForCleanup) {
        throw new NotFoundError('Task', id);
      }
      ensureProjectIsMutable(taskForCleanup.project, 'delete tasks');

      const snapshot: TaskCleanupSnapshot = {
        taskId: taskForCleanup.id,
        projectId: taskForCleanup.projectId,
        project: {
          repoPath: taskForCleanup.project.repoPath,
          mainBranch: taskForCleanup.project.mainBranch,
        },
        workspaces: taskForCleanup.workspaces.map((workspace) => ({
          id: workspace.id,
          worktreePath: workspace.worktreePath,
          workingDir: getWorkspaceWorkingDir(workspace),
          workspaceKind: workspace.workspaceKind,
          branchName: workspace.branchName,
          baseBranch: workspace.baseBranch,
          sessions: workspace.sessions
            .filter((session) => session.status === SessionStatus.PENDING || session.status === SessionStatus.RUNNING)
            .map((session) => ({ id: session.id })),
        })),
      };
      const teamRunId = taskForCleanup.teamRun?.id;
      const cancelledInvocationIds = taskForCleanup.teamRun?.invocations.map((invocation) => invocation.id) ?? [];

      await prisma.$transaction(async (tx) => {
        await tx.taskCleanupJob.create({
          data: {
            taskId: taskForCleanup.id,
            projectId: taskForCleanup.projectId,
            payload: JSON.stringify(snapshot),
          },
        });

        if (teamRunId) {
          await tx.workRequest.updateMany({
            where: {
              teamRunId,
              status: { in: CANCELLABLE_DELETE_WORK_REQUEST_STATUSES },
            },
            data: { status: 'CANCELLED' },
          });
          await tx.agentInvocation.updateMany({
            where: {
              teamRunId,
              status: { in: CANCELLABLE_DELETE_INVOCATION_STATUSES },
            },
            data: {
              status: 'CANCELLED',
              nextRoomReplyReminderAt: null,
            },
          });
        }
      });
      cleanupJobCreated = true;

      deleteResult = {
        projectId: taskForCleanup.projectId,
        cancelledInvocationIds,
      };
    } catch (error) {
      if (!cleanupJobCreated) {
        await prisma.task.updateMany({
          where: { id, deletedAt },
          data: { deletedAt: null },
        }).catch(() => {
          // If rollback fails, leave the task hidden rather than masking the original error.
        });
      }
      throw error;
    }

    for (const invocationId of deleteResult.cancelledInvocationIds) {
      defaultTeamLockService.releaseByOwner(invocationId);
    }

    this.eventBus.emit('task:deleted', {
      taskId: id,
      projectId: deleteResult.projectId,
    });
    this.cleanupService?.trigger();

    return true;
  }

  /**
   * 获取项目的任务统计
   */
  async getStatsByProjectId(projectId: string) {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) {
      throw new NotFoundError('Project', projectId);
    }

    const counts = await prisma.task.groupBy({
      by: ['status'],
      where: { projectId, deletedAt: null },
      _count: { id: true },
    });

    const stats = {
      total: 0,
      todo: 0,
      inProgress: 0,
      inReview: 0,
      done: 0,
      cancelled: 0,
    };

    for (const row of counts) {
      const count = row._count.id;
      stats.total += count;
      switch (row.status) {
        case TaskStatus.TODO:
          stats.todo = count;
          break;
        case TaskStatus.IN_PROGRESS:
          stats.inProgress = count;
          break;
        case TaskStatus.IN_REVIEW:
          stats.inReview = count;
          break;
        case TaskStatus.DONE:
          stats.done = count;
          break;
        case TaskStatus.CANCELLED:
          stats.cancelled = count;
          break;
      }
    }

    return stats;
  }

  /**
   * 重试任务
   *
   * 1. 停止当前 ACTIVE Workspace 的所有 Session
   * 2. 将 ACTIVE Workspace 标记为 ABANDONED（保留 worktree 供参考）
   * 3. 重置 Task 状态为 TODO
   * 4. 通知前端 — 用户可重新派发 Agent（会创建新 Worktree）
   */
  async retry(id: string) {
    const task = await prisma.task.findFirst({
      where: { id, deletedAt: null },
      include: {
        project: true,
        workspaces: {
          where: { status: WorkspaceStatus.ACTIVE },
          include: { sessions: true },
        },
      },
    });
    if (!task) {
      throw new NotFoundError('Task', id);
    }
    ensureProjectIsMutable(task.project, 'retry tasks');

    // 停止活跃 Session 并归档 Workspace
    for (const workspace of task.workspaces) {
      const activeSessions = workspace.sessions.filter(
        (s) => s.status === SessionStatus.PENDING || s.status === SessionStatus.RUNNING
      );
      for (const session of activeSessions) {
        try {
          await this.sessionManager.stop(session.id);
        } catch (err) {
          console.warn(`[TaskService] retry: failed to stop session ${session.id}:`, err);
        }
      }
      await prisma.workspace.update({
        where: { id: workspace.id },
        data: { status: WorkspaceStatus.ABANDONED },
      });
      this.workspaceGitWatcher.unwatchWorkspace(workspace.id);
    }

    // 重置 Task 到 TODO
    const updated = await prisma.task.update({
      where: { id },
      data: { status: TaskStatus.TODO },
    });

    this.emitTaskUpdated(id, task.projectId, TaskStatus.TODO);

    return updated;
  }

  // ── 内部方法 ────────────────────────────────────────────────────────────────

  /**
   * 发射 task:updated 事件，通知 SocketGateway 转发到前端
   */
  emitTaskUpdated(taskId: string, projectId: string, status: string): void {
    this.eventBus.emit('task:updated', { taskId, projectId, status });
  }
}
