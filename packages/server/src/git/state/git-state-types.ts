/**
 * Shapes of the git state service (./git-state-service.ts), shared by the
 * service, the command helper protocol and the server facade. Types only.
 */

/** One changed file, in the shape of `GET /git/changes`. */
export interface GitChangeEntry {
  status: string;
  path: string;
  /** Absent for untracked files and for files above the size limit. */
  additions?: number;
  deletions?: number;
  /**
   * Version of this file's diff (./git-file-versions.ts): it changes whenever
   * the diff can change. Opaque; compare for equality only.
   */
  token: string;
}

export interface GitStateRequest {
  /** Absolute directory as the caller names it: `workingDir`, or a workspace's worktree path. */
  worktreePath: string;
  /** The project's repository. The branch comparison runs there, as `WorktreeManager.getBranchStatus` does. */
  repositoryPath?: string | null;
  /** Base branch of the committed list and of ahead/behind. */
  baseBranch: string;
  /**
   * The caller's effective environment, sent like an owned command's (the
   * server's environment can change after the command helper started).
   * Absent: the environment of the process that runs the service.
   */
  env?: Record<string, string>;
}

export type GitOperation = 'idle' | 'rebase' | 'merge';

/** Everything one computation determines; compared to decide whether the version moves. */
export interface GitStateContent {
  worktreePath: string;
  baseBranch: string;
  /** False when the directory is not inside a git work tree (`GIT_UNAVAILABLE`). */
  available: boolean;
  operation: GitOperation;
  /** `oid` is null before the first commit; `branch` is null for a detached HEAD. */
  head: { oid: string | null; branch: string | null };
  /** `GET /git/changes`: tracked changes against HEAD, then untracked files as `A`. */
  uncommitted: GitChangeEntry[];
  /** `GET /git/changes`: changes of `<base>...HEAD`, or of `origin/<base>...HEAD`. */
  committed: GitChangeEntry[];
  /** Tracked entries with changes (a rename counts once). */
  uncommittedCount: number;
  /** Untracked files (not collapsed folders). */
  untrackedCount: number;
  /** Unmerged paths; the git-status view reports them only while a rebase or merge is in progress. */
  unmergedPaths: string[];
  ahead: number;
  behind: number;
  /** Parts that could not be computed (a timeout, a git error). They hold the values today's code falls back to. */
  degraded: string[];
}

export interface GitStateSnapshot extends GitStateContent {
  /** Random id of the service instance that computed it; a new placement is a new epoch. */
  epoch: string;
  /** Increases by one whenever a computation of this worktree produced a different content. */
  version: number;
  /** When the computation began reading the worktree (ms since the Unix epoch). */
  computedAt: number;
}

export type GitStateSource = 'cache' | 'computation' | 'shared';

/** Signals that schedule work for a registered worktree. */
export type GitStateTrigger = 'watch' | 'agent' | 'terminal' | 'service' | 'operation' | 'refresh' | 'safety';

/** Cumulative counters of one service instance. */
export interface GitStateCounters {
  /** Every request, file diffs included (a diff looks up the current state first). */
  requests: number;
  computations: number;
  /** Requests answered from a fresh state, file diffs' state lookups included. */
  cacheAnswers: number;
  /** Every git process the instance started: state computations and file diffs. */
  gitProcesses: number;
  diffRequests: number;
  /** File diffs computed; requests that joined a running one are not counted again. */
  diffComputations: number;
  diffCacheAnswers: number;
  computationsWatch: number;
  computationsAgent: number;
  computationsTerminal: number;
  computationsService: number;
  computationsOperation: number;
  computationsRefresh: number;
  computationsSafety: number;
}

export interface GitStateResult {
  snapshot: GitStateSnapshot;
  /** `cache`: answered from a fresh state; `computation`: started one; `shared`: joined a running one. */
  source: GitStateSource;
  counters: GitStateCounters;
}

// ─── Diffs of single files ──────────────────────────────────────────────────

export type GitDiffKind = 'uncommitted' | 'committed';

/** One file's diff: the request names the worktree the way a state request does. */
export interface GitDiffRequest extends GitStateRequest {
  /** As the change list names it: from the top of the work tree, untracked files from `worktreePath`. */
  path: string;
  kind: GitDiffKind;
  /** "Load anyway": raises the size limit to GIT_FILE_DIFF_FORCED_LIMIT_BYTES. */
  force?: boolean;
}

/** Exactly one of a text diff, a binary file, or a file above the size limit. Sizes are in bytes; null for a side that does not exist. */
export type GitFileDiff =
  | { kind: 'text'; token: string; diff: string }
  | { kind: 'binary'; token: string; oldSize: number | null; newSize: number | null }
  | {
    kind: 'too_large'; token: string; oldSize: number | null; newSize: number | null;
    /** The per-side limit this answer applied. */
    limit: number;
    /** True when a forced request ("load anyway") can show it. */
    canForce: boolean;
  };

export type GitDiffSource = 'cache' | 'computation' | 'shared' | 'state';

export interface GitDiffResult {
  /** Null when the directory is not inside a git work tree (`GIT_UNAVAILABLE`). */
  diff: GitFileDiff | null;
  /** The service instance that answered (its counters are cumulative per epoch). */
  epoch: string;
  /** `state`: answered from the state alone (the file is not listed); the others as for git state. */
  source: GitDiffSource;
  counters: GitStateCounters;
}
