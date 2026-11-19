/**
 * Limits of the git state service (./git-state-service.ts). The command
 * helper client derives its deadline for git state requests from the
 * computation budget, so both live here.
 */

/**
 * Line counts are never computed for a file whose old or new side is larger
 * than this. Such files appear in the change lists without `additions` and
 * `deletions` (one worktree on the production host has four 48 MB files whose
 * `--numstat` alone needs 36 s of CPU).
 */
export const GIT_DIFF_SIZE_LIMIT_BYTES = 1024 * 1024;

/** A cached state is reused for this long after its computation started. */
export const GIT_STATE_FRESHNESS_MS = 1_000;

/** Registered worktrees have one safety computation per interval. */
export const GIT_STATE_SAFETY_INTERVAL_MS = 30_000;
export const GIT_STATE_DEBOUNCE_MS = 300;
export const GIT_STATE_MIN_COMPUTATION_INTERVAL_MS = 1_000;

/**
 * Upper bound for one computation. Every git command gets at most the time
 * that is left of it, so a computation never runs longer, and the server
 * waits for the command helper's answer at most this plus the stop grace.
 */
export const GIT_STATE_COMPUTATION_BUDGET_MS = 60_000;

/** Per-command timeouts, as today: `git status` and `rev-list` had 30 s (execGit), the diffs of `/git/changes` 10 s. */
export const GIT_STATUS_TIMEOUT_MS = 30_000;
export const GIT_DIFF_TIMEOUT_MS = 10_000;
export const GIT_REV_LIST_TIMEOUT_MS = 30_000;
export const GIT_PROBE_TIMEOUT_MS = 10_000;

/** Output limit of one git command, as today. */
export const GIT_OUTPUT_LIMIT_BYTES = 10 * 1024 * 1024;

// ─── Diffs of single files (./git-file-diff.ts) ─────────────────────────────

/** A diff is shown only while both sides are at most this large; `force` raises it to the forced limit. */
export const GIT_FILE_DIFF_LIMIT_BYTES = GIT_DIFF_SIZE_LIMIT_BYTES;
/** "Load anyway": the largest side a forced request shows. Above it the answer stays `too_large`. */
export const GIT_FILE_DIFF_FORCED_LIMIT_BYTES = 8 * 1024 * 1024;

/** Bytes of diff text the service keeps for all worktrees together (least recently used first out). */
export const GIT_DIFF_CACHE_LIMIT_BYTES = 16 * 1024 * 1024;
/** A larger diff text is answered but not kept. */
export const GIT_DIFF_CACHE_ENTRY_LIMIT_BYTES = 1024 * 1024;

/**
 * A file whose modification time lies within this window of a computation's
 * start may still change without a visible `lstat` change (timestamps have a
 * granularity). Its version token then also carries the state's epoch and
 * version, and a diff read in that window is not cached.
 */
export const GIT_RACY_WINDOW_MS = 3_000;

/** Per-command timeouts of a file diff: the diff itself (larger when forced) and the blob size probe. */
export const GIT_FILE_DIFF_TIMEOUT_MS = 10_000;
export const GIT_FILE_DIFF_FORCED_TIMEOUT_MS = 30_000;
/** Upper bound for the git work of one diff after the state is known: the diff plus one size probe. */
export const GIT_FILE_DIFF_BUDGET_MS = GIT_FILE_DIFF_FORCED_TIMEOUT_MS + GIT_PROBE_TIMEOUT_MS;
