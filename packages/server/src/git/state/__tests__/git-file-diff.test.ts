/**
 * Step 4: version tokens of changed files, file diffs from the git state
 * service, the diff cache, the size guard and cancellation.
 *
 * The facade blocks run in both placements: in this process with the default
 * config, in the command helper with `vitest.command-helper.config.ts`. The
 * counters come from the runtime metrics, which the helper's replies feed. The
 * service blocks test the class directly (they need a controlled clock, small
 * cache limits or a recording runner), independent of the placement.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readRuntimeCounters, type RuntimeCounters } from '../../../runtime/runtime-metrics.js';
import { runOwnedCommandInProcess } from '../../../utils/owned-child-process.js';
import {
  getWorkspaceGitDiff, getWorkspaceGitState, registerWorkspaceGitState, unregisterWorkspaceGitState,
  type WorkspaceGitDiffInput,
} from '../git-state-facade.js';
import type { GitCommandRunner } from '../git-state-compute.js';
import { GIT_FILE_DIFF_FORCED_LIMIT_BYTES, GIT_FILE_DIFF_LIMIT_BYTES, GIT_STATE_FRESHNESS_MS } from '../git-state-limits.js';
import { WorkspaceGitStateService } from '../git-state-service.js';
import type { GitFileDiff, GitStateSnapshot } from '../git-state-types.js';
import { commitAll, git, initRepo, isolateGitConfiguration, largeText, lines, settle, withoutTokens, write } from './git-fixtures.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-git-file-diff-'));
isolateGitConfiguration(root);
const repo = path.join(root, 'repo');
let worktreeCount = 0;

/** Textconv driver that waits `ticks` tenths of a second (file `ticks`) before printing the file; it records its pid. */
const slowDir = path.join(root, 'slow-textconv');
const slowScript = path.join(slowDir, 'slow-textconv-marker.sh');
const slowPids = path.join(slowDir, 'pids');
const slowTicks = path.join(slowDir, 'ticks');

function newWorktree(): string {
  const dir = path.join(root, `wt-${++worktreeCount}`);
  git(repo, 'worktree', 'add', '-q', '-b', `topic-${worktreeCount}`, dir, 'main');
  write(path.join(dir, 'topic.txt'), 'topic\n');
  commitAll(dir, 'topic');
  return dir;
}

function input(dir: string) {
  return { worktreePath: dir, repositoryPath: repo, baseBranch: 'main' };
}

function stateOf(dir: string): Promise<GitStateSnapshot> {
  return getWorkspaceGitState(input(dir));
}

/** A state computed now: waits until the previous one is outside the freshness window. */
async function freshState(dir: string, previous: GitStateSnapshot): Promise<GitStateSnapshot> {
  const wait = previous.computedAt + GIT_STATE_FRESHNESS_MS + 50 - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  return stateOf(dir);
}

async function diffOf(dir: string, file: string, kind: WorkspaceGitDiffInput['kind'] = 'uncommitted', options: { force?: boolean; signal?: AbortSignal } = {}): Promise<GitFileDiff> {
  const result = await getWorkspaceGitDiff({ ...input(dir), path: file, kind, force: options.force }, { signal: options.signal });
  return result.diff!;
}

function delta(before: RuntimeCounters, after: RuntimeCounters) {
  return {
    gitProcesses: after.gitStateGitProcesses - before.gitStateGitProcesses,
    diffRequests: after.gitDiffRequests - before.gitDiffRequests,
    diffComputations: after.gitDiffComputations - before.gitDiffComputations,
    diffCacheAnswers: after.gitDiffCacheAnswers - before.gitDiffCacheAnswers,
  };
}

async function measured<T>(work: () => Promise<T>) {
  const before = readRuntimeCounters();
  const value = await work();
  return { value, ...delta(before, readRuntimeCounters()) };
}

function tokenOf(snapshot: GitStateSnapshot, file: string, list: 'uncommitted' | 'committed' = 'uncommitted'): string | undefined {
  return snapshot[list].find((entry) => entry.path === file)?.token;
}

