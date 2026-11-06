import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLAUDE_BACKGROUND_WAIT_CEILING_ENV,
  CLAUDE_IDLE_EXIT_GRACE_ENV,
  ClaudeRunLifecycle,
  DEFAULT_CLAUDE_BACKGROUND_WAIT_CEILING_MS,
  DEFAULT_CLAUDE_IDLE_EXIT_GRACE_MS,
  resolveClaudeBackgroundWaitCeilingMs,
  resolveClaudeIdleExitGraceMs,
} from '../claude-run-lifecycle.js';

describe('ClaudeRunLifecycle', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function create(overrides: Partial<ConstructorParameters<typeof ClaudeRunLifecycle>[0]> = {}) {
    const stop = vi.fn();
    const publishTasks = vi.fn();
    const lifecycle = new ClaudeRunLifecycle({ stop, publishTasks, idleExitGraceMs: 1_000, waitCeilingMs: 60_000, ...overrides });
    return { stop, publishTasks, lifecycle };
  }

  it('stops a process that lingers after a result with nothing pending', () => {
    const { stop, lifecycle } = create();
    lifecycle.onTurnStarted();
    lifecycle.onTurnResult();
    vi.advanceTimersByTime(999);
    expect(stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stop).toHaveBeenCalledWith('idle_exit_timeout', expect.stringContaining('did not exit'));
    lifecycle.onTurnResult();
    vi.advanceTimersByTime(5_000);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('waits while background work is pending and arms the grace once it clears', () => {
    const { stop, publishTasks, lifecycle } = create();
    lifecycle.onTasksChanged([{ taskId: 'b1', description: 'watch' }]);
    expect(publishTasks).toHaveBeenLastCalledWith([{ taskId: 'b1', description: 'watch' }]);
    lifecycle.onTurnResult();
    vi.advanceTimersByTime(30_000);
    expect(stop).not.toHaveBeenCalled();
    expect(lifecycle.isIdle).toBe(true);
    lifecycle.onTasksChanged([]);
    vi.advanceTimersByTime(999);
    expect(stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stop).toHaveBeenCalledWith('idle_exit_timeout', expect.any(String));
  });

  it('cancels the grace when a continuation turn starts and re-arms after its result', () => {
    const { stop, lifecycle } = create();
    lifecycle.onTurnResult();
    vi.advanceTimersByTime(500);
    lifecycle.onTurnStarted();
    vi.advanceTimersByTime(10_000);
    expect(stop).not.toHaveBeenCalled();
    lifecycle.onTurnResult();
    vi.advanceTimersByTime(1_000);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('enforces the wait ceiling even while tasks stay pending', () => {
    const { stop, lifecycle } = create({ waitCeilingMs: 5_000 });
    lifecycle.onTasksChanged([{ taskId: 'b1' }]);
    lifecycle.onTurnResult();
    vi.advanceTimersByTime(4_999);
    expect(stop).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(stop).toHaveBeenCalledWith('background_wait_ceiling', expect.stringContaining('minutes'));
  });

  it('never fires after exit and clears published tasks', () => {
    const { stop, publishTasks, lifecycle } = create();
    lifecycle.onTasksChanged([{ taskId: 'b1' }]);
    lifecycle.onTurnResult();
    lifecycle.onExit();
    expect(publishTasks).toHaveBeenLastCalledWith([]);
    vi.advanceTimersByTime(120_000);
    expect(stop).not.toHaveBeenCalled();
    lifecycle.onTurnResult();
    lifecycle.onTasksChanged([]);
    vi.advanceTimersByTime(120_000);
    expect(stop).not.toHaveBeenCalled();
  });

  it('treats a zero ceiling as unlimited', () => {
    const { stop, lifecycle } = create({ waitCeilingMs: 0 });
    lifecycle.onTasksChanged([{ taskId: 'b1' }]);
    lifecycle.onTurnResult();
    vi.advanceTimersByTime(10 * 60 * 60_000);
    expect(stop).not.toHaveBeenCalled();
  });

  it('reads the ceiling and grace from the environment with safe defaults', () => {
    expect(resolveClaudeBackgroundWaitCeilingMs({})).toBe(DEFAULT_CLAUDE_BACKGROUND_WAIT_CEILING_MS);
    expect(resolveClaudeBackgroundWaitCeilingMs({ [CLAUDE_BACKGROUND_WAIT_CEILING_ENV]: '0' })).toBe(0);
    expect(resolveClaudeBackgroundWaitCeilingMs({ [CLAUDE_BACKGROUND_WAIT_CEILING_ENV]: '90000' })).toBe(90_000);
    expect(resolveClaudeBackgroundWaitCeilingMs({ [CLAUDE_BACKGROUND_WAIT_CEILING_ENV]: 'soon' })).toBe(DEFAULT_CLAUDE_BACKGROUND_WAIT_CEILING_MS);
    expect(resolveClaudeIdleExitGraceMs({})).toBe(DEFAULT_CLAUDE_IDLE_EXIT_GRACE_MS);
    expect(resolveClaudeIdleExitGraceMs({ [CLAUDE_IDLE_EXIT_GRACE_ENV]: '500' })).toBe(500);
    expect(resolveClaudeIdleExitGraceMs({ [CLAUDE_IDLE_EXIT_GRACE_ENV]: '-1' })).toBe(DEFAULT_CLAUDE_IDLE_EXIT_GRACE_MS);
  });
});
