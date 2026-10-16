// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectBaseBranchSettings } from '../ProjectBaseBranchSettings'
import { apiClient } from '@/lib/api-client'
import { queryKeys } from '@/hooks/query-keys'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (text: string) => text }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))

describe('ProjectBaseBranchSettings', () => {
  let container: HTMLDivElement
  let root: Root
  let queryClient: QueryClient
  const options = {
    mainBranch: 'main', branches: ['main', 'develop', 'feature/first', 'feature/second'],
    workspaces: [],
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
      <QueryClientProvider client={queryClient}><ProjectBaseBranchSettings projectId="project-1" /></QueryClientProvider>,
    ))
  }

  async function select(value: string) {
    await act(async () => (container.querySelector('[aria-haspopup="listbox"]') as HTMLButtonElement).click())
    await act(async () => {
      const option = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')).find((item) => item.textContent === value)!
      option.click()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }

  function saveButton() {
    return Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Save default base branch')!
  }

  it('saves the project default even when there are no active workspaces', async () => {
    const put = vi.spyOn(apiClient, 'put').mockImplementation(async () => {
      vi.mocked(apiClient.get).mockResolvedValue({ ...options, mainBranch: 'develop' })
      return { id: 'project-1', mainBranch: 'develop' } as never
    })
    const patch = vi.spyOn(apiClient, 'patch')
    await render()
    expect(container.querySelectorAll('[aria-haspopup="listbox"]')).toHaveLength(1)
    expect(container.querySelector('[aria-haspopup="listbox"]')!.textContent).toBe('main')
    expect(saveButton().disabled).toBe(true)
    await select('develop')
    await act(async () => {
      saveButton().click()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(put).toHaveBeenCalledExactlyOnceWith('/projects/project-1', { mainBranch: 'develop' })
    expect(patch).not.toHaveBeenCalled()
    expect(container.querySelector('[aria-haspopup="listbox"]')!.textContent).toBe('develop')
    expect(saveButton().disabled).toBe(true)
  })

  it('keeps the saved default unchanged when saving fails', async () => {
    vi.spyOn(apiClient, 'put').mockRejectedValue(new Error('Branch was deleted'))
    await render()
    await select('develop')
    await act(async () => {
      saveButton().click()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not save the default base branch.')
    expect(queryClient.getQueryData(queryKeys.workspaces.projectBranches('project-1'))).toMatchObject({ mainBranch: 'main' })
  })

  it('refreshes on open and searches the full list including newly created branches beyond the first page', async () => {
    await render()
    const branches = [...options.branches, ...Array.from({ length: 1000 }, (_, index) => `feature/branch-${index}`), 'release/newest']
    vi.mocked(apiClient.get).mockResolvedValue({ ...options, branches })
    await act(async () => (container.querySelector('[aria-haspopup="listbox"]') as HTMLButtonElement).click())
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    expect(document.body.querySelectorAll('[role="option"]')).toHaveLength(branches.length)
    await act(async () => {
      const search = document.body.querySelector<HTMLInputElement>('input[role="combobox"]')!
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'release/newest')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(document.body.querySelectorAll('[role="option"]')).toHaveLength(1)
    await act(async () => (document.body.querySelector('[role="option"]') as HTMLButtonElement).click())
    expect(container.querySelector('[aria-haspopup="listbox"]')!.textContent).toBe('release/newest')
    expect(saveButton().disabled).toBe(false)
  })
})
