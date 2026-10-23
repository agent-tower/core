// @vitest-environment happy-dom
import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentType, RuntimeType, TaskPriority, TaskStatus, WorkspaceKind } from '@agent-tower/shared'
import type { ProviderWithAvailability } from '@/hooks/use-providers'
import type { CreateTaskInput } from '@/components/task/CreateTaskInput'
import { readProviderLastUsedAt } from '@/lib/provider-usage'
import { ProjectKanbanPage } from '../ProjectKanbanPage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type CreateInputProps = ComponentProps<typeof CreateTaskInput>
const fixtures = vi.hoisted(() => ({
  providers: [] as ProviderWithAvailability[],
  createInput: undefined as CreateInputProps | undefined,
  projects: [{ id: 'project-1', name: 'Project', mainBranch: 'main' }],
  tasks: [],
  post: vi.fn(),
  startSession: vi.fn(async () => undefined),
}))

vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (value: string) => value, locale: 'en' }) }))
vi.mock('@/hooks/use-projects', () => ({
  useProjects: () => ({ data: { data: fixtures.projects }, isLoading: false }),
}))
vi.mock('@/hooks/use-tasks', () => ({
  useTaskBoard: () => ({ data: { data: fixtures.tasks }, isLoading: false }),
  useDeleteTask: () => ({}),
  useUpdateTask: () => ({}),
  useUpdateTaskStatus: () => ({}),
}))
vi.mock('@/hooks/use-providers', () => ({
  useProviders: () => ({ data: fixtures.providers, isLoading: false }),
}))
vi.mock('@/hooks/use-sessions', () => ({
  useStartSession: () => ({ mutateAsync: fixtures.startSession }),
}))
vi.mock('@/hooks/use-team-run', () => ({ useCreateTaskTeamRun: () => ({}) }))
vi.mock('@/lib/api-client', () => ({ apiClient: { post: fixtures.post } }))
vi.mock('@/components/TunnelButton', () => ({ TunnelButton: () => null }))
vi.mock('@/components/project/CreateProjectModal', () => ({ CreateProjectModal: () => null }))
vi.mock('@/components/task/TaskDetail', () => ({ TaskDetail: () => <p>Task detail</p> }))
vi.mock('@/components/task/TaskList', () => ({
  TaskList: ({ onCreateTask }: { onCreateTask: () => void }) => <button onClick={onCreateTask}>New task</button>,
}))
vi.mock('@/components/task/CreateTaskInput', () => ({
  CreateTaskInput: (props: CreateInputProps) => {
    fixtures.createInput = props
    return <ol>{props.providers.map(provider => <li key={provider.id}>{provider.id}</li>)}</ol>
  },
}))

function provider(id: string, issue?: 'missing' | 'permission'): ProviderWithAvailability {
  return {
    provider: {
      id, name: id, agentType: AgentType.CODEX, runtimeType: RuntimeType.CLI,
      executionPermission: 'AUTO_SANDBOX',
      executionPermissionOptions: [{
        mode: 'AUTO_SANDBOX', supported: issue !== 'permission', authorized: true,
        selectable: issue !== 'permission',
        reasons: issue === 'permission' ? [{ code: 'CONFLICT', message: 'Permission denied' }] : [],
      }],
      env: {}, config: {}, isDefault: false,
    },
    availability: { type: issue === 'missing' ? 'NOT_FOUND' : 'INSTALLATION_FOUND' },
  }
}

let root: Root | undefined
let container: HTMLDivElement | undefined
let queryClient: QueryClient | undefined

async function render() {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => root!.render(
    <QueryClientProvider client={queryClient!}><ProjectKanbanPage /></QueryClientProvider>,
  ))
}

function unmount() {
  if (root) act(() => root!.unmount())
  container?.remove()
  queryClient?.clear()
  root = undefined
}

function order() {
  return [...container!.querySelectorAll('li')].map(item => item.textContent)
}

function submit(providerId: string) {
  return fixtures.createInput!.onSubmit({
    title: 'New task', description: '', projectId: 'project-1', providerId,
    mode: 'SOLO', workspaceMode: WorkspaceKind.WORKTREE, teamRunMode: 'AUTO',
    teamTemplateId: null, memberPresetIds: [], attachmentLinks: '', attachmentIds: [],
    priority: TaskPriority.NORMAL,
  })
}

