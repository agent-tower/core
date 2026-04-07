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
