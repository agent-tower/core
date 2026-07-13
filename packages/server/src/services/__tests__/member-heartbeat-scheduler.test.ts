import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventBus } from '../../core/event-bus.js';
import type { SessionManager } from '../session-manager.js';
import type { TeamReconcilerService } from '../team-reconciler.service.js';
import { MemberHeartbeatScheduler } from '../member-heartbeat-scheduler.js';

describe('MemberHeartbeatScheduler queue pump', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('pumps queued work on the startup scan and every heartbeat tick', async () => {
    const reconciler = {
      reconcileOrphanInvocations: vi.fn(async () => undefined),
      reconcileIncompleteTerminalInvocations: vi.fn(async () => undefined),
      reconcileStalledInvocations: vi.fn(async () => undefined),
      reconcileDueRoomReplyReminders: vi.fn(async () => 0),
    } as unknown as TeamReconcilerService;
    const queuePump = {
      reconcileQueuedWork: vi.fn(async () => 0),
    };
    const scheduler = new MemberHeartbeatScheduler({
      eventBus: {} as EventBus,
      sessionManager: {} as SessionManager,
      reconciler,
      queuePump,
      tickIntervalMs: 30_000,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(reconciler.reconcileOrphanInvocations).toHaveBeenCalledTimes(1);
    expect(reconciler.reconcileIncompleteTerminalInvocations).toHaveBeenCalledTimes(1);
    expect(reconciler.reconcileStalledInvocations).toHaveBeenCalledTimes(1);
    expect(reconciler.reconcileDueRoomReplyReminders).toHaveBeenCalledTimes(1);
    expect(queuePump.reconcileQueuedWork).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);

    expect(reconciler.reconcileOrphanInvocations).toHaveBeenCalledTimes(1);
    expect(reconciler.reconcileIncompleteTerminalInvocations).toHaveBeenCalledTimes(2);
    expect(reconciler.reconcileStalledInvocations).toHaveBeenCalledTimes(2);
    expect(reconciler.reconcileDueRoomReplyReminders).toHaveBeenCalledTimes(2);
    expect(queuePump.reconcileQueuedWork).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('still pumps queued work when every preceding reconciliation stage fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const reconciler = {
      reconcileOrphanInvocations: vi.fn(async () => { throw new Error('orphan failure'); }),
      reconcileIncompleteTerminalInvocations: vi.fn(async () => { throw new Error('terminal recovery failure'); }),
      reconcileStalledInvocations: vi.fn(async () => { throw new Error('stalled failure'); }),
      reconcileDueRoomReplyReminders: vi.fn(async () => { throw new Error('reminder failure'); }),
    } as unknown as TeamReconcilerService;
    const queuePump = {
      reconcileQueuedWork: vi.fn(async () => 0),
    };
    const scheduler = new MemberHeartbeatScheduler({
      eventBus: {} as EventBus,
      sessionManager: {} as SessionManager,
      reconciler,
      queuePump,
      tickIntervalMs: 30_000,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(reconciler.reconcileOrphanInvocations).toHaveBeenCalledTimes(1);
    expect(reconciler.reconcileIncompleteTerminalInvocations).toHaveBeenCalledTimes(1);
    expect(reconciler.reconcileStalledInvocations).toHaveBeenCalledTimes(1);
    expect(reconciler.reconcileDueRoomReplyReminders).toHaveBeenCalledTimes(1);
    expect(queuePump.reconcileQueuedWork).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(reconciler.reconcileOrphanInvocations).toHaveBeenCalledTimes(2);
    expect(reconciler.reconcileIncompleteTerminalInvocations).toHaveBeenCalledTimes(2);
    expect(queuePump.reconcileQueuedWork).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });
});
