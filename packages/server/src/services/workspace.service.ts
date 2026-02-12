import { prisma } from '../utils/index.js';
import { WorkspaceStatus, TaskStatus, SessionStatus } from '../types/index.js';
import { WorktreeManager } from '../git/worktree.manager.js';
import { execGit } from '../git/git-cli.js';
import { NotFoundError, ServiceError } from '../errors.js';
import { getSessionManager, getEventBus } from '../core/container.js';
import type { EventBus } from '../core/event-bus.js';

export class WorkspaceService {
  private sessionService = getSessionManager();
  private eventBus: EventBus = getEventBus();

  // ── Queries ──────────────────────────────────────────────────────────────────

  async findById(id: string) {
    return prisma.workspace.findUnique({
      where: { id },
      include: { sessions: true, task: { include: { project: true } } },
    });
  }

  /**
   * 获取 Task 下所有 Workspace
   */
  async findByTaskId(taskId: string) {
    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task) {
      throw new NotFoundError('Task', taskId);
    }

    return prisma.workspace.findMany({
      where: { taskId },
      include: { sessions: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ── Create ───────────────────────────────────────────────────────────────────

  /**
   * 创建 Workspace
   *
   * - 默认分支名: at/{workspace-short-id}（ID 前 8 位）
   * - 支持用户自定义分支名
   * - 创建前校验分支名合法性 & 是否已存在
   * - 创建后自动将关联 Task 状态改为 IN_PROGRESS
   * - 失败时回滚已创建的数据库记录
   */
  async create(taskId: string, branchName?: string) {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      include: { project: true },
    });

    if (!task) {
      throw new NotFoundError('Task', taskId);
    }

    const worktreeManager = new WorktreeManager(task.project.repoPath);

    // 先在数据库创建记录以获取 ID（用于生成默认分支名）
    const workspace = await prisma.workspace.create({
      data: {
        taskId,
        branchName: '', // 占位，稍后更新
        worktreePath: '', // 占位，稍后更新
        status: WorkspaceStatus.ACTIVE,
      },
    });

    try {
      // 生成分支名：用户指定 or 自动生成 at/{shortId}
      const branch = branchName || `at/${workspace.id.slice(0, 8)}`;

      // WorktreeManager.create 内部已做分支名合法性校验和重复检查
      const worktreePath = await worktreeManager.create(branch);

      // 更新数据库记录：填入真正的 branchName 和 worktreePath
      const updated = await prisma.workspace.update({
        where: { id: workspace.id },
        data: { branchName: branch, worktreePath },
        include: { sessions: true, task: { include: { project: true } } },
      });

      // 将关联 Task 状态改为 IN_PROGRESS（仅当当前为 TODO 时）
      if (task.status === TaskStatus.TODO) {
        await prisma.task.update({
          where: { id: taskId },
          data: { status: TaskStatus.IN_PROGRESS },
        });
        this.eventBus.emit('task:updated', {
          taskId,
          projectId: task.projectId,
          status: TaskStatus.IN_PROGRESS,
        });
      }

      return updated;
    } catch (err) {
      // 回滚：删除已创建的数据库记录
      await prisma.workspace.delete({ where: { id: workspace.id } }).catch(() => {
        // 忽略回滚失败
      });
      throw err;
    }
  }

  // ── Delete ───────────────────────────────────────────────────────────────────

  /**
   * 删除 Workspace
   *
   * - 删除前检查是否有 RUNNING 状态的 Session，有则拒绝删除
   * - 删除时先停止所有关联 Session 的进程
   * - 删除时调用 WorktreeManager.remove 清理 worktree
   * - worktree 清理失败时仍然删除数据库记录（记录警告日志）
   */
  async delete(id: string) {
    const workspace = await prisma.workspace.findUnique({
      where: { id },
      include: {
        sessions: true,
        task: { include: { project: true } },
      },
    });

    if (!workspace) {
      throw new NotFoundError('Workspace', id);
    }

    // 停止所有活跃的 Session（RUNNING 和 PENDING 状态）
    const activeSessions = workspace.sessions.filter(
      (s) => s.status === SessionStatus.PENDING || s.status === SessionStatus.RUNNING
    );
    for (const session of activeSessions) {
      try {
        await this.sessionService.stop(session.id);
      } catch {
        // 忽略停止失败
      }
    }

    // 清理 worktree
    try {
      const worktreeManager = new WorktreeManager(workspace.task.project.repoPath);
      await worktreeManager.remove(workspace.worktreePath);
    } catch (err) {
      // worktree 清理失败时记录警告但不阻断删除
      console.warn(
        `[WorkspaceService] Failed to remove worktree for workspace ${id}: ${err instanceof Error ? err.message : err}`
      );
    }

    // 删除数据库记录（级联删除 sessions）
    await prisma.workspace.delete({ where: { id } });
    return true;
  }

  // ── Diff ─────────────────────────────────────────────────────────────────────

  async getDiff(id: string) {
    const workspace = await prisma.workspace.findUnique({
      where: { id },
      include: { task: { include: { project: true } } },
    });

    if (!workspace) {
      throw new NotFoundError('Workspace', id);
    }

    const worktreeManager = new WorktreeManager(workspace.task.project.repoPath);
    return worktreeManager.getDiff(
      workspace.worktreePath,
      workspace.task.project.mainBranch
    );
  }

  // ── Merge ────────────────────────────────────────────────────────────────────

  /**
   * 合并 Workspace 到主分支（squash merge）
   *
   * @returns squash commit 的 SHA
   */
  async merge(id: string): Promise<string> {
    const workspace = await prisma.workspace.findUnique({
      where: { id },
      include: { task: { include: { project: true } } },
    });

    if (!workspace) {
      throw new NotFoundError('Workspace', id);
    }

    const worktreeManager = new WorktreeManager(workspace.task.project.repoPath);
    await worktreeManager.merge(
      workspace.worktreePath,
      workspace.task.project.mainBranch
    );

    // 获取 squash commit SHA（merge 后 HEAD 即为 squash commit）
    const sha = (
      await execGit(workspace.task.project.repoPath, ['rev-parse', 'HEAD'])
    ).trim();

    await prisma.workspace.update({
      where: { id },
      data: { status: WorkspaceStatus.MERGED },
    });

    // 自动推进 Task 状态：如果 Task 处于 IN_PROGRESS，合并后自动流转到 IN_REVIEW
    if (workspace.task.status === TaskStatus.IN_PROGRESS) {
      await prisma.task.update({
        where: { id: workspace.task.id },
        data: { status: TaskStatus.IN_REVIEW },
      });
      this.eventBus.emit('task:updated', {
        taskId: workspace.task.id,
        projectId: workspace.task.projectId,
        status: TaskStatus.IN_REVIEW,
      });
    }

    return sha;
  }

  // ── Archive ──────────────────────────────────────────────────────────────────

  /**
   * 归档 Workspace（标记状态为 ABANDONED）
   */
  async archive(id: string) {
    const workspace = await prisma.workspace.findUnique({
      where: { id },
      include: { sessions: true },
    });

    if (!workspace) {
      throw new NotFoundError('Workspace', id);
    }

    if (workspace.status !== WorkspaceStatus.ACTIVE) {
      throw new ServiceError(
        `Cannot archive workspace in ${workspace.status} status`,
        'INVALID_WORKSPACE_STATE',
        400
      );
    }

    // 停止所有活跃的 Session
    const activeSessions = workspace.sessions.filter(
      (s) => s.status === SessionStatus.PENDING || s.status === SessionStatus.RUNNING
    );
    for (const session of activeSessions) {
      try {
        await this.sessionService.stop(session.id);
      } catch {
        // 忽略停止失败
      }
    }

    return prisma.workspace.update({
      where: { id },
      data: { status: WorkspaceStatus.ABANDONED },
      include: { sessions: true, task: { include: { project: true } } },
    });
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────────

  /**
   * 清理所有 ABANDONED/MERGED 状态且关联 Task 为 DONE 的 Workspace
   *
   * @returns 被清理的 Workspace 数量
   */
  async cleanup(): Promise<number> {
    const workspaces = await prisma.workspace.findMany({
      where: {
        status: { in: [WorkspaceStatus.ABANDONED, WorkspaceStatus.MERGED] },
        task: { status: TaskStatus.DONE },
      },
      include: { task: { include: { project: true } } },
    });

    let cleaned = 0;

    for (const workspace of workspaces) {
      try {
        const worktreeManager = new WorktreeManager(workspace.task.project.repoPath);
        await worktreeManager.remove(workspace.worktreePath);
      } catch (err) {
        console.warn(
          `[WorkspaceService] cleanup: failed to remove worktree for workspace ${workspace.id}: ${err instanceof Error ? err.message : err}`
        );
      }

      await prisma.workspace.delete({ where: { id: workspace.id } });
      cleaned++;
    }

    return cleaned;
  }

  // ── Startup Prune ────────────────────────────────────────────────────────────

  /**
   * 服务启动时调用：对所有项目执行 git worktree prune
   */
  static async pruneAllWorktrees(): Promise<void> {
    const projects = await prisma.project.findMany();

    for (const project of projects) {
      try {
        const worktreeManager = new WorktreeManager(project.repoPath);
        await worktreeManager.prune();
      } catch (err) {
        console.warn(
          `[WorkspaceService] prune failed for project ${project.id}: ${err instanceof Error ? err.message : err}`
        );
      }
    }
  }
}
