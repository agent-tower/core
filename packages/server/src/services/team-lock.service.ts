import type { TeamMemberCapabilities, WorkspacePolicy } from '@agent-tower/shared';

export interface LockRequest {
  teamRunId: string;
  memberId: string;
  workspaceId?: string | null;
  projectId?: string | null;
  capabilities: TeamMemberCapabilities;
  workspacePolicy: WorkspacePolicy;
}

export interface HeldLock {
  key: string;
  ownerId: string;
}

export class TeamLockService {
  private readonly locks = new Map<string, string>();

  getRequiredLocks(request: LockRequest): string[] {
    const lockKeys = new Set<string>();
    const usesWorkspaceLocks = request.workspacePolicy === 'shared' && request.workspaceId != null;

    if (usesWorkspaceLocks && request.capabilities.writeFiles) {
      lockKeys.add(`workspace:${request.workspaceId}:write`);
    }

    if (usesWorkspaceLocks && request.capabilities.runCommands) {
      lockKeys.add(`workspace:${request.workspaceId}:command`);
    }

    if (request.capabilities.mergeWorkspace && request.projectId != null) {
      lockKeys.add(`project:${request.projectId}:merge`);
    }

    return [...lockKeys];
  }

  canAcquire(lockKeys: string[]): boolean {
    return lockKeys.every((key) => !this.locks.has(key));
  }

  acquire(ownerId: string, lockKeys: string[]): boolean {
    const uniqueKeys = [...new Set(lockKeys)];
    const canAcquireAll = uniqueKeys.every((key) => {
      const currentOwnerId = this.locks.get(key);
      return currentOwnerId == null || currentOwnerId === ownerId;
    });

    if (!canAcquireAll) {
      return false;
    }

    for (const key of uniqueKeys) {
      this.locks.set(key, ownerId);
    }

    return true;
  }

  releaseByOwner(ownerId: string): void {
    for (const [key, currentOwnerId] of this.locks) {
      if (currentOwnerId === ownerId) {
        this.locks.delete(key);
      }
    }
  }

  listLocks(): HeldLock[] {
    return [...this.locks.entries()].map(([key, ownerId]) => ({ key, ownerId }));
  }
}
