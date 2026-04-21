import { execFile } from 'child_process';
import { promisify } from 'util';
import { ConflictOp } from '@agent-tower/shared';

const execFileAsync = promisify(execFile);

const IS_WINDOWS = process.platform === 'win32';

// ─── Custom Error Types ───────────────────────────────────────────────────────

export class GitError extends Error {
  code: string;

  constructor(message: string, code = 'GIT_ERROR') {
    super(message);
    this.name = 'GitError';
    this.code = code;
  }
}

export class BranchNotFoundError extends GitError {
  constructor(branchName: string) {
    super(`Branch '${branchName}' does not exist`, 'BRANCH_NOT_FOUND');
    this.name = 'BranchNotFoundError';
  }
}

export class BranchExistsError extends GitError {
  constructor(branchName: string) {
    super(`Branch '${branchName}' already exists`, 'BRANCH_EXISTS');
    this.name = 'BranchExistsError';
  }
}

export class InvalidBranchNameError extends GitError {
  constructor(branchName: string, reason?: string) {
    const msg = reason
      ? `Invalid branch name '${branchName}': ${reason}`
      : `Invalid branch name '${branchName}'`;
    super(msg, 'INVALID_BRANCH_NAME');
    this.name = 'InvalidBranchNameError';
  }
}

export class WorktreeNotFoundError extends GitError {
  constructor(worktreePath: string) {
    super(
      `Worktree not found at '${worktreePath}'`,
      'WORKTREE_NOT_FOUND'
    );
    this.name = 'WorktreeNotFoundError';
  }
}

export class WorktreeDirtyError extends GitError {
  constructor(worktreePath: string) {
    super(
      `Worktree at '${worktreePath}' has uncommitted changes`,
      'WORKTREE_DIRTY'
    );
    this.name = 'WorktreeDirtyError';
  }
}

export class MergeConflictError extends GitError {
  conflictedFiles: string[];
  conflictOp: ConflictOp;

  constructor(conflictedFiles: string[], conflictOp: ConflictOp = ConflictOp.MERGE) {
    const fileList = conflictedFiles.join(', ');
    super(
      `Merge conflict in files: ${fileList}`,
      'MERGE_CONFLICT'
    );
    this.name = 'MergeConflictError';
    this.conflictedFiles = conflictedFiles;
    this.conflictOp = conflictOp;
  }
}

export class RebaseInProgressError extends GitError {
  constructor() {
    super('Rebase in progress; resolve or abort it before retrying', 'REBASE_IN_PROGRESS');
    this.name = 'RebaseInProgressError';
  }
}

export class BranchesDivergedError extends GitError {
  ahead: number;
  behind: number;

  constructor(taskBranch: string, baseBranch: string, ahead: number, behind: number) {
    super(
      `Branch '${taskBranch}' has diverged from '${baseBranch}' (ahead: ${ahead}, behind: ${behind}). Rebase or update before merging.`,
      'BRANCHES_DIVERGED'
    );
    this.name = 'BranchesDivergedError';
    this.ahead = ahead;
    this.behind = behind;
  }
}

// ─── Git CLI Wrapper ──────────────────────────────────────────────────────────

/**
 * Execute a git command in the given repository path.
 * All git operations go through this single entry point for uniform error handling.
 */
export async function execGit(
  repoPath: string,
  args: string[],
  options?: { timeout?: number }
): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: repoPath,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
      timeout: options?.timeout ?? 30_000,
      encoding: 'utf-8',
      ...(IS_WINDOWS ? { shell: true } : {}),
    });
    return stdout;
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string; code?: string | number };
    const stderr = error.stderr ?? error.message ?? 'Unknown git error';
    throw new GitError(
      `git ${args.join(' ')} failed: ${stderr.trim()}`,
      typeof error.code === 'string' ? error.code : 'GIT_EXEC_ERROR'
    );
  }
}

/**
 * Check that the `git` binary is available on PATH.
 */
export async function ensureGitAvailable(): Promise<void> {
  try {
    await execFileAsync('git', ['--version'], {
      encoding: 'utf-8',
      ...(IS_WINDOWS ? { shell: true } : {}),
    });
  } catch {
    throw new GitError(
      'git is not installed or not found on PATH',
      'GIT_NOT_AVAILABLE'
    );
  }
}

// ─── Branch Name Validation ───────────────────────────────────────────────────

/**
 * Validate a git branch name.
 * Follows rules from `git check-ref-format --branch`:
 * - No double dots (..)
 * - No ASCII control chars or space, ~, ^, :, ?, *, [, \
 * - Cannot begin or end with a dot, or end with .lock
 * - Cannot contain @{
 * - Cannot be a single @
 * - Each component cannot begin with a dot
 */
export function isValidBranchName(name: string): { valid: boolean; reason?: string } {
  if (!name || name.trim().length === 0) {
    return { valid: false, reason: 'branch name cannot be empty' };
  }

  if (name === '@') {
    return { valid: false, reason: 'branch name cannot be a single @' };
  }

  if (name.includes('..')) {
    return { valid: false, reason: 'branch name cannot contain ".."' };
  }

  if (name.includes('@{')) {
    return { valid: false, reason: 'branch name cannot contain "@{"' };
  }

  if (name.endsWith('.lock')) {
    return { valid: false, reason: 'branch name cannot end with ".lock"' };
  }

  if (name.startsWith('.') || name.endsWith('.')) {
    return { valid: false, reason: 'branch name cannot start or end with "."' };
  }

  if (name.startsWith('-')) {
    return { valid: false, reason: 'branch name cannot start with "-"' };
  }

  // No ASCII control chars, space, ~, ^, :, ?, *, [, backslash
  // eslint-disable-next-line no-control-regex
  const invalidChars = /[\x00-\x1f\x7f ~^:?*[\]\\]/;
  if (invalidChars.test(name)) {
    return { valid: false, reason: 'branch name contains invalid characters' };
  }

  // Each slash-separated component cannot begin with a dot
  const components = name.split('/');
  for (const comp of components) {
    if (comp.startsWith('.')) {
      return { valid: false, reason: `path component "${comp}" cannot start with "."` };
    }
    if (comp.length === 0) {
      return { valid: false, reason: 'branch name cannot contain empty path components (consecutive slashes)' };
    }
  }

  return { valid: true };
}
