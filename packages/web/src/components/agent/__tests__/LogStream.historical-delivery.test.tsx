// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionMessageDelivery } from '@agent-tower/shared'
import { LogType, type LogEntry } from '@agent-tower/shared/log-adapter'
import { apiClient } from '@/lib/api-client'
import { loadHistoricalDelivery } from '@/hooks/use-historical-delivery'
import { LogStream } from '../LogStream'

vi.mock('@/hooks/use-session-translations', async original => ({ ...await original<typeof import('@/hooks/use-session-translations')>(), useSessionTranslations: () => ({ overlays: [] }) }))
vi.mock('@/hooks/use-translation-settings', async original => ({ ...await original<typeof import('@/hooks/use-translation-settings')>(), useTranslationSettings: () => ({ data: { enabled: false }, isError: false }) }))
vi.mock('@/lib/api-client', async original => ({ ...await original<typeof import('@/lib/api-client')>(), apiClient: { post: vi.fn(), get: vi.fn() } }))
vi.mock('@/lib/socket/manager', () => ({ socketManager: { connect: () => ({ on: vi.fn(), off: vi.fn() }) } }))
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (value: string) => value }) }))
vi.mock('streamdown', () => ({ Streamdown: ({ children }: { children: React.ReactNode }) => <div data-markdown>{children}</div> }))
vi.mock('@streamdown/mermaid', () => ({ mermaid: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const BATCH_URL = '/message-deliveries/by-ids'

function delivery(id: string, state: SessionMessageDelivery['state']): SessionMessageDelivery {
  return {
    origin: 'TASK_FOLLOWUP', sessionId: 'session-1', conversationId: null, destination: { kind: 'SESSION', sessionId: 'session-1' },
    id, clientSubmissionId: `submission-${id}`, channelKey: 'channel', sequence: 1, originalText: `Message ${id}`, attachmentIds: [],
    state, sentMode: 'ORIGINAL', acceptedText: `Message ${id}`, actualSentText: state === 'SENT' ? `Message ${id}` : null, sentAt: null,
    acceptedDestinationId: null, lastError: null, revision: 1, createdAt: new Date(10).toISOString(),
  }
}
const userMessage = (id: string): LogEntry => ({ id: `entry-${id}`, deliveryId: id, type: LogType.User, content: `Message ${id}` })

let client: QueryClient
let root: Root
let container: HTMLDivElement
let stored: Record<string, SessionMessageDelivery>

async function flush(ms = 10) { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }
async function render(logs: LogEntry[]) {
  act(() => root.render(<QueryClientProvider client={client}><LogStream logs={logs} sessionId="session-1" /></QueryClientProvider>))
  await flush()
}
const batchRequests = () => vi.mocked(apiClient.get).mock.calls.filter(([url]) => url === BATCH_URL)
const singleRequests = () => vi.mocked(apiClient.get).mock.calls.filter(([url]) => /^\/message-deliveries\/(?!by-ids)/.test(String(url)))

beforeEach(() => {
  vi.clearAllMocks()
  stored = { old: delivery('old', 'CANCELLED'), team: delivery('team', 'CANCELLED') }
  vi.mocked(apiClient.get).mockImplementation(async (url, options) => {
    // The session lists carry none of these deliveries, as for team, cancelled and older sent ones.
    if (url !== BATCH_URL) return { items: [], nextCursor: null }
    const ids = String(options?.params?.ids ?? '').split(',')
    return { items: ids.flatMap(id => stored[id] ? [stored[id]] : []) }
  })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  client.clear()
})

it('reads the deliveries of all user messages rendered together in one request', async () => {
  await render([userMessage('old'), userMessage('team'), userMessage('hidden')])

  expect(batchRequests()).toHaveLength(1)
  expect(String(batchRequests()[0][1]?.params?.ids).split(',').sort()).toEqual(['hidden', 'old', 'team'])
  expect(singleRequests()).toHaveLength(0)
  // Both cancelled deliveries show their feedback; the one the server left out shows none.
  expect(container.querySelectorAll('[data-message-feedback]')).toHaveLength(3)
  expect([...container.querySelectorAll('[data-message-feedback]')].map(item => item.textContent)).toEqual(['Cancelled', 'Cancelled', ''])

  // Known deliveries are not read again when the log grows.
  await render([userMessage('old'), userMessage('team'), userMessage('hidden'), userMessage('later')])
  expect(batchRequests()).toHaveLength(2)
  expect(batchRequests()[1][1]?.params?.ids).toBe('later')
})

it('fails the waiting rows instead of leaving them loading when an answer is malformed', async () => {
  vi.mocked(apiClient.get).mockResolvedValue({ unexpected: true })
  await expect(loadHistoricalDelivery('old')).rejects.toBeInstanceOf(TypeError)
})