function slowPidList(): number[] {
  return fs.existsSync(slowPids) ? fs.readFileSync(slowPids, 'utf8').split('\n').filter(Boolean).map(Number) : [];
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Processes whose command line names the slow textconv script (Linux; elsewhere the pid check covers it). */
function slowProcesses(): number[] {
  if (process.platform !== 'linux') return slowPidList().filter(alive);
  const found: number[] = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      if (fs.readFileSync(`/proc/${name}/cmdline`, 'utf8').includes('slow-textconv-marker')) found.push(Number(name));
    } catch { /* exited meanwhile */ }
  }
  return found;
}

beforeAll(() => {
  initRepo(repo);
  write(path.join(repo, 'a.txt'), lines(5, 'a'));
  write(path.join(repo, 'b.txt'), lines(5, 'b'));
  write(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255, 254, 0]));
  write(path.join(repo, 'small.txt'), lines(20, 'small'));
  write(path.join(repo, 'shrinks.txt'), largeText('shrinks'));
  write(path.join(repo, 'slow.txt'), lines(3, 'slow'));
  write(path.join(repo, '.gitattributes'), 'slow.txt diff=slowconv\n');
  commitAll(repo, 'base');
  fs.mkdirSync(slowDir);
  fs.writeFileSync(slowTicks, '600');
  fs.writeFileSync(slowScript, [
    '#!/bin/sh',
    `echo $$ >> '${slowPids}'`,
    `n=$(cat '${slowTicks}'); i=0`,
    'while [ $i -lt $n ]; do sleep 0.1; i=$((i+1)); done',
    'cat "$1"',
    '',
  ].join('\n'), { mode: 0o755 });
  git(repo, 'config', 'diff.slowconv.textconv', slowScript);
}, 60_000);

