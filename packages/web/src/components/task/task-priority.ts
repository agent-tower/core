import { TaskPriority } from '@agent-tower/shared'

export const TASK_PRIORITY_OPTIONS = [
  { value: TaskPriority.URGENT, code: 'P0', label: '紧急', className: 'bg-destructive/10 text-destructive', iconName: 'chevrons-up' },
  { value: TaskPriority.HIGH, code: 'P1', label: '高', className: 'bg-warning/15 text-warning', iconName: 'signal-high' },
  { value: TaskPriority.NORMAL, code: 'P2', label: '普通', className: 'bg-muted text-muted-foreground', iconName: 'minus' },
  { value: TaskPriority.LOW, code: 'P3', label: '低', className: 'bg-info/10 text-info', iconName: 'chevrons-down' },
] as const

export function getTaskPriorityOption(priority?: number) {
  return TASK_PRIORITY_OPTIONS.find(option => option.value === priority) ?? TASK_PRIORITY_OPTIONS[2]
}
