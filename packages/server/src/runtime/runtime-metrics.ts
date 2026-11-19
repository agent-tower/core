import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { GitStateCounters } from '../git/state/git-state-types.js';

/**
 * Small always-on runtime metrics of the server process: event-loop delay,
 * where owned commands ran, and the git state service's work. One log line
 * per minute; only the server entries start the reporter, so tests, the MCP
 * entry and the command helper never log it.
 */

const counters = {
  commandsViaHelper: 0,
  commandsInProcess: 0,
  helperRestarts: 0,
  helperRecycles: 0,
  /** Requests answered by the git state service, wherever it runs. */
  gitStateRequests: 0,
  gitStateComputations: 0,
  gitStateCacheAnswers: 0,
  /** Git processes started by the git state service, file diffs included (in the helper they are not owned-command requests). */
  gitStateGitProcesses: 0,
  gitDiffRequests: 0,
  gitDiffComputations: 0,
  gitDiffCacheAnswers: 0,
  gitStatePushes: 0,
  gitStateRegisteredWorktrees: 0,
  gitStateComputationsWatch: 0,
  gitStateComputationsAgent: 0,
  gitStateComputationsTerminal: 0,
  gitStateComputationsService: 0,
  gitStateComputationsOperation: 0,
  gitStateComputationsRefresh: 0,
  gitStateComputationsSafety: 0,
};

export type RuntimeCounters = Readonly<typeof counters>;

export function countOwnedCommand(route: 'helper' | 'in-process'): void {
  if (route === 'helper') counters.commandsViaHelper += 1;
  else counters.commandsInProcess += 1;
}

export function countCommandHelperRestart(): void {
  counters.helperRestarts += 1;
}

export function countCommandHelperRecycle(): void {
  counters.helperRecycles += 1;
}

export function countGitStateActivity(delta: Partial<GitStateCounters>): void {
  counters.gitStateRequests += delta.requests ?? 0;
  counters.gitStateComputations += delta.computations ?? 0;
  counters.gitStateCacheAnswers += delta.cacheAnswers ?? 0;
  counters.gitStateGitProcesses += delta.gitProcesses ?? 0;
  counters.gitDiffRequests += delta.diffRequests ?? 0;
  counters.gitDiffComputations += delta.diffComputations ?? 0;
  counters.gitDiffCacheAnswers += delta.diffCacheAnswers ?? 0;
  counters.gitStateComputationsWatch += delta.computationsWatch ?? 0;
  counters.gitStateComputationsAgent += delta.computationsAgent ?? 0;
  counters.gitStateComputationsTerminal += delta.computationsTerminal ?? 0;
  counters.gitStateComputationsService += delta.computationsService ?? 0;
  counters.gitStateComputationsOperation += delta.computationsOperation ?? 0;
  counters.gitStateComputationsRefresh += delta.computationsRefresh ?? 0;
  counters.gitStateComputationsSafety += delta.computationsSafety ?? 0;
}

/** Number of subscribed socket deliveries, excluding subscribe acknowledgements. */
export function countGitStatePushes(count = 1): void {
  counters.gitStatePushes += count;
}

/** Gauge of the active placement, including the last-subscriber grace. */
export function setRegisteredGitWorktrees(count: number): void {
  counters.gitStateRegisteredWorktrees = count;
}

export function readRuntimeCounters(): RuntimeCounters {
  return { ...counters };
}

/** Sampling period of the delay histogram. Every sample includes it, so it is subtracted. */
const EVENT_LOOP_RESOLUTION_MS = 20;
const REPORT_INTERVAL_MS = 60_000;

export interface CommandHelperSummary {
  state: string;
  rssBytes?: number;
}

export interface EventLoopDelaySummary {
  /** Number of samples; 0 means no percentile is available. */
  samples: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
}

/** Git state service activity during one interval. */
export interface GitStateActivitySummary extends Partial<GitStateCounters> {
  requests: number;
  computations: number;
  cacheAnswers: number;
  gitProcesses: number;
  pushes?: number;
  registeredWorktrees?: number;
}

