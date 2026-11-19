/**
 * Stop timing of owned child processes (owned-child-process.ts). The command
 * helper client derives its deadlines from the same numbers, so a change here
 * moves both together.
 */

/** Delay between the graceful stop signal and SIGKILL when the caller sets none. */
export const DEFAULT_STOP_GRACE_MS = 2_000;

/** How long an owner waits for the tree to disappear after each escalation step. */
export const FORCE_EXIT_TIMEOUT_MS = 2_000;

/**
 * Longest time an owner legitimately needs from a stop request until it
 * confirms that the command tree is gone, on its first attempt: the grace,
 * the wait after it, and the wait after the forced stop (supervised scope;
 * the compatibility backend needs one force wait less).
 */
export const OWNER_STOP_BUDGET_MS = DEFAULT_STOP_GRACE_MS + 2 * FORCE_EXIT_TIMEOUT_MS;
