import type { useI18n } from '@/lib/i18n'
import type { UITask } from './types'

type TaskStatusSummary = Pick<UITask, 'status' | 'ownStatus' | 'runningDescendantCount' | 'reviewDescendantCount'>

export function getTaskActivitySummary(task: TaskStatusSummary, t: ReturnType<typeof useI18n>['t']): string | undefined {
  const running = task.runningDescendantCount ?? 0
  const review = task.reviewDescendantCount ?? 0
  if (!running && !review) return undefined
  return t('Subtasks and grandchildren: {running} running, {review} in review', { running, review })
}

export function getTaskStatusSummary(task: TaskStatusSummary, t: ReturnType<typeof useI18n>['t']): string | undefined {
  const activity = getTaskActivitySummary(task, t)
  if (!activity) return undefined
  return `${t('Own status: {status}', { status: t(task.ownStatus ?? task.status) })}. ${activity}`
}
