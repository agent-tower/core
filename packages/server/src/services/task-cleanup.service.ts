import { prisma } from '../utils/index.js';
import { WorktreeManager } from '../git/worktree.manager.js';
import type { SessionManager } from './session-manager.js';
import { isWorktreeWorkspace } from './workspace-kind.js';

export const TaskCleanupJobStatus = {
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;

interface TaskCleanupSessionSnapshot {
  id: string;
}

interface TaskCleanupWorkspaceSnapshot {
  id: string;
  worktreePath: string;
  workingDir: string;
  workspaceKind: string;
  branchName: string;
  baseBranch: string | null;
  sessions: TaskCleanupSessionSnapshot[];
}

export interface TaskCleanupSnapshot {
  taskId: string;
  projectId: string;
  project: {
    repoPath: string;
    mainBranch: string;
  };
  workspaces: TaskCleanupWorkspaceSnapshot[];
}

const MAX_JOB_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [
  30_000,
  2 * 60_000,
  10 * 60_000,
  30 * 60_000,
  60 * 60_000,
];

function parseSnapshot(payload: string): TaskCleanupSnapshot {
  const parsed = JSON.parse(payload) as TaskCleanupSnapshot;
  if (!parsed.taskId || !parsed.projectId || !parsed.project?.repoPath || !Array.isArray(parsed.workspaces)) {
    throw new Error('Invalid task cleanup snapshot');
  }
  return parsed;
}

export function getTaskCleanupRetryDelayMs(attempts: number): number {
  return RETRY_DELAYS_MS[Math.min(Math.max(attempts - 1, 0), RETRY_DELAYS_MS.length - 1)];
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingCleanupTableError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: unknown }).code === 'P2021'
  );
}

/**
 * Persistent worker for resources left behind by fast task deletion.
 */
export class TaskCleanupService {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly sessionManager: SessionManager) {}

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.processDueJobs().catch((error) => {
        console.error('[TaskCleanupService] processDueJobs failed:', error);
      });
    }, intervalMs);
    this.processDueJobs().catch((error) => {
      console.error('[TaskCleanupService] startup cleanup failed:', error);
    });
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  trigger(): void {
    this.processDueJobs().catch((error) => {
      console.error('[TaskCleanupService] triggered cleanup failed:', error);
    });
  }

  async processDueJobs(limit = 5): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      let processed = 0;
      while (processed < limit) {
        const job = await this.claimNextJob();
        if (!job) break;
        await this.processJob(job.id);
        processed++;
      }
      return processed;
    } finally {
      this.running = false;
    }
  }

  async processJob(jobId: string): Promise<void> {
    const job = await prisma.taskCleanupJob.findUnique({ where: { id: jobId } });
    if (!job) return;

    try {
      const snapshot = parseSnapshot(job.payload);
      await this.cleanupSnapshot(snapshot);

      await prisma.$transaction([
        prisma.task.deleteMany({ where: { id: snapshot.taskId } }),
        prisma.taskCleanupJob.update({
          where: { id: jobId },
          data: {
            status: TaskCleanupJobStatus.COMPLETED,
            lastError: null,
            nextRetryAt: null,
            completedAt: new Date(),
          },
        }),
      ]);
    } catch (error) {
      await this.recordFailure(jobId, job.attempts, toErrorMessage(error));
    }
  }

  private async claimNextJob() {
    const now = new Date();
    let job;
    try {
      job = await prisma.taskCleanupJob.findFirst({
        where: {
          OR: [
            { status: TaskCleanupJobStatus.PENDING },
            {
              status: TaskCleanupJobStatus.RUNNING,
              attempts: { lt: MAX_JOB_ATTEMPTS },
            },
            {
              status: TaskCleanupJobStatus.FAILED,
              attempts: { lt: MAX_JOB_ATTEMPTS },
              OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
            },
          ],
        },
        orderBy: [{ createdAt: 'asc' }],
      });
    } catch (error) {
      if (isMissingCleanupTableError(error)) {
        return null;
      }
      throw error;
    }

    if (!job) return null;

    try {
      return await prisma.taskCleanupJob.update({
        where: { id: job.id },
        data: {
          status: TaskCleanupJobStatus.RUNNING,
          attempts: { increment: 1 },
          startedAt: now,
          lastError: null,
        },
      });
    } catch {
      return null;
    }
  }

  private async cleanupSnapshot(snapshot: TaskCleanupSnapshot): Promise<void> {
    const worktreeManager = new WorktreeManager(snapshot.project.repoPath);

    for (const workspace of snapshot.workspaces) {
      for (const session of workspace.sessions) {
        try {
          await this.sessionManager.stop(session.id, { skipTeamRunReconcile: true });
        } catch (error) {
          console.warn(
            `[TaskCleanupService] failed to stop session ${session.id}:`,
            toErrorMessage(error),
          );
        }
      }
    }

    for (const workspace of snapshot.workspaces) {
      if (!isWorktreeWorkspace(workspace)) continue;
      if (!workspace.worktreePath) continue;
      const result = await worktreeManager.remove(workspace.worktreePath);
      if (result.status === 'unregistered') {
        throw new Error(`Workspace ${workspace.id} path is unregistered or unsafe to remove: ${result.path}`);
      }
    }

    for (const workspace of snapshot.workspaces) {
      if (!isWorktreeWorkspace(workspace)) continue;
      const result = await worktreeManager.deleteBranchIfSafe(workspace.branchName, {
        protectedBranches: [snapshot.project.mainBranch, workspace.baseBranch],
      });
      if (result.status === 'failed') {
        throw new Error(`Failed to delete branch ${result.branchName}: ${result.reason ?? 'unknown error'}`);
      }
      if (result.status === 'checked_out') {
        throw new Error(`Branch ${result.branchName} is checked out: ${result.reason ?? 'unknown location'}`);
      }
    }

    if (snapshot.workspaces.some((workspace) => isWorktreeWorkspace(workspace))) {
      await worktreeManager.prune();
    }
  }

  private async recordFailure(jobId: string, attempts: number, message: string): Promise<void> {
    const retryable = attempts < MAX_JOB_ATTEMPTS;
    await prisma.taskCleanupJob.update({
      where: { id: jobId },
      data: {
        status: TaskCleanupJobStatus.FAILED,
        lastError: message,
        nextRetryAt: retryable ? new Date(Date.now() + getTaskCleanupRetryDelayMs(attempts)) : null,
      },
    });
  }
}
