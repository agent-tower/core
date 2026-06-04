import { NotFoundError } from '../errors.js';

export function ensureTaskNotDeleted(task: { id: string; deletedAt?: Date | null } | null | undefined): asserts task is { id: string; deletedAt?: Date | null } {
  if (!task || task.deletedAt) {
    throw new NotFoundError('Task', task?.id ?? 'unknown');
  }
}

export function isTaskDeleted(task: { deletedAt?: Date | null } | null | undefined): boolean {
  return Boolean(task?.deletedAt);
}
