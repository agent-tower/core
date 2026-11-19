import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runOwnedCommandInProcess } from '../../../utils/owned-child-process.js';
import type { GitCommandRunner } from '../git-state-compute.js';
import { WorkspaceGitStateService, type GitStateServiceOptions } from '../git-state-service.js';
import type { GitStateRequest, GitStateSnapshot, GitStateTrigger } from '../git-state-types.js';
import { commitAll, git, initRepo, isolateGitConfiguration, keepRacy, settle, write } from './git-fixtures.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-git-registered-'));
isolateGitConfiguration(root);
const repo = path.join(root, 'repo');
let sequence = 0;
const services: WorkspaceGitStateService[] = [];
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function worktree(): GitStateRequest {
  const name = `registered-${++sequence}`;
  const worktreePath = path.join(root, name);
  git(repo, 'worktree', 'add', '-q', '-b', name, worktreePath, 'main');
  return { worktreePath, repositoryPath: repo, baseBranch: 'main' };
}

function service(options: Partial<GitStateServiceOptions> = {}) {
  const changes: GitStateSnapshot[] = [];
  const instance = new WorkspaceGitStateService({
    run: runOwnedCommandInProcess, safetyIntervalMs: 60_000,
    debounceMs: 30, minComputationIntervalMs: 80, log: () => undefined,
    onChange: (snapshot) => changes.push(snapshot), ...options,
  });
  services.push(instance);
  return { instance, changes };
}

