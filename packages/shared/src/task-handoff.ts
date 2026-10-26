/** Handoffs are fetched on demand, separately from task/list metadata. */
export interface TaskHandoff {
  taskId: string
  content: string
}

/** Exactly one literal match is replaced; an empty oldString only initializes an empty note. */
export interface UpdateTaskHandoffInput {
  oldString: string
  newString: string
}

export const TASK_HANDOFF_MAX_LENGTH = 32_768
