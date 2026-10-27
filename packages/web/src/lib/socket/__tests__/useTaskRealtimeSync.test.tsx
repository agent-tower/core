// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskStatus, type Task } from '@agent-tower/shared'
import { ServerEvents } from '@agent-tower/shared/socket'
import { useTask } from '@/hooks/use-tasks'
import { queryKeys } from '@/hooks/query-keys'
import { useTaskRealtimeSync } from '../hooks/useTaskRealtimeSync'

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (payload?: unknown) => unknown>() }))
vi.mock('../manager.js', () => ({ socketManager: { connect: () => ({
  on: (event: string, handler: (payload?: unknown) => unknown) => handlers.set(event, handler),
  off: (event: string) => handlers.delete(event),
}) } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let container: HTMLDivElement
let client: QueryClient

function Harness() {
  useTaskRealtimeSync()
  const task = useTask('parent')
  return <span>{task.data?.displayStatus}</span>
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  client?.clear()
  handlers.clear()
  vi.unstubAllGlobals()
})

describe('task hierarchy realtime recovery', () => {
  it('refreshes an ancestor for uncached descendant updates/deletions and reconnects', async () => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } })
    const parent: Task = { id: 'parent', projectId: 'project', title: 'Parent', status: TaskStatus.DONE, displayStatus: TaskStatus.DONE }
    client.setQueryData(queryKeys.tasks.detail('parent'), parent)
    client.setQueryData(queryKeys.tasks.detail('other'), { ...parent, id: 'other', projectId: 'other-project' })
    client.setQueryData(queryKeys.tasks.stats('project'), { done: 1 })
    let displayStatus = TaskStatus.IN_PROGRESS
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...parent, displayStatus })))
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => root.render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>))
    expect(container.textContent).toBe(TaskStatus.DONE)

    const emit = async (event: string, payload?: unknown) => {
      await act(async () => {
        await handlers.get(event)?.(payload)
        await new Promise(resolve => setTimeout(resolve, 20))
      })
    }
    await emit(ServerEvents.TASK_UPDATED, { taskId: 'uncached-grandchild', projectId: 'project', status: 'IN_PROGRESS' })
    expect(container.textContent).toBe(TaskStatus.IN_PROGRESS)
    expect(client.getQueryData<Task>(queryKeys.tasks.detail('parent'))?.status).toBe(TaskStatus.DONE)
    expect(client.getQueryState(queryKeys.tasks.stats('project'))?.isInvalidated).toBe(true)
    expect(client.getQueryState(queryKeys.tasks.detail('other'))?.isInvalidated).toBe(false)

    displayStatus = TaskStatus.IN_REVIEW
    await emit(ServerEvents.TASK_DELETED, { taskId: 'uncached-grandchild', projectId: 'project' })
    expect(container.textContent).toBe(TaskStatus.IN_REVIEW)
    expect(client.getQueryState(queryKeys.tasks.detail('other'))?.isInvalidated).toBe(false)

    displayStatus = TaskStatus.DONE
    await emit('connect')
    expect(container.textContent).toBe(TaskStatus.DONE)
  })
})
