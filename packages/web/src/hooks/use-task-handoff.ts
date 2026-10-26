import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TaskHandoff, UpdateTaskHandoffInput } from '@agent-tower/shared'
import { apiClient } from '@/lib/api-client'
import { queryKeys } from './query-keys'

export function useTaskHandoff(taskId: string) {
  return useQuery({
    queryKey: queryKeys.tasks.handoff(taskId),
    queryFn: ({ signal }) => apiClient.get<TaskHandoff>(`/tasks/${encodeURIComponent(taskId)}/handoff`, { signal }),
    enabled: Boolean(taskId),
  })
}

export function useUpdateTaskHandoff(taskId: string) {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: UpdateTaskHandoffInput) => apiClient.patch<TaskHandoff>(`/tasks/${encodeURIComponent(taskId)}/handoff`, input),
    onMutate: () => client.cancelQueries({ queryKey: queryKeys.tasks.handoff(taskId) }),
    onSuccess: (note) => {
      client.setQueryData(queryKeys.tasks.handoff(note.taskId), note)
    },
    onSettled: () => client.invalidateQueries({ queryKey: queryKeys.tasks.handoff(taskId) }),
  })
}
