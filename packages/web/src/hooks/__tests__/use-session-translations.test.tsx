// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionTranslationOverlay } from '@agent-tower/shared'
import { LogType, type LogEntry } from '@agent-tower/shared/log-adapter'
import { ClientEvents, ServerEvents } from '@agent-tower/shared/socket'
import { apiClient, ApiError } from '@/lib/api-client'
import { matchingTranslation, mergeTranslationSnapshot, readSessionTranslations, useSessionTranslations } from '../use-session-translations'

const socket = vi.hoisted(() => ({ connected: true, handlers: new Map<string, Set<(...args: never[]) => void>>(), emit: vi.fn(), on: vi.fn(), off: vi.fn() }))
vi.mock('@/lib/socket/manager', () => ({ socketManager: { connect: () => socket, getSocket: () => socket } }))
vi.mock('@/lib/api-client', async original => ({ ...await original<typeof import('@/lib/api-client')>(), apiClient: { get: vi.fn() } }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const overlay: SessionTranslationOverlay = { sourceId: 'source-a', sessionId: 's1', turnId: 't1', blockId: 'b1',
  sourceRevision: 2, overlayRevision: 8, originalText: 'original', translatedText: 'translation', state: 'SUCCESS', targetLanguage: 'Chinese', errorCode: null }
const log: LogEntry = { id: 'log-a', type: LogType.Assistant, content: 'original', textBlock: { turnId: 't1', runtimeGeneration: 'g1', streamId: 'stream1', blockId: 'b1', sourceRevision: 2, state: 'SEALED', semanticType: 'assistant_message' } }
let client: QueryClient
let root: Root
let container: HTMLDivElement
let snapshots: Record<string, SessionTranslationOverlay[]>
const get = vi.mocked(apiClient.get)
function event(name: string, data?: unknown) { for (const handler of socket.handlers.get(name) ?? []) handler(data as never) }
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)) }) }
function Consumer({ sessionId, logs, name }: { sessionId: string; logs: LogEntry[]; name: string }) {
  const query = useSessionTranslations(sessionId, logs)
  snapshots[name] = query.overlays
  return <div data-consumer={name}>{logs.map(item => matchingTranslation(sessionId, item, query.overlays)?.translatedText ?? item.content).join('|')}</div>
}
async function render(children: React.ReactNode) { act(() => root.render(<QueryClientProvider client={client}>{children}</QueryClientProvider>)); await flush() }
beforeEach(() => {
  vi.clearAllMocks(); socket.handlers.clear(); snapshots = {}
  socket.on.mockImplementation((name, handler) => { const set = socket.handlers.get(name) ?? new Set(); set.add(handler); socket.handlers.set(name, set) })
  socket.off.mockImplementation((name, handler) => { socket.handlers.get(name)?.delete(handler) })
  socket.emit.mockImplementation((_name, _payload, ack) => { if (typeof ack === 'function') queueMicrotask(() => ack({ success: true })) })
  get.mockResolvedValue({ items: [overlay], nextCursor: null })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); client.clear() })

