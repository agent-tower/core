import { describe, expect, it, vi } from 'vitest';
import { countCommandHelperRecycle, countGitStateActivity, countGitStatePushes, countOwnedCommand, formatRuntimeMetricsLine, setRegisteredGitWorktrees, startRuntimeMetrics } from '../runtime-metrics.js';

const MB = 1024 * 1024;

describe('runtime metrics', () => {
  it('formats one line with event-loop delay, command counters and memory', () => {
    expect(formatRuntimeMetricsLine({
      eventLoop: { samples: 3000, p50Ms: 0.24, p99Ms: 12.5, maxMs: 210 },
      commandsViaHelper: 120,
      commandsInProcess: 0,
      helperRestartsTotal: 1,
      helperRecyclesTotal: 2,
      helper: { state: 'running', rssBytes: 45 * MB },
      serverRssBytes: 800 * MB,
    })).toBe('[runtime-metrics] event_loop_delay_ms p50=0.2 p99=12.5 max=210.0 commands_helper=120 commands_in_process=0'
      + ' helper_restarts_total=1 helper_recycles_total=2 helper=running helper_rss_mb=45.0 server_rss_mb=800.0');
    expect(formatRuntimeMetricsLine({
      eventLoop: { samples: 3000, p50Ms: 0.24, p99Ms: 12.5, maxMs: 210 },
      commandsViaHelper: 0,
      commandsInProcess: 0,
      helperRestartsTotal: 0,
      helperRecyclesTotal: 0,
      gitState: { requests: 80, computations: 30, cacheAnswers: 45, gitProcesses: 41 },
      helper: { state: 'running', rssBytes: 45 * MB },
      serverRssBytes: 800 * MB,
    })).toBe('[runtime-metrics] event_loop_delay_ms p50=0.2 p99=12.5 max=210.0 commands_helper=0 commands_in_process=0'
      + ' helper_restarts_total=0 helper_recycles_total=0 git_state_requests=80 git_state_computations=30 git_state_cache_answers=45 git_state_git_processes=41'
      + ' git_state_pushes=0 git_state_registered_worktrees=0 git_state_computations_watch=0 git_state_computations_agent=0'
      + ' git_state_computations_terminal=0 git_state_computations_service=0 git_state_computations_operation=0'
      + ' git_state_computations_refresh=0 git_state_computations_safety=0 git_diff_requests=0 git_diff_computations=0'
      + ' git_diff_cache_answers=0 helper=running helper_rss_mb=45.0 server_rss_mb=800.0');
    expect(formatRuntimeMetricsLine({
      eventLoop: { samples: 0, p50Ms: 0, p99Ms: 0, maxMs: 0 },
      commandsViaHelper: 0,
      commandsInProcess: 2,
      helperRestartsTotal: 0,
      helperRecyclesTotal: 0,
      serverRssBytes: 60 * MB,
    })).toBe('[runtime-metrics] event_loop_delay_ms p50=n/a p99=n/a max=n/a commands_helper=0 commands_in_process=2'
      + ' helper_restarts_total=0 helper_recycles_total=0 server_rss_mb=60.0');
  });

  it('logs once per interval with the commands of that interval and the blocked time', async () => {
    const lines: string[] = [];
    const stop = startRuntimeMetrics({
      intervalMs: 600,
      log: (line) => lines.push(line),
      commandHelperStatus: () => ({ state: 'running', rssBytes: MB }),
    });
    try {
      countOwnedCommand('helper');
      countOwnedCommand('helper');
      countOwnedCommand('in-process');
      countCommandHelperRecycle();
      countGitStateActivity({ requests: 3, computations: 1, cacheAnswers: 2, gitProcesses: 2, computationsAgent: 1, diffRequests: 4, diffComputations: 1, diffCacheAnswers: 3 });
      countGitStatePushes(2);
      setRegisteredGitWorktrees(3);
      // Block the event loop once for 250 ms.
      await new Promise<void>((resolve) => setTimeout(() => {
        const end = Date.now() + 250;
        while (Date.now() < end) { /* blocked on purpose */ }
        resolve();
      }, 50));
      await vi.waitFor(() => expect(lines.length).toBeGreaterThanOrEqual(1), { timeout: 5_000 });
      expect(lines[0]).toMatch(/^\[runtime-metrics\] event_loop_delay_ms p50=\d+\.\d p99=\d+\.\d max=\d+\.\d commands_helper=2 commands_in_process=1 helper_restarts_total=\d+ helper_recycles_total=1 git_state_requests=3 git_state_computations=1 git_state_cache_answers=2 git_state_git_processes=2 git_state_pushes=2 git_state_registered_worktrees=3 git_state_computations_watch=0 git_state_computations_agent=1 git_state_computations_terminal=0 git_state_computations_service=0 git_state_computations_operation=0 git_state_computations_refresh=0 git_state_computations_safety=0 git_diff_requests=4 git_diff_computations=1 git_diff_cache_answers=3 helper=running helper_rss_mb=1\.0 server_rss_mb=\d+\.\d$/);
      const max = Number(/max=(\d+\.\d)/.exec(lines[0]!)![1]);
      expect(max).toBeGreaterThanOrEqual(200);
      await vi.waitFor(() => expect(lines.length).toBeGreaterThanOrEqual(2), { timeout: 5_000 });
      expect(lines[1]).toContain('commands_helper=0 commands_in_process=0');
      expect(lines[1]).toContain('git_state_requests=0 git_state_computations=0 git_state_cache_answers=0 git_state_git_processes=0');
      expect(lines[1]).toContain('helper_recycles_total=1');
      expect(lines[1]).toContain('git_state_pushes=0 git_state_registered_worktrees=3');
    } finally {
      stop();
      setRegisteredGitWorktrees(0);
    }
  }, 20_000);
});
