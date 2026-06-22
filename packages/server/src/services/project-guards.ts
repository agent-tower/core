import fs from 'node:fs';
import path from 'node:path';
import { ValidationError } from '../errors.js';

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

export function ensureProjectSupportsGit(
  project: Pick<ProjectGuardInput, 'name'> & { repoPath: string },
  action: string
): void {
  if (hasGitMetadata(project.repoPath)) return;

  throw new ValidationError(
    `Project "${project.name}" is not a Git repository. Initialize Git before trying to ${action}.`
  );
}
