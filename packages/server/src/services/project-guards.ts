import fs from 'node:fs';
import path from 'node:path';
import type { ProjectGitCapability } from '@agent-tower/shared';
import { ValidationError } from '../errors.js';
import { execGit } from '../git/git-cli.js';
import { prisma } from '../utils/index.js';

type ProjectGuardInput = {
  name: string;
  archivedAt: Date | null;
  repoDeletedAt: Date | null;
};

export function ensureProjectIsMutable(
  project: ProjectGuardInput,
  action: string
): void {
  if (!project.archivedAt) return;

  if (project.repoDeletedAt) {
    throw new ValidationError(
      `Project "${project.name}" is archived and its local repository files were deleted. Rebind repoPath and restore it before trying to ${action}.`
    );
  }

  throw new ValidationError(
    `Project "${project.name}" is archived. Restore it before trying to ${action}.`
  );
}

export function ensureProjectHasRepository(
  project: Pick<ProjectGuardInput, 'name' | 'repoDeletedAt'>,
  action: string
): void {
  if (!project.repoDeletedAt) return;

  throw new ValidationError(
    `Project "${project.name}" no longer has local repository files. Rebind repoPath and restore it before trying to ${action}.`
  );
}

export function hasGitMetadata(projectPath: string): boolean {
  return fs.existsSync(path.join(projectPath, '.git'));
}

type StoredProjectGitCapability = {
  repoPath: string;
  isGitRepo: boolean | null;
  worktreeReady: boolean | null;
  gitCapabilityReason: string | null;
};

const PROJECT_GIT_CAPABILITY_REASONS = new Set<ProjectGitCapability['reason']>([
  'NO_GIT',
  'NO_HEAD',
  'READY',
  'INVALID_REPOSITORY',
]);

export function getStoredProjectGitCapability(
  project: StoredProjectGitCapability
): ProjectGitCapability {
  if (
    project.isGitRepo !== null
    && project.worktreeReady !== null
    && PROJECT_GIT_CAPABILITY_REASONS.has(project.gitCapabilityReason as ProjectGitCapability['reason'])
  ) {
    return {
      isGitRepo: project.isGitRepo,
      worktreeReady: project.worktreeReady,
      reason: project.gitCapabilityReason as ProjectGitCapability['reason'],
    };
  }

  // Legacy rows have no persisted capability. Keep list reads cheap and let
  // explicit refresh/operation guards perform the authoritative Git check.
  const isGitRepo = hasGitMetadata(project.repoPath);
  return {
    isGitRepo,
    worktreeReady: isGitRepo,
    reason: isGitRepo ? 'READY' : 'NO_GIT',
  };
}

export async function detectProjectGitCapability(projectPath: string): Promise<ProjectGitCapability> {
  if (!hasGitMetadata(projectPath)) {
    return {
      isGitRepo: false,
      worktreeReady: false,
      reason: 'NO_GIT',
    };
  }

  try {
    await execGit(projectPath, ['rev-parse', '--verify', 'HEAD']);
    return {
      isGitRepo: true,
      worktreeReady: true,
      reason: 'READY',
    };
  } catch {
    try {
      await execGit(projectPath, ['rev-parse', '--is-inside-work-tree']);
      return {
        isGitRepo: true,
        worktreeReady: false,
        reason: 'NO_HEAD',
      };
    } catch {
      return {
        isGitRepo: true,
        worktreeReady: false,
        reason: 'INVALID_REPOSITORY',
      };
    }
  }
}

export async function detectAndStoreProjectGitCapability(project: {
  id: string;
  repoPath: string;
}): Promise<ProjectGitCapability & { gitCapabilityCheckedAt: Date }> {
  const capability = await detectProjectGitCapability(project.repoPath);
  const gitCapabilityCheckedAt = new Date();
  await prisma.project.update({
    where: { id: project.id },
    data: {
      isGitRepo: capability.isGitRepo,
      worktreeReady: capability.worktreeReady,
      gitCapabilityReason: capability.reason,
      gitCapabilityCheckedAt,
    },
  });
  return { ...capability, gitCapabilityCheckedAt };
}

export function ensureProjectSupportsGit(
  project: Pick<ProjectGuardInput, 'name'> & { repoPath: string },
  action: string
): void {
  if (hasGitMetadata(project.repoPath)) return;

  throw new ValidationError(
    `Project "${project.name}" is not a Git repository. Initialize Git before trying to ${action}.`
  );
}

export async function ensureProjectSupportsWorktrees(
  project: Pick<ProjectGuardInput, 'name'> & { id: string; repoPath: string },
  action: string
): Promise<void> {
  const capability = await detectAndStoreProjectGitCapability(project);
  if (capability.worktreeReady) return;

  if (!capability.isGitRepo) {
    throw new ValidationError(
      `Project "${project.name}" is not a Git repository. Initialize Git before trying to ${action}.`
    );
  }

  if (capability.reason === 'NO_HEAD') {
    throw new ValidationError(
      `Project "${project.name}" is a Git repository but has no commits. Create the first commit before trying to ${action}.`
    );
  }

  throw new ValidationError(
    `Project "${project.name}" is not ready for Git worktrees. Check the repository and try again.`
  );
}
