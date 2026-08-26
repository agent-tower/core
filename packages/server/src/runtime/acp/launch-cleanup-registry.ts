import { randomUUID } from 'node:crypto';

const IMMEDIATE_ATTEMPTS = 3;
const ATTEMPT_TIMEOUT_MS = 1_000;
const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 120_000, 300_000];

export type LaunchCleanupStatus = 'PENDING' | 'RUNNING' | 'CONFIRMED' | 'FAILED';

export interface LaunchCleanupOwnerState {
  id: string;
  label?: string;
  status: LaunchCleanupStatus;
  attemptCount: number;
  lastError?: string;
  nextRetryAt?: number;
}

type CleanupOwner = LaunchCleanupOwnerState & {
  cleanup: () => Promise<void>;
  inFlight?: Promise<void>;
  retryTimer?: ReturnType<typeof setTimeout>;
  shutdownWarningReported?: boolean;
};

/**
 * Auxiliary ACP launch cleanup is independent from DriverSession lifetime.
 * Every transport generation gets its own owner, so a reconnect cannot
 * overwrite a failed callback from the previous generation.
 */
export class LaunchCleanupRegistry {
  private readonly owners = new Map<string, CleanupOwner>();
  private stopped = false;

  register(cleanup: () => Promise<void>, label?: string): string {
    if (this.stopped) {
      if (this.owners.size > 0) {
        throw new Error('Cannot register ACP launch cleanup while shutdown owners remain unresolved');
      }
      // A fresh RuntimeCoordinator represents a fresh application lifecycle
      // (and keeps isolated test coordinators from sharing shutdown state).
      this.stopped = false;
    }
    const id = randomUUID();
    this.owners.set(id, {
      id,
      label,
      status: 'PENDING',
      attemptCount: 0,
      cleanup,
    });
    return id;
  }

  async runWithImmediateRetries(id: string, attempts = IMMEDIATE_ATTEMPTS): Promise<void> {
    const owner = this.owners.get(id);
    if (!owner) return;
    let lastError: unknown;
    const attemptLimit = Math.max(1, attempts);
    for (let index = 0; index < attemptLimit; index += 1) {
      try {
        await this.runAttempt(owner, false);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    this.scheduleRetry(owner);
    if (lastError) throw lastError;
  }

  async runAttemptById(id: string): Promise<void> {
    const owner = this.owners.get(id);
    if (!owner) return;
    await this.runAttempt(owner, true);
  }

  getState(id: string): LaunchCleanupOwnerState | undefined {
    const owner = this.owners.get(id);
    return owner ? this.toState(owner) : undefined;
  }

  getUnresolvedStates(): LaunchCleanupOwnerState[] {
    return [...this.owners.values()].map((owner) => this.toState(owner));
  }

  async drain(timeoutMs = 5_000): Promise<LaunchCleanupOwnerState[]> {
    const owners = [...this.owners.values()];
    for (const owner of owners) this.clearRetryTimer(owner);
    const attempts = Promise.allSettled(owners.map((owner) => this.runAttempt(owner, true)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        attempts.then(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, timeoutMs));
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return this.getUnresolvedStates();
  }

  /** Stop accepting owners while preserving unresolved cleanup work. */
  shutdown(): LaunchCleanupOwnerState[] {
    this.stopped = true;
    for (const owner of this.owners.values()) {
      if (!owner.inFlight && !owner.retryTimer) this.scheduleRetry(owner);
      if (!owner.shutdownWarningReported) {
        owner.shutdownWarningReported = true;
        console.warn('[AcpRuntimeDriver] Auxiliary launch cleanup unresolved during shutdown', this.toState(owner));
      }
    }
    return this.getUnresolvedStates();
  }

  private async runAttempt(owner: CleanupOwner, scheduleOnFailure: boolean): Promise<void> {
    if (owner.status === 'CONFIRMED') return;
    if (owner.inFlight) return owner.inFlight;
    owner.status = 'RUNNING';
    let attempt!: Promise<void>;
    attempt = (async () => {
      try {
        await withTimeout(owner.cleanup(), ATTEMPT_TIMEOUT_MS, 'ACP auxiliary launch cleanup timed out');
        owner.status = 'CONFIRMED';
        owner.lastError = undefined;
        owner.nextRetryAt = undefined;
        this.clearRetryTimer(owner);
        this.owners.delete(owner.id);
      } catch (error) {
        owner.attemptCount += 1;
        owner.status = 'FAILED';
        owner.lastError = error instanceof Error ? error.message : String(error);
        if (scheduleOnFailure) this.scheduleRetry(owner);
        throw error;
      } finally {
        if (owner.inFlight === attempt) owner.inFlight = undefined;
      }
    })();
    owner.inFlight = attempt;
    return attempt;
  }

  private scheduleRetry(owner: CleanupOwner): void {
    if (owner.status === 'CONFIRMED' || owner.retryTimer) return;
    const retryIndex = Math.max(0, owner.attemptCount - IMMEDIATE_ATTEMPTS);
    const delay = RETRY_DELAYS_MS[Math.min(retryIndex, RETRY_DELAYS_MS.length - 1)] ?? RETRY_DELAYS_MS.at(-1)!;
    owner.nextRetryAt = Date.now() + delay;
    owner.retryTimer = setTimeout(() => {
      owner.retryTimer = undefined;
      owner.nextRetryAt = undefined;
      this.runAttemptById(owner.id).catch(() => undefined);
    }, delay);
    (owner.retryTimer as { unref?: () => void }).unref?.();
  }

  private clearRetryTimer(owner: CleanupOwner): void {
    if (owner.retryTimer) clearTimeout(owner.retryTimer);
    owner.retryTimer = undefined;
    owner.nextRetryAt = undefined;
  }

  private toState(owner: CleanupOwner): LaunchCleanupOwnerState {
    return {
      id: owner.id,
      ...(owner.label ? { label: owner.label } : {}),
      status: owner.status,
      attemptCount: owner.attemptCount,
      ...(owner.lastError ? { lastError: owner.lastError } : {}),
      ...(owner.nextRetryAt ? { nextRetryAt: owner.nextRetryAt } : {}),
    };
  }
}

export const acpLaunchCleanupRegistry = new LaunchCleanupRegistry();

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
