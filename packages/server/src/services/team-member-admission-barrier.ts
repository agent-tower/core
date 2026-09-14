import { ServiceError } from '../errors.js';

const memberAdmissionBarriers = new Map<string, Promise<void>>();
const memberAdmissionHolders = new Map<string, { label: string; acquiredAt: number }>();

/**
 * Default ceiling for callers that must answer a user request (member stop,
 * direct session stop). The barrier is an in-memory promise chain with no
 * lease, so an owner that never returns would otherwise block every later
 * stop/follow-up for the same member forever.
 */
export const DEFAULT_MEMBER_ADMISSION_ACQUIRE_TIMEOUT_MS = 30_000;
const HOLD_WARN_THRESHOLD_MS = 60_000;

export function teamMemberAdmissionKey(teamRunId: string, memberId: string): string {
  return `scheduling:${teamRunId}:member:${memberId}`;
}

/** Fail-fast signal for admission waiters; the route boundary maps it to HTTP 409. */
export class MemberAdmissionBusyError extends ServiceError {
  constructor(
    public readonly key: string,
    public readonly waitedMs: number,
    public readonly holderLabel: string | null,
    public readonly heldMs: number | null,
  ) {
    super(
      holderLabel
        ? `TeamRun member admission is busy: '${holderLabel}' has been holding it for ${Math.round((heldMs ?? 0) / 1000)}s`
        : 'TeamRun member admission is busy and did not become available in time',
      'MEMBER_ADMISSION_BUSY',
      409,
    );
    this.name = 'MemberAdmissionBusyError';
  }
}

export interface AcquireTeamMemberAdmissionOptions {
  /** Diagnostic label recorded while this caller owns the barrier. */
  holder?: string;
  /** Abandon the wait with `MemberAdmissionBusyError` after this many milliseconds. */
  timeoutMs?: number;
}

export async function acquireTeamMemberAdmission(
  teamRunId: string,
  memberId: string,
  options: AcquireTeamMemberAdmissionOptions = {},
): Promise<() => void> {
  const key = teamMemberAdmissionKey(teamRunId, memberId);
  const previous = memberAdmissionBarriers.get(key) ?? Promise.resolve();
  let resolveHold!: () => void;
  const hold = new Promise<void>((resolve) => {
    resolveHold = resolve;
  });
  const current = previous.then(() => hold);
  memberAdmissionBarriers.set(key, current);

  let released = false;
  if (options.timeoutMs != null) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      previous.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), options.timeoutMs);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) {
      // Let this abandoned slot pass through instead of holding the chain
      // forever. The real owner keeps the lock and everything queued behind us
      // still proceeds in arrival order once that owner releases. Releasing a
      // stuck owner is never safe here: the barrier is what guarantees a member
      // cannot start two sessions at once.
      released = true;
      resolveHold();
      const holder = memberAdmissionHolders.get(key);
      throw new MemberAdmissionBusyError(
        key,
        options.timeoutMs,
        holder?.label ?? null,
        holder ? Math.max(0, Date.now() - holder.acquiredAt) : null,
      );
    }
  } else {
    await previous;
  }

  const holderLabel = options.holder ?? 'unlabeled';
  memberAdmissionHolders.set(key, { label: holderLabel, acquiredAt: Date.now() });
  let holdWarnTimer: ReturnType<typeof setTimeout> | undefined;
  if (options.holder) {
    holdWarnTimer = setTimeout(() => {
      console.error(
        `[TeamMemberAdmission] ${key} has been held by '${holderLabel}' for over ${HOLD_WARN_THRESHOLD_MS / 1000}s`,
      );
    }, HOLD_WARN_THRESHOLD_MS);
    (holdWarnTimer as { unref?: () => void }).unref?.();
  }

  return () => {
    if (released) return;
    released = true;
    if (holdWarnTimer) clearTimeout(holdWarnTimer);
    if (memberAdmissionHolders.get(key)?.label === holderLabel) {
      memberAdmissionHolders.delete(key);
    }
    resolveHold();
    if (memberAdmissionBarriers.get(key) === current) {
      memberAdmissionBarriers.delete(key);
    }
  };
}
