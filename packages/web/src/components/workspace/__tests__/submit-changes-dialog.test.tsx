// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceBackgroundServiceDto } from '@agent-tower/shared'
import { SubmitChangesDialog } from '../SubmitChangesDialog'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError, apiClient } from '@/lib/api-client'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({
    t: (source: string, values?: Record<string, unknown>) => (
      values?.count === undefined ? source : source.replace('{count}', String(values.count))
    ),
  }),
}))

function activeService(name: string): WorkspaceBackgroundServiceDto {
  return {
    id: `service-${name}`,
    workspaceId: 'workspace-1',
    name,
    command: 'pnpm',
    args: ['dev'],
    relativeCwd: '.',
    desiredState: 'RUNNING',
    runtimeState: 'RUNNING',
    runtimeInstanceId: `runtime-${name}`,
    pid: 123,
    exitCode: null,
    lastError: null,
    startedAt: '2026-08-07T00:00:00.000Z',
    stoppedAt: null,
    createdAt: '2026-08-07T00:00:00.000Z',
    updatedAt: '2026-08-07T00:00:00.000Z',
  }
}

describe('SubmitChangesDialog', () => {
  let container: HTMLDivElement
  let root: Root
  let queryClient: QueryClient
  const branchOptions = {
    mainBranch: 'main', branches: ['main', 'develop', 'feature/task'],
    workspaces: [{ id: 'workspace-1', taskId: 'task-1', taskTitle: 'Task', branchName: 'feature/task', baseBranch: 'main' }],
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    const domRoot = createRoot(container)
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
    root = {
      render: (node) => domRoot.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>),
      unmount: () => domRoot.unmount(),
    }
    vi.spyOn(apiClient, 'get').mockResolvedValue(branchOptions)
  })

  afterEach(() => {
    act(() => root.unmount())
    queryClient.clear()
    container.remove()
    vi.restoreAllMocks()
  })

  it('requires an explicit stop-and-submit action when services are active', async () => {
    const onConfirm = vi.fn()
    await act(async () => {
      root.render(
        <SubmitChangesDialog
          projectId="project-1"
          workspaceId="workspace-1"
          canMerge
          isOpen
          onClose={() => undefined}
          branchName="feature/task"
          targetBranch="main"
          commitMessage="fix: merge safely"
          isPending={false}
          activeServices={[activeService('web'), activeService('api')]}
          isCheckingServices={false}
          serviceCheckFailed={false}
          onConfirm={onConfirm}
        />,
      )
    })

    expect(document.body.textContent).toContain('合并前将停止 2 个后台服务')
    expect(document.body.textContent).toContain('web, api')
    expect(document.body.textContent).toContain('停止后不会自动恢复。')
    const submitButton = Array.from(document.body.querySelectorAll('button'))
      .find(button => button.textContent?.includes('停止服务并提交'))
    expect(submitButton).toBeDefined()

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    await act(async () => submitButton?.click())
    expect(onConfirm).toHaveBeenCalledWith('fix: merge safely', true)
  })

  it('keeps submission disabled while service state is loading', async () => {
    await act(async () => {
      root.render(
        <SubmitChangesDialog
          projectId="project-1"
          workspaceId="workspace-1"
          canMerge
          isOpen
          onClose={() => undefined}
          branchName="feature/task"
          targetBranch="main"
          isPending={false}
          activeServices={[]}
          isCheckingServices
          serviceCheckFailed={false}
          onConfirm={() => undefined}
        />,
      )
    })

    const checkingButton = Array.from(document.body.querySelectorAll('button'))
      .find(button => button.textContent?.includes('正在检查后台服务...'))
    expect(checkingButton).toBeDefined()
    expect(checkingButton?.hasAttribute('disabled')).toBe(true)
  })

  async function renderBranchDialog(overrides: Partial<React.ComponentProps<typeof SubmitChangesDialog>> = {}) {
    const onConfirm = vi.fn()
    const onClose = vi.fn()
    await act(async () => {
      root.render(<SubmitChangesDialog isOpen projectId="project-1" workspaceId="workspace-1" branchName="feature/task" targetBranch="main"
        isPending={false} canMerge activeServices={[]} isCheckingServices={false} serviceCheckFailed={false}
        onConfirm={onConfirm} onClose={onClose} {...overrides} />)
    })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
    return { onConfirm, onClose }
  }

  async function chooseBranch() {
    await act(async () => (document.body.querySelector('[aria-haspopup="listbox"]') as HTMLButtonElement).click())
    await act(async () => {
      expect(Array.from(document.body.querySelectorAll('[role="option"]')).map((item) => item.textContent)).not.toContain('feature/task')
      const option = Array.from(document.body.querySelectorAll<HTMLButtonElement>('[role="option"]')).find((item) => item.textContent === 'develop')!
      option.click()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }

  function button(label: string) {
    return Array.from(document.body.querySelectorAll('button')).find((item) => item.textContent === label)!
  }

  it('saves only this workspace and returns to review without merging a changed target', async () => {
    const patch = vi.spyOn(apiClient, 'patch').mockResolvedValue({ id: 'workspace-1', baseBranch: 'develop' })
    const put = vi.spyOn(apiClient, 'put')
    const onBaseBranchSaved = vi.fn()
    const { onConfirm, onClose } = await renderBranchDialog({ onBaseBranchSaved })
    await chooseBranch()
    expect(button('确认提交').disabled).toBe(true)
    await act(async () => {
      button('Save base branch and review changes').click()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(patch).toHaveBeenCalledExactlyOnceWith('/workspaces/workspace-1/base-branch', { baseBranch: 'develop', expectedBaseBranch: 'main' })
    expect(put).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledOnce()
    expect(onBaseBranchSaved).toHaveBeenCalledOnce()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('keeps the dialog open and prevents merging when the base branch save fails', async () => {
    vi.spyOn(apiClient, 'patch').mockRejectedValue(new ApiError(409, 'busy', { code: 'WORKSPACE_BASE_BRANCH_BUSY' }))
    const { onClose, onConfirm } = await renderBranchDialog()
    await chooseBranch()
    await act(async () => {
      button('Save base branch and review changes').click()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain('Wait for the Agent')
    expect(button('确认提交').disabled).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('does not offer a base branch override for a managed member workspace', async () => {
    vi.mocked(apiClient.get).mockResolvedValue({ ...branchOptions, workspaces: [] })
    await renderBranchDialog({ targetBranch: 'at/team-main' })
    expect(document.body.querySelector('[aria-haspopup="listbox"]')).toBeNull()
    expect(document.body.textContent).toContain('at/team-main')
  })

  it('allows changing the base while an update is needed, but keeps merge disabled', async () => {
    await renderBranchDialog({ canMerge: false })
    expect(button('确认提交').disabled).toBe(true)
    await chooseBranch()
    expect(button('Save base branch and review changes').disabled).toBe(false)
  })
})
