// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentType, RuntimeType } from '@agent-tower/shared'
import type { ProviderWithAvailability } from '@/hooks/use-providers'
import { StartAgentDialog } from '../StartAgentDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  createWorkspace: vi.fn(async () => ({ id: 'workspace-1' })),
  createSession: vi.fn(async () => ({ id: 'session-1' })),
  startSession: vi.fn(async () => undefined),
  providers: [] as ProviderWithAvailability[],
}))

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn(async () => undefined) }),
}))
vi.mock('@/hooks/use-providers', () => ({ useProviders: () => ({ data: mocks.providers, isLoading: false }) }))
vi.mock('@/hooks/use-workspaces', () => ({ useCreateWorkspace: () => ({ mutateAsync: mocks.createWorkspace }) }))
vi.mock('@/hooks/use-sessions', () => ({ useStartSession: () => ({ mutateAsync: mocks.startSession }) }))
vi.mock('@/hooks/use-projects', () => ({
  useRefreshProjectGitCapability: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))
vi.mock('@/lib/api-client', () => ({ apiClient: { post: mocks.createSession } }))
vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (source: string, params?: Record<string, string>) => source.replace(/\{(\w+)\}/g, (match, key: string) => params?.[key] ?? match) }),
}))
vi.mock('@/components/agent', () => ({ AgentLogo: () => null }))
vi.mock('@/components/ui/modal', () => ({
  Modal: ({ children, action, isOpen }: { children: ReactNode; action: ReactNode; isOpen: boolean }) =>
    isOpen ? <div>{children}{action}</div> : null,
}))

function provider(id: string, issue?: string): ProviderWithAvailability {
  return {
    provider: {
      id,
      name: id,
      agentType: AgentType.CODEX,
      runtimeType: RuntimeType.CLI,
      executionPermission: 'AUTO_SANDBOX',
      executionPermissionOptions: [{
        mode: 'AUTO_SANDBOX', supported: !issue, authorized: true, selectable: !issue,
        reasons: issue ? [{ code: 'CONFLICT', message: issue }] : [],
      }],
      env: {}, config: {}, isDefault: false,
    },
    availability: { type: 'INSTALLATION_FOUND' },
  }
}

let root: Root | undefined
let container: HTMLDivElement | undefined

function render() {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const props = {
    isOpen: true, onClose: vi.fn(), taskId: 'task-1', projectId: 'project-1',
    taskTitle: 'Review this change', taskDescription: '',
  }
  const rerender = () => act(() => root!.render(<StartAgentDialog {...props} />))
  rerender()
  return rerender
}

function button(label: string) {
  return [...container!.querySelectorAll<HTMLButtonElement>('button')]
    .find(item => item.textContent?.includes(label))!
}

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = undefined
  container = undefined
  mocks.providers = []
  vi.clearAllMocks()
})

describe('StartAgentDialog Provider permissions', () => {
  it('explains the empty Provider list beside the selector', () => {
    mocks.providers = []
    render()
    expect(container!.querySelector('[role="alert"]')?.textContent).toBe('No available Provider for this session.')
    expect(button('启动').disabled).toBe(true)
  })

  it('shows every reason beside the selector when no Provider can start and exposes disabled options to the keyboard', () => {
    mocks.providers = [provider('first', 'First mode denied'), provider('second', 'Second mode denied')]
    render()

    expect(container!.textContent).toContain('No available Provider for this session.')
    expect(container!.textContent).toContain('first: First mode denied')
    expect(container!.textContent).toContain('second: Second mode denied')
    expect(button('启动').disabled).toBe(true)

    act(() => button('选择 Agent').click())
    const disabledOption = button('first')
    const help = disabledOption.parentElement!
    expect(disabledOption.disabled).toBe(true)
    expect(help.tabIndex).toBe(0)
    expect(help.getAttribute('aria-label')).toContain('First mode denied')
    act(() => {
      help.focus()
      help.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(document.activeElement).toBe(help)
    expect(button('启动').disabled).toBe(true)
    expect(mocks.createWorkspace).not.toHaveBeenCalled()
  })

  it('keeps a selected Provider visible after capability refresh and requires an available choice before starting', async () => {
    mocks.providers = [provider('ready'), provider('alternate', 'Not allowed yet')]
    const rerender = render()
    expect(button('启动').disabled).toBe(false)

    mocks.providers = [provider('ready', 'Native mode was revoked'), provider('alternate')]
    rerender()
    expect(container!.textContent).toContain('Native mode was revoked')
    expect(button('启动').disabled).toBe(true)

    act(() => button('ready').click())
    act(() => button('alternate').click())
    expect(button('启动').disabled).toBe(false)
    await act(async () => button('启动').click())
    expect(mocks.createSession).toHaveBeenCalledWith('/workspaces/workspace-1/sessions', {
      providerId: 'alternate', prompt: 'Review this change',
    })
  })
})
