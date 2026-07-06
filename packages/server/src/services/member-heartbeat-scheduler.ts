import type { EventBus } from '../core/event-bus.js';
import type { SessionManager } from './session-manager.js';
import { TeamReconcilerService } from './team-reconciler.service.js';

const DEFAULT_TICK_INTERVAL_MS = 30_000;
// 首扫延迟：让其它服务先完成初始化，再回收 server 重启遗留的 orphan invocation。
const INITIAL_SCAN_DELAY_MS = 10_000;

export interface MemberHeartbeatSchedulerDeps {
  eventBus: EventBus;
  sessionManager: SessionManager;
  tickIntervalMs?: number;
  reconciler?: TeamReconcilerService;
}

/**
 * TeamRun 成员心跳 watchdog。
 *
 * 现有 TeamRun 调度完全事件驱动（依赖 PTY 退出事件），无法发现“进程仍在但无任何进展”的卡死成员，
 * 也没有任何地方周期调用 reconcileDueRoomReplyReminders。该调度器以固定 tick 周期承担三件事：
 *  1. 首扫回收 server 重启后脱管的 RUNNING invocation（reconcileOrphanInvocations）；
 *  2. 唤醒/释放长时间无 session:patch 进展的 RUNNING 成员（reconcileStalledInvocations）；
 *  3. 推进到期的 room reply 补催（reconcileDueRoomReplyReminders）。
 *
 * 唤醒与补催复用同一 reconciler 状态机（统一计数/退避/释放闭环）。
 */
export class MemberHeartbeatScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private initialScanTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private orphanScanDone = false;
  private readonly tickIntervalMs: number;
  private readonly reconciler: TeamReconcilerService;

  constructor(deps: MemberHeartbeatSchedulerDeps) {
    this.tickIntervalMs = deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    // watchdog 用轮询驱动续催/唤醒，因此 reconciler 关闭内部 setTimeout，避免与轮询重复触发。
    this.reconciler = deps.reconciler ?? new TeamReconcilerService({
      eventBus: deps.eventBus,
      sessionMessenger: deps.sessionManager,
      scheduleReminders: false,
    });
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
      // 首扫：先回收 server 重启后脱管（内存无 pipeline）的 RUNNING invocation，避免永久占用成员。
      if (!this.orphanScanDone) {
        this.orphanScanDone = true;
        await this.reconciler.reconcileOrphanInvocations();
      }
      // 唤醒/释放长时间无进展的 RUNNING 成员。
      await this.reconciler.reconcileStalledInvocations();
      // 推进到期的 room reply 补催（同时修复重启后 reminder 丢失、无人周期调用的问题）。
      await this.reconciler.reconcileDueRoomReplyReminders();
    } finally {
      this.running = false;
    }
  }
}
