import simpleGit, { SimpleGit } from 'simple-git';
import path from 'path';
import fs from 'fs/promises';

export class WorktreeManager {
  private git: SimpleGit;
  private repoPath: string;
  private worktreeBaseDir: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
    this.git = simpleGit(repoPath);
    this.worktreeBaseDir = path.join(repoPath, '..', '.worktrees');
  }

  async create(branchName: string): Promise<string> {
    const worktreePath = path.join(this.worktreeBaseDir, branchName);

    await fs.mkdir(this.worktreeBaseDir, { recursive: true });
    await this.git.raw(['worktree', 'add', '-b', branchName, worktreePath]);

    return worktreePath;
  }

  async remove(worktreePath: string): Promise<void> {
    await this.git.raw(['worktree', 'remove', worktreePath, '--force']);
  }

  async getDiff(worktreePath: string, baseBranch: string): Promise<string> {
    const worktreeGit = simpleGit(worktreePath);
    return worktreeGit.diff([baseBranch]);
  }

  async merge(worktreePath: string, targetBranch: string): Promise<void> {
    const worktreeGit = simpleGit(worktreePath);
    const currentBranch = await worktreeGit.revparse(['--abbrev-ref', 'HEAD']);

    await this.git.checkout(targetBranch);
    await this.git.merge([currentBranch.trim()]);
    await this.remove(worktreePath);
    await this.git.deleteLocalBranch(currentBranch.trim(), true);
  }

  async list(): Promise<string[]> {
    const result = await this.git.raw(['worktree', 'list', '--porcelain']);
    const lines = result.split('\n');
    const worktrees: string[] = [];

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        worktrees.push(line.replace('worktree ', ''));
      }
    }

    return worktrees;
  }
}
