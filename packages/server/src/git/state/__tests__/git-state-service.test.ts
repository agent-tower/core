/**
 * Behaviour of the git state service through the server's facade: shared
 * computations, the freshness window, the number of git processes per
 * refresh, versions. Runs in both placements: in this process with the
 * default config, in the command helper with `vitest.command-helper.config.ts`.
 * The counters come from the runtime metrics, which the helper's replies feed.
 *
 * The last block tests the service class directly (abort and eviction rules,
 * and which commands it runs), independent of the placement.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readRuntimeCounters, type RuntimeCounters } from '../../../runtime/runtime-metrics.js';
import { runOwnedCommandInProcess, type OwnedCommandOptions } from '../../../utils/owned-child-process.js';
import { getWorkspaceGitState } from '../git-state-facade.js';
import type { GitCommandRunner } from '../git-state-compute.js';
import { GIT_DIFF_SIZE_LIMIT_BYTES, GIT_STATE_FRESHNESS_MS } from '../git-state-limits.js';
import { WorkspaceGitStateService } from '../git-state-service.js';
import type { GitStateSnapshot } from '../git-state-types.js';
import { commitAll, git, initRepo, isolateGitConfiguration, largeText, lines, settle, withoutTokens, write } from './git-fixtures.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-git-state-service-'));
isolateGitConfiguration(root);
const repo = path.join(root, 'repo');
let worktreeCount = 0;

/** A linked worktree on its own branch with one commit ahead of main. */
function newWorktree(): string {
  const dir = path.join(root, `wt-${++worktreeCount}`);
  git(repo, 'worktree', 'add', '-q', '-b', `topic-${worktreeCount}`, dir, 'main');
  write(path.join(dir, 'topic.txt'), 'topic\n');
  commitAll(dir, 'topic');
  return dir;
}

function delta(before: RuntimeCounters, after: RuntimeCounters) {
  return {
    requests: after.gitStateRequests - before.gitStateRequests,
    computations: after.gitStateComputations - before.gitStateComputations,
    cacheAnswers: after.gitStateCacheAnswers - before.gitStateCacheAnswers,
    gitProcesses: after.gitStateGitProcesses - before.gitStateGitProcesses,
  };
}

function stateOf(worktreePath: string, baseBranch = 'main'): Promise<GitStateSnapshot> {
  return getWorkspaceGitState({ worktreePath, repositoryPath: repo, baseBranch });
}

/** Runs `requests` and returns their result with the counter changes they caused. */
async function measured<T>(requests: () => Promise<T>) {
  const before = readRuntimeCounters();
  const value = await requests();
  return { value, ...delta(before, readRuntimeCounters()) };
}