afterAll(() => {
  for (const pid of slowPidList()) if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('version tokens through the facade', () => {
  it('changes an uncommitted token with the content and keeps it while nothing changes', async () => {
    const dir = newWorktree();
    const file = path.join(dir, 'a.txt');
    fs.appendFileSync(file, 'one\n');
    settle(file);
    const first = await stateOf(dir);
    const unchanged = await freshState(dir, first);
    expect(tokenOf(unchanged, 'a.txt')).toBe(tokenOf(first, 'a.txt'));
    expect(unchanged.version).toBe(first.version);

    fs.appendFileSync(file, 'two\n');
    settle(file);
    const grown = await freshState(dir, unchanged);
    expect(tokenOf(grown, 'a.txt')).not.toBe(tokenOf(first, 'a.txt'));

    // Same size, other bytes: the stat times move.
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('two', 'TWO'));
    settle(file);
    const rewritten = await freshState(dir, grown);
    expect(tokenOf(rewritten, 'a.txt')).not.toBe(tokenOf(grown, 'a.txt'));
  });

  it('changes when HEAD moves the file\'s blob, and only then', async () => {
    const dir = newWorktree();
    const file = path.join(dir, 'a.txt');
    fs.appendFileSync(file, 'working\n');
    settle(file);
    const first = await stateOf(dir);
    const statBefore = fs.statSync(file);

    // Commit another version of a.txt without touching the working file.
    const other = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: `${lines(5, 'a')}committed\n`, encoding: 'utf8' }).trim();
    git(dir, 'update-index', '--cacheinfo', `100644,${other},a.txt`);
    git(dir, 'commit', '-q', '-m', 'move a.txt in HEAD only');
    expect(fs.statSync(file).mtimeMs).toBe(statBefore.mtimeMs);
    const headMoved = await stateOf(dir);
    expect(headMoved.head.oid).not.toBe(first.head.oid);
    expect(tokenOf(headMoved, 'a.txt')).not.toBe(tokenOf(first, 'a.txt'));

    // An unrelated commit moves HEAD but not a.txt's blob.
    write(path.join(dir, 'unrelated.txt'), 'u\n');
    git(dir, 'add', 'unrelated.txt');
    git(dir, 'commit', '-q', '-m', 'unrelated');
    const unrelated = await stateOf(dir);
    expect(unrelated.head.oid).not.toBe(headMoved.head.oid);
    expect(tokenOf(unrelated, 'a.txt')).toBe(tokenOf(headMoved, 'a.txt'));
  });

  it('changes for a rename, uncommitted and committed', async () => {
    const dir = newWorktree();
    fs.appendFileSync(path.join(dir, 'b.txt'), 'edited\n');
    settle(path.join(dir, 'b.txt'));
    const edited = await stateOf(dir);
    git(dir, 'mv', 'b.txt', 'renamed.txt');
    const renamed = await stateOf(dir);
    expect(withoutTokens(renamed.uncommitted)).toEqual([expect.objectContaining({ status: 'R', path: 'renamed.txt' })]);
    expect(tokenOf(renamed, 'renamed.txt')).not.toBe(tokenOf(edited, 'b.txt'));

    commitAll(dir, 'rename');
    const committed = await stateOf(dir);
    const token = tokenOf(committed, 'renamed.txt', 'committed');
    expect(committed.committed.find((entry) => entry.path === 'renamed.txt')?.status).toBe('R');
    fs.appendFileSync(path.join(dir, 'renamed.txt'), 'second commit\n');
    commitAll(dir, 'edit the renamed file');
    const recommitted = await stateOf(dir);
    expect(tokenOf(recommitted, 'renamed.txt', 'committed')).not.toBe(token);
  });

  it('changes for a deletion, and not when the deletion is staged', async () => {
    const dir = newWorktree();
    const file = path.join(dir, 'a.txt');
    fs.appendFileSync(file, 'edited\n');
    settle(file);
    const edited = await stateOf(dir);
    fs.rmSync(file);
    const deleted = await freshState(dir, edited);
    expect(deleted.uncommitted.find((entry) => entry.path === 'a.txt')?.status).toBe('D');
    expect(tokenOf(deleted, 'a.txt')).not.toBe(tokenOf(edited, 'a.txt'));
    git(dir, 'rm', '-q', '--cached', 'a.txt');
    const staged = await stateOf(dir);
    // HEAD's a.txt is deleted either way: the same diff, the same token.
    expect(tokenOf(staged, 'a.txt')).toBe(tokenOf(deleted, 'a.txt'));
  });

  it('versions an untracked file by its stat data', async () => {
    const dir = newWorktree();
    const file = path.join(dir, 'new.txt');
    write(file, 'new\n');
    settle(file);
    const created = await stateOf(dir);
    expect(created.uncommitted).toEqual([{ status: 'A', path: 'new.txt', token: expect.any(String) }]);
    fs.appendFileSync(file, 'more\n');
    settle(file);
    const edited = await freshState(dir, created);
    expect(tokenOf(edited, 'new.txt')).not.toBe(tokenOf(created, 'new.txt'));
    git(dir, 'add', 'new.txt');
    const added = await stateOf(dir);
    expect(tokenOf(added, 'new.txt')).not.toBe(tokenOf(edited, 'new.txt'));
  });

  it('keeps settled tokens across placements and states: they carry no epoch', async () => {
    const dir = newWorktree();
    fs.appendFileSync(path.join(dir, 'a.txt'), 'x\n');
    settle(path.join(dir, 'a.txt'));
    const state = await stateOf(dir);
    const service = new WorkspaceGitStateService({ run: runOwnedCommandInProcess });
    try {
      const other = (await service.get(input(dir))).snapshot;
      expect(other.epoch).not.toBe(state.epoch);
      expect(other.uncommitted).toEqual(state.uncommitted);
      expect(other.committed).toEqual(state.committed);
    } finally { service.dispose(); }
  });
});

