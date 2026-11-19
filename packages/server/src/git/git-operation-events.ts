/**
 * Lightweight server-side mutation signal. Keeping this independent of the
 * application container lets WorktreeManager remain usable on its own.
 */
export interface WorkspaceGitOperation {
  worktreePaths: string[];
  /** Recreating a directory also requires rebuilding its watches. */
  recreated?: boolean;
  /** Workspace metadata may change which row supplies a shared directory's base. */
  metadataChanged?: boolean;
}

const listeners = new Set<(event: WorkspaceGitOperation) => void>();

export function onWorkspaceGitOperation(listener: (event: WorkspaceGitOperation) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Called once after a Tower operation, including one that leaves a conflict. */
export function notifyWorkspaceGitOperation(worktreePaths: string[], recreated = false): void {
  publish({ worktreePaths, recreated });
}

/** Reload directory metadata without treating the existing directory as recreated. */
export function notifyWorkspaceGitMetadataChanged(workingDirs: string[]): void {
  if (listeners.size === 0) return;
  const worktreePaths = [...new Set(workingDirs.filter(Boolean))];
  if (worktreePaths.length) publish({ worktreePaths, metadataChanged: true });
}

/** Uses the row captured before a mutation, including before its paths are cleared. */
export function notifyMainDirectoryGitMetadataChanged(workspace: {
  workspaceKind?: string | null;
  workingDir?: string | null;
  worktreePath?: string | null;
}): void {
  if (workspace.workspaceKind !== 'MAIN_DIRECTORY' || listeners.size === 0) return;
  const workingDir = workspace.workingDir || workspace.worktreePath;
  if (workingDir) notifyWorkspaceGitMetadataChanged([workingDir]);
}

function publish(event: WorkspaceGitOperation): void {
  if (listeners.size === 0) return;
  for (const listener of listeners) {
    // Observing a completed operation must not change its result.
    try { listener(event); }
    catch (error) { console.warn('[workspace-git] operation observer failed', error); }
  }
}