/** Waits until a state computed at `snapshot.computedAt` is outside the freshness window. */
async function outsideWindow(snapshot: GitStateSnapshot): Promise<void> {
  const wait = snapshot.computedAt + GIT_STATE_FRESHNESS_MS + 50 - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

beforeAll(() => {
  initRepo(repo);
  write(path.join(repo, 'a.txt'), lines(5, 'a'));
  write(path.join(repo, 'b.txt'), lines(5, 'b'));
  commitAll(repo, 'base');
}, 60_000);

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('git state service through the facade', () => {
  it('starts one computation for many simultaneous requests of one worktree', async () => {
    const dir = newWorktree();
    const { value: snapshots, ...counts } = await measured(() => Promise.all(Array.from({ length: 25 }, () => stateOf(dir))));
    expect(counts.requests).toBe(25);
    expect(counts.computations).toBe(1);
    // status + committed diff + ahead/behind: a clean worktree seen for the first time.
    expect(counts.gitProcesses).toBe(3);
    for (const snapshot of snapshots) expect(snapshot).toEqual(snapshots[0]);
    expect(withoutTokens(snapshots[0]!.committed)).toEqual([{ status: 'A', path: 'topic.txt', additions: 1, deletions: 0 }]);
    expect(snapshots[0]!.committed[0]!.token).toEqual(expect.any(String));
    expect(snapshots[0]).toMatchObject({ available: true, ahead: 1, behind: 0, uncommittedCount: 0, version: 1 });
  });

  it('answers inside the freshness window without a git process, and after it with one shared computation', async () => {
    const dir = newWorktree();
    const first = await measured(() => stateOf(dir));
    expect(first.computations).toBe(1);

    await outsideWindow(first.value);
    // Several requests after the window: one computation. The commits did not
    // move, so the comparisons come from their cache and only `git status` runs.
    const refreshed = await measured(() => Promise.all([stateOf(dir), stateOf(dir), stateOf(dir)]));
    expect(refreshed).toMatchObject({ requests: 3, computations: 1, gitProcesses: 1 });
    const [state] = refreshed.value;
    expect(state!.computedAt).toBeGreaterThan(first.value.computedAt);
    expect(refreshed.value.every((other) => other.computedAt === state!.computedAt)).toBe(true);
    // Same content: same version, same epoch.
    expect(state!.version).toBe(first.value.version);
    expect(state!.epoch).toBe(first.value.epoch);

    const cached = await measured(() => stateOf(dir));
    if (Date.now() - state!.computedAt < GIT_STATE_FRESHNESS_MS) {
      expect(cached).toMatchObject({ requests: 1, computations: 0, cacheAnswers: 1, gitProcesses: 0 });
      expect(cached.value).toEqual(state);
    } else {
      // The host was too slow to ask again inside the window; never seen on an idle machine.
      expect(cached.computations).toBe(1);
    }
  });

  it('runs 1 git process for a clean worktree, 2 with uncommitted changes, and at most 4 when HEAD or the base moved', async () => {
    const dir = newWorktree();
    const first = await measured(() => stateOf(dir));
    expect(first.gitProcesses).toBe(3);

    await outsideWindow(first.value);
    const clean = await measured(() => stateOf(dir));
    expect(clean).toMatchObject({ computations: 1, gitProcesses: 1 });

    fs.appendFileSync(path.join(dir, 'a.txt'), 'uncommitted\n');
    // Outside the racy window: from now on, a.txt's token only changes when the file does.
    settle(path.join(dir, 'a.txt'));
    await outsideWindow(clean.value);
    const dirty = await measured(() => stateOf(dir));
    expect(dirty).toMatchObject({ computations: 1, gitProcesses: 2 });
    expect(withoutTokens(dirty.value.uncommitted)).toEqual([{ status: 'M', path: 'a.txt', additions: 1, deletions: 0 }]);
    expect(dirty.value.version).toBe(clean.value.version + 1);

    // A commit rewrites the index and the branch ref: the next request sees it
    // at once, inside the window. a.txt stays uncommitted and unchanged, so
    // its line counts are reused: status, committed diff and ahead/behind.
    write(path.join(dir, 'committed.txt'), 'c\n');
    git(dir, 'add', 'committed.txt');
    git(dir, 'commit', '-q', '-m', 'move HEAD');
    const headMoved = await measured(() => stateOf(dir));
    expect(headMoved).toMatchObject({ computations: 1, gitProcesses: 3 });
    expect(headMoved.value.uncommitted).toEqual(dirty.value.uncommitted);
    expect(headMoved.value.head.oid).toBe(git(dir, 'rev-parse', 'HEAD'));
    expect(headMoved.value).toMatchObject({ ahead: 2, behind: 0, uncommittedCount: 1 });
    expect(headMoved.value.version).toBe(dirty.value.version + 1);

    // The base branch moves in the repository's main worktree.
    write(path.join(repo, 'base-moved.txt'), 'm\n');
    commitAll(repo, 'base moved');
    const baseMoved = await measured(() => stateOf(dir));
    expect(baseMoved.computations).toBe(1);
    expect(baseMoved.gitProcesses).toBeLessThanOrEqual(4);
    expect(baseMoved.value).toMatchObject({ ahead: 2, behind: 1 });
    expect(baseMoved.value.version).toBe(headMoved.value.version + 1);

    // Committing everything leaves a clean worktree on a new commit: status,
    // committed diff and ahead/behind.
    commitAll(dir, 'commit the rest');
    const cleanAgain = await measured(() => stateOf(dir));
    expect(cleanAgain).toMatchObject({ computations: 1, gitProcesses: 3 });
    expect(cleanAgain.value).toMatchObject({ uncommitted: [], uncommittedCount: 0, ahead: 3, behind: 1 });
  });

  it('keeps one entry per worktree within one epoch', async () => {
    const one = newWorktree();
    const two = newWorktree();
    const both = await measured(() => Promise.all([stateOf(one), stateOf(two)]));
    expect(both.computations).toBe(2);
    const [a, b] = both.value;
    expect(a!.worktreePath).toBe(one);
    expect(b!.worktreePath).toBe(two);
    expect(a!.epoch).toBe(b!.epoch);
  });

  it('computes again for another base branch instead of answering with the state of the old one', async () => {
    const dir = newWorktree();
    const branch = `topic-${worktreeCount}`;
    const onMain = await stateOf(dir, 'main');
    const onBranch = await measured(() => stateOf(dir, branch));
    expect(onBranch.computations).toBe(1);
    expect(onBranch.value).toMatchObject({ baseBranch: branch, committed: [], ahead: 0, behind: 0 });
    expect(onMain.committed).not.toEqual([]);
  });

  it('reports a directory outside any repository as unavailable', async () => {
    const outside = fs.mkdtempSync(path.join(root, 'not-a-repository-'));
    const state = await stateOf(outside);
    expect(state).toMatchObject({ available: false, uncommitted: [], committed: [] });
  });
});

describe('git state service rules', () => {
  const statusOutput = (branch: string) => `# branch.oid (initial)\0# branch.head ${branch}\0`;

  /** A runner whose commands wait until released; records arguments and abort signals. */
  function controlledRunner() {
    const calls: { args: string[]; signal?: AbortSignal; release: () => void }[] = [];
    const run: GitCommandRunner = (command, args, options) => new Promise((resolve, reject) => {
      calls.push({ args, signal: options.signal, release: () => resolve({ stdout: statusOutput('main'), stderr: '' }) });
      options.signal?.addEventListener('abort', () => reject(Object.assign(new Error(`${command} was cancelled`), { code: 'ABORT_ERR' })), { once: true });
    });
    return { calls, run };
  }

  it('aborts a shared computation only when no request waits for it any more', async () => {
    const runner = controlledRunner();
    const service = new WorkspaceGitStateService({ run: runner.run });
    const dir = fs.mkdtempSync(path.join(root, 'abort-'));
    const first = new AbortController();
    const second = new AbortController();
    const a = service.get({ worktreePath: dir, baseBranch: 'main' }, { signal: first.signal });
    const b = service.get({ worktreePath: dir, baseBranch: 'main' }, { signal: second.signal });
    await expect.poll(() => runner.calls.length).toBe(1);
    first.abort();
    await expect(a).rejects.toMatchObject({ code: 'ABORT_ERR' });
    expect(runner.calls[0]!.signal!.aborted).toBe(false);
    second.abort();
    await expect(b).rejects.toMatchObject({ code: 'ABORT_ERR' });
    expect(runner.calls[0]!.signal!.aborted).toBe(true);
    // The next request starts afresh instead of joining the aborted computation.
    const c = service.get({ worktreePath: dir, baseBranch: 'main' });
    await expect.poll(() => runner.calls.length).toBe(2);
    runner.calls[1]!.release();
    await expect(c).resolves.toMatchObject({ source: 'computation' });
    expect(service.readCounters()).toMatchObject({ requests: 3, computations: 2, cacheAnswers: 0, gitProcesses: 2 });
    service.dispose();
  });

  it('answers a request without a signal even when every other waiter left', async () => {
    const runner = controlledRunner();
    const service = new WorkspaceGitStateService({ run: runner.run });
    const dir = fs.mkdtempSync(path.join(root, 'keep-'));
    const leaving = new AbortController();
    const a = service.get({ worktreePath: dir, baseBranch: 'main' }, { signal: leaving.signal });
    const b = service.get({ worktreePath: dir, baseBranch: 'main' });
    await expect.poll(() => runner.calls.length).toBe(1);
    leaving.abort();
    await expect(a).rejects.toMatchObject({ code: 'ABORT_ERR' });
    expect(runner.calls[0]!.signal!.aborted).toBe(false);
    runner.calls[0]!.release();
    await expect(b).resolves.toMatchObject({ source: 'shared' });
    service.dispose();
  });

  it('bounds the number of entries, drops idle ones, and never moves a version back', async () => {
    let now = 1_000_000;
    let output = statusOutput('one');
    const run: GitCommandRunner = async () => ({ stdout: output, stderr: '' });
    const service = new WorkspaceGitStateService({ run, maxEntries: 2, entryIdleMs: 60_000, now: () => now });
    const dirs = [0, 1, 2].map((index) => fs.mkdtempSync(path.join(root, `entry-${index}-`)));
    const get = (dir: string) => service.get({ worktreePath: dir, baseBranch: 'main' });

    expect((await get(dirs[0]!)).snapshot.version).toBe(1);
    now += 2_000;
    output = statusOutput('two');
    expect((await get(dirs[0]!)).snapshot.version).toBe(2);
    await get(dirs[1]!);
    await get(dirs[2]!);
    expect(service.size).toBe(2);

    // dirs[0], the least recently requested, was dropped; its version line goes on.
    now += 2_000;
    const again = await get(dirs[0]!);
    expect(again.source).toBe('computation');
    expect(again.snapshot.version).toBe(2);
    now += 2_000;
    output = statusOutput('three');
    expect((await get(dirs[0]!)).snapshot.version).toBe(3);
    expect(service.size).toBe(2);

    now += 120_000;
    service.sweep();
    expect(service.size).toBe(0);
    service.dispose();
  });

  it('keeps line counting away from files above the size limit, and runs every command without optional locks', async () => {
    const dir = newWorktree();
    write(path.join(dir, 'big.txt'), largeText('big'));
    commitAll(dir, 'big file');
    fs.appendFileSync(path.join(dir, 'big.txt'), 'edit\n');
    fs.appendFileSync(path.join(dir, 'a.txt'), 'edit\n');
    expect(fs.statSync(path.join(dir, 'big.txt')).size).toBeGreaterThan(GIT_DIFF_SIZE_LIMIT_BYTES);
    const commands: { args: string[]; options: OwnedCommandOptions }[] = [];
    const service = new WorkspaceGitStateService({
      run: (command, args, options) => {
        commands.push({ args, options });
        return runOwnedCommandInProcess(command, args, options);
      },
    });
    const { snapshot } = await service.get({ worktreePath: dir, repositoryPath: repo, baseBranch: 'main' });
    expect(withoutTokens(snapshot.uncommitted)).toEqual([
      { status: 'M', path: 'a.txt', additions: 1, deletions: 0 },
      { status: 'M', path: 'big.txt' },
    ]);
    expect(withoutTokens(snapshot.committed)).toEqual([
      { status: 'A', path: 'big.txt' },
      { status: 'A', path: 'topic.txt', additions: 1, deletions: 0 },
    ]);

    const subcommands = commands.map(({ args }) => args.find((arg) => ['status', 'diff', 'rev-list'].includes(arg)));
    expect(subcommands.sort()).toEqual(['diff', 'diff', 'rev-list', 'status']);
    const diffs = commands.filter(({ args }) => args.includes('diff'));
    for (const { args } of diffs) expect(args).toContain(`core.bigFileThreshold=${GIT_DIFF_SIZE_LIMIT_BYTES}`);
    // The large working file is not even read for the uncommitted counts.
    const uncommitted = diffs.find(({ args }) => args.includes('HEAD'))!.args;
    expect(uncommitted.slice(uncommitted.indexOf('--') + 1)).toEqual([':(top,literal)a.txt']);
    for (const { options } of commands) expect(options.env?.GIT_OPTIONAL_LOCKS).toBe('0');
    service.dispose();
  });
});