export function formatRuntimeMetricsLine(input: {
  eventLoop: EventLoopDelaySummary;
  commandsViaHelper: number;
  commandsInProcess: number;
  helperRestartsTotal: number;
  helperRecyclesTotal: number;
  gitState?: GitStateActivitySummary;
  helper?: CommandHelperSummary;
  serverRssBytes: number;
}): string {
  const ms = (value: number) => (input.eventLoop.samples > 0 ? value.toFixed(1) : 'n/a');
  const mb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
  const fields = [
    `event_loop_delay_ms p50=${ms(input.eventLoop.p50Ms)} p99=${ms(input.eventLoop.p99Ms)} max=${ms(input.eventLoop.maxMs)}`,
    `commands_helper=${input.commandsViaHelper}`,
    `commands_in_process=${input.commandsInProcess}`,
    `helper_restarts_total=${input.helperRestartsTotal}`,
    `helper_recycles_total=${input.helperRecyclesTotal}`,
  ];
  if (input.gitState) {
    fields.push(
      `git_state_requests=${input.gitState.requests}`,
      `git_state_computations=${input.gitState.computations}`,
      `git_state_cache_answers=${input.gitState.cacheAnswers}`,
      `git_state_git_processes=${input.gitState.gitProcesses}`,
      `git_state_pushes=${input.gitState.pushes ?? 0}`,
      `git_state_registered_worktrees=${input.gitState.registeredWorktrees ?? 0}`,
      `git_state_computations_watch=${input.gitState.computationsWatch ?? 0}`,
      `git_state_computations_agent=${input.gitState.computationsAgent ?? 0}`,
      `git_state_computations_terminal=${input.gitState.computationsTerminal ?? 0}`,
      `git_state_computations_service=${input.gitState.computationsService ?? 0}`,
      `git_state_computations_operation=${input.gitState.computationsOperation ?? 0}`,
      `git_state_computations_refresh=${input.gitState.computationsRefresh ?? 0}`,
      `git_state_computations_safety=${input.gitState.computationsSafety ?? 0}`,
      `git_diff_requests=${input.gitState.diffRequests ?? 0}`,
      `git_diff_computations=${input.gitState.diffComputations ?? 0}`,
      `git_diff_cache_answers=${input.gitState.diffCacheAnswers ?? 0}`,
    );
  }
  if (input.helper) {
    fields.push(`helper=${input.helper.state}`);
    if (input.helper.rssBytes !== undefined) fields.push(`helper_rss_mb=${mb(input.helper.rssBytes)}`);
  }
  fields.push(`server_rss_mb=${mb(input.serverRssBytes)}`);
  return `[runtime-metrics] ${fields.join(' ')}`;
}

export interface RuntimeMetricsOptions {
  intervalMs?: number;
  log?: (line: string) => void;
  commandHelperStatus?: () => CommandHelperSummary;
}

/**
 * Logs, once per interval: event-loop delay p50/p99/max beyond the sampling
 * period, the number of owned commands run through the helper and in this
 * process during the interval, helper restarts and planned recycles since start, and the git state
 * service's requests, computations, cache answers and git processes during
 * the interval, with its file diff requests, computations and cache answers.
 * Returns a function that stops the reporter.
 */
export function startRuntimeMetrics(options: RuntimeMetricsOptions = {}): () => void {
  const histogram = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS });
  histogram.enable();
  const log = options.log ?? ((line: string) => console.log(line));
  const delayMs = (nanoseconds: number) => Math.max(0, nanoseconds / 1e6 - EVENT_LOOP_RESOLUTION_MS);
  let previous = readRuntimeCounters();
  const timer = setInterval(() => {
    const current = readRuntimeCounters();
    const line = formatRuntimeMetricsLine({
      eventLoop: {
        samples: histogram.count,
        p50Ms: delayMs(histogram.percentile(50)),
        p99Ms: delayMs(histogram.percentile(99)),
        maxMs: delayMs(histogram.max),
      },
      commandsViaHelper: current.commandsViaHelper - previous.commandsViaHelper,
      commandsInProcess: current.commandsInProcess - previous.commandsInProcess,
      helperRestartsTotal: current.helperRestarts,
      helperRecyclesTotal: current.helperRecycles,
      gitState: {
        requests: current.gitStateRequests - previous.gitStateRequests,
        computations: current.gitStateComputations - previous.gitStateComputations,
        cacheAnswers: current.gitStateCacheAnswers - previous.gitStateCacheAnswers,
        gitProcesses: current.gitStateGitProcesses - previous.gitStateGitProcesses,
        pushes: current.gitStatePushes - previous.gitStatePushes,
        registeredWorktrees: current.gitStateRegisteredWorktrees,
        computationsWatch: current.gitStateComputationsWatch - previous.gitStateComputationsWatch,
        computationsAgent: current.gitStateComputationsAgent - previous.gitStateComputationsAgent,
        computationsTerminal: current.gitStateComputationsTerminal - previous.gitStateComputationsTerminal,
        computationsService: current.gitStateComputationsService - previous.gitStateComputationsService,
        computationsOperation: current.gitStateComputationsOperation - previous.gitStateComputationsOperation,
        computationsRefresh: current.gitStateComputationsRefresh - previous.gitStateComputationsRefresh,
        computationsSafety: current.gitStateComputationsSafety - previous.gitStateComputationsSafety,
        diffRequests: current.gitDiffRequests - previous.gitDiffRequests,
        diffComputations: current.gitDiffComputations - previous.gitDiffComputations,
        diffCacheAnswers: current.gitDiffCacheAnswers - previous.gitDiffCacheAnswers,
      },
      helper: options.commandHelperStatus?.(),
      serverRssBytes: process.memoryUsage.rss(),
    });
    previous = current;
    histogram.reset();
    try { log(line); } catch { /* metrics must never disturb the server */ }
  }, options.intervalMs ?? REPORT_INTERVAL_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}
