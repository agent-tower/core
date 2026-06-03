import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorktreeManager } from './worktree.manager.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function initRepo(repoPath: string) {
  fs.mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init']);
  git(repoPath, ['checkout', '-B', 'main']);
  git(repoPath, ['config', 'user.email', 'test@example.com']);
  git(repoPath, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# test\n');
  git(repoPath, ['add', 'README.md']);
  git(repoPath, ['commit', '-m', 'initial commit']);
}

describe('WorktreeManager.remove', () => {
  let tempDir: string;
  let repoPath: string;
  let manager: WorktreeManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-worktree-manager-'));
    repoPath = path.join(tempDir, 'repo');
    initRepo(repoPath);
    manager = new WorktreeManager(repoPath);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('removes a registered worktree using git worktree registry state', async () => {
    const worktreePath = await manager.create('at/12345678');

    const result = await manager.remove(worktreePath);

    expect(result).toMatchObject({
      status: 'removed',
      path: path.resolve(worktreePath),
      managed: true,
    });
    expect(fs.existsSync(worktreePath)).toBe(false);
    await expect(manager.list()).resolves.not.toContain(path.resolve(worktreePath));
  });

  it('removes a registered TeamRun nested worktree using git worktree registry state', async () => {
    const worktreePath = await manager.create('at/team/b40b01bb/main/71b4ffc6');

    const result = await manager.remove(worktreePath);

    expect(result).toMatchObject({
      status: 'removed',
      path: path.resolve(worktreePath),
      managed: true,
    });
    expect(fs.existsSync(worktreePath)).toBe(false);
  });

  it('removes an unregistered stale directory under managed .worktrees for a normal workspace path', async () => {
    const stalePath = path.join(tempDir, '.worktrees', 'at', 'deadbeef');
    fs.mkdirSync(stalePath, { recursive: true });
    fs.writeFileSync(path.join(stalePath, 'leftover.txt'), 'stale');

    const result = await manager.remove(stalePath);

    expect(result).toMatchObject({
      status: 'stale_removed',
      path: path.resolve(stalePath),
      managed: true,
    });
    expect(fs.existsSync(stalePath)).toBe(false);
  });

  it('removes an unregistered stale directory under managed .worktrees for a TeamRun nested path', async () => {
    const stalePath = path.join(
      tempDir,
      '.worktrees',
      'at',
      'team',
      'b40b01bb',
      'main',
      '71b4ffc6',
    );
    fs.mkdirSync(stalePath, { recursive: true });
    fs.writeFileSync(path.join(stalePath, 'leftover.txt'), 'stale');

    const result = await manager.remove(stalePath);

    expect(result).toMatchObject({
      status: 'stale_removed',
      path: path.resolve(stalePath),
      managed: true,
    });
    expect(fs.existsSync(stalePath)).toBe(false);
  });

  it('does not remove an unregistered managed ancestor that contains a registered TeamRun worktree', async () => {
    const childWorktreePath = await manager.create('at/team/b40b01bb/main/71b4ffc6');
    const ancestorPath = path.join(tempDir, '.worktrees', 'at', 'team', 'b40b01bb');

    const result = await manager.remove(ancestorPath);

    expect(result).toMatchObject({
      status: 'unregistered',
      path: path.resolve(ancestorPath),
      managed: true,
    });
    expect(fs.existsSync(childWorktreePath)).toBe(true);
    const registeredPaths = await manager.list();
    expect(registeredPaths.map((registeredPath) => fs.realpathSync(registeredPath))).toContain(
      fs.realpathSync(childWorktreePath),
    );
  });

  it('does not physically delete an unregistered path outside managed .worktrees', async () => {
    const unmanagedPath = path.join(tempDir, 'outside-worktree');
    fs.mkdirSync(unmanagedPath, { recursive: true });
    fs.writeFileSync(path.join(unmanagedPath, 'keep.txt'), 'keep');

    const result = await manager.remove(unmanagedPath);

    expect(result).toMatchObject({
      status: 'unregistered',
      path: path.resolve(unmanagedPath),
      managed: false,
    });
    expect(fs.existsSync(path.join(unmanagedPath, 'keep.txt'))).toBe(true);
  });
});

describe('WorktreeManager.deleteBranchIfSafe', () => {
  let tempDir: string;
  let repoPath: string;
  let manager: WorktreeManager;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-worktree-manager-'));
    repoPath = path.join(tempDir, 'repo');
    initRepo(repoPath);
    manager = new WorktreeManager(repoPath);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('deletes an existing local task branch', async () => {
    git(repoPath, ['branch', 'at/delete-me']);

    const result = await manager.deleteBranchIfSafe('at/delete-me');

    expect(result).toMatchObject({
      status: 'deleted',
      branchName: 'at/delete-me',
    });
    await expect(manager.checkBranchExists('at/delete-me')).resolves.toBe(false);
  });

  it('skips empty, protected, and missing branches', async () => {
    await expect(manager.deleteBranchIfSafe('')).resolves.toMatchObject({
      status: 'empty',
      branchName: '',
    });
    await expect(manager.deleteBranchIfSafe('main')).resolves.toMatchObject({
      status: 'protected',
      branchName: 'main',
    });
    await expect(manager.deleteBranchIfSafe('develop', { protectedBranches: ['develop'] })).resolves.toMatchObject({
      status: 'protected',
      branchName: 'develop',
    });
    await expect(manager.deleteBranchIfSafe('at/missing')).resolves.toMatchObject({
      status: 'missing',
      branchName: 'at/missing',
    });
  });

  it('skips branches that are currently checked out in a worktree', async () => {
    const worktreePath = await manager.create('at/checked-out');

    const result = await manager.deleteBranchIfSafe('at/checked-out');

    expect(result).toMatchObject({
      status: 'checked_out',
      branchName: 'at/checked-out',
    });
    expect(result.reason).toContain(worktreePath);
    await expect(manager.checkBranchExists('at/checked-out')).resolves.toBe(true);
  });
});
