/**
 * Server entry to the git state service. Subscriptions belong to the socket
 * registry; this facade routes reads, registrations and invalidations to the
 * current placement and reports state changes back to that registry.
 */
import path from 'node:path';
import { getRunningCommandHelper, onCommandHelperPlacementChange, type CommandHelperClient } from '../../runtime/command-helper/client.js';
import { COMMAND_HELPER_EXITED } from '../../runtime/command-helper/protocol.js';
import { countGitStateActivity, setRegisteredGitWorktrees } from '../../runtime/runtime-metrics.js';
import { runOwnedCommand } from '../../utils/owned-child-process.js';
import { WorkspaceGitStateService } from './git-state-service.js';
import type {
  GitDiffKind, GitDiffRequest, GitDiffResult, GitStateCounters, GitStateRequest, GitStateSnapshot, GitStateTrigger,
} from './git-state-types.js';

export interface WorkspaceGitStateInput {
  /** `workingDir` of `GET /git/changes`, or a workspace's worktree path. */
  worktreePath: string;
  repositoryPath?: string | null;
  baseBranch: string;
}

export interface WorkspaceGitDiffInput extends WorkspaceGitStateInput {
  /** As the change list names it. */
  path: string;
  kind: GitDiffKind;
  /** "Load anyway": the forced size limit. */
  force?: boolean;
}

let localService: WorkspaceGitStateService | undefined;
/** Replies from retiring placements can arrive after a new epoch's replies. */
const helperCounters = new Map<string, Partial<GitStateCounters>>();
const changeListeners = new Set<(snapshot: GitStateSnapshot) => void>();
const placementListeners = new Set<() => void>();
let observedHelper: CommandHelperClient | null = null;
let unobserveHelper: (() => void) | undefined;

function publishChange(snapshot: GitStateSnapshot): void {
  for (const listener of [...changeListeners]) {
    try { listener(structuredClone(snapshot)); }
    catch (error) { console.error('[git-state] change listener failed', error); }
  }
}

function observeHelper(): void {
  const helper = getRunningCommandHelper();
  if (helper === observedHelper) return;
  unobserveHelper?.();
  unobserveHelper = undefined;
  observedHelper = helper;
  if (!helper) return;
  const offChange = helper.onGitStateChange(({ snapshot, counters }) => {
    if (getRunningCommandHelper() !== helper) return;
    recordHelperCounters(snapshot.epoch, counters);
    publishChange(snapshot);
  });
  const offActivity = helper.onGitStateActivity(({ epoch, counters, registeredWorktrees }) => {
    if (getRunningCommandHelper() !== helper) return;
    recordHelperCounters(epoch, counters);
    setRegisteredGitWorktrees(registeredWorktrees);
  });
  unobserveHelper = () => { offChange(); offActivity(); };
}

onCommandHelperPlacementChange((running) => {
  if (running && localService) {
    // Retire closes watches/timers. Existing REST waiters may still finish.
    localService.retire();
    localService = undefined;
  }
  observeHelper();
  setRegisteredGitWorktrees(0);
  for (const listener of [...placementListeners]) {
    try { listener(); }
    catch (error) { console.error('[git-state] placement listener failed', error); }
  }
});

function getLocalService(): WorkspaceGitStateService {
  if (!localService) {
    const service = new WorkspaceGitStateService({
      run: runOwnedCommand,
      onCounters: countGitStateActivity,
      onRegisteredCount: (count) => {
        if (localService === service && !getRunningCommandHelper()) setRegisteredGitWorktrees(count);
      },
      onChange: (snapshot) => {
        if (localService === service && !getRunningCommandHelper()) publishChange(snapshot);
      },
    });
    localService = service;
  }
  return localService;
}

/** Cumulative counters become increments once, even when replies overtake. */
function recordHelperCounters(epoch: string, counters: GitStateCounters): void {
  const previous = helperCounters.get(epoch) ?? {};
  const highest = { ...previous };
  const delta: Partial<GitStateCounters> = {};
  for (const key of Object.keys(counters) as (keyof GitStateCounters)[]) {
    const before = previous[key] ?? 0;
    if (counters[key] > before) {
      delta[key] = counters[key] - before;
      highest[key] = counters[key];
    }
  }
  helperCounters.set(epoch, highest);
  if (helperCounters.size > 16) helperCounters.delete(helperCounters.keys().next().value!);
  countGitStateActivity(delta);
}

