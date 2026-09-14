import type { EventBus } from '../core/event-bus.js';
import type { SessionManager } from './session-manager.js';
import { TeamReconcilerService } from './team-reconciler.service.js';
import { TeamSchedulerService } from './team-scheduler.service.js';

const DEFAULT_TICK_INTERVAL_MS = 30_000;
// 首扫延迟：让其它服务先完成初始化，再回收 server 重启遗留的 orphan invocation。
const INITIAL_SCAN_DELAY_MS = 10_000;
// 单阶段上限：任一阶段卡住（例如等待一把永不释放的 admission barrier）时，
// 只放弃该阶段并继续后续阶段，避免 6 个阶段整体停摆。
const DEFAULT_STAGE_TIMEOUT_MS = 5 * 60_000;

export interface MemberHeartbeatSchedulerDeps {
  eventBus: EventBus;
  sessionManager: SessionManager;
  tickIntervalMs?: number;
  stageTimeoutMs?: number;
  reconciler?: TeamReconcilerService;
  queuePump?: Pick<TeamSchedulerService, 'reconcileQueuedWork'>;
}

/**
 * TeamRun 成员心跳 watchdog。
 *
 * 现有 TeamRun 调度完全事件驱动（依赖 PTY 退出事件），无法发现“进程仍在但无任何进展”的卡死成员，
 * 也没有任何地方周期调用 reconcileDueRoomReplyReminders。该调度器以固定 tick 周期承担五件事：
 *  1. 重试并恢复持久化的 owned process cleanup；
 *  2. 首扫回收 server 重启后脱管的 RUNNING invocation（reconcileOrphanInvocations）；
 *  3. 修复 Invocation 已终态、WorkRequest 仍为 STARTED 的运行期半完成状态；
 *  4. 唤醒/释放长时间无 session:patch 进展的 RUNNING 成员（reconcileStalledInvocations）；
 *  5. 推进到期的 room reply 补催（reconcileDueRoomReplyReminders）；
 *  6. 恢复 AUTO 或已批准 CONFIRM TeamRun 中没有活跃 invocation 的 QUEUED 请求。
 *
 * 唤醒与补催复用同一 reconciler 状态机（统一计数/退避/释放闭环）。
 */
export class MemberHeartbeatScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private initialScanTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private orphanScanDone = false;
  private readonly tickIntervalMs: number;
  private readonly stageTimeoutMs: number;
  private readonly reconciler: TeamReconcilerService;
  private readonly queuePump: Pick<TeamSchedulerService, 'reconcileQueuedWork'>;

  constructor(deps: MemberHeartbeatSchedulerDeps) {
    this.tickIntervalMs = deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.stageTimeoutMs = deps.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;
    // watchdog 用轮询驱动续催/唤醒，因此 reconciler 关闭内部 setTimeout，避免与轮询重复触发。
    this.reconciler = deps.reconciler ?? new TeamReconcilerService({
      eventBus: deps.eventBus,
      sessionMessenger: deps.sessionManager,
      scheduleReminders: false,
    });
    this.queuePump = deps.queuePump ?? new TeamSchedulerService();
  }

  start(): void {
    if (this.timer) {
      return;
    }

    console.log(`[MemberHeartbeatScheduler] Started (interval: ${this.tickIntervalMs / 1000}s)`);

    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error('[MemberHeartbeatScheduler] Tick failed:', err);
      });
    }, this.tickIntervalMs);
    (this.timer as { unref?: () => void }).unref?.();

    this.initialScanTimer = setTimeout(() => {
      this.initialScanTimer = null;
      this.tick().catch((err) => {
        console.error('[MemberHeartbeatScheduler] Initial tick failed:', err);
      });
    }, INITIAL_SCAN_DELAY_MS);
    (this.initialScanTimer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.initialScanTimer) {
      clearTimeout(this.initialScanTimer);
      this.initialScanTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log('[MemberHeartbeatScheduler] Stopped');
    }
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;

    try {
      // 各阶段相互隔离，避免历史坏记录阻断后续队列恢复。
      await this.runStage(
        'runtime process cleanup reconciliation',
        () => this.reconciler.reconcilePendingRuntimeCleanup(),
      );
      if (!this.orphanScanDone && await this.runStage(
        'orphan invocation reconciliation',
        () => this.reconciler.reconcileOrphanInvocations(),
      )) {
        this.orphanScanDone = true;
      }
      await this.runStage(
        'incomplete terminal invocation reconciliation',
        () => this.reconciler.reconcileIncompleteTerminalInvocations(),
      );
      await this.runStage(
        'stalled invocation reconciliation',
        () => this.reconciler.reconcileStalledInvocations(),
      );
      await this.runStage(
        'room reply reminder reconciliation',
        () => this.reconciler.reconcileDueRoomReplyReminders(),
      );
      await this.runStage(
        'queued work reconciliation',
        () => this.queuePump.reconcileQueuedWork(),
      );
    } finally {
      this.running = false;
    }
  }

  private async runStage(name: string, operation: () => Promise<unknown>): Promise<boolean> {
    try {
      return await this.withStageTimeout(name, operation());
    } catch (error) {
      console.warn(
        `[MemberHeartbeatScheduler] Failed ${name}:`,
        error instanceof Error ? error.message : error,
      );
      return false;
    }
  }

  /**
   * A hung stage must not stop the remaining stages: `tick()` holds the
   * `running` re-entry gate, so one await that never settles would silently
   * disable cleanup, orphan recovery, nudges and the queue pump together.
   * The abandoned stage keeps running in the background; the barrier still
   * serializes whatever it does per member. Returns false on timeout so a
   * one-shot stage (the startup orphan scan) can be retried on the next tick.
   */
  private async withStageTimeout(name: string, operation: Promise<unknown>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      operation.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), this.stageTimeoutMs);
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (timedOut) {
      console.error(
        `[MemberHeartbeatScheduler] Stage "${name}" exceeded ${this.stageTimeoutMs}ms; continuing with the remaining stages`,
      );
      return false;
    }
    return true;
  }
}
