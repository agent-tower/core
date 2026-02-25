import { prisma } from '../utils/index.js';
import { TaskStatus, SessionStatus, SessionPurpose } from '../types/index.js';
import {
  NotFoundError,
  ValidationError,
  InvalidStateTransitionError,
} from '../errors.js';
import type { EventBus } from '../core/event-bus.js';
import type { SessionManager } from './session-manager.js';
import { WorktreeManager } from '../git/worktree.manager.js';

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

export class TaskService {
  constructor(
    private readonly eventBus: EventBus,
    private readonly sessionManager: SessionManager
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
    const limit = Math.min(100, Math.max(1, params.limit || 50));
    const skip = (page - 1) * limit;

    const where: any = { projectId };
    if (params.status) {
      where.status = params.status;
    }

    const [data, total] = await Promise.all([
      prisma.task.findMany({
        where,
        include: { workspaces: true },
        orderBy: [{ status: 'asc' }, { position: 'asc' }],
        skip,
        take: limit,
      }),
      prisma.task.count({ where }),
    ]);

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
    const task = await prisma.task.findUnique({
      where: { id },
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
    // 校验项目存在
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project) {
      throw new NotFoundError('Project', projectId);
    }

    // 自动计算 position
    const maxPosition = await prisma.task.aggregate({
      where: { projectId, status: TaskStatus.TODO },
      _max: { position: true },
    });

    return prisma.task.create({
      data: {
        title: input.title,
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
    const task = await prisma.task.findUnique({ where: { id } });
    if (!task) {
      throw new NotFoundError('Task', id);
    }

    return prisma.task.update({
      where: { id },
      data: input,
    });
  }

  /**
   * 更新任务状态（含状态流转校验）
   * 更新后通过 EventBus 发射 task:updated 事件，通知前端实时更新
   */
  async updateStatus(id: string, status: TaskStatus) {
    const task = await prisma.task.findUnique({ where: { id } });
    if (!task) {
      throw new NotFoundError('Task', id);
    }

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
      where: { projectId: task.projectId, status },
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
    const task = await prisma.task.findUnique({ where: { id } });
    if (!task) {
      throw new NotFoundError('Task', id);
    }

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
   * 删除任务（增强版）
   *
   * 1. 停止所有 RUNNING/PENDING 状态的 Session
   * 2. 清理所有关联 Workspace 的 git worktree
   * 3. 级联删除数据库记录
   * 4. 通过 EventBus 通知前端实时删除
   */
  async delete(id: string) {
    const task = await prisma.task.findUnique({
      where: { id },
      include: {
        project: true,
        workspaces: {
          include: { sessions: true },
        },
      },
    });
    if (!task) {
      throw new NotFoundError('Task', id);
    }

    // 1. 停止所有活跃 Session
    for (const workspace of task.workspaces) {
      const activeSessions = workspace.sessions.filter(
        (s) => s.status === SessionStatus.PENDING || s.status === SessionStatus.RUNNING
      );
      for (const session of activeSessions) {
        try {
          await this.sessionManager.stop(session.id);
        } catch (err) {
          console.warn(`[TaskService] Failed to stop session ${session.id} during task delete:`, err);
        }
      }
    }

    // 2. 清理所有 Workspace 的 worktree
    for (const workspace of task.workspaces) {
      try {
        const worktreeManager = new WorktreeManager(task.project.repoPath);
        await worktreeManager.remove(workspace.worktreePath);
      } catch (err) {
        console.warn(
          `[TaskService] Failed to remove worktree for workspace ${workspace.id} during task delete:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    // 3. 级联删除数据库记录
    await prisma.task.delete({ where: { id } });

    // 4. 通知前端
    this.eventBus.emit('task:deleted', {
      taskId: id,
      projectId: task.projectId,
    });

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
      where: { projectId },
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

  // ── 内部方法 ────────────────────────────────────────────────────────────────

  /**
   * 发射 task:updated 事件，通知 SocketGateway 转发到前端
   */
  emitTaskUpdated(taskId: string, projectId: string, status: string): void {
    this.eventBus.emit('task:updated', { taskId, projectId, status });
  }
}