describe('line-count reuse through the facade', () => {
  it('recomputes a worktree with settled uncommitted changes with git status alone', async () => {
    const dir = newWorktree();
    fs.appendFileSync(path.join(dir, 'a.txt'), 'edit\n');
    write(path.join(dir, 'new.txt'), 'untracked\n');
    settle(path.join(dir, 'a.txt'));
    settle(path.join(dir, 'new.txt'));
    const first = await measured(() => stateOf(dir));
    // status and the uncommitted counts at least (the branch comparison may come from its cache).
    expect(first.gitProcesses).toBeGreaterThanOrEqual(2);
    const again = await measured(() => freshState(dir, first.value));
    expect(again.gitProcesses).toBe(1);
    expect(again.value.uncommitted).toEqual(first.value.uncommitted);
    expect(again.value.version).toBe(first.value.version);

    // A changed file is counted again; the unchanged ones are not.
    fs.appendFileSync(path.join(dir, 'b.txt'), 'second edit\n');
    settle(path.join(dir, 'b.txt'));
    const changed = await measured(() => freshState(dir, again.value));
    expect(changed.gitProcesses).toBe(2);
    expect(withoutTokens(changed.value.uncommitted)).toEqual([
      { status: 'M', path: 'a.txt', additions: 1, deletions: 0 },
      { status: 'M', path: 'b.txt', additions: 1, deletions: 0 },
      { status: 'A', path: 'new.txt' },
    ]);
    expect(tokenOf(changed.value, 'a.txt')).toBe(tokenOf(first.value, 'a.txt'));
  });
});

