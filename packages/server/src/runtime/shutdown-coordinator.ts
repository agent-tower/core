/**
 * Keeps application shutdown alive until all process owners report confirmed
 * cleanup. The retry timer is intentionally referenced: a pending owner must
 * keep the Node host alive instead of allowing an unref'ed timer to disappear.
 */
const RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000, 15_000, 30_000];

export type ShutdownCleanup = () => Promise<void>;

export class ReferencedShutdownCoordinator {
  private shutdownPromise?: Promise<void>;
  private resolveShutdown?: () => void;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private attemptCount = 0;
  private confirmed = false;

  constructor(
    private readonly cleanup: ShutdownCleanup,
    private readonly onRetryError: (error: unknown, attempt: number) => void = () => undefined,
  ) {}

  request(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = new Promise<void>((resolve) => {
      this.resolveShutdown = resolve;
    });
    void this.runAttempt();
    return this.shutdownPromise;
  }

  get pending(): boolean {
    return this.shutdownPromise !== undefined && !this.confirmed;
  }

  private async runAttempt(): Promise<void> {
    this.attemptCount += 1;
    try {
      await this.cleanup();
      this.clearRetryTimer();
      this.confirmed = true;
      this.resolveShutdown?.();
    } catch (error) {
      try {
        this.onRetryError(error, this.attemptCount);
      } catch {
        // Diagnostics must not disable the retry that protects process owners.
      }
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    const index = Math.min(this.attemptCount - 1, RETRY_DELAYS_MS.length - 1);
    const delay = RETRY_DELAYS_MS[index] ?? RETRY_DELAYS_MS.at(-1)!;
    // Do not call unref(): unresolved process owners are an application
    // lifetime obligation and must prevent Node from exiting early.
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.runAttempt();
    }, delay);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }
}