beforeEach(() => {
  localStorage.clear()
  fixtures.providers = [
    provider('frequent'), provider('recent'), provider('unused'),
    provider('missing', 'missing'), provider('permission-denied', 'permission'),
  ]
  fixtures.post.mockImplementation(async (path: string) => {
    if (path === '/projects/project-1/tasks') {
      return { id: 'created-task', projectId: 'project-1', title: 'New task', status: TaskStatus.TODO }
    }
    if (path === '/tasks/created-task/workspaces') return { id: 'workspace-1' }
    if (path === '/workspaces/workspace-1/sessions') return { id: 'session-1' }
    throw new Error(`Unexpected API call: ${path}`)
  })
})

afterEach(() => {
  unmount()
  localStorage.clear()
  fixtures.createInput = undefined
  vi.clearAllMocks()
})

describe('task creation Provider recency', () => {
  it('excludes disabled configurations even when they are the default and last selection', async () => {
    fixtures.providers[0].provider.enabled = false
    fixtures.providers[0].provider.isDefault = true
    localStorage.setItem('lastSelectedProviderId', 'frequent')
    await render()
    expect(order()).toEqual(['recent', 'unused', 'missing', 'permission-denied'])
    expect(fixtures.createInput!.defaultProviderId).toBe('recent')
    expect(fixtures.providers[0].provider.id).toBe('frequent')
  })

  it('reorders immediately after creation without fetching Providers again and preserves the order after reload', async () => {
    localStorage.setItem('providerUsageCount', JSON.stringify({ frequent: 100, unused: 1 }))
    localStorage.setItem('providerLastUsedAt', JSON.stringify({
      frequent: 100, recent: 200, missing: 400, 'permission-denied': 300,
    }))
    localStorage.setItem('lastSelectedProviderId', 'recent')
    const originalProviders = fixtures.providers
    await render()

    expect(order()).toEqual(['recent', 'frequent', 'unused', 'missing', 'permission-denied'])
    expect(fixtures.createInput!.defaultProviderId).toBe('recent')

    await act(async () => { await submit('unused') })
    await act(async () => {
      await vi.dynamicImportSettled()
      const newTaskButton = [...container!.querySelectorAll('button')]
        .find(button => button.textContent === 'New task')!
      newTaskButton.click()
    })

    expect(fixtures.providers).toBe(originalProviders)
    expect(originalProviders.map(item => item.provider.id)).toEqual([
      'frequent', 'recent', 'unused', 'missing', 'permission-denied',
    ])
    expect(order()).toEqual(['unused', 'recent', 'frequent', 'missing', 'permission-denied'])
    expect(fixtures.createInput!.defaultProviderId).toBe('unused')
    expect(readProviderLastUsedAt().unused).toBeGreaterThan(200)

    unmount()
    await render()
    expect(order()).toEqual(['unused', 'recent', 'frequent', 'missing', 'permission-denied'])
    expect(fixtures.createInput!.defaultProviderId).toBe('unused')
  })

  it('migrates the last selection and leaves history unchanged when task creation fails', async () => {
    localStorage.setItem('lastSelectedProviderId', 'unused')
    localStorage.setItem('providerUsageCount', '{corrupted legacy counts')
    await render()
    expect(order()).toEqual(['unused', 'frequent', 'recent', 'missing', 'permission-denied'])

    fixtures.post.mockRejectedValueOnce(new Error('Task creation failed'))
    await act(async () => { await expect(submit('recent')).rejects.toThrow('Task creation failed') })
    expect(order()).toEqual(['unused', 'frequent', 'recent', 'missing', 'permission-denied'])
    expect(localStorage.getItem('providerLastUsedAt')).toBeNull()
    expect(localStorage.getItem('lastSelectedProviderId')).toBe('unused')
  })

  it.each(['{broken', 'null', '[]', '{"frequent":"invalid","recent":-1}'])(
    'recovers from invalid persisted history: %s',
    async raw => {
      localStorage.setItem('providerLastUsedAt', raw)
      localStorage.setItem('lastSelectedProviderId', 'recent')
      await render()
      expect(order()).toEqual(['recent', 'frequent', 'unused', 'missing', 'permission-denied'])
    },
  )
})
