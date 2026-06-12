import { EventBus } from './event-bus.js';
import { SessionManager } from '../services/session-manager.js';
import { CommitMessageService } from '../services/commit-message.service.js';
import { NotificationService } from '../services/notifications/index.js';
import { TaskCleanupService } from '../services/task-cleanup.service.js';
import { WorkspaceGitWatcherService } from '../services/workspace-git-watcher.service.js';
import { prisma } from '../utils/index.js';
// TerminalManager is lazy-imported to avoid eager native module (node-pty) loading
// that could break getEventBus()/getSessionManager() if the import fails.
import type { TerminalManager } from '../services/terminal-manager.js';

let eventBus: EventBus | null = null;
let sessionManager: SessionManager | null = null;
let terminalManager: TerminalManager | null = null;
let commitMessageService: CommitMessageService | null = null;
let notificationService: NotificationService | null = null;
let taskCleanupService: TaskCleanupService | null = null;
let workspaceGitWatcherService: WorkspaceGitWatcherService | null = null;

export function getEventBus(): EventBus {
  if (!eventBus) {
    eventBus = new EventBus();
  }
  return eventBus;
}

export function getSessionManager(): SessionManager {
  if (!sessionManager) {
    sessionManager = new SessionManager(getEventBus());
  }
  return sessionManager;
}

export function getCommitMessageService(): CommitMessageService {
  if (!commitMessageService) {
    commitMessageService = new CommitMessageService();
  }
  return commitMessageService;
}

export function getTaskCleanupService(): TaskCleanupService {
  if (!taskCleanupService) {
    taskCleanupService = new TaskCleanupService(getSessionManager(), getWorkspaceGitWatcherService());
  }
  return taskCleanupService;
}

export function getWorkspaceGitWatcherService(): WorkspaceGitWatcherService {
  if (!workspaceGitWatcherService) {
    workspaceGitWatcherService = new WorkspaceGitWatcherService(getEventBus());
  }
  return workspaceGitWatcherService;
}

export async function getTerminalManager(): Promise<TerminalManager> {
  if (!terminalManager) {
    const { TerminalManager: TM } = await import('../services/terminal-manager.js');
    terminalManager = new TM(getEventBus());
  }
  return terminalManager;
}

export function getNotificationService(): NotificationService {
  if (!notificationService) {
    notificationService = new NotificationService();

    // 监听 task:updated，当任务进入 IN_REVIEW 时发送通知
    getEventBus().on('task:updated', ({ taskId, status }) => {
      if (status !== 'IN_REVIEW') return;
      prisma.task.findUnique({
        where: { id: taskId },
        select: { title: true, projectId: true },
      })
        .then((task) => {
          notificationService!.notify({
            type: 'task_in_review',
            title: 'Agent Tower', // 模板里会覆盖
            body: '', // 模板里会覆盖
            metadata: {
              taskId,
              taskTitle: task?.title ?? taskId,
              projectId: task?.projectId ?? '',
            },
          });
        })
        .catch((err) => {
          console.error('[NotificationService] Failed to fetch task for notification:', err);
        });
    });
  }
  return notificationService;
}
