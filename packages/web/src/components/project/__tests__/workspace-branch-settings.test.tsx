// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceBranchSettings } from '../WorkspaceBranchSettings'
import { ApiError, apiClient } from '@/lib/api-client'
import { queryKeys } from '@/hooks/query-keys'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (text: string) => text }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))

describe('WorkspaceBranchSettings', () => {
  let container: HTMLDivElement
  let root: Root
  let queryClient: QueryClient
  const options = {
    mainBranch: 'main', branches: ['main', 'develop', 'feature/first', 'feature/second'],
    workspaces: [
      { id: 'first', taskId: 'task-1', taskTitle: 'First task', branchName: 'feature/first', baseBranch: 'main' },
      { id: 'second', taskId: 'task-2', taskTitle: 'Second task', branchName: 'feature/second', baseBranch: 'develop' },
    ],
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })
    queryClient.setQueryData(queryKeys.workspaces.projectBranches('project-1'), options)
    vi.spyOn(apiClient, 'get').mockResolvedValue(options)
  })

  afterEach(() => {
    act(() => root.unmount())
    queryClient.clear()
    container.remove()
    vi.restoreAllMocks()
  })

  async function render() {
    await act(async () => root.render(
      <QueryClientProvider client={queryClient}><WorkspaceBranchSettings projectId="project-1" /></QueryClientProvider>,
    ))
  }

  async function select(index: number, value: string) {
    await act(async () => {
      const element = container.querySelectorAll('select')[index]!
      element.value = value
      element.dispatchEvent(new Event('change', { bubbles: true }))
    })
  }

  function saveButton() {
    return Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Save base branch')!
  }

  it('saves only the selected workspace and resets the branch draft when switching workspaces', async () => {
    const patch = vi.spyOn(apiClient, 'patch').mockResolvedValue({ id: 'second', baseBranch: 'main' })
    await render()
    await select(0, 'first')
    expect(saveButton().disabled).toBe(true)
    expect(Array.from(container.querySelectorAll('select')[1]!.options).map((option) => option.value)).not.toContain('feature/first')
    await select(1, 'develop')
    await select(0, 'second')
    expect(container.querySelectorAll('select')[1]!.value).toBe('develop')
    expect(saveButton().disabled).toBe(true)
    await select(1, 'main')
    await act(async () => saveButton().click())
    expect(patch).toHaveBeenCalledExactlyOnceWith('/workspaces/second/base-branch', { baseBranch: 'main', expectedBaseBranch: 'develop' })
  })

  it('explains a busy workspace error and keeps its current target unchanged', async () => {
    vi.spyOn(apiClient, 'patch').mockRejectedValue(new ApiError(409, 'busy', { code: 'WORKSPACE_BASE_BRANCH_BUSY' }))
    await render()
    await select(0, 'first')
    await select(1, 'develop')
    await act(async () => {
      saveButton().click()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Wait for the Agent to finish or stop it before changing the base branch.')
    expect(container.textContent).toContain('feature/first → main')
  })
})
