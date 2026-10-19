import { TaskPriority } from '@agent-tower/shared'

export const TASK_PRIORITY_OPTIONS = [
  { value: TaskPriority.URGENT, code: 'P0', label: '紧急', className: 'bg-destructive/10 text-destructive-ink', iconName: 'chevrons-up' },
  { value: TaskPriority.HIGH, code: 'P1', label: '高', className: 'bg-warning/15 text-warning-ink', iconName: 'signal-high' },
  { value: TaskPriority.NORMAL, code: 'P2', label: '普通', className: 'bg-muted text-muted-foreground', iconName: 'minus' },
  // 低优先级不该比其它信息更抢眼，也避免与「进行中」的蓝色混淆
  { value: TaskPriority.LOW, code: 'P3', label: '低', className: 'bg-foreground/[0.06] text-muted-foreground', iconName: 'chevrons-down' },
] as const

export function getTaskPriorityOption(priority?: number) {
  return TASK_PRIORITY_OPTIONS.find(option => option.value === priority) ?? TASK_PRIORITY_OPTIONS[2]
}
