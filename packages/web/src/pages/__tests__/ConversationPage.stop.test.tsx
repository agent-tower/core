// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AgentType, RuntimeType, SessionStatus, type Conversation } from '@agent-tower/shared'
import type { ProviderWithAvailability } from '@/hooks/use-providers'
import { afterEach, expect, it, vi } from 'vitest'
import { useSessionActivity } from '@/hooks/use-sessions'
import { queryKeys } from '@/hooks/query-keys'
import { ConversationPage } from '../ConversationPage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const { get, post, socket } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), socket: { on: vi.fn(), off: vi.fn() } }))
const providerRows = vi.hoisted(() => ({ data: [] as ProviderWithAvailability[] }))
vi.mock('@/lib/api-client', () => ({ apiClient: { get, post } }))
vi.mock('@/lib/socket/manager', () => ({ socketManager: { connect: () => socket } }))
vi.mock('@/hooks/use-providers', () => ({ useProviders: () => ({ data: providerRows.data }) }))
vi.mock('@/lib/desktop-titlebar', () => ({ useDesktopTitlebar: () => ({}), useDesktopNavigate: () => vi.fn() }))
vi.mock('@/lib/i18n', () => ({ translate: (s: string) => s, useI18n: () => ({ t: (s: string) => s }) }))
vi.mock('@/components/task/CreateTaskInput', () => ({ CreateTaskInput: ({ providers, defaultProviderId }: {
  providers: Array<{ id: string; available: boolean; reason?: string; permissionMode?: string }>
  defaultProviderId: string
}) => <div data-start-providers data-default-provider={defaultProviderId}>
  {providers.map(provider => <span key={provider.id} data-provider-id={provider.id} data-available={provider.available} data-mode={provider.permissionMode}>{provider.reason}</span>)}
</div> }))
// Keep the panel's authoritative activity rule; omit unrelated logs/editor UI.
vi.mock('@/components/agent', () => ({ AgentSessionPanel: ({ sessionId, sessionStatus, onStop, isStopping }: { sessionId: string; sessionStatus: SessionStatus; onStop(): Promise<void>; isStopping: boolean }) => {
  const { isActive, runtimeState } = useSessionActivity(sessionId, sessionStatus)
  return <div>
    {runtimeState?.pendingPermissions.map(request => <div key={request.requestId}>pending approval</div>)}
    {isActive && <button data-stop disabled={isStopping} onClick={() => { void onStop() }}>Stop</button>}
  </div>
} }))
let root: Root | undefined
let client: QueryClient | undefined
afterEach(() => { if (root) act(() => root!.unmount()); client?.clear(); document.body.replaceChildren(); providerRows.data = []; vi.clearAllMocks() })

it('keeps a blocked Provider visible in the new conversation start options', async () => {
  const reason = 'Remove sandbox_workspace_write from Codex advanced settings before using automatic sandbox approval.'
  const provider = (id: string, blocked: boolean): ProviderWithAvailability => ({
    provider: {
      id, name: id, agentType: AgentType.CODEX, runtimeType: RuntimeType.CLI,
      executionPermission: blocked ? 'AUTO_SANDBOX' : 'ASK', env: {}, config: {}, isDefault: !blocked,
      executionPermissionOptions: [{
        mode: blocked ? 'AUTO_SANDBOX' : 'ASK', supported: !blocked, authorized: true,
        selectable: !blocked, reasons: blocked ? [{ code: 'CONFLICT', message: reason }] : [],
      }],
    },
    availability: { type: 'INSTALLATION_FOUND' },
  })
  providerRows.data = [provider('ready', false), provider('blocked', true)]
  get.mockResolvedValue([])
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => { root!.render(<QueryClientProvider client={client!}><MemoryRouter initialEntries={['/conversations']}><Routes><Route path="/conversations" element={<ConversationPage />} /></Routes></MemoryRouter></QueryClientProvider>) })
  await vi.waitFor(() => expect(container.querySelector('[data-default-provider]')?.getAttribute('data-default-provider')).toBe('ready'))
  expect(container.querySelectorAll('[data-provider-id]')).toHaveLength(2)
  expect(container.querySelector('[data-provider-id="blocked"]')?.getAttribute('data-available')).toBe('false')
  expect(container.querySelector('[data-provider-id="blocked"]')?.getAttribute('data-mode')).toBe('AUTO_SANDBOX')
  expect(container.querySelector('[data-provider-id="blocked"]')?.textContent).toBe(reason)
})

it.each([SessionStatus.COMPLETED, SessionStatus.CANCELLED])('sends stop without refresh when cached Conversation is %s but runtime awaits approval', async status => {
  const conversation = { id: 'conversation-1', sessionId: 'session-1', title: 'ASK', status, agentType: AgentType.CLAUDE_CODE, runtimeType: RuntimeType.CLI, providerId: 'provider', createdAt: new Date().toISOString() } as Conversation
  let stopped = false
  const runtime = () => ({ sessionId: 'session-1', runtimeType: RuntimeType.CLI, turnState: stopped ? 'IDLE' : 'AWAITING_PERMISSION', pendingPermissions: stopped ? [] : [{ requestId: 'pending' }] })
  get.mockImplementation(async (url: string) => url.endsWith('/runtime') ? runtime() : url === '/conversations' ? [conversation] : { ...conversation, status: stopped ? SessionStatus.CANCELLED : status })
  post.mockImplementation(async () => { stopped = true; return { ...conversation, status: SessionStatus.CANCELLED } })
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } })
  client.setQueryData(queryKeys.conversations.detail(conversation.id), conversation)
  client.setQueryData(queryKeys.conversations.list({ limit: 50 }), [conversation])
  client.setQueryData(queryKeys.sessions.runtime(conversation.sessionId), runtime())
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  const container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  await act(async () => { root!.render(<QueryClientProvider client={client!}><MemoryRouter initialEntries={['/conversations/conversation-1']}><Routes><Route path="/conversations/:conversationId" element={<ConversationPage />} /></Routes></MemoryRouter></QueryClientProvider>) })
  expect(container.textContent).toContain('pending approval')
  expect(container.querySelector('[data-stop]')).not.toBeNull()
  await act(async () => { (container.querySelector('[data-stop]') as HTMLButtonElement).click(); await new Promise(resolve => setTimeout(resolve, 10)) })
  expect(post).toHaveBeenCalledExactlyOnceWith('/conversations/conversation-1/stop')
  expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.sessions.runtime('session-1') })
  await act(async () => { await vi.waitFor(() => expect(container.textContent).not.toContain('pending approval')) })
  expect(container.querySelector('[data-stop]')).toBeNull()
})
