import { useCallback, useEffect, useState } from 'react'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import type { TaskCleanupStatus } from '@agent-tower/shared'
import { toast } from 'sonner'
import { apiClient } from '@/lib/api-client'
import { useI18n } from '@/lib/i18n'
import { queryKeys } from './query-keys'

const STORAGE_KEY = 'task-cleanup-pending'

export function useTaskCleanupMonitor() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [taskIds, setTaskIds] = useState<string[]>(() => {
    try {
      const saved: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]')
      return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []
    } catch { return [] }
  })
  useEffect(() => {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(taskIds)) } catch { /* Monitoring still works in memory. */ }
  }, [taskIds])
  const jobs = useQueries({
    queries: taskIds.map(taskId => ({
      queryKey: queryKeys.tasks.cleanup(taskId),
      queryFn: () => apiClient.get<TaskCleanupStatus>(`/tasks/${taskId}/cleanup`),
      refetchInterval: (query: { state: { data?: TaskCleanupStatus } }) =>
        query.state.data?.status === 'COMPLETED' ? false as const : 3000,
    })),
  })
  useEffect(() => {
    const completed: string[] = []
    jobs.forEach((query, index) => {
      const taskId = taskIds[index]
      const job = query.data
      if (!job) return
      const toastId = `task-cleanup:${taskId}`
      if (job.status === 'COMPLETED') {
        toast.success(t('Task resources deleted'), { id: toastId })
        completed.push(taskId)
      } else if (job.status === 'FAILED') {
        toast.error(t('Task resource cleanup failed'), {
          id: toastId,
          description: job.lastError ?? undefined,
          duration: Infinity,
          action: {
            label: t('Retry'),
            onClick: () => {
              void apiClient.post<TaskCleanupStatus>(`/tasks/${taskId}/cleanup/retry`, {}).then(data => {
                queryClient.setQueryData(queryKeys.tasks.cleanup(taskId), data)
              }).catch(error => toast.error(error instanceof Error ? error.message : t('Task resource cleanup failed')))
            },
          },
        })
      } else {
        toast.loading(t('Deleting task resources…'), { id: toastId })
      }
    })
    // Retire completed server operations from the persisted monitoring list.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (completed.length) setTaskIds(current => current.filter(id => !completed.includes(id)))
  }, [jobs, taskIds, queryClient, t])
  return useCallback((taskId: string) => setTaskIds(current => current.includes(taskId) ? current : [...current, taskId]), [])
}