async function requestState(input: WorkspaceGitStateInput, register: boolean, options: { signal?: AbortSignal }): Promise<GitStateSnapshot> {
  const request: GitStateRequest = {
    worktreePath: path.resolve(input.worktreePath),
    repositoryPath: input.repositoryPath ?? null,
    baseBranch: input.baseBranch,
  };
  for (let attempt = 0; ; attempt += 1) {
    const helper = getRunningCommandHelper();
    if (!helper) {
      const service = getLocalService();
      const result = await (register ? service.register(request, options) : service.get(request, options));
      return structuredClone(result.snapshot);
    }
    observeHelper();
    try {
      const result = await (register ? helper.registerGitState(request, options) : helper.requestGitState(request, options));
      recordHelperCounters(result.snapshot.epoch, result.counters);
      return result.snapshot;
    } catch (error) {
      // These reads can be retried after a crash. Owned commands never are.
      if (attempt === 0 && (error as { code?: unknown } | null)?.code === COMMAND_HELPER_EXITED && !options.signal?.aborted) continue;
      throw error;
    }
  }
}

/**
 * One file's diff from the git state service of the active placement, with
 * its version token. Aborting the signal stops the git process when no other
 * request waits for the same diff; in the helper through its `cancel`.
 */
export async function getWorkspaceGitDiff(input: WorkspaceGitDiffInput, options: { signal?: AbortSignal } = {}): Promise<GitDiffResult> {
  const request: GitDiffRequest = {
    worktreePath: path.resolve(input.worktreePath),
    repositoryPath: input.repositoryPath ?? null,
    baseBranch: input.baseBranch,
    path: input.path,
    kind: input.kind,
    force: input.force === true,
  };
  for (let attempt = 0; ; attempt += 1) {
    const helper = getRunningCommandHelper();
    if (!helper) return structuredClone(await getLocalService().diff(request, options));
    observeHelper();
    try {
      const result = await helper.requestGitDiff(request, options);
      recordHelperCounters(result.epoch, result.counters);
      return result;
    } catch (error) {
      // A diff only reads; it can be asked again after a crash.
      if (attempt === 0 && (error as { code?: unknown } | null)?.code === COMMAND_HELPER_EXITED && !options.signal?.aborted) continue;
      throw error;
    }
  }
}

/** Registered clean worktrees stay cached; unregistered reads use the 1 s window. */
export function getWorkspaceGitState(input: WorkspaceGitStateInput, options: { signal?: AbortSignal } = {}): Promise<GitStateSnapshot> {
  return requestState(input, false, options);
}

export function registerWorkspaceGitState(input: WorkspaceGitStateInput, options: { signal?: AbortSignal } = {}): Promise<GitStateSnapshot> {
  return requestState(input, true, options);
}

export function unregisterWorkspaceGitState(worktreePath: string): void {
  const key = path.resolve(worktreePath);
  const helper = getRunningCommandHelper();
  if (helper) helper.unregisterGitState(key);
  else localService?.unregister(key);
}

export function invalidateWorkspaceGitState(worktreePath: string, trigger: GitStateTrigger): void {
  const key = path.resolve(worktreePath);
  const helper = getRunningCommandHelper();
  if (helper) helper.invalidateGitState(key, trigger);
  else localService?.invalidate(key, trigger);
}

export function onWorkspaceGitStateChange(listener: (snapshot: GitStateSnapshot) => void): () => void {
  changeListeners.add(listener);
  observeHelper();
  return () => { changeListeners.delete(listener); };
}

/** The server registry re-registers all subscriptions after this notification. */
export function onGitStatePlacementChange(listener: () => void): () => void {
  placementListeners.add(listener);
  return () => { placementListeners.delete(listener); };
}

export function getGitStatePlacement(): 'helper' | 'server' {
  return getRunningCommandHelper() ? 'helper' : 'server';
}

/** Drops the server instance and closes all its watches/timers (tests and shutdown). */
export function resetLocalGitStateService(): void {
  localService?.dispose();
  localService = undefined;
  helperCounters.clear();
  if (!getRunningCommandHelper()) setRegisteredGitWorktrees(0);
}
