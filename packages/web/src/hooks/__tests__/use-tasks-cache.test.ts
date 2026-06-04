import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { TaskStatus, type Task } from '@agent-tower/shared'
import { queryKeys } from '../query-keys'
import { isTaskListQueryKey, removeTaskFromListCaches } from '../use-tasks'

function makeTask(id: string, projectId = 'project-1'): Task {
  return {
    id,
    projectId,
    title: id,
    status: TaskStatus.TODO,
  }
}

describe('task cache helpers', () => {
  it('matches only task list query keys and supports project list keys with params', () => {
    expect(isTaskListQueryKey(['tasks', 'list', 'project-1', { limit: 1000 }], 'project-1')).toBe(true)
    expect(isTaskListQueryKey(['tasks', 'list', 'project-2', { limit: 1000 }], 'project-1')).toBe(false)
    expect(isTaskListQueryKey(['tasks', 'detail', 'task-1'], 'project-1')).toBe(false)
    expect(isTaskListQueryKey(['tasks', 'stats', 'project-1'], 'project-1')).toBe(false)
  })

  it('removes a task from matching list caches without touching detail or stats caches', () => {
    const queryClient = new QueryClient()
    const targetTask = makeTask('task-1')
    const remainingTask = makeTask('task-2')
    queryClient.setQueryData(queryKeys.tasks.list('project-1', { limit: 1000 }), {
      data: [targetTask, remainingTask],
      total: 2,
      page: 1,
      limit: 1000,
    })
    queryClient.setQueryData(queryKeys.tasks.list('project-2', { limit: 1000 }), {
      data: [makeTask('task-1', 'project-2')],
      total: 1,
      page: 1,
      limit: 1000,
    })
    queryClient.setQueryData(queryKeys.tasks.detail('task-1'), targetTask)
    queryClient.setQueryData(queryKeys.tasks.stats('project-1'), { total: 2 })

    const snapshots = removeTaskFromListCaches(queryClient, 'task-1', 'project-1')

    expect(snapshots).toHaveLength(1)
    expect(queryClient.getQueryData(queryKeys.tasks.list('project-1', { limit: 1000 }))).toMatchObject({
      data: [remainingTask],
      total: 1,
    })
    expect(queryClient.getQueryData(queryKeys.tasks.list('project-2', { limit: 1000 }))).toMatchObject({
      data: [expect.objectContaining({ id: 'task-1' })],
      total: 1,
    })
    expect(queryClient.getQueryData(queryKeys.tasks.detail('task-1'))).toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.tasks.stats('project-1'))).toEqual({ total: 2 })
  })

  it('leaves malformed list cache data unchanged', () => {
    const queryClient = new QueryClient()
    const queryKey = queryKeys.tasks.list('project-1', { limit: 1000 })
    queryClient.setQueryData(queryKey, { data: null, total: 1 })

    expect(() => removeTaskFromListCaches(queryClient, 'task-1', 'project-1')).not.toThrow()
    expect(queryClient.getQueryData(queryKey)).toEqual({ data: null, total: 1 })
  })
})
