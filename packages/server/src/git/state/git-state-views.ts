/**
 * The two REST responses, unchanged in shape, built from one git state.
 */
import { ConflictOp, type GitOperationStatus } from '@agent-tower/shared';
import type { GitChangeEntry, GitStateSnapshot } from './git-state-types.js';

/** `GET /git/changes` (call only for an available state; otherwise the route answers `GIT_UNAVAILABLE`). */
export function toGitChangesResponse(snapshot: GitStateSnapshot): { uncommitted: GitChangeEntry[]; committed: GitChangeEntry[] } {
  return { uncommitted: snapshot.uncommitted, committed: snapshot.committed };
}

/**
 * `GET /workspaces/:id/git-status`, as `WorktreeManager.getGitOperationStatus`
 * builds it: conflicted files only while a rebase or merge is in progress, and
 * the defaults for a directory that is not a work tree.
 */
export function toGitOperationStatus(snapshot: GitStateSnapshot): GitOperationStatus {
  const operation = snapshot.available ? snapshot.operation : 'idle';
  const conflictOp = operation === 'rebase' ? ConflictOp.REBASE : operation === 'merge' ? ConflictOp.MERGE : null;
  return {
    operation,
    conflictedFiles: operation === 'idle' ? [] : [...snapshot.unmergedPaths],
    conflictOp,
    ahead: snapshot.ahead,
    behind: snapshot.behind,
    hasUncommittedChanges: snapshot.uncommittedCount > 0,
    uncommittedCount: snapshot.uncommittedCount,
    untrackedCount: snapshot.untrackedCount,
  };
}

/** Existing Git status response for a Git-backed MAIN_DIRECTORY workspace. */
export function mainDirectoryGitStatus(): GitOperationStatus {
  return {
    operation: 'idle', conflictedFiles: [], conflictOp: null, ahead: 0, behind: 0,
    hasUncommittedChanges: false, uncommittedCount: 0, untrackedCount: 0,
  };
}
