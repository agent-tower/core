import { EventBus } from './event-bus.js';
import { SessionManager } from '../services/session-manager.js';
import { CommitMessageService } from '../services/commit-message.service.js';
import { NotificationService } from '../services/notifications/index.js';
import { TaskCleanupService } from '../services/task-cleanup.service.js';
import { AgentCliEnvironmentService } from '../services/agent-cli/environment.service.js';
import { WorkspaceBackgroundService } from '../services/workspace-background-service.service.js';
import { WorkspaceSetupProgressStore } from '../services/workspace-setup-progress.js';
import { prisma } from '../utils/index.js';
import { TunnelService } from '../services/tunnel.service.js';
import { assertApplicationProcessStartAllowed, beginApplicationProcessShutdown, cleanupApplicationProcessOwners } from '../runtime/application-process-cleanup.js';
// TerminalManager is lazy-imported to avoid eager native module (node-pty) loading
// that could break getEventBus()/getSessionManager() if the import fails.
import type { TerminalManager } from '../services/terminal-manager.js';

let eventBus: EventBus | null = null;
let sessionManager: SessionManager | null = null;
let terminalManager: TerminalManager | null = null;
let terminalManagerPromise: Promise<TerminalManager> | null = null;
let commitMessageService: CommitMessageService | null = null;
let notificationService: NotificationService | null = null;
let taskCleanupService: TaskCleanupService | null = null;
let agentCliEnvironmentService: AgentCliEnvironmentService | null = null;
let workspaceBackgroundService: WorkspaceBackgroundService | null = null;
const workspaceSetupProgressStore = new WorkspaceSetupProgressStore();

export function getWorkspaceSetupProgressStore(): WorkspaceSetupProgressStore {
  return workspaceSetupProgressStore;
}

export function getEventBus(): EventBus {
  if (!eventBus) {
    eventBus = new EventBus();
  }
  return eventBus;
}

export function getSessionManager(): SessionManager {
  if (!sessionManager) {
    assertApplicationProcessStartAllowed();
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
    taskCleanupService = new TaskCleanupService(getSessionManager(), getWorkspaceBackgroundService());
  }
  return taskCleanupService;
}

export function getWorkspaceBackgroundService(): WorkspaceBackgroundService {
  if (!workspaceBackgroundService) {
    assertApplicationProcessStartAllowed();
    workspaceBackgroundService = new WorkspaceBackgroundService();
  }
  return workspaceBackgroundService;
}

export async function getTerminalManager(): Promise<TerminalManager> {
  if (terminalManager) return terminalManager;
  if (!terminalManagerPromise) {
    assertApplicationProcessStartAllowed();
    terminalManagerPromise = import('../services/terminal-manager.js').then(({ TerminalManager: TM }) => {
      assertApplicationProcessStartAllowed();
      terminalManager = new TM(getEventBus());
      return terminalManager;
    }).finally(() => { terminalManagerPromise = null; });
  }
  return terminalManagerPromise;
}

/** Every process owner participates in each retry, independently of HTTP hooks. */
export async function destroyApplicationProcesses(): Promise<void> {
  beginApplicationProcessShutdown();
  await cleanupApplicationProcessOwners([
    () => sessionManager?.destroyAll(),
    () => workspaceBackgroundService?.shutdown(),
    () => agentCliEnvironmentService?.shutdown(),
    () => TunnelService.stop(),
    async () => {
      const manager = terminalManager ?? await terminalManagerPromise?.catch(() => null);
      await manager?.destroyAll();
    },
  ]);
}

export function getAgentCliEnvironmentService(): AgentCliEnvironmentService {
  if (!agentCliEnvironmentService) {
    assertApplicationProcessStartAllowed();
    agentCliEnvironmentService = new AgentCliEnvironmentService();
  }
  return agentCliEnvironmentService;
}

export function getNotificationService(): NotificationService {
  if (!notificationService) {
    notificationService = new NotificationService();

    // 监听 task:updated，当任务进入 IN_REVIEW 时发送通知
    getEventBus().on('task:updated', ({ taskId, status, priority }) => {
      if (status !== 'IN_REVIEW' || priority !== undefined) return;
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
