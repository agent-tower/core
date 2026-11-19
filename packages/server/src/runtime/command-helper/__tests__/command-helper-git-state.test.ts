/**
 * The git state service placed in the command helper: its answers, and what a
 * request gets when the helper goes away, stops answering or is stopped while
 * it computes. This file starts and stops its own helpers; run it with the
 * default config only (not `vitest.command-helper.config.ts`).
 *
 * A `git` placed first on PATH for one request makes the helper's computation
 * wait: the facade sends the request's environment to the helper, and the
 * helper starts git with it.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { commitAll, git, initRepo, isolateGitConfiguration, lines, settle, withoutTokens, write } from '../../../git/state/__tests__/git-fixtures.js';
import { getGitStatePlacement, getWorkspaceGitState, invalidateWorkspaceGitState, onGitStatePlacementChange, onWorkspaceGitStateChange, registerWorkspaceGitState, resetLocalGitStateService, unregisterWorkspaceGitState } from '../../../git/state/git-state-facade.js';
import { GIT_STATE_FRESHNESS_MS } from '../../../git/state/git-state-limits.js';
import type { GitStateContent, GitStateSnapshot } from '../../../git/state/git-state-types.js';
import { readRuntimeCounters } from '../../runtime-metrics.js';
import { getCommandHelperStatus, getRunningCommandHelper, startCommandHelper, stopCommandHelper, type StartCommandHelperOptions } from '../client.js';
import { COMMAND_HELPER_UNRESPONSIVE } from '../protocol.js';

const posix = process.platform !== 'win32';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-helper-git-state-'));
isolateGitConfiguration(root);
const repo = path.join(root, 'repo');
const worktree = path.join(root, 'worktree');
const slowGitDirectory = path.join(root, 'slow-git');
const slowGitPids = path.join(root, 'slow-git.pids');
const input = { worktreePath: worktree, repositoryPath: repo, baseBranch: 'main' };
const helperPids = new Set<number>();
const quietLog = vi.fn();
let expected: GitStateContent;

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function content(snapshot: GitStateSnapshot): GitStateContent {
  const { epoch: _epoch, version: _version, computedAt: _computedAt, ...rest } = snapshot;
  return rest;
}

async function startHelper(options: StartCommandHelperOptions = {}): Promise<number> {
  expect(await startCommandHelper({ mode: 'on', log: quietLog, ...options })).toBe(true);
  const pid = getCommandHelperStatus().pid!;
  helperPids.add(pid);
  return pid;
}

/** Starts a request whose git processes first wait 30 s; the request's environment is taken synchronously. */
function slowRequest(options: { signal?: AbortSignal } = {}): Promise<GitStateSnapshot> {
  const previous = process.env.PATH;
  process.env.PATH = `${slowGitDirectory}${path.delimiter}${previous ?? ''}`;
  try {
    return getWorkspaceGitState(input, options);
  } finally {
    process.env.PATH = previous;
  }
}

function slowGitPidList(): number[] {
  return fs.existsSync(slowGitPids) ? fs.readFileSync(slowGitPids, 'utf8').split('\n').filter(Boolean).map(Number) : [];
}

function outsideWindow(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, GIT_STATE_FRESHNESS_MS + 100));
}

async function firstSlowGit(): Promise<number> {
  await vi.waitFor(() => expect(slowGitPidList().length).toBeGreaterThan(0), { timeout: 15_000 });
  return slowGitPidList()[0]!;
}

