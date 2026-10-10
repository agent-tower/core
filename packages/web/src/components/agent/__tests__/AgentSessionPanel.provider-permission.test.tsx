// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentType, RuntimeType } from '@agent-tower/shared'
import type { ProviderWithAvailability } from '@/hooks/use-providers'
import { AgentSessionPanel } from '../AgentSessionPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('use-stick-to-bottom', () => ({
  useStickToBottom: () => ({
    scrollRef: { current: null }, contentRef: { current: null }, isAtBottom: true,
    scrollToBottom: vi.fn(), stopScroll: vi.fn(),
  }),
}))
vi.mock('@/lib/socket/hooks/useNormalizedLogs', () => ({
  useNormalizedLogs: () => ({
    isConnected: false, isLoadingSnapshot: false, isOutputActive: false,
    lastExitAt: null, logs: [], entries: [], attach: vi.fn(async () => undefined),
  }),
}))
vi.mock('@/hooks/use-sessions', () => ({
  useSessionActivity: () => ({ isActive: false, isCancelling: false }),
}))
vi.mock('@/hooks/use-todos', () => ({ useTodos: () => ({ todos: [] }) }))
vi.mock('@/hooks/useTokenUsage', () => ({ useTokenUsage: () => null }))
vi.mock('@/hooks/use-attachments', () => ({
  useAttachments: () => ({
    files: [], addFiles: vi.fn(), removeFile: vi.fn(), clear: vi.fn(),
    buildMarkdownLinks: () => '', getDoneAttachments: () => [], hasFiles: false, isUploading: false,
  }),
}))
vi.mock('@/components/agent', () => ({ AgentLogo: () => null }))
vi.mock('../TokenUsageBar', () => ({ TokenUsageIndicator: () => null }))
vi.mock('../RuntimePermissionPrompt', () => ({ RuntimePermissionPrompt: () => null }))
vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (source: string, params?: Record<string, string>) => source.replace(/\{(\w+)\}/g, (match, key: string) => params?.[key] ?? match) }),
}))

function provider(issue?: string): ProviderWithAvailability {
  return {
    provider: {
      id: 'codex', name: 'Codex', agentType: AgentType.CODEX, runtimeType: RuntimeType.CLI,
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

afterEach(() => {
  if (root) act(() => root!.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

describe('AgentSessionPanel Provider permissions', () => {
  it('blocks Enter and send while selected permission is invalid, then allows a refreshed valid Provider', async () => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    const onSend = vi.fn(async () => undefined)
    const props = {
      sessionId: 'session-1', agentType: AgentType.CODEX, runtimeType: RuntimeType.CLI,
      providerId: 'codex', onSend, onStop: vi.fn(async () => undefined),
    }
    const rerender = (providers: ProviderWithAvailability[]) =>
      act(() => root!.render(<AgentSessionPanel {...props} providers={providers} />))

    rerender([provider('Native mode was revoked')])
    const textarea = container.querySelector('textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, 'Continue this task')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const send = container.querySelector<HTMLButtonElement>('button[title="Send"]')!
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Native mode was revoked')
    expect(send.disabled).toBe(true)
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(onSend).not.toHaveBeenCalled()

    rerender([provider()])
    expect(send.disabled).toBe(false)
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(onSend).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'codex', message: 'Continue this task' }))
  })
})
