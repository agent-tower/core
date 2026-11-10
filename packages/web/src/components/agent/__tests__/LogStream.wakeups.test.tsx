// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionWakeupDto } from '@agent-tower/shared'
import { apiClient } from '@/lib/api-client'
import { LogStream } from '../LogStream'

vi.mock('@/hooks/use-session-translations', async original => ({ ...await original<typeof import('@/hooks/use-session-translations')>(), useSessionTranslations: () => ({ overlays: [] }) }))
vi.mock('@/hooks/use-translation-settings', async original => ({ ...await original<typeof import('@/hooks/use-translation-settings')>(), useTranslationSettings: () => ({ data: { enabled: false }, isError: false }) }))
vi.mock('@/lib/api-client', async original => ({ ...await original<typeof import('@/lib/api-client')>(), apiClient: { post: vi.fn(), get: vi.fn(), delete: vi.fn() } }))
vi.mock('@/lib/socket/manager', () => ({ socketManager: { connect: () => ({ on: vi.fn(), off: vi.fn() }) } }))
vi.mock('@/lib/i18n', () => ({
  useI18n: () => ({ t: (value: string, params?: Record<string, unknown>) => value.replace(/\{(\w+)\}/g, (_, key: string) => String(params?.[key] ?? '')) }),
}))
vi.mock('streamdown', () => ({ Streamdown: ({ children }: { children: React.ReactNode }) => <div data-markdown>{children}</div> }))
vi.mock('@streamdown/mermaid', () => ({ mermaid: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const wakeup = (patch: Partial<SessionWakeupDto>): SessionWakeupDto => ({
  id: 'w', sessionId: 'session-1', kind: 'TIMER', reason: '', serviceName: null, fireAt: null, state: 'PENDING',
  lastError: null, createdAt: new Date(0).toISOString(), firedAt: null, ...patch,
})

let client: QueryClient
let root: Root
let container: HTMLDivElement
let wakeups: SessionWakeupDto[] = []
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }) }
async function render() {
  act(() => root.render(<QueryClientProvider client={client}><LogStream logs={[]} sessionId="session-1" /></QueryClientProvider>))
  await flush()
}

beforeEach(() => {
  vi.clearAllMocks()
  wakeups = []
  vi.mocked(apiClient.get).mockImplementation(async (url: string) => (url === '/sessions/session-1/wakeups' ? wakeups : { items: [], nextCursor: null }) as never)
  vi.mocked(apiClient.delete).mockResolvedValue({} as never)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); client.clear() })

describe('Pending wake-ups in the session log', () => {
  it('lists only wake-ups that will still start a turn and cancels one on request', async () => {
    wakeups = [
      wakeup({ id: 'service', kind: 'SERVICE_EXIT', serviceName: 'x1-viewer-check', reason: 'browser suite results', createdAt: new Date(1).toISOString() }),
      wakeup({ id: 'ready', kind: 'TIMER', state: 'READY', reason: 'recheck the build', fireAt: new Date(2).toISOString(), createdAt: new Date(2).toISOString() }),
      wakeup({ id: 'fired', state: 'FIRED', reason: 'already delivered' }),
      wakeup({ id: 'cancelled', state: 'CANCELLED', reason: 'dropped earlier' }),
    ]
    await render()
    const notice = container.querySelector('[data-pending-wakeups]')
    expect(notice?.textContent).toContain('等待唤醒 (2)')
    expect(notice?.textContent).toContain('后台服务 x1-viewer-check 退出后唤醒')
    expect(notice?.textContent).toContain('browser suite results')
    expect(notice?.textContent).toContain('当前回合结束后唤醒')
    expect(notice?.textContent).not.toContain('already delivered')
    expect(notice?.textContent).not.toContain('dropped earlier')

    const cancel = container.querySelector<HTMLButtonElement>('[data-wakeup-id="service"] button')
    await act(async () => { cancel?.click() })
    await flush()
    expect(apiClient.delete).toHaveBeenCalledWith('/sessions/session-1/wakeups/service')
  })

  it('renders nothing when no wake-up is pending', async () => {
    wakeups = [wakeup({ id: 'fired', state: 'FIRED' })]
    await render()
    expect(container.querySelector('[data-pending-wakeups]')).toBeNull()
  })
})
