import { ServiceError } from '../errors.js';
import { execGit } from './git-cli.js';

/** Only local branch names are valid task bases, never revision expressions. */
export async function requireLocalBaseBranch(repoPath: string, value: string): Promise<string> {
  const branch = value.trim();
  try {
    if (!branch) throw new Error('Empty branch');
    await execGit(repoPath, ['check-ref-format', `refs/heads/${branch}`]);
    await execGit(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  } catch {
    throw new ServiceError(
      'The base branch is unavailable. Choose an existing local branch.',
      'INVALID_BASE_BRANCH',
      400,
    );
  }
  return branch;
}
