import { prisma } from '../utils/index.js';
import { WorkspaceStatus } from '../types/index.js';
import { WorktreeManager } from '../git/worktree.manager.js';

export class WorkspaceService {
  async findById(id: string) {
    return prisma.workspace.findUnique({
      where: { id },
      include: { sessions: true, task: { include: { project: true } } },
    });
  }

  async create(taskId: string, branchName?: string) {
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      include: { project: true },
    });

    if (!task) {
      throw new Error('Task not found');
    }

    const branch = branchName || `task-${taskId.slice(0, 8)}`;
    const worktreeManager = new WorktreeManager(task.project.repoPath);
    const worktreePath = await worktreeManager.create(branch);

    return prisma.workspace.create({
      data: {
        taskId,
        branchName: branch,
        worktreePath,
        status: WorkspaceStatus.ACTIVE,
      },
    });
  }

  async getDiff(id: string) {
    const workspace = await prisma.workspace.findUnique({
      where: { id },
      include: { task: { include: { project: true } } },
    });

    if (!workspace) {
      return null;
    }

    const worktreeManager = new WorktreeManager(workspace.task.project.repoPath);
    return worktreeManager.getDiff(
      workspace.worktreePath,
      workspace.task.project.mainBranch
    );
  }

  async merge(id: string) {
    const workspace = await prisma.workspace.findUnique({
      where: { id },
      include: { task: { include: { project: true } } },
    });

    if (!workspace) {
      return false;
    }

    const worktreeManager = new WorktreeManager(workspace.task.project.repoPath);
    await worktreeManager.merge(
      workspace.worktreePath,
      workspace.task.project.mainBranch
    );

    await prisma.workspace.update({
      where: { id },
      data: { status: WorkspaceStatus.MERGED },
    });

    return true;
  }

  async delete(id: string) {
    const workspace = await prisma.workspace.findUnique({
      where: { id },
      include: { task: { include: { project: true } } },
    });

    if (!workspace) {
      return false;
    }

    try {
      const worktreeManager = new WorktreeManager(workspace.task.project.repoPath);
      await worktreeManager.remove(workspace.worktreePath);
    } catch {
      // Worktree may already be removed
    }

    await prisma.workspace.delete({ where: { id } });
    return true;
  }
}
