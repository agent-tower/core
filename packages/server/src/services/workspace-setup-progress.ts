import type { WorkspaceSetupProgressPayload } from '@agent-tower/shared/socket';

const TERMINAL_RETENTION_MS = 10 * 60_000;

/** Live setup state is shared by all WorkspaceService instances in this server. */
export class WorkspaceSetupProgressStore {
  private readonly progress = new Map<string, WorkspaceSetupProgressPayload>();
  private lastUpdatedAt = 0;

  record(input: Omit<WorkspaceSetupProgressPayload, 'updatedAt'>): WorkspaceSetupProgressPayload {
    this.prune();
    const updatedAt = Math.max(Date.now(), this.lastUpdatedAt + 1);
    this.lastUpdatedAt = updatedAt;
    const snapshot = { ...input, updatedAt };
    this.progress.set(input.workspaceId, snapshot);
    return snapshot;
  }

  get(workspaceId: string): WorkspaceSetupProgressPayload | undefined {
    const progress = this.progress.get(workspaceId);
    if (progress && progress.status !== 'running' && progress.updatedAt < Date.now() - TERMINAL_RETENTION_MS) {
      this.progress.delete(workspaceId);
      return undefined;
    }
    return progress;
  }

  private prune(): void {
    const cutoff = Date.now() - TERMINAL_RETENTION_MS;
    for (const [id, progress] of this.progress) {
      if (progress.status !== 'running' && progress.updatedAt < cutoff) this.progress.delete(id);
    }
  }
}
