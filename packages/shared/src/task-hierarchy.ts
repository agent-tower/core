/** Root task, child task, grandchild task. */
export const MAX_TASK_DEPTH = 3

export interface TaskHierarchy {
  parentTaskId?: string | null
  /** Root first, immediate parent last; excludes the task itself. */
  ancestorIds?: string[]
}

export function getTaskAncestorIds(task: TaskHierarchy): string[] {
  return task.ancestorIds ?? (task.parentTaskId ? [task.parentTaskId] : [])
}

export function canCreateSubtask(task: TaskHierarchy): boolean {
  return getTaskAncestorIds(task).length < MAX_TASK_DEPTH - 1
}

export function isTaskInSubtree(task: TaskHierarchy & { id: string }, rootId: string): boolean {
  return task.id === rootId || getTaskAncestorIds(task).includes(rootId)
}

export interface TaskDeletionScope {
  /** All descendants, excluding the selected task. */
  descendantCount: number
}