beforeAll(async () => {
  initRepo(repo);
  write(path.join(repo, 'a.txt'), lines(5, 'a'));
  commitAll(repo, 'base');
  git(repo, 'worktree', 'add', '-q', '-b', 'topic', worktree, 'main');
  write(path.join(worktree, 'topic.txt'), 'topic\n');
  commitAll(worktree, 'topic');
  fs.appendFileSync(path.join(worktree, 'a.txt'), 'uncommitted\n');
  write(path.join(worktree, 'new.txt'), 'untracked\n');
  // Settled files have the same version tokens in every placement (racy ones carry the epoch).
  settle(path.join(worktree, 'a.txt'));
  settle(path.join(worktree, 'new.txt'));

  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  fs.mkdirSync(slowGitDirectory);
  // Short sleeps, so nothing outlives a killed script by more than 0.1 s.
  fs.writeFileSync(path.join(slowGitDirectory, 'git'), [
    '#!/bin/sh',
    `echo $$ >> '${slowGitPids}'`,
    'i=0; while [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done',
    `exec '${realGit}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });

  // The reference: the same service in this process, no helper running.
  expect(getGitStatePlacement()).toBe('server');
  expected = content(await getWorkspaceGitState(input));
  expect(withoutTokens(expected.uncommitted)).toEqual([
    { status: 'M', path: 'a.txt', additions: 1, deletions: 0 },
    { status: 'A', path: 'new.txt' },
  ]);
  expect(withoutTokens(expected.committed)).toEqual([{ status: 'A', path: 'topic.txt', additions: 1, deletions: 0 }]);
}, 60_000);

afterEach(async () => {
  await stopCommandHelper();
  resetLocalGitStateService();
  for (const pid of slowGitPidList()) {
    if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ } }
  }
  fs.rmSync(slowGitPids, { force: true });
  quietLog.mockClear();
}, 60_000);

afterAll(async () => {
  await stopCommandHelper();
  for (const pid of helperPids) {
    if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ } }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!posix)('git state in the command helper', () => {
  it('registers, pushes changed states, reports unchanged computations, and unregisters over IPC', async () => {
    await startHelper();
    const changes: GitStateSnapshot[] = [];
    const offChange = onWorkspaceGitStateChange((snapshot) => changes.push(snapshot));
    const file = path.join(worktree, 'subscription.txt');
    try {
      const first = await registerWorkspaceGitState(input);
      expect(content(first)).toEqual(expected);
      await vi.waitFor(() => expect(readRuntimeCounters().gitStateRegisteredWorktrees).toBe(1));
      changes.length = 0;
      const processes = readRuntimeCounters().gitStateGitProcesses;
      await outsideWindow();
      expect(await getWorkspaceGitState(input)).toEqual(first);
      expect(readRuntimeCounters().gitStateGitProcesses).toBe(processes);

      write(file, 'agent edit\n');
      const beforeAgent = readRuntimeCounters().gitStateComputationsAgent;
      invalidateWorkspaceGitState(worktree, 'agent');
      await vi.waitFor(() => expect(changes).toHaveLength(1), { timeout: 5_000 });
      expect(changes[0]!.uncommitted).toContainEqual({ status: 'A', path: 'subscription.txt', token: expect.any(String) });
      expect(changes[0]!.version).toBe(first.version + 1);
      expect(changes[0]!.epoch).toBe(first.epoch);
      expect(readRuntimeCounters().gitStateComputationsAgent).toBe(beforeAgent + 1);

      const beforeRefresh = readRuntimeCounters().gitStateComputationsRefresh;
      const beforeProcesses = readRuntimeCounters().gitStateGitProcesses;
      invalidateWorkspaceGitState(worktree, 'refresh');
      await vi.waitFor(() => expect(readRuntimeCounters().gitStateComputationsRefresh).toBe(beforeRefresh + 1), { timeout: 5_000 });
      // The unchanged computation has no state event, but its activity reaches the server.
      await getWorkspaceGitState(input);
      expect(readRuntimeCounters().gitStateGitProcesses).toBeGreaterThan(beforeProcesses);
      expect(changes).toHaveLength(1);
      console.info(`[helper subscribed] helper rss_mb=${((getCommandHelperStatus().rssBytes ?? 0) / 1024 / 1024).toFixed(1)} (tsx source)`);

      unregisterWorkspaceGitState(worktree);
      await vi.waitFor(() => expect(readRuntimeCounters().gitStateRegisteredWorktrees).toBe(0));
      const afterUnregister = readRuntimeCounters().gitStateComputations;
      write(file, 'another edit\n');
      invalidateWorkspaceGitState(worktree, 'operation');
      await outsideWindow();
      expect(readRuntimeCounters().gitStateComputations).toBe(afterUnregister);
      expect(changes).toHaveLength(1);
    } finally {
      offChange();
      unregisterWorkspaceGitState(worktree);
      fs.rmSync(file, { force: true });
    }
  }, 30_000);

  it('answers like the in-process service, with its own epoch, and starts no process in the server', async () => {
    const serverEpoch = (await getWorkspaceGitState(input)).epoch;
    const helperPid = await startHelper();
    expect(getGitStatePlacement()).toBe('helper');
    const before = readRuntimeCounters();
    const first = await getWorkspaceGitState(input);
    const after = readRuntimeCounters();
    expect(content(first)).toEqual(expected);
    expect(first.epoch).not.toBe(serverEpoch);
    expect(after.commandsInProcess - before.commandsInProcess).toBe(0);
    expect(after.commandsViaHelper - before.commandsViaHelper).toBe(0);
    expect(after.gitStateGitProcesses - before.gitStateGitProcesses).toBe(4);
    const second = await getWorkspaceGitState(input);
    expect(second.epoch).toBe(first.epoch);
    expect(getCommandHelperStatus().pid).toBe(helperPid);
    console.info(`[helper git state] helper rss_mb=${((getCommandHelperStatus().rssBytes ?? 0) / 1024 / 1024).toFixed(1)} (tsx source)`);
  }, 60_000);

  it('lets the registry register subscriptions again after a helper crash and recovery, with a new epoch each time', async () => {
    const helperPid = await startHelper({ restartDelaysMs: [2_000] });
    const first = await registerWorkspaceGitState(input);
    const epochs = [first.epoch];
    const failures: unknown[] = [];
    const pending: Promise<void>[] = [];
    const offPlacement = onGitStatePlacementChange(() => {
      pending.push(registerWorkspaceGitState(input).then((snapshot) => {
        expect(content(snapshot)).toEqual(expected);
        epochs.push(snapshot.epoch);
      }).catch((error: unknown) => { failures.push(error); }));
    });
    try {
      process.kill(helperPid, 'SIGKILL');
      await vi.waitFor(() => expect(epochs).toHaveLength(3), { timeout: 30_000 });
      await Promise.all(pending);
      expect(failures).toEqual([]);
      expect(new Set(epochs).size).toBe(3);
      expect(getGitStatePlacement()).toBe('helper');
      helperPids.add(getCommandHelperStatus().pid!);
      await vi.waitFor(() => expect(readRuntimeCounters().gitStateRegisteredWorktrees).toBe(1));
      unregisterWorkspaceGitState(worktree);
      await vi.waitFor(() => expect(readRuntimeCounters().gitStateRegisteredWorktrees).toBe(0));
    } finally {
      offPlacement();
      await Promise.all(pending);
      unregisterWorkspaceGitState(worktree);
    }
  }, 40_000);

  it('answers from the server when the helper is killed during the computation, and the restarted helper is a new epoch', async () => {
    const helperPid = await startHelper({ restartDelaysMs: [1_500] });
    const helperEpoch = (await getWorkspaceGitState(input)).epoch;
    // Outside the freshness window, so the slow request computes.
    await outsideWindow();
    const inProcessBefore = readRuntimeCounters().commandsInProcess;
    const pending = slowRequest();
    const slowGit = await firstSlowGit();

    process.kill(helperPid, 'SIGKILL');
    const answered = await pending;
    expect(content(answered)).toEqual(expected);
    expect(answered.epoch).not.toBe(helperEpoch);
    // Asked again from this process: the helper was down.
    expect(readRuntimeCounters().commandsInProcess).toBeGreaterThan(inProcessBefore);
    // The scope supervisor stops the helper's git when the helper dies.
    await vi.waitFor(() => expect(alive(slowGit)).toBe(false), { timeout: 10_000 });

    await vi.waitFor(() => expect(getCommandHelperStatus().state).toBe('running'), { timeout: 30_000 });
    const restartedPid = getCommandHelperStatus().pid!;
    helperPids.add(restartedPid);
    expect(restartedPid).not.toBe(helperPid);
    const restarted = await getWorkspaceGitState(input);
    expect(content(restarted)).toEqual(expected);
    expect([helperEpoch, answered.epoch]).not.toContain(restarted.epoch);
  }, 90_000);

  it('ends a request with a distinct error when the helper stops answering, replaces the helper, and later requests work', async () => {
    const helperPid = await startHelper({ gitStateDeadlineMs: 1_000, resultGraceMs: 600, terminateGraceMs: 400, restartDelaysMs: [100] });
    const helperEpoch = (await getWorkspaceGitState(input)).epoch;

    process.kill(helperPid, 'SIGSTOP');
    const sentAt = Date.now();
    await expect(getWorkspaceGitState(input)).rejects.toMatchObject({ code: COMMAND_HELPER_UNRESPONSIVE });
    const waited = Date.now() - sentAt;
    expect(waited).toBeGreaterThanOrEqual(900);
    expect(waited).toBeLessThan(5_000);
    // The frozen helper counts as failed: requests are answered in this process meanwhile.
    expect(getRunningCommandHelper()).toBeNull();
    expect(content(await getWorkspaceGitState(input))).toEqual(expected);

    // SIGTERM stays pending in a stopped process; SIGKILL follows after the grace.
    await vi.waitFor(() => expect(alive(helperPid)).toBe(false), { timeout: 10_000 });
    await vi.waitFor(() => expect(getCommandHelperStatus().state).toBe('running'), { timeout: 30_000 });
    const restartedPid = getCommandHelperStatus().pid!;
    helperPids.add(restartedPid);
    expect(restartedPid).not.toBe(helperPid);
    const restarted = await getWorkspaceGitState(input);
    expect(content(restarted)).toEqual(expected);
    expect(restarted.epoch).not.toBe(helperEpoch);
  }, 60_000);

  it('answers a request that is running while the helper is stopped', async () => {
    await startHelper();
    const pending = slowRequest();
    const slowGit = await firstSlowGit();
    await stopCommandHelper();
    expect(getGitStatePlacement()).toBe('server');
    expect(content(await pending)).toEqual(expected);
    await vi.waitFor(() => expect(alive(slowGit)).toBe(false), { timeout: 10_000 });
  }, 60_000);

  it('cancels the computation in the helper when the only request waiting for it is cancelled', async () => {
    await startHelper();
    const epoch = (await getWorkspaceGitState(input)).epoch;
    const controller = new AbortController();
    // Outside the freshness window, so the slow request computes.
    await outsideWindow();
    const pending = slowRequest({ signal: controller.signal });
    const slowGit = await firstSlowGit();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ABORT_ERR' });
    await vi.waitFor(() => expect(alive(slowGit)).toBe(false), { timeout: 10_000 });
    // Same helper, same epoch.
    const next = await getWorkspaceGitState(input);
    expect(content(next)).toEqual(expected);
    expect(next.epoch).toBe(epoch);
  }, 60_000);
});
