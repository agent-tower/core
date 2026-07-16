// @vitest-environment happy-dom
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentType, WorkspaceKind } from '@agent-tower/shared'
import { CreateTaskInput } from '../CreateTaskInput'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const refreshGitCapabilityMock = vi.fn()

vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (source: string) => source }),
}))

vi.mock('@/hooks/use-attachments', () => ({
  useAttachments: () => ({
    files: [],
    addFiles: vi.fn(),
    removeFile: vi.fn(),
    clear: vi.fn(),
    buildMarkdownLinks: () => '',
    getDoneAttachments: () => [],
    isUploading: false,
  }),
}))

vi.mock('@/hooks/use-projects', () => ({
  useRefreshProjectGitCapability: () => ({
    mutateAsync: refreshGitCapabilityMock,
    isPending: false,
  }),
}))

vi.mock('@/hooks/use-slash-command-catalog', () => ({
  useSlashCommandCatalog: () => ({ data: [] }),
  mergeSlashCommandCatalog: (builtinCommands: unknown[]) => builtinCommands,
}))

vi.mock('@/components/team/TeamRunCreateForm', () => ({
  TeamRunCreateForm: () => null,
}))

vi.mock('@/components/agent', () => ({
  AgentLogo: () => null,
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(project: { isGitRepo?: boolean; worktreeReady?: boolean; reason?: string }) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const onSubmit = vi.fn(async () => undefined)

  act(() => {
    root!.render(
      <CreateTaskInput
        projects={[{ id: 'project-1', name: 'Project 1', ...project }]}
        providers={[{
          id: 'provider-1',
          name: 'Provider 1',
          agentType: AgentType.CODEX,
          available: true,
        }]}
        onSubmit={onSubmit}
        defaultProjectId="project-1"
        defaultProviderId="provider-1"
        createStep="idle"
      />,
    )
  })

  return { onSubmit }
}

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount()
    })
  }
  container?.remove()
  root = null
  container = null
})

beforeEach(() => {
  refreshGitCapabilityMock.mockReset()
})

describe('CreateTaskInput Git capability refresh', () => {
  it('allows worktree mode after refreshing a local project that became worktree-ready', async () => {
    refreshGitCapabilityMock.mockResolvedValue({
      isGitRepo: true,
      worktreeReady: true,
      reason: 'READY',
    })
    const { onSubmit } = render({ isGitRepo: false, worktreeReady: false, reason: 'NO_GIT' })

    const textarea = container!.querySelector('textarea')!
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      valueSetter?.call(textarea, 'Ship the fix')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })

    const modeButton = Array.from(container!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('本地模式'))
    expect(modeButton).toBeTruthy()

    await act(async () => {
      modeButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const refreshButton = Array.from(container!.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('重新检测 Git 状态'))
    expect(refreshButton).toBeTruthy()

    await act(async () => {
      refreshButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await Promise.resolve()

    const submitButton = Array.from(container!.querySelectorAll('button'))
      .find((button) => button.getAttribute('title') === 'Create & Start')
    await act(async () => {
      submitButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      workspaceMode: WorkspaceKind.WORKTREE,
    }))
  })
})
