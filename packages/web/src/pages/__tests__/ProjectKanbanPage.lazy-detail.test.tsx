// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import { ProjectKanbanPage } from '../ProjectKanbanPage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const fixtures = vi.hoisted(() => {
  function deferred() {
    let resolve!: () => void
    const promise = new Promise<void>(done => { resolve = done })
    return { promise, resolve }
  }
  return {
    mobile: true,
    loaded: { mobile: false, desktop: false },
    mobileReady: deferred(),
    desktopReady: deferred(),
    projects: [{ id: 'project-1', name: 'Project', mainBranch: 'main' }],
    tasks: [{ id: 'task-1', projectId: 'project-1', title: 'Example task', status: 'IN_REVIEW', updatedAt: 1 }],
  }
})

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => fixtures.mobile }))
vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (value: string) => value, locale: 'en' }),
}))
vi.mock('@/hooks/use-projects', () => ({
  useProjects: () => ({ data: { data: fixtures.projects }, isLoading: false }),
}))
vi.mock('@/hooks/use-tasks', () => ({
  useTaskBoard: () => ({ data: { data: fixtures.tasks }, isLoading: false }),
  useDeleteTask: () => ({}),
  useUpdateTask: () => ({}),
  useUpdateTaskStatus: () => ({}),
}))
vi.mock('@/hooks/use-providers', () => ({ useProviders: () => ({}) }))
vi.mock('@/hooks/use-sessions', () => ({ useStartSession: () => ({}) }))
vi.mock('@/hooks/use-team-run', () => ({ useCreateTaskTeamRun: () => ({}) }))
vi.mock('@/components/TunnelButton', () => ({ TunnelButton: () => null }))
vi.mock('@/components/project/CreateProjectModal', () => ({ CreateProjectModal: () => null }))
vi.mock('@/components/task/CreateTaskInput', () => ({ CreateTaskInput: () => <p>Create task</p> }))
vi.mock('@/components/task/TaskList', () => ({
  TaskList: ({ onSelectTask }: { onSelectTask: (id: string) => void }) => (
    <button onClick={() => onSelectTask('task-1')}>Open task</button>
  ),
}))

// These promises model slow chunk downloads. A module factory running is more
// significant than a component rendering: eager imports spend memory even when
// the corresponding detail view is never mounted.
vi.mock('@/components/mobile/MobileTaskDetail', async () => {
  fixtures.loaded.mobile = true
  await fixtures.mobileReady.promise
  return {
    MobileTaskDetail: ({ onBack }: { onBack: () => void }) => (
      <div>Mobile detail<button onClick={onBack}>Back</button></div>
    ),
  }
})
vi.mock('@/components/task/TaskDetail', async () => {
  fixtures.loaded.desktop = true
  await fixtures.desktopReady.promise
  return { TaskDetail: () => <p>Desktop detail</p> }
})

it('loads only the selected detail layout and keeps the desktop board usable during download', async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  const render = async () => {
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}><ProjectKanbanPage /></QueryClientProvider>)
    })
  }
  const click = async (label: string) => {
    const button = Array.from(container.querySelectorAll('button')).find(el => el.textContent === label)
    expect(button).toBeDefined()
    await act(async () => { button!.click() })
  }

  try {
    await render()
    expect(container.textContent).toContain('Open task')
    expect(fixtures.loaded).toEqual({ mobile: false, desktop: false })

    await click('Open task')
    await vi.waitFor(() => expect(fixtures.loaded.mobile).toBe(true))
    expect(fixtures.loaded.desktop).toBe(false)
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Loading...')
    await act(async () => { fixtures.mobileReady.resolve() })
    await vi.waitFor(() => expect(container.textContent).toContain('Mobile detail'))
    await click('Back')
    expect(container.textContent).toContain('Open task')

    fixtures.mobile = false
    await render()
    expect(container.textContent).toContain('Create task')
    expect(fixtures.loaded.desktop).toBe(false)
    await click('Open task')
    await vi.waitFor(() => expect(fixtures.loaded.desktop).toBe(true))
    expect(container.textContent).toContain('Open task')
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Loading...')
    await act(async () => { fixtures.desktopReady.resolve() })
    await vi.waitFor(() => expect(container.textContent).toContain('Desktop detail'))
    expect(container.textContent).not.toContain('Mobile detail')
  } finally {
    act(() => root.unmount())
    container.remove()
    queryClient.clear()
  }
})