describe('file diffs through the facade', () => {
  it('shows a staged-only change as HEAD against the working tree', async () => {
    const dir = newWorktree();
    write(path.join(dir, 'a.txt'), lines(5, 'a').replace('a line 3', 'a line three'));
    git(dir, 'add', 'a.txt');
    // Today's comparison, the index against the working tree, shows nothing.
    expect(git(dir, 'diff', '--', 'a.txt')).toBe('');
    const state = await stateOf(dir);
    expect(withoutTokens(state.uncommitted)).toEqual([{ status: 'M', path: 'a.txt', additions: 1, deletions: 1 }]);
    const diff = await diffOf(dir, 'a.txt');
    expect(diff).toMatchObject({ kind: 'text', token: tokenOf(state, 'a.txt') });
    const text = (diff as Extract<GitFileDiff, { kind: 'text' }>).diff;
    expect(text).toContain('diff --git a/a.txt b/a.txt');
    expect(text).toContain('-a line 3\n+a line three');
    expect(text).not.toContain('new file mode');
  });

  it('shows an untracked file whole, a committed file against the base, and nothing for an unlisted path', async () => {
    const dir = newWorktree();
    write(path.join(dir, 'new.txt'), 'n1\nn2\n');
    const state = await stateOf(dir);
    const untracked = await diffOf(dir, 'new.txt');
    expect(untracked).toMatchObject({ kind: 'text', token: tokenOf(state, 'new.txt') });
    expect((untracked as { diff: string }).diff).toContain('new file mode');
    expect((untracked as { diff: string }).diff).toContain('+n1\n+n2');

    const committed = await diffOf(dir, 'topic.txt', 'committed');
    expect(committed).toMatchObject({ kind: 'text', token: tokenOf(state, 'topic.txt', 'committed') });
    expect((committed as { diff: string }).diff).toContain('+topic');

    const unlisted = await measured(() => diffOf(dir, 'b.txt'));
    expect(unlisted.value).toMatchObject({ kind: 'text', diff: '' });
    expect(unlisted.diffComputations).toBe(0);
  });

  it('answers a cache hit without a process, sees a changed file through a fresh lstat, and drops the cache with the registration', async () => {
    const dir = newWorktree();
    const file = path.join(dir, 'a.txt');
    fs.appendFileSync(file, 'edit\n');
    settle(file);
    const registered = await registerWorkspaceGitState(input(dir));
    try {
      const first = await measured(() => diffOf(dir, 'a.txt'));
      expect(first).toMatchObject({ gitProcesses: 1, diffRequests: 1, diffComputations: 1, diffCacheAnswers: 0 });
      expect(first.value).toMatchObject({ kind: 'text', token: tokenOf(registered, 'a.txt') });

      const hit = await measured(() => diffOf(dir, 'a.txt'));
      expect(hit).toMatchObject({ gitProcesses: 0, diffRequests: 1, diffComputations: 0, diffCacheAnswers: 1 });
      expect(hit.value).toEqual(first.value);

      // Nothing refreshed the registered state; the fresh lstat sees the edit anyway.
      fs.appendFileSync(file, 'more\n');
      settle(file);
      const changed = await measured(() => diffOf(dir, 'a.txt'));
      expect(changed).toMatchObject({ gitProcesses: 1, diffComputations: 1, diffCacheAnswers: 0 });
      expect(changed.value.token).not.toBe(first.value.token);
      expect((changed.value as { diff: string }).diff).toContain('+more');
    } finally {
      unregisterWorkspaceGitState(dir);
    }
    // The registration took its cached diffs along.
    const after = await measured(() => diffOf(dir, 'a.txt'));
    expect(after).toMatchObject({ diffComputations: 1, diffCacheAnswers: 0 });
  });

  it('does not keep an answer above 1 MiB', async () => {
    const dir = newWorktree();
    write(path.join(dir, 'large-new.txt'), largeText('large', 1_300_000));
    settle(path.join(dir, 'large-new.txt'));
    await stateOf(dir);
    const first = await measured(() => diffOf(dir, 'large-new.txt', 'uncommitted', { force: true }));
    expect(first.value.kind).toBe('text');
    expect(Buffer.byteLength((first.value as { diff: string }).diff)).toBeGreaterThan(1024 * 1024);
    const second = await measured(() => diffOf(dir, 'large-new.txt', 'uncommitted', { force: true }));
    expect(second).toMatchObject({ diffComputations: 1, diffCacheAnswers: 0 });
    expect(second.gitProcesses).toBeGreaterThanOrEqual(1);
  });

  it('guards sizes: 1 MiB by default, binary files, force up to 8 MiB, refusal above it', async () => {
    const dir = newWorktree();
    write(path.join(dir, 'small.txt'), largeText('grown', 1_600_000));
    write(path.join(dir, 'bin.dat'), Buffer.from([0, 9, 8, 7, 0, 1]));
    write(path.join(dir, 'huge.txt'), largeText('huge', GIT_FILE_DIFF_FORCED_LIMIT_BYTES + 200_000));
    write(path.join(dir, 'shrinks.txt'), 'shrunk\n');
    for (const name of ['small.txt', 'bin.dat', 'huge.txt', 'shrinks.txt']) settle(path.join(dir, name));
    const smallSize = fs.statSync(path.join(repo, 'small.txt')).size;
    const shrinksSize = fs.statSync(path.join(repo, 'shrinks.txt')).size;
    await registerWorkspaceGitState(input(dir));
    try {
      // A working file above the limit never reaches git diff: one size probe of HEAD's blob.
      const grown = await measured(() => diffOf(dir, 'small.txt'));
      expect(grown.value).toMatchObject({
        kind: 'too_large', oldSize: smallSize, newSize: fs.statSync(path.join(dir, 'small.txt')).size,
        limit: GIT_FILE_DIFF_LIMIT_BYTES, canForce: true,
      });
      expect(grown.gitProcesses).toBe(1);
      const forced = await measured(() => diffOf(dir, 'small.txt', 'uncommitted', { force: true }));
      expect(forced.value.kind).toBe('text');
      expect((forced.value as { diff: string }).diff).toContain('+grown ');
      expect(forced.gitProcesses).toBe(1);

      const binary = await measured(() => diffOf(dir, 'bin.dat'));
      expect(binary.value).toMatchObject({ kind: 'binary', oldSize: 8, newSize: 6 });
      expect(binary.gitProcesses).toBe(1);

      // A large HEAD blob: git reports it as binary without reading it; --stat carries the sizes.
      const shrunk = await measured(() => diffOf(dir, 'shrinks.txt'));
      expect(shrunk.value).toMatchObject({ kind: 'too_large', oldSize: shrinksSize, newSize: 7, canForce: true });
      expect(shrunk.gitProcesses).toBe(1);

      const huge = await measured(() => diffOf(dir, 'huge.txt'));
      expect(huge.value).toMatchObject({ kind: 'too_large', oldSize: null, limit: GIT_FILE_DIFF_LIMIT_BYTES, canForce: false });
      expect(huge.gitProcesses).toBe(0);
      const hugeForced = await measured(() => diffOf(dir, 'huge.txt', 'uncommitted', { force: true }));
      expect(hugeForced.value).toMatchObject({ kind: 'too_large', limit: GIT_FILE_DIFF_FORCED_LIMIT_BYTES, canForce: false });
      expect(hugeForced.gitProcesses).toBe(0);
    } finally {
      unregisterWorkspaceGitState(dir);
    }
  });
});

