/**
 * Fixture repositories for the git state tests: one scenario per case the
 * differential test compares between today's implementation and the git
 * state service. Built synchronously with the git CLI, outside the code
 * under test.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Makes git independent of the host's configuration, for fixtures and for the
 * code under test alike (both inherit the test process's environment).
 */
export function isolateGitConfiguration(root: string): void {
  const globalConfig = path.join(root, 'global.gitconfig');
  fs.writeFileSync(globalConfig, '');
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  // Tests may keep their temporary files inside the source worktree. A
  // deliberately non-repository fixture must not discover that ancestor.
  process.env.GIT_CEILING_DIRECTORIES = root;
  delete process.env.GIT_DIR;
  delete process.env.GIT_WORK_TREE;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** For merges and rebases that stop on a conflict. */
export function gitMayFail(cwd: string, ...args: string[]): void {
  try {
    execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    // The conflict is the point.
  }
}

export function write(file: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

export function lines(count: number, prefix: string): string {
  return Array.from({ length: count }, (_, index) => `${prefix} line ${index + 1}\n`).join('');
}

/** Text above the 1 MiB limit. */
export function largeText(prefix: string, bytes = 1_600_000): string {
  const line = `${prefix} ${'x'.repeat(70)}\n`;
  return line.repeat(Math.ceil(bytes / line.length));
}

export function initRepo(dir: string, branch = 'main'): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', branch);
  git(dir, 'config', 'user.name', 'Git State Fixture');
  git(dir, 'config', 'user.email', 'git-state@example.test');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

export function commitAll(dir: string, message: string): void {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
}

/**
 * Moves a file's modification time 10 s into the past, out of the racy
 * window of the version tokens (git/state/git-file-versions.ts): its token
 * then no longer carries the state's version.
 */
export function settle(file: string): void {
  const past = new Date(Date.now() - 10_000);
  fs.utimesSync(file, past, past);
}

/** Moves a file's modification time 60 s into the future: it stays inside the racy window for the whole test. */
export function keepRacy(file: string): void {
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(file, future, future);
}

/** Change entries without their version tokens, for comparisons of statuses, paths and counts. */
export function withoutTokens<T extends { token?: string }>(entries: T[]): Omit<T, 'token'>[] {
  return entries.map(({ token: _token, ...entry }) => entry);
}

export interface Scenario {
  name: string;
  /** `workingDir` of `GET /git/changes`. */
  workingDir: string;
  /** The workspace's worktree path (`GET /workspaces/:id/git-status`). */
  worktreePath: string;
  repoPath: string;
  baseBranch: string;
  /** Paths (unquoted) whose old or new side is above the size limit: they lose their line counts. */
  largePaths?: string[];
}

/** Builds every scenario below `root` (an empty directory). */
export function buildScenarios(root: string): Scenario[] {
  const scenarios: Scenario[] = [];
  const repo = path.join(root, 'repo');
  initRepo(repo);
  write(path.join(repo, 'a.txt'), lines(10, 'a'));
  write(path.join(repo, 'b.txt'), 'b\n');
  write(path.join(repo, 'c.txt'), lines(5, 'c'));
  write(path.join(repo, 'dir', 'd.txt'), 'd\n');
  write(path.join(repo, 'del-staged.txt'), 'x\n');
  write(path.join(repo, 'del-unstaged.txt'), 'y\n');
  write(path.join(repo, 'ren-src.txt'), lines(100, 'r'));
  write(path.join(repo, 'ren-edit.txt'), lines(100, 'e'));
  write(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255, 254, 0]));
  write(path.join(repo, 'link-target.txt'), 'target\n');
  write(path.join(repo, 'typechange.txt'), 'plain\n');
  write(path.join(repo, 'big-old.txt'), largeText('old'));
  write(path.join(repo, 'shrinks.txt'), largeText('shrinks'));
  write(path.join(repo, '.gitignore'), 'ignored/\n*.log\n');
  commitAll(repo, 'base');
  const baseCommit = git(repo, 'rev-parse', 'HEAD');

  // develop: two commits ahead of main.
  git(repo, 'branch', 'develop');
  const developWorktree = path.join(root, 'develop-wt');
  git(repo, 'worktree', 'add', '-q', developWorktree, 'develop');
  write(path.join(developWorktree, 'develop-1.txt'), 'one\n');
  commitAll(developWorktree, 'develop 1');
  write(path.join(developWorktree, 'b.txt'), 'b from develop\n');
  commitAll(developWorktree, 'develop 2');

  const worktree = (name: string, options: { from?: string; detach?: boolean; feature?: boolean } = {}): string => {
    const dir = path.join(root, 'wt', name);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    if (options.detach) git(repo, 'worktree', 'add', '-q', '--detach', dir, options.from ?? 'main');
    else git(repo, 'worktree', 'add', '-q', '-b', `sc/${name}`, dir, options.from ?? 'main');
    if (options.feature !== false) {
      write(path.join(dir, 'c.txt'), `${lines(5, 'c')}feature\n`);
      write(path.join(dir, 'feature.txt'), 'feature\n');
      commitAll(dir, `feature ${name}`);
    }
    return dir;
  };
  const add = (name: string, dir: string, extra: Partial<Scenario> = {}) => {
    scenarios.push({ name, workingDir: dir, worktreePath: dir, repoPath: repo, baseBranch: 'main', ...extra });
  };

  add('clean', worktree('clean'));

  {
    const dir = worktree('modified');
    fs.appendFileSync(path.join(dir, 'a.txt'), 'modified\n');
    add('modified', dir);
  }
  {
    const dir = worktree('staged');
    fs.appendFileSync(path.join(dir, 'a.txt'), 'staged\n');
    git(dir, 'add', 'a.txt');
    add('staged', dir);
  }
  {
    const dir = worktree('staged-and-modified');
    fs.appendFileSync(path.join(dir, 'a.txt'), 'staged\n');
    git(dir, 'add', 'a.txt');
    fs.appendFileSync(path.join(dir, 'a.txt'), 'modified again\n');
    add('staged and modified again', dir);
  }
  {
    const dir = worktree('new-staged');
    write(path.join(dir, 'new.txt'), lines(3, 'new'));
    git(dir, 'add', 'new.txt');
    add('new staged file', dir);
  }
  {
    const dir = worktree('untracked');
    write(path.join(dir, 'untracked.txt'), 'u\n');
    write(path.join(dir, 'newdir', 'x.txt'), 'x\n');
    write(path.join(dir, 'newdir', 'sub', 'y.txt'), 'y\n');
    write(path.join(dir, 'ignored', 'z.txt'), 'ignored\n');
    write(path.join(dir, 'debug.log'), 'ignored\n');
    add('untracked files and an untracked folder', dir);
  }
  {
    const dir = worktree('deleted');
    git(dir, 'rm', '-q', 'del-staged.txt');
    fs.rmSync(path.join(dir, 'del-unstaged.txt'));
    add('deleted, staged and unstaged', dir);
  }
  {
    const dir = worktree('renamed');
    git(dir, 'mv', 'ren-src.txt', 'ren-dst.txt');
    git(dir, 'mv', 'ren-edit.txt', 'ren-edited.txt');
    fs.appendFileSync(path.join(dir, 'ren-edited.txt'), 'small edit\n');
    git(dir, 'add', 'ren-edited.txt');
    add('renamed, staged, with and without edits', dir);
  }
  {
    const dir = worktree('renamed-then-edited');
    git(dir, 'mv', 'ren-edit.txt', 'ren-moved.txt');
    fs.appendFileSync(path.join(dir, 'ren-moved.txt'), 'unstaged edit\n');
    add('renamed (staged), then edited (unstaged)', dir);
  }
  {
    const dir = worktree('renamed-rewritten');
    git(dir, 'mv', 'ren-edit.txt', 'ren-rewritten.txt');
    write(path.join(dir, 'ren-rewritten.txt'), lines(100, 'completely different'));
    add('renamed (staged), then rewritten (unstaged)', dir);
  }
  {
    // A merge in progress with conflicts.
    git(repo, 'branch', 'merge-theirs', 'main');
    const theirs = path.join(root, 'merge-theirs-wt');
    git(repo, 'worktree', 'add', '-q', theirs, 'merge-theirs');
    write(path.join(theirs, 'a.txt'), `theirs\n${lines(9, 'a')}`);
    write(path.join(theirs, 'theirs.txt'), 'theirs\n');
    commitAll(theirs, 'theirs');
    const dir = worktree('merge');
    write(path.join(dir, 'a.txt'), `ours\n${lines(9, 'a')}`);
    commitAll(dir, 'ours');
    gitMayFail(dir, 'merge', 'merge-theirs');
    fs.appendFileSync(path.join(dir, 'b.txt'), 'unrelated edit\n');
    add('merge in progress with conflicts', dir);
  }
  {
    // A rebase in progress with conflicts.
    git(repo, 'branch', 'rebase-onto', 'main');
    const onto = path.join(root, 'rebase-onto-wt');
    git(repo, 'worktree', 'add', '-q', onto, 'rebase-onto');
    write(path.join(onto, 'a.txt'), `onto\n${lines(9, 'a')}`);
    commitAll(onto, 'onto');
    const dir = worktree('rebase');
    write(path.join(dir, 'a.txt'), `rebased\n${lines(9, 'a')}`);
    commitAll(dir, 'rebased');
    gitMayFail(dir, 'rebase', 'rebase-onto');
    add('rebase in progress with conflicts', dir, { baseBranch: 'rebase-onto' });
  }
  {
    const dir = worktree('detached', { detach: true, feature: false });
    fs.appendFileSync(path.join(dir, 'a.txt'), 'detached edit\n');
    add('detached HEAD', dir);
  }
  {
    const unborn = path.join(root, 'unborn');
    initRepo(unborn);
    write(path.join(unborn, 'staged.txt'), 'staged\n');
    write(path.join(unborn, 'staged-modified.txt'), 'first\n');
    git(unborn, 'add', 'staged.txt', 'staged-modified.txt');
    fs.appendFileSync(path.join(unborn, 'staged-modified.txt'), 'second\n');
    write(path.join(unborn, 'untracked.txt'), 'u\n');
    scenarios.push({ name: 'no commits yet', workingDir: unborn, worktreePath: unborn, repoPath: unborn, baseBranch: 'main' });
  }
  {
    // origin/<base> present, no local <base>.
    git(repo, 'update-ref', 'refs/remotes/origin/release', git(repo, 'rev-parse', 'develop'));
    const dir = worktree('remote-base');
    fs.appendFileSync(path.join(dir, 'a.txt'), 'edit\n');
    add('missing local base branch with origin/<base> present', dir, { baseBranch: 'release' });
  }
  add('no base branch at all', worktree('no-base'), { baseBranch: 'does-not-exist' });
  {
    const dir = worktree('binary');
    write(path.join(dir, 'bin.dat'), Buffer.from([0, 9, 9, 9, 0, 1]));
    commitAll(dir, 'binary change');
    write(path.join(dir, 'bin.dat'), Buffer.from([0, 7, 7, 0]));
    write(path.join(dir, 'new.bin'), Buffer.from([0, 0, 1]));
    git(dir, 'add', 'new.bin');
    add('binary files', dir);
  }
  {
    const dir = worktree('large');
    write(path.join(dir, 'big-new.txt'), largeText('committed'));
    fs.appendFileSync(path.join(dir, 'big-old.txt'), 'committed edit\n');
    commitAll(dir, 'large files');
    fs.appendFileSync(path.join(dir, 'big-new.txt'), 'uncommitted edit\n');
    fs.rmSync(path.join(dir, 'big-old.txt'));
    write(path.join(dir, 'shrinks.txt'), 'now small\n');
    write(path.join(dir, 'grows.txt'), largeText('grows'));
    git(dir, 'add', 'grows.txt');
    add('files above the size limit', dir, {
      largePaths: ['big-new.txt', 'big-old.txt', 'shrinks.txt', 'grows.txt'],
    });
  }
  {
    const dir = worktree('special');
    write(path.join(dir, 'with space.txt'), 'space\n');
    write(path.join(dir, 'ünïcödé.txt'), 'unicode\n');
    write(path.join(dir, '中文', '文件.txt'), 'chinese\n');
    commitAll(dir, 'special names');
    fs.appendFileSync(path.join(dir, 'with space.txt'), 'edit\n');
    write(path.join(dir, 'quote"d.txt'), 'quote\n');
    write(path.join(dir, 'tab\there.txt'), 'tab\n');
    write(path.join(dir, '中文', '新.txt'), 'new\n');
    add('paths with special characters', dir);
  }
  {
    const dir = worktree('typechange');
    fs.rmSync(path.join(dir, 'typechange.txt'));
    fs.symlinkSync('link-target.txt', path.join(dir, 'typechange.txt'));
    add('type change to a symlink', dir);
  }
  {
    const dir = worktree('added-deleted');
    write(path.join(dir, 'gone.txt'), 'gone\n');
    git(dir, 'add', 'gone.txt');
    fs.rmSync(path.join(dir, 'gone.txt'));
    add('added, then deleted from the working tree', dir);
  }
  {
    const dir = worktree('intent-to-add');
    write(path.join(dir, 'ita.txt'), lines(2, 'ita'));
    git(dir, 'add', '-N', 'ita.txt');
    add('intent to add', dir);
  }
  add('diverged from the base branch', worktree('diverged'), { baseBranch: 'develop' });
  {
    const emptyTree = git(repo, 'hash-object', '-t', 'tree', '/dev/null');
    git(repo, 'branch', 'orphan', git(repo, 'commit-tree', emptyTree, '-m', 'orphan'));
    add('base branch with unrelated history', worktree('unrelated'), { baseBranch: 'orphan' });
  }
  {
    // A tag with the base branch's name wins over the branch in git's lookup order.
    git(repo, 'branch', 'shadow', 'develop');
    git(repo, 'tag', 'shadow', baseCommit);
    add('base name shadowed by a tag', worktree('tag-shadow'), { baseBranch: 'shadow' });
  }
  {
    const dir = worktree('subdir');
    fs.appendFileSync(path.join(dir, 'dir', 'd.txt'), 'edit\n');
    write(path.join(dir, 'dir', 'inside.txt'), 'inside\n');
    write(path.join(dir, 'outside.txt'), 'outside\n');
    scenarios.push({
      name: 'workingDir is a subdirectory', workingDir: path.join(dir, 'dir'), worktreePath: dir, repoPath: repo, baseBranch: 'main',
    });
  }
  {
    const packed = path.join(root, 'packed');
    initRepo(packed);
    write(path.join(packed, 'p.txt'), 'p\n');
    commitAll(packed, 'packed base');
    const dir = path.join(root, 'packed-wt');
    git(packed, 'worktree', 'add', '-q', '-b', 'feature', dir, 'main');
    write(path.join(dir, 'p.txt'), 'p feature\n');
    commitAll(dir, 'packed feature');
    git(packed, 'pack-refs', '--all', '--prune');
    fs.appendFileSync(path.join(dir, 'p.txt'), 'edit\n');
    scenarios.push({ name: 'refs in packed-refs', workingDir: dir, worktreePath: dir, repoPath: packed, baseBranch: 'main' });
  }
  {
    // A rebase in a main worktree (not a linked one).
    const main = path.join(root, 'rebase-main');
    initRepo(main);
    write(path.join(main, 'a.txt'), 'base\n');
    commitAll(main, 'base');
    git(main, 'checkout', '-q', '-b', 'onto');
    write(path.join(main, 'a.txt'), 'onto\n');
    commitAll(main, 'onto');
    git(main, 'checkout', '-q', '-b', 'topic', 'main');
    write(path.join(main, 'a.txt'), 'topic\n');
    commitAll(main, 'topic');
    gitMayFail(main, 'rebase', 'onto');
    scenarios.push({
      name: 'rebase in progress in a main worktree', workingDir: main, worktreePath: main, repoPath: main, baseBranch: 'onto',
    });
  }
  {
    // The project directory itself, with changes (last: it edits the main worktree).
    fs.appendFileSync(path.join(repo, 'a.txt'), 'main worktree edit\n');
    write(path.join(repo, 'main-untracked.txt'), 'u\n');
    add('main worktree of the repository', repo);
  }
  {
    const plain = path.join(root, 'not-a-repository');
    fs.mkdirSync(plain);
    scenarios.push({ name: 'not a git repository', workingDir: plain, worktreePath: plain, repoPath: repo, baseBranch: 'main' });
  }
  return scenarios;
}
