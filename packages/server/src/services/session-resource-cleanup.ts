import { ServiceError } from '../errors.js';
import type { SessionManager } from './session-manager.js';
import { WorkspaceStatus } from '../types/index.js';

/** Historical sessions stay readable, but cannot launch in a reclaimed workspace. */
export function assertWorkspaceSessionAvailable(workspace: { status: string; cleanedAt?: Date | null }): void {
  if (workspace.cleanedAt || workspace.status !== WorkspaceStatus.ACTIVE) {
    throw new ServiceError('Workspace is read-only. Create or reactivate a workspace to continue.', 'WORKSPACE_NOT_ACTIVE', 409);
  }
}

interface SessionResource {
  workspaceId?: string | null;
  conversationId?: string | null;
}

// Cover the entire filesystem/DB removal boundary, including time after stop
// has released the session action lock. Late follow-ups must not reopen it.
const cleanupCounts = new Map<string, number>();

function resourceKeys(resource: SessionResource): string[] {
  return [
    ...(resource.workspaceId ? [`workspace:${resource.workspaceId}`] : []),
    ...(resource.conversationId ? [`conversation:${resource.conversationId}`] : []),
  ];
}

export function assertSessionResourceAvailable(resource: SessionResource): void {
  if (resourceKeys(resource).some((key) => cleanupCounts.has(key))) {
    throw new ServiceError('Session resource cleanup is in progress', 'SESSION_NOT_ADMITTED', 409);
  }
}

export async function withSessionResourceCleanup<T>(
  resource: SessionResource,
  operation: () => Promise<T>,
): Promise<T> {
  const keys = resourceKeys(resource);
  for (const key of keys) cleanupCounts.set(key, (cleanupCounts.get(key) ?? 0) + 1);
  try {
    return await operation();
  } finally {
    for (const key of keys) {
      const count = (cleanupCounts.get(key) ?? 1) - 1;
      if (count > 0) cleanupCounts.set(key, count);
      else cleanupCounts.delete(key);
    }
  }
}

export async function stopSessionForResourceCleanup(
  manager: Pick<SessionManager, 'stop' | 'isRuntimeCleanupConfirmed'>,
  sessionId: string,
  options?: Parameters<SessionManager['stop']>[1],
): Promise<void> {
  const session = options === undefined
    ? await manager.stop(sessionId)
    : await manager.stop(sessionId, options);
  if (session === null) return;
  if (!await manager.isRuntimeCleanupConfirmed(sessionId)) {
    throw new ServiceError(
      `Session '${sessionId}' process cleanup is not confirmed`,
      'RUNTIME_CLEANUP_PENDING',
      409,
    );
  }
}