beforeAll(() => {
  initRepo(repo);
  write(path.join(repo, 'tracked.txt'), 'base\n');
  write(path.join(repo, 'touched.txt'), 'unchanged\n');
  commitAll(repo, 'base');
});
afterEach(() => {
  for (const instance of services.splice(0)) {
    instance.dispose();
    expect(instance.registeredCount).toBe(0);
    expect(instance.watchCount).toBe(0);
  }
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('registered git state', () => {
  it('keeps the safety check after the first registration request loses its waiter', async () => {
    const input = worktree();
    const { instance, changes } = service({ safetyIntervalMs: 100 });
    const controller = new AbortController();
    const registration = instance.register(input, { signal: controller.signal });
    controller.abort();
    await expect(registration).rejects.toMatchObject({ code: 'ABORT_ERR' });
    expect(instance.registeredCount).toBe(1);
    await expect.poll(() => changes.map(snapshot => snapshot.available), { timeout: 3_000 }).toContain(true);
    expect(instance.readCounters().computationsSafety).toBeGreaterThan(0);
  });

  it('keeps clean registered state beyond the REST window, with no git process and no idle eviction', async () => {
    const input = worktree();
    const { instance } = service({ freshnessMs: 1, entryIdleMs: 1, maxEntries: 1 });
    const initial = await instance.register(input);
    expect(initial.snapshot.head.oid).toBe(git(input.worktreePath, 'rev-parse', 'HEAD'));
    expect(instance.registeredCount).toBe(1);
    expect(instance.watchCount).toBeGreaterThan(0);
    await pause(20);
    const before = instance.readCounters();
    expect((await instance.get(input)).snapshot).toEqual(initial.snapshot);
    expect(instance.readCounters().gitProcesses).toBe(before.gitProcesses);
    await instance.get(worktree());
    instance.sweep(Date.now() + 60_000);
    expect(instance.size).toBe(1);
    expect((await instance.get(input)).snapshot).toEqual(initial.snapshot);
    instance.unregister(input.worktreePath);
    expect(instance.watchCount).toBe(0);
    expect(instance.registeredCount).toBe(0);
    expect(instance.size).toBe(0);
  });

  it.each<GitStateTrigger>(['agent', 'terminal', 'service', 'operation', 'refresh'])('%s invalidation produces one changed notification, and none for unchanged content', async (trigger) => {
    const input = worktree();
    const { instance, changes } = service();
    await instance.register(input);
    changes.length = 0;
    write(path.join(input.worktreePath, `${trigger}.txt`), 'new\n');
    for (let i = 0; i < 5; i += 1) instance.invalidate(input.worktreePath, trigger);
    const result = await instance.get(input);
    expect(result.snapshot.untrackedCount).toBe(1);
    expect(changes).toHaveLength(1);
    const computed = instance.readCounters().computations;
    instance.invalidate(input.worktreePath, trigger);
    await instance.get(input);
    expect(changes).toHaveLength(1);
    expect(instance.readCounters().computations).toBe(computed + 1);
    await pause(120);
    expect(instance.readCounters().computations).toBe(computed + 1);
  });

  it('sees a plain external git commit through non-recursive git watches', async () => {
    const input = worktree();
    const { instance, changes } = service();
    await instance.register(input);
    changes.length = 0;
    write(path.join(input.worktreePath, 'committed.txt'), 'external\n');
    commitAll(input.worktreePath, 'external');
    await expect.poll(() => changes.length, { timeout: 3_000 }).toBe(1);
    expect(changes[0]!.head.oid).toBe(git(input.worktreePath, 'rev-parse', 'HEAD'));
    expect(instance.readCounters().computationsWatch).toBeGreaterThan(0);
  });

  it('refreshes both worktrees when their shared base ref moves', async () => {
    const first = worktree();
    const second = worktree();
    const { instance, changes } = service();
    await instance.register(first);
    await instance.register(second);
    changes.length = 0;
    write(path.join(repo, `base-${sequence}.txt`), 'base moved\n');
    commitAll(repo, 'base moved');
    await expect.poll(() => changes.length, { timeout: 3_000 }).toBe(2);
    expect(new Set(changes.map((state) => state.worktreePath))).toEqual(new Set([first.worktreePath, second.worktreePath]));
    expect(changes.every((state) => state.behind === 1)).toBe(true);
    await pause(160);
    expect(changes).toHaveLength(2);
  });

  it('uses the safety computation for ref-only changes when watches are unavailable, logging each failure once', async () => {
    const input = worktree();
    git(input.worktreePath, 'commit', '-q', '--allow-empty', '-m', 'empty');
    const messages: string[] = [];
    const { instance, changes } = service({
      safetyIntervalMs: 200,
      watch: () => { throw new Error('watch unavailable'); },
      log: (message) => messages.push(message),
    });
    await instance.register(input);
    const warnings = messages.length;
    expect(warnings).toBeGreaterThan(0);
    changes.length = 0;
    git(input.worktreePath, 'update-ref', `refs/heads/${path.basename(input.worktreePath)}`, git(input.worktreePath, 'rev-parse', 'HEAD~1'));
    await expect.poll(() => changes.length, { timeout: 3_000 }).toBe(1);
    expect(changes[0]!.head.oid).toBe(git(input.worktreePath, 'rev-parse', 'HEAD'));
    expect(instance.readCounters().computationsSafety).toBeGreaterThan(0);
    await pause(250);
    expect(messages).toHaveLength(warnings);
    expect(changes).toHaveLength(1);
  });

  // Step 4: a settled tracked edit keeps its line counts (its version token did
  // not change), so only `git status` runs. A racy one is counted again each time.
  it.each([
    { edit: 'none', processes: 1 },
    { edit: 'settled', processes: 1 },
    { edit: 'racy', processes: 2 },
  ])('starts $processes git process(es) per idle safety interval (tracked edit: $edit)', async ({ edit, processes }) => {
    const input = worktree();
    const tracked = path.join(input.worktreePath, 'tracked.txt');
    if (edit !== 'none') fs.appendFileSync(tracked, 'unchanged tracked edit\n');
    if (edit === 'settled') settle(tracked);
    if (edit === 'racy') keepRacy(tracked);
    const { instance, changes } = service({ safetyIntervalMs: 250 });
    await instance.register(input);
    changes.length = 0;
    const before = instance.readCounters();
    await expect.poll(() => instance.readCounters().computationsSafety, { timeout: 2_000, interval: 10 }).toBe(2);
    await instance.get(input);
    instance.unregister(input.worktreePath);
    const after = instance.readCounters();
    expect(after.computations - before.computations).toBe(2);
    expect(after.gitProcesses - before.gitProcesses).toBe(2 * processes);
    expect(changes).toHaveLength(0);
  });

  it('does not start another computation from its own index refresh after an mtime-only touch', async () => {
    const input = worktree();
    const { instance, changes } = service();
    // Keep a tracked edit so each computation also runs diff: diff can
    // refresh the other file's index stat even with GIT_OPTIONAL_LOCKS=0.
    // The edit stays racy, so its line counts are never reused.
    fs.appendFileSync(path.join(input.worktreePath, 'tracked.txt'), 'edit\n');
    keepRacy(path.join(input.worktreePath, 'tracked.txt'));
    await instance.register(input);
    changes.length = 0;
    const future = new Date(Date.now() + 2_000);
    fs.utimesSync(path.join(input.worktreePath, 'touched.txt'), future, future);
    const processes = instance.readCounters().gitProcesses;
    instance.invalidate(input.worktreePath, 'refresh');
    await instance.get(input);
    expect(instance.readCounters().gitProcesses - processes).toBe(2);
    const computed = instance.readCounters().computations;
    await pause(400);
    expect(instance.readCounters().computations).toBe(computed);
    expect(changes).toHaveLength(0);
  });

  it('coalesces invalidations during one computation into exactly one later computation', async () => {
    const input = worktree();
    let hold = false;
    let release: (() => void) | undefined;
    const run: GitCommandRunner = async (...args) => {
      const result = await runOwnedCommandInProcess(...args);
      if (hold && args[1].includes('status')) {
        hold = false;
        await new Promise<void>((resolve) => { release = resolve; });
      }
      return result;
    };
    const { instance } = service({ run });
    await instance.register(input);
    const before = instance.readCounters().computations;
    hold = true;
    write(path.join(input.worktreePath, 'during.txt'), 'first\n');
    instance.invalidate(input.worktreePath, 'agent');
    await expect.poll(() => !!release, { timeout: 3_000 }).toBe(true);
    for (let i = 0; i < 20; i += 1) instance.invalidate(input.worktreePath, 'agent');
    release!();
    await expect.poll(() => instance.readCounters().computations, { timeout: 2_000 }).toBe(before + 2);
    await instance.get(input);
    await pause(180);
    expect(instance.readCounters().computations).toBe(before + 2);
  });

  it('recomputes after an external commit moves HEAD while a status result is in flight', async () => {
    const input = worktree();
    let hold = false;
    let release: (() => void) | undefined;
    const { instance, changes } = service({ run: async (...args) => {
      const result = await runOwnedCommandInProcess(...args);
      if (hold && args[1].includes('status')) {
        hold = false;
        await new Promise<void>((resolve) => { release = resolve; });
      }
      return result;
    } });
    await instance.register(input);
    changes.length = 0;
    const before = instance.readCounters().computations;
    hold = true;
    instance.invalidate(input.worktreePath, 'refresh');
    try {
      await expect.poll(() => !!release, { timeout: 3_000 }).toBe(true);
      git(input.worktreePath, 'commit', '-q', '--allow-empty', '-m', 'commit during status');
      const head = git(input.worktreePath, 'rev-parse', 'HEAD');
      release!();
      await expect.poll(() => changes.length, { timeout: 2_000 }).toBe(1);
      expect(changes[0]!.head.oid).toBe(head);
      await instance.get(input);
      await pause(160);
      expect(instance.readCounters().computations).toBe(before + 2);
      expect(changes).toHaveLength(1);
    } finally {
      release?.();
    }
  });

  it('retains pending REST ownership when the registration leaves and closes every watch', async () => {
    const input = worktree();
    const { instance } = service();
    await instance.register(input);
    write(path.join(input.worktreePath, 'pending.txt'), 'pending\n');
    instance.invalidate(input.worktreePath, 'refresh');
    const reading = instance.get(input);
    instance.unregister(input.worktreePath);
    expect(instance.watchCount).toBe(0);
    expect((await reading).snapshot.untrackedCount).toBe(1);
  });

  it('registers a recreated path without joining an aborted former registration', async () => {
    const input = worktree();
    let hold = true;
    let release: (() => void) | undefined;
    const { instance } = service({ run: async (...args) => {
      const result = await runOwnedCommandInProcess(...args);
      if (hold && args[1].includes('status')) {
        hold = false;
        await new Promise<void>((resolve) => { release = resolve; });
      }
      return result;
    } });
    const controller = new AbortController();
    const previous = instance.register(input, { signal: controller.signal });
    try {
      await expect.poll(() => !!release, { timeout: 3_000 }).toBe(true);
      controller.abort();
      await expect(previous).rejects.toMatchObject({ code: 'ABORT_ERR' });
      instance.unregister(input.worktreePath);
      write(path.join(input.worktreePath, 'recreated.txt'), 'new identity\n');
      let current: GitStateSnapshot | undefined;
      const registration = instance.register(input).then((result) => { current = result.snapshot; });
      await expect.poll(() => current?.untrackedCount, { timeout: 2_000 }).toBe(1);
      await registration;
      expect(instance.registeredCount).toBe(1);
    } finally {
      release?.();
    }
  });

  it('lets an old REST read finish without replacing a recreated registration', async () => {
    const input = worktree();
    let hold = false;
    let release: (() => void) | undefined;
    const { instance, changes } = service({ run: async (...args) => {
      const result = await runOwnedCommandInProcess(...args);
      if (hold && args[1].includes('status')) {
        hold = false;
        await new Promise<void>((resolve) => { release = resolve; });
      }
      return result;
    } });
    await instance.register(input);
    hold = true;
    instance.invalidate(input.worktreePath, 'refresh');
    await expect.poll(() => !!release, { timeout: 3_000 }).toBe(true);
    const previous = instance.get(input);
    try {
      instance.unregister(input.worktreePath);
      changes.length = 0;
      write(path.join(input.worktreePath, 'new-generation.txt'), 'new\n');
      const current = await instance.register(input);
      expect(current.snapshot.untrackedCount).toBe(1);
      release!();
      expect((await previous).snapshot.untrackedCount).toBe(0);
      expect((await instance.get(input)).snapshot).toEqual(current.snapshot);
      expect(changes).toHaveLength(1);
      expect(changes[0]!.untrackedCount).toBe(1);
    } finally {
      release?.();
    }
  });

  it('applies a trailing debounce and a one-second minimum interval', async () => {
    const input = worktree();
    const starts: number[] = [];
    const { instance } = service({
      debounceMs: 100, minComputationIntervalMs: 1_000,
      run: async (...args) => {
        if (args[1].includes('status')) starts.push(Date.now());
        return runOwnedCommandInProcess(...args);
      },
    });
    await instance.register(input);
    instance.invalidate(input.worktreePath, 'refresh');
    await pause(150);
    instance.invalidate(input.worktreePath, 'refresh');
    await instance.get(input);
    expect(starts).toHaveLength(2);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(950);
  });
});
