import path from 'path';
import fs from 'fs/promises';
import { ConflictOp } from '@agent-tower/shared';
import type { GitOperationStatus } from '@agent-tower/shared';
import {
  execGit,
  isValidBranchName,
  GitError,
  BranchExistsError,
  BranchNotFoundError,
  InvalidBranchNameError,
  WorktreeDirtyError,
  MergeConflictError,
  BranchesDivergedError,
  RebaseInProgressError,
} from './git-cli.js';

// Re-export error types for consumers
export {
  GitError,
  BranchExistsError,
  BranchNotFoundError,
  InvalidBranchNameError,
  WorktreeDirtyError,
  MergeConflictError,
  BranchesDivergedError,
  RebaseInProgressError,
} from './git-cli.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WorktreeInfo {
  /** Absolute path to the worktree directory */
  path: string;
  /** HEAD commit hash */
  head: string;
  /** Branch name (empty for detached HEAD) */
  branch: string;
  /** Whether this is the bare/main worktree */
  bare: boolean;
}

export interface BranchStatus {
  ahead: number;
  behind: number;
}

export interface WorktreeStatus {
  /** Number of staged + unstaged modified files */
  changedFiles: number;
  /** Number of untracked files */
  untrackedFiles: number;
}

export interface DiffResult {
  /** Full diff output */
  diff: string;
  /** Summary stat output */
  stat: string;
}

// ─── WorktreeManager ──────────────────────────────────────────────────────────

