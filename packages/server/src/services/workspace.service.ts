import { prisma } from '../utils/index.js';
import { WorkspaceStatus, TaskStatus, SessionStatus, SessionPurpose } from '../types/index.js';
import { WorktreeManager } from '../git/worktree.manager.js';
import { execGit } from '../git/git-cli.js';
import { NotFoundError, ServiceError } from '../errors.js';
import { getSessionManager, getEventBus } from '../core/container.js';
import { copyProjectFiles } from './copy-files.service.js';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { EventBus } from '../core/event-bus.js';
import type { GitOperationStatus } from '@agent-tower/shared';

const execAsync = promisify(exec);

/** 过滤条件：只返回用户可见的 CHAT session */
const visibleSessionsFilter = { where: { purpose: { not: SessionPurpose.COMMIT_MSG } } };

export class WorkspaceService {
  private sessionService = getSessionManager();
  private eventBus: EventBus = getEventBus();

  // ── Queries ──────────────────────────────────────────────────────────────────

  async findById(id: string) {
    return prisma.workspace.findUnique({
      where: { id },
      include: { sessions: visibleSessionsFilter, task: { include: { project: true } } },
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
      include: { sessions: visibleSessionsFilter },
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

    // 查找可复用的 MERGED workspace（branch 已通过 update-ref 保留）
    if (!branchName) {
      const mergedWorkspace = await prisma.workspace.findFirst({
        where: { taskId, status: WorkspaceStatus.MERGED },
        orderBy: { updatedAt: 'desc' },
      });

      if (mergedWorkspace) {
        const worktreePath = await worktreeManager.ensureWorktreeExists(mergedWorkspace.branchName);

        // 复用 worktree 时重新执行文件复制（worktree 可能被重建）
        this.runCopyFiles(task.project.repoPath, worktreePath, task.project.copyFiles);

        // 复用 worktree 时也执行 setup 脚本（fire-and-forget）
        this.fireSetupScript(mergedWorkspace.id, taskId, worktreePath, task.project.setupScript);

        const updated = await prisma.workspace.update({
          where: { id: mergedWorkspace.id },
          data: {
            status: WorkspaceStatus.ACTIVE,
            worktreePath,
          },
          include: { sessions: true, task: { include: { project: true } } },
        });

        // Task 状态回退到 IN_PROGRESS
        if (task.status !== TaskStatus.IN_PROGRESS && task.status !== TaskStatus.TODO) {
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
      }
    }

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

      // worktree 创建后：复制文件 + 异步执行 setup 脚本（fire-and-forget）
      this.runCopyFiles(task.project.repoPath, worktreePath, task.project.copyFiles);
      this.fireSetupScript(workspace.id, taskId, worktreePath, task.project.setupScript);

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

  // ── Git Operations ──────────────────────────────────────────────────────────

  /**
   * Rebase 工作空间分支到最新的基础分支
   */
  async rebase(id: string): Promise<void> {
    const workspace = await prisma.workspace.findUnique({
      where: { id },
      include: { task: { include: { project: true } } },
    });

    if (!workspace) {
      throw new NotFoundError('Workspace', id);
    }

    const worktreeManager = new WorktreeManager(workspace.task.project.repoPath);
    await worktreeManager.rebase(
      workspace.worktreePath,
      workspace.task.project.mainBranch
    );
  }

  /**
   * 获取工作空间的 Git 操作状态
   */
  async getGitStatus(id: string): Promise<GitOperationStatus> {
    const workspace = await prisma.workspace.findUnique({
      where: { id },
      include: { task: { include: { project: true } } },
    });

    if (!workspace) {
      throw new NotFoundError('Workspace', id);
    }

    const worktreeManager = new WorktreeManager(workspace.task.project.repoPath);
    return worktreeManager.getGitOperationStatus(
      workspace.worktreePath,
      workspace.task.project.mainBranch
    );
  }

  /**
   * 中止工作空间当前进行中的 Git 操作
   */
  async abortOperation(id: string): Promise<void> {
    const workspace = await prisma.workspace.findUnique({
      where: { id },
      include: { task: { include: { project: true } } },
    });

    if (!workspace) {
      throw new NotFoundError('Workspace', id);
    }

    const worktreeManager = new WorktreeManager(workspace.task.project.repoPath);
    await worktreeManager.abortOperation(workspace.worktreePath);
  }

  // ── Merge (squash) ──────────────────────────────────────────────────────────

  /**
   * 合并 Workspace 到主分支（squash merge）
   *
   * @param commitMessage - 可选的自定义 commit message
   * @returns squash commit 的 SHA
   */
  async merge(id: string, commitMessage?: string): Promise<string> {
    const workspace = await prisma.workspace.findUnique({
      where: { id },
      include: { task: { include: { project: true } } },
    });

    if (!workspace) {
      throw new NotFoundError('Workspace', id);
    }

    // 优先使用传入的 commitMessage，其次使用 AI 生成的缓存
    const message = commitMessage || workspace.commitMessage || undefined;

    const worktreeManager = new WorktreeManager(workspace.task.project.repoPath);
    const { sha } = await worktreeManager.merge(
      workspace.worktreePath,
      workspace.task.project.mainBranch,
      message ? { commitMessage: message } : undefined
    );

    // 更新 workspace：标记 MERGED，清空 worktreePath（物理目录已删除）
    await prisma.workspace.update({
      where: { id },
      data: { status: WorkspaceStatus.MERGED, worktreePath: '' },
    });

    // Task 推进到 DONE
    const advanceableStatuses = [TaskStatus.IN_PROGRESS, TaskStatus.IN_REVIEW];
    if (advanceableStatuses.includes(workspace.task.status as TaskStatus)) {
      await prisma.task.update({
        where: { id: workspace.task.id },
        data: { status: TaskStatus.DONE },
      });
      this.eventBus.emit('task:updated', {
        taskId: workspace.task.id,
        projectId: workspace.task.projectId,
        status: TaskStatus.DONE,
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

        // 清理残留 worktree（如果还存在）
        if (workspace.worktreePath) {
          await worktreeManager.remove(workspace.worktreePath);
        }

        // Task 已 DONE，branch 不再需要，删除
        if (workspace.branchName) {
          try {
            await execGit(workspace.task.project.repoPath, ['branch', '-D', workspace.branchName]);
          } catch {
            // branch 可能已不存在，忽略
          }
        }
      } catch (err) {
        console.warn(
          `[WorkspaceService] cleanup: failed for workspace ${workspace.id}: ${err instanceof Error ? err.message : err}`
        );
      }

      await prisma.workspace.delete({ where: { id: workspace.id } });
      cleaned++;
    }

    return cleaned;
  }

  // ── Startup Prune ────────────────────────────────────────────────────────────

  /**
   * 复制项目配置的文件到 worktree
   */
  private runCopyFiles(repoPath: string, worktreePath: string, copyFiles: string | null): void {
    if (!copyFiles?.trim()) return;
    try {
      copyProjectFiles(repoPath, worktreePath, copyFiles);
    } catch (err) {
      console.warn(
        `[WorkspaceService] copyFiles failed: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  /**
   * 在 worktree 中执行 setup 脚本（逐行执行），通过 EventBus 推送进度
   */
  private async runSetupScript(
    workspaceId: string,
    taskId: string,
    worktreePath: string,
    setupScript: string | null,
  ): Promise<void> {
    if (!setupScript?.trim()) return;
    const commands = setupScript.split('\n').map((c) => c.trim()).filter(Boolean);
    if (commands.length === 0) return;

    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i];
      console.log(`[WorkspaceService] Setup [${i + 1}/${commands.length}] running: "${cmd}"`);
      this.eventBus.emit('workspace:setup_progress', {
        workspaceId,
        taskId,
        status: 'running',
        currentCommand: cmd,
        currentIndex: i + 1,
        totalCommands: commands.length,
      });

      try {
        await execAsync(cmd, { cwd: worktreePath, timeout: 300_000 });
      } catch (err) {
        console.warn(
          `[WorkspaceService] Setup command failed: "${cmd}" - ${err instanceof Error ? err.message : err}`
        );
        // 不中断，继续执行下一条
      }
    }

    console.log(`[WorkspaceService] Setup completed (${commands.length} commands)`);
    this.eventBus.emit('workspace:setup_progress', {
      workspaceId,
      taskId,
      status: 'completed',
      totalCommands: commands.length,
    });
  }

  /**
   * Fire-and-forget 包装：异步执行 setup 脚本，不阻塞调用方
   */
  private fireSetupScript(
    workspaceId: string,
    taskId: string,
    worktreePath: string,
    setupScript: string | null,
  ): void {
    if (!setupScript?.trim()) return;
    this.runSetupScript(workspaceId, taskId, worktreePath, setupScript).catch((err) => {
      console.error(`[WorkspaceService] Setup script unexpected error:`, err);
      this.eventBus.emit('workspace:setup_progress', {
        workspaceId,
        taskId,
        status: 'failed',
        totalCommands: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

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
