import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { TaskStatus, type Task, type TaskBoardItem } from '@agent-tower/shared'
import { queryKeys } from '../query-keys'
import {
  isTaskBoardQueryKey,
  isTaskListQueryKey,
  removeTaskFromBoardCaches,
  removeTaskFromListCaches,
  removeTaskFromSubtaskCaches,
} from '../use-tasks'

function makeTask(id: string, projectId = 'project-1'): Task {
  return {
    id,
    projectId,
    title: id,
    status: TaskStatus.TODO,
  }
}

function makeBoardTask(id: string, projectId = 'project-1'): TaskBoardItem {
  return {
    id,
    projectId,
    title: id,
    status: TaskStatus.TODO,
    updatedAt: new Date('2026-01-01T00:00:00.000Z').getTime(),
  }
}

describe('task cache helpers', () => {
  it('removes the family and out-of-page parent context in one optimistic change', () => {
    const client = new QueryClient()
    const key = queryKeys.tasks.board({ limit: 1 })
    client.setQueryData(key, {
      data: [{ ...makeBoardTask('child'), parentTaskId: 'parent' }, makeBoardTask('other')],
      parents: [makeBoardTask('parent')], total: 2, page: 1, limit: 1, totalPages: 2,
    })
    const before = removeTaskFromBoardCaches(client, 'parent')
    expect(client.getQueryData(key)).toMatchObject({ data: [makeBoardTask('other')], parents: [], total: 1 })
    expect(before[0][1]?.data).toHaveLength(2)
  })

  it('removes grandchildren across board and child pages and preserves a rollback snapshot', () => {
    const client = new QueryClient()
    const root = makeBoardTask('root')
    const child = { ...makeBoardTask('child'), parentTaskId: 'root', ancestorIds: ['root'] }
    const grandchild = { ...makeBoardTask('grandchild'), parentTaskId: 'child', ancestorIds: ['root', 'child'] }
    const other = makeBoardTask('other')
    const boardKey = queryKeys.tasks.board({ limit: 2 })
    const childKey = queryKeys.tasks.subtasks('child')
    const page = { data: [grandchild, other], parents: [root, child], total: 2, page: 1, limit: 2, totalPages: 1 }
    client.setQueryData(boardKey, page)
    client.setQueryData(childKey, { pages: [{ ...page, data: [grandchild], parents: [], total: 1 }], pageParams: [1] })
    const boardSnapshots = removeTaskFromBoardCaches(client, 'root')
    const childSnapshots = removeTaskFromSubtaskCaches(client, 'root')
    expect(client.getQueryData(boardKey)).toMatchObject({ data: [other], parents: [], total: 1 })
    expect(client.getQueryData(childKey)).toMatchObject({ pages: [{ data: [], total: 0 }] })
    for (const [key, data] of [...boardSnapshots, ...childSnapshots]) client.setQueryData(key, data)
    expect(client.getQueryData(boardKey)).toEqual(page)
    expect(client.getQueryData(childKey)).toMatchObject({ pages: [{ data: [grandchild], total: 1 }] })
    removeTaskFromBoardCaches(client, 'child')
    expect(client.getQueryData(boardKey)).toMatchObject({ data: [other], parents: [root] })
  })

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

  it('matches global and project-scoped board keys', () => {
    expect(isTaskBoardQueryKey(queryKeys.tasks.board({ limit: 1000 }), 'project-1')).toBe(true)
    expect(isTaskBoardQueryKey(queryKeys.tasks.board({ projectId: 'project-1' }), 'project-1')).toBe(true)
    expect(isTaskBoardQueryKey(queryKeys.tasks.board({ projectId: 'project-2' }), 'project-1')).toBe(false)
    expect(isTaskBoardQueryKey(queryKeys.tasks.list('project-1'), 'project-1')).toBe(false)
  })

  it('removes deleted tasks from matching board caches', () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(queryKeys.tasks.board({ limit: 1000 }), {
      data: [makeBoardTask('task-1'), makeBoardTask('task-2')],
      total: 2,
      page: 1,
      limit: 1000,
      totalPages: 1,
    })
    queryClient.setQueryData(queryKeys.tasks.board({ projectId: 'project-2' }), {
      data: [makeBoardTask('task-1', 'project-2')],
      total: 1,
      page: 1,
      limit: 1000,
      totalPages: 1,
    })

    const snapshots = removeTaskFromBoardCaches(queryClient, 'task-1', 'project-1')

    expect(snapshots).toHaveLength(1)
    expect(queryClient.getQueryData(queryKeys.tasks.board({ limit: 1000 }))).toMatchObject({
      data: [expect.objectContaining({ id: 'task-2' })],
      total: 1,
    })
    expect(queryClient.getQueryData(queryKeys.tasks.board({ projectId: 'project-2' }))).toMatchObject({
      data: [expect.objectContaining({ id: 'task-1' })],
      total: 1,
    })
  })
})
