// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LogType, type LogEntry } from '@agent-tower/shared/log-adapter'
import { apiClient } from '@/lib/api-client'
import { GROUP_PREFETCH_CHAR_LIMIT } from '@/hooks/use-log-entry-content'
import { LogStream } from '../LogStream'

vi.mock('@/hooks/use-session-translations', async original => ({ ...await original<typeof import('@/hooks/use-session-translations')>(), useSessionTranslations: () => ({ overlays: [] }) }))
vi.mock('@/hooks/use-translation-settings', async original => ({ ...await original<typeof import('@/hooks/use-translation-settings')>(), useTranslationSettings: () => ({ data: { enabled: false }, isError: false }) }))
vi.mock('@/lib/api-client', async original => ({ ...await original<typeof import('@/lib/api-client')>(), apiClient: { post: vi.fn(), get: vi.fn() } }))
vi.mock('@/lib/socket/manager', () => ({ socketManager: { connect: () => ({ on: vi.fn(), off: vi.fn() }) } }))
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (value: string) => value }) }))
vi.mock('streamdown', () => ({ Streamdown: ({ children }: { children: React.ReactNode }) => <div data-markdown>{children}</div> }))
vi.mock('@streamdown/mermaid', () => ({ mermaid: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ENTRIES_URL = '/sessions/session-1/logs/entries'

/** A tool entry as the light log view delivers it: a prefix plus the full length. */
function omittedTool(id: string, full: string, preview = full.split('\n\n')[0]): LogEntry {
  return {
    id,
    type: LogType.Tool,
    title: 'Read ✓',
    content: preview,
    contentOmitted: full.length,
    tool: { action: 'file_read', name: 'Read', id, status: 'success' },
  }
}

const fullA = `Reading /repo/a.ts\n\n${'a'.repeat(4000)}`
const fullB = `Reading /repo/b.ts\n\n${'b'.repeat(6000)}`

let client: QueryClient
let root: Root
let container: HTMLDivElement
let contents: Record<string, string>
let failEntries: boolean

async function flush(ms = 10) { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)) }) }
async function render(logs: LogEntry[]) {
  act(() => root.render(<QueryClientProvider client={client}><LogStream logs={logs} sessionId="session-1" /></QueryClientProvider>))
  await flush()
}
function entryRequests() {
  return vi.mocked(apiClient.get).mock.calls.filter(([url]) => url === ENTRIES_URL)
}
async function click(button: Element | undefined) {
  if (!button) throw new Error('Missing button')
  await act(async () => { button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  await flush()
}
function groupButton() {
  return [...container.querySelectorAll('button')].find(button => button.textContent?.includes('工具调用'))
}
function itemButtons() {
  return [...container.querySelectorAll('button[aria-expanded]')].filter(button => button !== groupButton())
}

beforeEach(() => {
  vi.clearAllMocks()
  contents = { a: fullA, b: fullB }
  failEntries = false
  vi.mocked(apiClient.get).mockImplementation(async (url, options) => {
    if (url !== ENTRIES_URL) return { items: [], nextCursor: null }
    if (failEntries) throw new Error('offline')
    const requested = String(options?.params?.entries ?? '').split(',').map((item) => {
      const separator = item.lastIndexOf(':')
      return { id: decodeURIComponent(item.slice(0, separator)), length: Number(item.slice(separator + 1)) }
    })
    // Like the server: an ID can name several entries; the length picks one.
    return { entries: requested.flatMap(({ id, length }) => {
      const content = contents[`${id}:${length}`] ?? contents[id]
      return content === undefined ? [] : [{ id, length, content }]
    }) }
  })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); client.clear() })

describe('tool outputs left out of the light log view', () => {
  it('loads a group\'s omitted outputs in one request when it opens and shows them on expand', async () => {
    await render([omittedTool('a', fullA), omittedTool('b', fullB)])
    expect(entryRequests()).toHaveLength(0)

    await click(groupButton())
    expect(entryRequests()).toHaveLength(1)
    expect(entryRequests()[0][1]).toMatchObject({ params: { entries: `a:${fullA.length},b:${fullB.length}` } })

    await click(itemButtons()[0])
    expect(container.textContent).toContain(fullA)
    expect(container.textContent).not.toContain('Loading the full output…')
    await click(itemButtons()[1])
    expect(container.textContent).toContain(fullB)
    // The prefetch already holds both outputs.
    expect(entryRequests()).toHaveLength(1)
  })

  it('keeps two outputs apart when their entries share an ID', async () => {
    const first = `Running: npm test\n\n${'1'.repeat(3000)}`
    const second = `Running: npm run build\n\n${'2'.repeat(5000)}`
    contents = { [`dup:${first.length}`]: first, [`dup:${second.length}`]: second }
    await render([omittedTool('dup', first), { ...omittedTool('dup', second), id: 'dup' }])

    await click(groupButton())
    expect(entryRequests()).toHaveLength(1)
    await click(itemButtons()[0])
    await click(itemButtons()[1])

    const outputs = [...container.querySelectorAll('code')].map(code => code.textContent)
    expect(outputs).toContain(first)
    expect(outputs).toContain(second)
  })

  it('loads a large output only when its item is expanded', async () => {
    const huge = `Reading /repo/huge.log\n\n${'h'.repeat(GROUP_PREFETCH_CHAR_LIMIT)}`
    contents = { huge }
    await render([omittedTool('huge', huge)])

    await click(groupButton())
    expect(entryRequests()).toHaveLength(0)
    expect(container.textContent).not.toContain(huge)

    await click(itemButtons()[0])
    expect(entryRequests()).toHaveLength(1)
    expect(container.textContent).toContain(huge)
  })

  it('keeps the preview, reports a failed load and retries on request', async () => {
    const huge = `Reading /repo/huge.log\n\n${'h'.repeat(GROUP_PREFETCH_CHAR_LIMIT)}`
    contents = { huge }
    failEntries = true
    await render([omittedTool('huge', huge)])
    await click(groupButton())
    await click(itemButtons()[0])
    expect(container.textContent).toContain('Loading the full output…')
    expect(container.textContent).toContain('Reading /repo/huge.log')

    // One automatic retry after TanStack Query's 1 s delay, then the error.
    await flush(1_200)
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not load the full output.')
    expect(container.textContent).toContain('Reading /repo/huge.log')

    failEntries = false
    await click([...container.querySelectorAll('[role="alert"] button')][0])
    expect(container.textContent).toContain(huge)
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('never requests complete tool outputs', async () => {
    const complete: LogEntry = { ...omittedTool('a', fullA), content: fullA, contentOmitted: undefined }
    await render([complete])
    await click(groupButton())
    await click(itemButtons()[0])

    expect(container.textContent).toContain(fullA)
    expect(entryRequests()).toHaveLength(0)
  })
})