export class WorktreeManager {
  private repoPath: string;
  private worktreeBaseDir: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
    this.worktreeBaseDir = path.join(repoPath, '..', '.worktrees');
  }

  // ── Read-only Queries ───────────────────────────────────────────────────────

  /**
   * List all worktrees with parsed metadata.
   * Parses `git worktree list --porcelain` output.
   */
  async listWorktrees(): Promise<WorktreeInfo[]> {
    const result = await execGit(this.repoPath, ['worktree', 'list', '--porcelain']);
    return this.parseWorktreeListOutput(result);
  }

  /**
   * Get branch divergence status (ahead/behind) relative to a base branch.
   */
  async getBranchStatus(branchName: string, baseBranch: string): Promise<BranchStatus> {
    await this.ensureBranchExists(branchName);
    await this.ensureBranchExists(baseBranch);

    const output = await execGit(this.repoPath, [
      'rev-list',
      '--left-right',
      '--count',
      `${baseBranch}...${branchName}`,
    ]);

    const parts = output.trim().split(/\s+/);
    const behind = parseInt(parts[0] ?? '0', 10);
    const ahead = parseInt(parts[1] ?? '0', 10);

    return { ahead, behind };
  }

  /**
   * Get the working tree status of a worktree (changed + untracked file counts).
   */
  async getWorktreeStatus(worktreePath: string): Promise<WorktreeStatus> {
    const output = await execGit(worktreePath, ['status', '--porcelain']);
    const lines = output.split('\n').filter((l) => l.length > 0);

    let changedFiles = 0;
    let untrackedFiles = 0;

    for (const line of lines) {
      if (line.startsWith('??')) {
        untrackedFiles++;
      } else {
        changedFiles++;
      }
    }

    return { changedFiles, untrackedFiles };
  }

  /**
   * Check whether a worktree has no uncommitted changes.
   */
  async isWorktreeClean(worktreePath: string): Promise<boolean> {
    const status = await this.getWorktreeStatus(worktreePath);
    return status.changedFiles === 0 && status.untrackedFiles === 0;
  }

  /**
   * Check whether a branch exists (local).
   */
  async checkBranchExists(branchName: string): Promise<boolean> {
    try {
      await execGit(this.repoPath, ['rev-parse', '--verify', `refs/heads/${branchName}`]);
      return true;
    } catch {
      return false;
    }
  }

  // ── Write Operations ────────────────────────────────────────────────────────

  /**
   * Create a new worktree with a new branch.
   *
   * - Validates branch name
   * - Checks branch does not already exist
   * - Creates the worktree base directory if needed
   */
  async create(branchName: string): Promise<string> {
    // Validate branch name
    const validation = isValidBranchName(branchName);
    if (!validation.valid) {
      throw new InvalidBranchNameError(branchName, validation.reason);
    }

    // Check branch does not already exist
    const exists = await this.checkBranchExists(branchName);
    if (exists) {
      throw new BranchExistsError(branchName);
    }

    const worktreePath = path.join(this.worktreeBaseDir, branchName);
    await fs.mkdir(this.worktreeBaseDir, { recursive: true });

    try {
      await execGit(this.repoPath, ['worktree', 'add', '-b', branchName, worktreePath]);
    } catch (err) {
      // Wrap with more context
      if (err instanceof GitError) {
        throw new GitError(
          `Failed to create worktree for branch '${branchName}': ${err.message}`,
          'WORKTREE_CREATE_FAILED'
        );
      }
      throw err;
    }

    return worktreePath;
  }

  /**
   * Remove a worktree. If the worktree does not exist, this is a no-op.
   */
  async remove(worktreePath: string): Promise<void> {
    // Check if the worktree path actually exists on disk
    const pathExists = await fs
      .access(worktreePath)
      .then(() => true)
      .catch(() => false);

    if (!pathExists) {
      // Worktree directory doesn't exist — run prune to clean up stale refs, then return
      await this.prune();
      return;
    }

    try {
      await execGit(this.repoPath, ['worktree', 'remove', worktreePath, '--force']);
    } catch (err) {
      // If the error indicates the worktree is not registered, treat as no-op
      if (err instanceof GitError && err.message.includes('is not a working tree')) {
        return;
      }
      throw err;
    }
  }

  /**
   * Ensure a worktree exists for an existing branch. If the worktree directory
   * is already valid, return its path. Otherwise, recreate it.
   *
   * Used when reactivating a MERGED workspace — the branch was preserved via
   * update-ref but the worktree directory was removed.
   *
   * 参考: vibe-kanban crates/services/src/services/worktree_manager.rs:93-123
   */
  async ensureWorktreeExists(branchName: string): Promise<string> {
    await this.ensureBranchExists(branchName);

    const worktreePath = path.join(this.worktreeBaseDir, branchName);

    // Check if worktree already exists and is valid
    const pathExists = await fs.access(worktreePath).then(() => true).catch(() => false);
    if (pathExists) {
      const gitFileExists = await fs.access(path.join(worktreePath, '.git')).then(() => true).catch(() => false);
      if (gitFileExists) {
        return worktreePath;
      }
      // Invalid directory — clean up first
      await this.remove(worktreePath);
    }

    // Prune stale worktree references
    await this.prune();

    // Create worktree from existing branch (no -b flag)
    await fs.mkdir(this.worktreeBaseDir, { recursive: true });
    try {
      await execGit(this.repoPath, ['worktree', 'add', worktreePath, branchName]);
    } catch (err) {
      if (err instanceof GitError) {
        throw new GitError(
          `Failed to recreate worktree for branch '${branchName}': ${err.message}`,
          'WORKTREE_RECREATE_FAILED'
        );
      }
      throw err;
    }

    return worktreePath;
  }

  /**
   * Get the diff of a worktree branch against a base branch.
   * Returns both the full diff and a stat summary.
   */
  async getDiff(worktreePath: string, baseBranch: string): Promise<string>;
  async getDiff(worktreePath: string, baseBranch: string, options: { withStat: true }): Promise<DiffResult>;
  async getDiff(
    worktreePath: string,
    baseBranch: string,
    options?: { withStat: boolean }
  ): Promise<string | DiffResult> {
    const diff = await execGit(worktreePath, ['diff', baseBranch]);

    if (options?.withStat) {
      const stat = await execGit(worktreePath, ['diff', '--stat', baseBranch]);
      return { diff, stat };
    }

    return diff;
  }

  /**
   * Squash-merge a worktree branch into the target branch.
   *
   * Performs the following steps:
   * 1. Verify the worktree is clean
   * 2. Check branch divergence — fail if base branch has advanced
   * 3. Checkout target branch in the main repo
   * 4. Execute `git merge --squash --no-commit <task_branch>`
   * 5. Commit the squash merge
   * 6. Remove the worktree and delete the task branch
   */
  async merge(
    worktreePath: string,
    targetBranch: string,
    options?: { commitMessage?: string }
  ): Promise<{ sha: string; taskBranch: string }> {
    const mergeStart = performance.now();
    const step = (label: string, start: number) =>
      console.log(`[WorktreeManager.merge] ${label}: ${(performance.now() - start).toFixed(0)}ms`);

    // Determine the current branch of the worktree
    let t = performance.now();
    const currentBranchRaw = await execGit(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const taskBranch = currentBranchRaw.trim();
    step('rev-parse branch', t);

    // 1. Check worktree is clean
    t = performance.now();
    const clean = await this.isWorktreeClean(worktreePath);
    step('isWorktreeClean', t);
    if (!clean) {
      throw new WorktreeDirtyError(worktreePath);
    }

    // 2. Check branch divergence
    t = performance.now();
    const status = await this.getBranchStatus(taskBranch, targetBranch);
    step('getBranchStatus', t);
    if (status.behind > 0) {
      throw new BranchesDivergedError(taskBranch, targetBranch, status.ahead, status.behind);
    }

    // 3. Checkout target branch in main repo
    t = performance.now();
    await execGit(this.repoPath, ['checkout', targetBranch]);
    step('checkout target', t);

    // 4. Squash merge (no commit yet)
    t = performance.now();
    try {
      await execGit(this.repoPath, [
        'merge',
        '--squash',
        '--no-commit',
        taskBranch,
      ]);
    } catch (err) {
      if (err instanceof GitError) {
        // Check for merge conflicts
        const conflictedFiles = await this.getConflictedFiles();
        if (conflictedFiles.length > 0) {
          // Abort the merge to leave the repo clean
          await execGit(this.repoPath, ['merge', '--abort']).catch(() => {
            // merge --abort may fail if no merge in progress, ignore
          });
          throw new MergeConflictError(conflictedFiles, ConflictOp.MERGE);
        }
      }
      throw err;
    }
    step('squash merge', t);

    // 5. Commit the squash
    t = performance.now();
    const message =
      options?.commitMessage ?? `squash merge branch '${taskBranch}'`;
    await execGit(this.repoPath, ['commit', '-m', message]);
    step('commit', t);

    // 6. Get the merge commit SHA
    t = performance.now();
    const sha = (await execGit(this.repoPath, ['rev-parse', 'HEAD'])).trim();
    step('rev-parse SHA', t);

    // 7. Update task branch ref to point to the merge commit.
    //    This allows future work to continue from the merged state without conflicts.
    //    参考: vibe-kanban crates/git/src/lib.rs:873-879
    t = performance.now();
    await execGit(this.repoPath, ['update-ref', `refs/heads/${taskBranch}`, sha]);
    step('update-ref', t);

    // Worktree 目录不在此处删除，由 WorkspaceService.cleanup() 统一清理。
    // 避免 merge 同步等待大量文件删除（node_modules 等）。

    console.log(`[WorktreeManager.merge] TOTAL: ${(performance.now() - mergeStart).toFixed(0)}ms`);
    return { sha, taskBranch };
  }

  /**
   * Prune stale worktree references.
   */
  async prune(): Promise<void> {
    await execGit(this.repoPath, ['worktree', 'prune']);
  }

  // ── Rebase & Git Operation Status ──────────────────────────────────────────

  /**
   * Rebase the current branch in the worktree onto the latest base branch.
   * Uses `git rebase --onto <baseBranch> <mergeBase> <taskBranch>`.
   *
   * - If a rebase is already in progress, throws RebaseInProgressError
   * - On conflict, throws MergeConflictError with ConflictOp.REBASE (preserves rebase state)
   * - On non-conflict failure, auto-aborts to keep repo clean
   */
  async rebase(worktreePath: string, baseBranch: string): Promise<void> {
    // Pre-check 1: worktree must be clean (no uncommitted tracked changes)
    if (!(await this.isWorktreeClean(worktreePath))) {
      throw new WorktreeDirtyError(worktreePath);
    }

    // Pre-check 2: no rebase already in progress
    if (await this.isRebaseInProgress(worktreePath)) {
      throw new RebaseInProgressError();
    }

    // Get current branch name
    const currentBranchRaw = await execGit(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const taskBranch = currentBranchRaw.trim();

    // Calculate merge-base
    const mergeBaseRaw = await execGit(worktreePath, ['merge-base', baseBranch, taskBranch]);
    const mergeBase = mergeBaseRaw.trim();

    try {
      await execGit(worktreePath, ['rebase', '--onto', baseBranch, mergeBase, taskBranch]);
    } catch (err) {
      // Check if it's a conflict
      if (await this.isRebaseInProgress(worktreePath)) {
        const conflictedFiles = await this.getConflictedFilesIn(worktreePath);
        if (conflictedFiles.length > 0) {
          throw new MergeConflictError(conflictedFiles, ConflictOp.REBASE);
        }
      }

      // Non-conflict failure: auto-abort to keep repo clean
      try {
        await execGit(worktreePath, ['rebase', '--abort']);
      } catch {
        // ignore abort failure
      }
      throw err;
    }
  }

  /**
   * Get the current Git operation status of a worktree.
   */
  async getGitOperationStatus(worktreePath: string, baseBranch: string): Promise<GitOperationStatus> {
    const rebaseInProgress = await this.isRebaseInProgress(worktreePath);
    const mergeInProgress = await this.isMergeInProgress(worktreePath);

    let operation: GitOperationStatus['operation'] = 'idle';
    let conflictOp: ConflictOp | null = null;

    if (rebaseInProgress) {
      operation = 'rebase';
      conflictOp = ConflictOp.REBASE;
    } else if (mergeInProgress) {
      operation = 'merge';
      conflictOp = ConflictOp.MERGE;
    }

    let conflictedFiles: string[] = [];
    if (operation !== 'idle') {
      conflictedFiles = await this.getConflictedFilesIn(worktreePath);
    }

    // Get branch divergence info
    let ahead = 0;
    let behind = 0;
    try {
      const currentBranchRaw = await execGit(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const currentBranch = currentBranchRaw.trim();
      const status = await this.getBranchStatus(currentBranch, baseBranch);
      ahead = status.ahead;
      behind = status.behind;
    } catch {
      // If branch status fails (e.g. during rebase with detached HEAD), use defaults
    }

    // Get uncommitted changes info
    let uncommittedCount = 0;
    let untrackedCount = 0;
    try {
      const wtStatus = await this.getWorktreeStatus(worktreePath);
      uncommittedCount = wtStatus.changedFiles;
      untrackedCount = wtStatus.untrackedFiles;
    } catch {
      // ignore
    }

    return {
      operation,
      conflictedFiles,
      conflictOp,
      ahead,
      behind,
      hasUncommittedChanges: uncommittedCount > 0,
      uncommittedCount,
      untrackedCount,
    };
  }

  /**
   * Abort the current in-progress Git operation (rebase or merge).
   * If no operation is in progress, this is a no-op.
   */
  async abortOperation(worktreePath: string): Promise<void> {
    if (await this.isRebaseInProgress(worktreePath)) {
      await execGit(worktreePath, ['rebase', '--abort']);
      return;
    }

    if (await this.isMergeInProgress(worktreePath)) {
      await execGit(worktreePath, ['merge', '--abort']);
      return;
    }

    // No operation in progress — no-op
  }

  // ── Backward-compatible aliases ─────────────────────────────────────────────

  /**
   * Alias for `listWorktrees()`, returns just the paths.
   * Kept for backward compatibility with existing callers.
   */
  async list(): Promise<string[]> {
    const worktrees = await this.listWorktrees();
    return worktrees.map((w) => w.path);
  }

  // ── Private Helpers ─────────────────────────────────────────────────────────

  /**
   * Assert that a branch exists; throw BranchNotFoundError if not.
   */
  private async ensureBranchExists(branchName: string): Promise<void> {
    const exists = await this.checkBranchExists(branchName);
    if (!exists) {
      throw new BranchNotFoundError(branchName);
    }
  }

  /**
   * Parse the porcelain output of `git worktree list --porcelain`.
   *
   * Format:
   * ```
   * worktree /path/to/main
   * HEAD abc123
   * branch refs/heads/main
   *
   * worktree /path/to/wt
   * HEAD def456
   * branch refs/heads/feature
   * ```
   */
  private parseWorktreeListOutput(output: string): WorktreeInfo[] {
    const worktrees: WorktreeInfo[] = [];
    const blocks = output.split('\n\n').filter((b) => b.trim().length > 0);

    for (const block of blocks) {
      const lines = block.split('\n');
      let wtPath = '';
      let head = '';
      let branch = '';
      let bare = false;

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          wtPath = line.slice('worktree '.length);
        } else if (line.startsWith('HEAD ')) {
          head = line.slice('HEAD '.length);
        } else if (line.startsWith('branch ')) {
          // Strip refs/heads/ prefix
          branch = line.slice('branch '.length).replace('refs/heads/', '');
        } else if (line === 'bare') {
          bare = true;
        }
      }

      if (wtPath) {
        worktrees.push({ path: wtPath, head, branch, bare });
      }
    }

    return worktrees;
  }

  /**
   * Get the list of conflicted files from a failed merge.
   */
  private async getConflictedFiles(): Promise<string[]> {
    return this.getConflictedFilesIn(this.repoPath);
  }

  /**
   * Get the list of conflicted files in a specific worktree path.
   */
  private async getConflictedFilesIn(worktreePath: string): Promise<string[]> {
    try {
      const output = await execGit(worktreePath, ['diff', '--name-only', '--diff-filter=U']);
      return output
        .split('\n')
        .map((f) => f.trim())
        .filter((f) => f.length > 0);
    } catch {
      return [];
    }
  }

  /**
   * Check if a rebase is in progress in the given worktree.
   * Detects by checking for rebase-merge or rebase-apply directories.
   */
  private async isRebaseInProgress(worktreePath: string): Promise<boolean> {
    try {
      const rebaseMergePath = (await execGit(worktreePath, ['rev-parse', '--git-path', 'rebase-merge'])).trim();
      const rebaseApplyPath = (await execGit(worktreePath, ['rev-parse', '--git-path', 'rebase-apply'])).trim();

      const [mergeExists, applyExists] = await Promise.all([
        fs.access(rebaseMergePath).then(() => true).catch(() => false),
        fs.access(rebaseApplyPath).then(() => true).catch(() => false),
      ]);

      return mergeExists || applyExists;
    } catch {
      return false;
    }
  }

  /**
   * Check if a merge is in progress in the given worktree.
   * Detects by verifying MERGE_HEAD exists.
   */
  private async isMergeInProgress(worktreePath: string): Promise<boolean> {
    try {
      await execGit(worktreePath, ['rev-parse', '--verify', 'MERGE_HEAD']);
      return true;
    } catch {
      return false;
    }
  }
}