describe('cancellation through the facade', () => {
  it('stops the git process of the only request and leaves no process behind', async () => {
    const dir = newWorktree();
    fs.writeFileSync(slowTicks, '600');
    fs.writeFileSync(slowPids, '');
    fs.appendFileSync(path.join(dir, 'slow.txt'), 'slow edit\n');
    await stateOf(dir);
    const controller = new AbortController();
    const pending = diffOf(dir, 'slow.txt', 'uncommitted', { signal: controller.signal });
    pending.catch(() => undefined);
    await vi.waitFor(() => expect(slowPidList().length).toBeGreaterThan(0), { timeout: 15_000 });
    const started = Date.now();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ABORT_ERR' });
    await vi.waitFor(() => {
      expect(slowPidList().filter(alive)).toEqual([]);
      expect(slowProcesses()).toEqual([]);
    }, { timeout: 15_000 });
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 60_000);

  it('keeps a shared computation running while another request still waits for it', async () => {
    const dir = newWorktree();
    fs.writeFileSync(slowTicks, '15');
    fs.writeFileSync(slowPids, '');
    fs.appendFileSync(path.join(dir, 'slow.txt'), 'shared edit\n');
    await registerWorkspaceGitState(input(dir));
    try {
      const before = readRuntimeCounters();
      const leaving = new AbortController();
      const first = diffOf(dir, 'slow.txt', 'uncommitted', { signal: leaving.signal });
      first.catch(() => undefined);
      const second = diffOf(dir, 'slow.txt');
      await vi.waitFor(() => expect(slowPidList().length).toBeGreaterThan(0), { timeout: 15_000 });
      leaving.abort();
      await expect(first).rejects.toMatchObject({ code: 'ABORT_ERR' });
      expect(slowPidList().some(alive)).toBe(true);
      const answer = await second;
      expect(answer.kind).toBe('text');
      expect((answer as { diff: string }).diff).toContain('+shared edit');
      expect(delta(before, readRuntimeCounters())).toMatchObject({ diffRequests: 2, diffComputations: 1 });
    } finally {
      unregisterWorkspaceGitState(dir);
    }
  }, 60_000);
});

describe('file diffs in the service', () => {
  function recordingRunner() {
    const commands: string[][] = [];
    const run: GitCommandRunner = (command, args, options) => {
      commands.push(args);
      return runOwnedCommandInProcess(command, args, options);
    };
    return { commands, run };
  }

  it('evicts the least recently used answers beyond the byte limit', async () => {
    const dir = newWorktree();
    for (const name of ['a.txt', 'b.txt', 'small.txt']) {
      fs.appendFileSync(path.join(dir, name), `${'x'.repeat(1_000)}\n`);
      settle(path.join(dir, name));
    }
    // About 1.5 KB per answer (text, key and bookkeeping): room for two, not three.
    const service = new WorkspaceGitStateService({ run: runOwnedCommandInProcess, diffCacheLimitBytes: 4_000 });
    const request = (file: string) => service.diff({ ...input(dir), path: file, kind: 'uncommitted' });
    try {
      await service.register(input(dir));
      expect((await request('a.txt')).source).toBe('computation');
      expect((await request('b.txt')).source).toBe('computation');
      expect(service.diffCacheSize).toBe(2);
      expect(service.diffCacheBytes).toBeGreaterThan(2_700);
      expect((await request('a.txt')).source).toBe('cache');
      // a.txt was used last: b.txt is the least recently used and leaves.
      expect((await request('small.txt')).source).toBe('computation');
      expect(service.diffCacheBytes).toBeLessThanOrEqual(4_000);
      expect((await request('a.txt')).source).toBe('cache');
      expect((await request('b.txt')).source).toBe('computation');
    } finally { service.dispose(); }
  });

  it('runs no git diff for a working file above the limit, and one diff otherwise', async () => {
    const dir = newWorktree();
    write(path.join(dir, 'small.txt'), largeText('grown', 1_600_000));
    fs.appendFileSync(path.join(dir, 'a.txt'), 'edit\n');
    settle(path.join(dir, 'small.txt'));
    settle(path.join(dir, 'a.txt'));
    const runner = recordingRunner();
    const service = new WorkspaceGitStateService({ run: runner.run });
    try {
      await service.register(input(dir));
      runner.commands.length = 0;
      const large = await service.diff({ ...input(dir), path: 'small.txt', kind: 'uncommitted' });
      expect(large.diff).toMatchObject({ kind: 'too_large' });
      expect(runner.commands.map((args) => args.find((arg) => ['diff', 'cat-file'].includes(arg)))).toEqual(['cat-file']);
      runner.commands.length = 0;
      await service.diff({ ...input(dir), path: 'a.txt', kind: 'uncommitted' });
      expect(runner.commands).toHaveLength(1);
      expect(runner.commands[0]).toEqual(expect.arrayContaining([`core.bigFileThreshold=${GIT_FILE_DIFF_LIMIT_BYTES}`, 'diff', 'HEAD', '--', ':(top,literal)a.txt']));
    } finally { service.dispose(); }
  });

  it('does not keep the answer for a file inside the racy window', async () => {
    const dir = newWorktree();
    fs.appendFileSync(path.join(dir, 'a.txt'), 'fresh edit\n');
    const service = new WorkspaceGitStateService({ run: runOwnedCommandInProcess });
    try {
      await service.register(input(dir));
      const request = () => service.diff({ ...input(dir), path: 'a.txt', kind: 'uncommitted' });
      expect((await request()).source).toBe('computation');
      expect((await request()).source).toBe('computation');
      expect(service.diffCacheSize).toBe(0);
    } finally { service.dispose(); }
  });

  it('gives a racy file the state version in its token until it has settled', async () => {
    const dir = newWorktree();
    let shift = 0;
    const service = new WorkspaceGitStateService({ run: runOwnedCommandInProcess, freshnessMs: 0, now: () => Date.now() + shift });
    const get = async () => (await service.get(input(dir))).snapshot;
    try {
      fs.appendFileSync(path.join(dir, 'a.txt'), 'racy edit\n');
      const first = await get();
      // Nothing changed: no new version, the same racy token.
      const unchanged = await get();
      expect(unchanged.version).toBe(first.version);
      expect(tokenOf(unchanged, 'a.txt')).toBe(tokenOf(first, 'a.txt'));
      // Another file makes a new state; the racy file's token moves with it although its stat did not.
      write(path.join(dir, 'other.txt'), 'other\n');
      const next = await get();
      expect(next.version).toBe(first.version + 1);
      expect(tokenOf(next, 'a.txt')).not.toBe(tokenOf(first, 'a.txt'));
      // Ten seconds later the file has settled: a last new token, then it stays.
      shift = 10_000;
      const settled = await get();
      expect(settled.version).toBe(next.version + 1);
      expect(tokenOf(settled, 'a.txt')).not.toBe(tokenOf(next, 'a.txt'));
      write(path.join(dir, 'third.txt'), 'third\n');
      settle(path.join(dir, 'third.txt'));
      const later = await get();
      expect(later.version).toBe(settled.version + 1);
      expect(tokenOf(later, 'a.txt')).toBe(tokenOf(settled, 'a.txt'));
    } finally { service.dispose(); }
  });
});
