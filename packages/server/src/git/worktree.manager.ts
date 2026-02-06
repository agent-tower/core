import path from 'path';
import fs from 'fs/promises';
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
  ): Promise<void> {
    // Determine the current branch of the worktree
    const currentBranchRaw = await execGit(worktreePath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const taskBranch = currentBranchRaw.trim();

    // 1. Check worktree is clean
    const clean = await this.isWorktreeClean(worktreePath);
    if (!clean) {
      throw new WorktreeDirtyError(worktreePath);
    }

    // 2. Check branch divergence
    const status = await this.getBranchStatus(taskBranch, targetBranch);
    if (status.behind > 0) {
      throw new BranchesDivergedError(taskBranch, targetBranch, status.ahead, status.behind);
    }

    // 3. Checkout target branch in main repo
    await execGit(this.repoPath, ['checkout', targetBranch]);

    // 4. Squash merge (no commit yet)
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
          throw new MergeConflictError(conflictedFiles);
        }
      }
      throw err;
    }

    // 5. Commit the squash
    const message =
      options?.commitMessage ?? `squash merge branch '${taskBranch}'`;
    await execGit(this.repoPath, ['commit', '-m', message]);

    // 6. Clean up: remove worktree and delete task branch
    await this.remove(worktreePath);
    try {
      await execGit(this.repoPath, ['branch', '-D', taskBranch]);
    } catch {
      // Branch may already be removed with the worktree — ignore
    }
  }

  /**
   * Prune stale worktree references.
   */
  async prune(): Promise<void> {
    await execGit(this.repoPath, ['worktree', 'prune']);
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
    try {
      const output = await execGit(this.repoPath, ['diff', '--name-only', '--diff-filter=U']);
      return output
        .split('\n')
        .map((f) => f.trim())
        .filter((f) => f.length > 0);
    } catch {
      return [];
    }
  }
}