describe('Session translation read model', () => {
  it('matches actual Session, runtime turn, block, revision and exact body; excludes open/thinking/tools', () => {
    expect(matchingTranslation('s1', log, [overlay])).toEqual(overlay)
    expect(matchingTranslation('s2', log, [overlay])).toBeUndefined()
    for (const item of [
      { ...log, content: 'original ' }, { ...log, type: LogType.Tool }, { ...log, title: 'Thinking' },
      { ...log, textBlock: { ...log.textBlock!, state: 'OPEN' as const } },
      { ...log, textBlock: { ...log.textBlock!, turnId: 'different' } },
      { ...log, textBlock: { ...log.textBlock!, sourceRevision: 3 } },
    ]) expect(matchingTranslation('s1', item, [overlay])).toBeUndefined()
  })

  it('follows empty pages with a cursor and splits more than 100 block IDs into sequential bounded reads', async () => {
    get.mockReset()
    get.mockResolvedValueOnce({ items: [], nextCursor: 'p2' })
      .mockResolvedValueOnce({ items: [overlay], nextCursor: null })
      .mockResolvedValueOnce({ items: [], nextCursor: null })
    const result = await readSessionTranslations('s1', Array.from({ length: 101 }, (_, i) => `block-${i}`), new AbortController().signal)
    expect(result).toEqual([overlay])
    expect(get.mock.calls.map(call => call[1]?.params?.blockIds.split(',').length)).toEqual([100, 100, 1])
    expect(get.mock.calls[1][1]?.params?.cursor).toBe('p2')
  })

  it('rejects lower overlay revisions, but authoritative omissions remove previous success', () => {
    expect(mergeTranslationSnapshot([overlay], [{ ...overlay, overlayRevision: 7, state: 'PENDING' }])).toEqual([overlay])
    expect(mergeTranslationSnapshot([overlay], [])).toEqual([])
  })

  it('shares subscriptions, keeps them until the last consumer, and restores them on reconnect', async () => {
    await render(<><Consumer name="a" sessionId="s1" logs={[log]} /><Consumer name="b" sessionId="s1" logs={[log]} /></>)
    expect(socket.emit.mock.calls.filter(call => call[0] === ClientEvents.SUBSCRIBE)).toHaveLength(1)
    expect(container.textContent).toBe('translationtranslation')
    await render(<Consumer name="a" sessionId="s1" logs={[log]} />)
    expect(socket.emit.mock.calls.filter(call => call[0] === ClientEvents.UNSUBSCRIBE)).toHaveLength(0)
    const before = get.mock.calls.length
    act(() => event('connect')); await flush()
    expect(socket.emit.mock.calls.filter(call => call[0] === ClientEvents.SUBSCRIBE)).toHaveLength(2)
    expect(get.mock.calls.length).toBeGreaterThan(before)
    await render(null)
    expect(socket.emit.mock.calls.filter(call => call[0] === ClientEvents.UNSUBSCRIBE)).toHaveLength(1)
  })

  it('re-reads when invalidated during the very first REST request and never installs its stale result', async () => {
    let finish!: (value: { items: SessionTranslationOverlay[]; nextCursor: null }) => void
    get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }) as never)
    act(() => root.render(<QueryClientProvider client={client}><Consumer name="a" sessionId="s1" logs={[log]} /></QueryClientProvider>))
    act(() => event(ServerEvents.TRANSLATION_INVALIDATED, { sessionId: 's1', overlayRevision: 8 }))
    await act(async () => finish({ items: [{ ...overlay, overlayRevision: 1, translatedText: 'stale' }], nextCursor: null })); await flush()
    expect(get.mock.calls.length).toBeGreaterThan(1)
    expect(container.textContent).toBe('translation')
  })

  it('clears absent/forbidden overlays and does not leak a previous Session or revised body', async () => {
    await render(<Consumer name="a" sessionId="s1" logs={[log]} />)
    expect(container.textContent).toBe('translation')
    get.mockResolvedValue({ items: [], nextCursor: null })
    act(() => event(ServerEvents.TRANSLATION_INVALIDATED, { sessionId: 's1' })); await flush()
    expect(container.textContent).toBe('original')
    get.mockResolvedValue({ items: [overlay], nextCursor: null })
    act(() => event(ServerEvents.TRANSLATION_INVALIDATED, { sessionId: 's1' })); await flush()
    expect(container.textContent).toBe('translation')
    get.mockRejectedValue(new ApiError(403, 'denied'))
    act(() => event(ServerEvents.TRANSLATION_INVALIDATED, { sessionId: 's1' })); await flush()
    expect(snapshots.a).toEqual([])
    let finish!: (value: { items: SessionTranslationOverlay[]; nextCursor: null }) => void
    get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }) as never)
    await render(<Consumer name="a" sessionId="s1" logs={[log, { ...log, id: 'new', content: 'new', textBlock: { ...log.textBlock!, blockId: 'new' } }]} />)
    expect(container.textContent).toBe('original|new')
    await act(async () => finish({ items: [], nextCursor: null })); await flush()
    get.mockResolvedValue({ items: [overlay], nextCursor: null })
    await render(<Consumer name="a" sessionId="s2" logs={[log]} />)
    expect(container.textContent).toBe('original')
    await render(<Consumer name="a" sessionId="s1" logs={[{ ...log, content: 'revised' }]} />)
    expect(container.textContent).toBe('revised')
  })

  it('retains a matching success while another block is loading, then removes it if the new authority omits it', async () => {
    await render(<Consumer name="a" sessionId="s1" logs={[log]} />)
    let finish!: (value: { items: SessionTranslationOverlay[]; nextCursor: null }) => void
    get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }) as never)
    const second = { ...log, id: 'log-b', content: 'second', textBlock: { ...log.textBlock!, blockId: 'b2' } }
    await render(<Consumer name="a" sessionId="s1" logs={[log, second]} />)
    expect(container.textContent).toBe('translation|second')
    await act(async () => finish({ items: [], nextCursor: null })); await flush()
    expect(container.textContent).toBe('original|second')
  })
})
