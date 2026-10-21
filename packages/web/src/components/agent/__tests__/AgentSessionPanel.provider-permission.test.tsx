// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentType, RuntimeType } from '@agent-tower/shared'
import type { ProviderWithAvailability } from '@/hooks/use-providers'
import type { PendingAttachment } from '@/hooks/use-attachments'
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
vi.mock('@/hooks/use-translation-settings', () => ({ useTranslationSettings: () => ({ data: { enabled: false }, isError: false }) }))
vi.mock('@/lib/api-client', async original => ({ ...await original<typeof import('@/lib/api-client')>(), apiClient: { get: vi.fn(async () => ({ items: [], nextCursor: null })) } }))
vi.mock('@/lib/socket/manager', () => {
  const socket = { connected: false, emit: vi.fn(), on: vi.fn(), off: vi.fn() }
  return { socketManager: { connect: () => socket, getSocket: () => socket } }
})
const attachmentState = vi.hoisted(() => ({ files: [] as PendingAttachment[], restoreFiles: vi.fn() }))
vi.mock('@/hooks/use-attachments', () => ({
  useAttachments: () => ({
    files: attachmentState.files, addFiles: vi.fn(), removeFile: vi.fn(), clear: () => { attachmentState.files = [] }, restoreFiles: attachmentState.restoreFiles,
    getDoneAttachments: () => attachmentState.files.flatMap(file => file.attachment ? [file.attachment] : []), hasFiles: attachmentState.files.length > 0, isUploading: false,
  }),
}))
vi.mock('@/components/agent', () => ({ AgentLogo: () => null }))
vi.mock('../MessageDeliveryStatus', () => ({ MessageDeliveryStatus: () => null }))
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
let client: QueryClient

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

afterEach(() => {
  attachmentState.files = []
  attachmentState.restoreFiles.mockClear()
  if (root) act(() => root!.unmount())
  client.clear()
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
      act(() => root!.render(<QueryClientProvider client={client}><AgentSessionPanel {...props} providers={providers} /></QueryClientProvider>))

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
  it('preserves a newer draft without restoring submitted attachments after a lost send response', async () => {
    const original: PendingAttachment = { tempId: 'old', file: new File(['x'], 'old.txt'), status: 'done', progress: 100,
      attachment: { id: 'attachment', url: '/attachments/attachment/file', originalName: 'old.txt', mimeType: 'text/plain', sizeBytes: 1, storagePath: '/private/old.txt', createdAt: new Date().toISOString() } }
    attachmentState.files = [original]
    container = document.createElement('div'); document.body.append(container); root = createRoot(container)
    let reject!: (error: Error) => void
    const onSend = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail }))
    act(() => root!.render(<QueryClientProvider client={client}><AgentSessionPanel sessionId="draft-session" agentType={AgentType.CODEX} runtimeType={RuntimeType.CLI} providers={[provider()]} providerId="codex" onSend={onSend} onStop={async () => {}} /></QueryClientProvider>))
    const textarea = container.querySelector('textarea')!
    const write = (text: string) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await act(async () => write('Original submission'))
    await act(async () => textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(onSend).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'Original submission', attachmentIds: ['attachment'] }))
    await act(async () => write('New draft'))
    await act(async () => { reject(new Error('response lost')); await Promise.resolve() })
    expect(textarea.value).toBe('New draft')
    expect(attachmentState.restoreFiles).not.toHaveBeenCalled()
    expect(attachmentState.files).toEqual([])
  })

})
