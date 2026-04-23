import { WorkspaceService } from './workspace.service.js';

const DEFAULT_SCAN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_IDLE_THRESHOLD_HOURS = 24;

export class HibernationScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly scanIntervalMs = DEFAULT_SCAN_INTERVAL_MS,
    private readonly idleThresholdHours = DEFAULT_IDLE_THRESHOLD_HOURS,
  ) {}

  start(): void {
    if (this.timer) return;

    console.log(
      `[HibernationScheduler] Started (interval: ${this.scanIntervalMs / 60000}min, threshold: ${this.idleThresholdHours}h)`,
    );

    this.timer = setInterval(() => {
      this.scan().catch((err) => {
        console.error('[HibernationScheduler] Scan failed:', err);
      });
    }, this.scanIntervalMs);

    // Run initial scan after a short delay to let services initialize
    setTimeout(() => {
      this.scan().catch((err) => {
        console.error('[HibernationScheduler] Initial scan failed:', err);
      });
    }, 10_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[HibernationScheduler] Stopped');
    }
  }

  private async scan(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const service = new WorkspaceService();
      await service.cleanup();
      await service.hibernateIdle(this.idleThresholdHours);
    } finally {
      this.running = false;
    }
  }
}
