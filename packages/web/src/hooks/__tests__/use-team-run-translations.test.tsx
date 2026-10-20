// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoomMessage, TeamRun, TeamRunTranslationOverlaySummary } from '@agent-tower/shared'
import { ClientEvents, ServerEvents } from '@agent-tower/shared/socket'
import { apiClient, ApiError } from '@/lib/api-client'
import { useTeamRunTranslations, readTeamRunTranslations, mergeRoomTranslationSnapshot, type RoomTranslations } from '../use-team-run-translations'
import { useLoginAccessAuth } from '../use-access-auth'
import { queryKeys } from '../query-keys'
import { RoomTimeline } from '@/components/team/RoomTimeline'
import { I18nProvider } from '@/lib/i18n'
const socket = vi.hoisted(() => ({ connected: true, handlers: new Map<string, Set<(...args: never[]) => void>>(), emit: vi.fn(), on: vi.fn(), off: vi.fn() }))
vi.mock('@/lib/socket/manager', () => ({ socketManager: { connect: () => socket, getSocket: () => socket } }))
vi.mock('@/lib/api-client', async original => ({ ...await original<typeof import('@/lib/api-client')>(), apiClient: { get: vi.fn(), post: vi.fn() } }))
vi.mock('@/hooks/use-app-settings', () => ({ useAppSettings: () => ({ data: { locale: 'en' } }), useUpdateAppSettings: () => ({ mutate: vi.fn() }) }))
vi.mock('@/hooks/use-translation-settings', async original => ({ ...await original<typeof import('@/hooks/use-translation-settings')>(), useTranslationSettings: () => ({ data: { enabled: false } }) }))
vi.mock('@/hooks/use-providers', () => ({ useProviders: () => ({ data: [] }) }))
vi.mock('use-stick-to-bottom', async () => {
  const { useRef } = await import('react')
  return { useStickToBottom: () => ({ scrollRef: useRef(null), contentRef: useRef(null), isAtBottom: true, scrollToBottom: vi.fn() }) }
})
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const message = (id = 'm1', overrides = {}): RoomMessage => ({ id, teamRunId: 'r1', senderType: 'agent', senderId: 'member', visibility: 'PUBLIC', kind: 'chat', content: 'Original preview…', contentPreview: 'Original preview…', isTruncated: true, mentions: [], createdAt: '2026-01-01', ...overrides })
const overlay = (id = 'm1', overrides = {}): TeamRunTranslationOverlaySummary => ({ messageId: id, teamRunId: 'r1', sourceId: `source-${id}`, sourceRevision: 3, overlayRevision: 8, originalTextPreview: 'Original '.repeat(250), translatedTextPreview: '译文', originalTextTruncated: true, translatedTextTruncated: false, state: 'SUCCESS', targetLanguage: 'Chinese', errorCode: null, ...overrides })
const full = (id = 'm1', overrides = {}) => { const { originalTextPreview: _original, translatedTextPreview: _translated, originalTextTruncated: _a, translatedTextTruncated: _b, ...metadata } = overlay(id); void [_original, _translated, _a, _b]; return { ...metadata, originalText: 'Original complete\n\n', translatedText: '完整译文\n\n', ...overrides } }
const get = vi.mocked(apiClient.get)
const post = vi.mocked(apiClient.post)
let client: QueryClient; let root: Root; let container: HTMLDivElement
let states: Record<string, RoomTranslations>
function event(name: string, payload?: unknown) { for (const handler of socket.handlers.get(name) ?? []) handler(payload as never) }
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)) }) }
function Consumer({ name, messages = [message()], id = 'r1' }: { name: string; messages?: RoomMessage[]; id?: string }) {
  const value = useTeamRunTranslations(id, messages)
  useEffect(() => { states[name] = value }, [name, value])
  return <div data-name={name}>{value.overlays.map(row => row.translatedTextPreview).join('|')}</div>
}
function Login() { const login = useLoginAccessAuth(); return <button onClick={() => login.mutate('fixture-password')}>Login</button> }
async function render(children: React.ReactNode) { act(() => root.render(<QueryClientProvider client={client}>{children}</QueryClientProvider>)); await flush() }
beforeEach(() => {
  vi.clearAllMocks(); socket.handlers.clear(); states = {}
  socket.on.mockImplementation((name, handler) => { const handlers = socket.handlers.get(name) ?? new Set(); handlers.add(handler); socket.handlers.set(name, handlers) })
  socket.off.mockImplementation((name, handler) => { socket.handlers.get(name)?.delete(handler) })
  socket.emit.mockImplementation((_event, _payload, ack) => { if (typeof ack === 'function') queueMicrotask(() => ack({ success: true })) })
  get.mockReset(); get.mockImplementation(async (url, options) => {
    if (url.endsWith('/translation')) return full() as never
    return { items: String(options?.params?.messageIds ?? '').split(',').filter(Boolean).map(id => overlay(id)) } as never
  })
  post.mockReset(); post.mockResolvedValue({})
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); client.clear() })

describe('real RoomTimeline translation read hook', () => {
  it('reads 101 confirmed PUBLIC Agent IDs as 100+1 and installs only a complete authoritative snapshot', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `m-${i}`)
    const result = await readTeamRunTranslations('r1', ids, new AbortController().signal)
    expect(result).toHaveLength(101); expect(get.mock.calls.map(call => String(call[1]?.params?.messageIds).split(',').length)).toEqual([100, 1])
    get.mockClear()
    await render(<Consumer name="a" messages={[message(), message('user', { senderType: 'user' }), message('private', { visibility: 'PRIVATE' }), message('pending-local')]} />)
    expect(states.a!.overlays.map(row => row.messageId)).toEqual(['m1'])
    // 240-char message previews deliberately differ from 2000-char overlay previews.
    expect(container.textContent).toBe('译文')
    expect(mergeRoomTranslationSnapshot([overlay()], [overlay('m1', { overlayRevision: 7 })])).toEqual([overlay()])
    expect(mergeRoomTranslationSnapshot([overlay()], [])).toEqual([])
    get.mockRejectedValueOnce(new Error('second batch failed'))
    await expect(readTeamRunTranslations('r1', ids, new AbortController().signal)).rejects.toThrow('second batch failed')
  })

  it('shares a single subscription and retains a shared in-flight summary when its first consumer unmounts', async () => {
    await render(<><Consumer key="a" name="a" /><Consumer key="b" name="b" /></>)
    expect(socket.emit.mock.calls.filter(call => call[0] === ClientEvents.SUBSCRIBE)).toHaveLength(1)
    let release!: (value: unknown) => void
    get.mockImplementationOnce(() => new Promise(resolve => { release = resolve }) as never)
    act(() => event(ServerEvents.TRANSLATION_INVALIDATED, { teamRunId: 'r1', messageId: 'm1', sourceId: 'source-m1', sourceRevision: 3, overlayRevision: 9 })); await flush()
    await render(<><Consumer key="b" name="b" /></>)
    await act(async () => release({ items: [overlay('m1', { overlayRevision: 9, translatedTextPreview: '新版' })] })); await flush()
    expect(states.b!.overlays[0]?.translatedTextPreview).toBe('新版')
    // Re-render with stable keyed consumers to exercise the true ref-count path.
    await render(<><Consumer key="a" name="a" /><Consumer key="b" name="b" /></>)
    const subscriptions = socket.emit.mock.calls.filter(call => call[0] === ClientEvents.SUBSCRIBE).length
    await render(<><Consumer key="b" name="b" /></>)
    expect(socket.emit.mock.calls.filter(call => call[0] === ClientEvents.SUBSCRIBE)).toHaveLength(subscriptions)
    const before = get.mock.calls.length; act(() => event('connect')); await flush(); expect(get.mock.calls.length).toBeGreaterThan(before)
  })

  it('re-reads first-request invalidation, merges duplicate signals and tolerates old source IDs/revisions', async () => {
    let release!: (value: unknown) => void
    get.mockImplementationOnce(() => new Promise(resolve => { release = resolve }) as never)
    act(() => root.render(<QueryClientProvider client={client}><Consumer name="a" /></QueryClientProvider>))
    act(() => {
      for (let i = 0; i < 5; i++) event(ServerEvents.TRANSLATION_INVALIDATED, { teamRunId: 'r1', messageId: 'm1', sourceId: 'old-deleted-source', sourceRevision: 1, overlayRevision: 9999 })
    })
    await act(async () => release({ items: [overlay('m1', { overlayRevision: 1, translatedTextPreview: 'stale' })] })); await flush()
    expect(container.textContent).toBe('译文')
    await expect(states.a!.loadFull(states.a!.overlays[0]!)).resolves.toEqual(full())
    expect(get.mock.calls.length).toBeLessThan(8)
  })

  it('does not let disjoint consumers remove or abort each other’s full reads', async () => {
    await render(<><Consumer name="a" messages={[message('m1')]} /><Consumer name="b" messages={[message('m2')]} /></>)
    let release!: (value: unknown) => void; let signal: AbortSignal | undefined
    get.mockImplementationOnce((_url, options) => { signal = options?.signal ?? undefined; return new Promise(resolve => { release = resolve }) as never })
    const request = states.a!.loadFull(states.a!.overlays[0]!)
    await flush(); await render(<><Consumer name="a" messages={[message('m1')]} /><Consumer name="b" messages={[message('m2')]} /></>)
    expect(signal?.aborted).toBe(false)
    await act(async () => release(full())); await expect(request).resolves.toEqual(full())
  })

  it('forbidden REST synchronously hides every owner, clears full cache and prevents late responses', async () => {
    await render(<><Consumer key="a" name="a" /><Consumer key="b" name="b" /></>)
    get.mockRejectedValueOnce(new ApiError(403, 'Forbidden'))
    await act(async () => { await expect(states.a!.loadFull(states.a!.overlays[0]!)).rejects.toBeTruthy() }); await flush()
    expect(states.a!.overlays).toEqual([]); expect(states.b!.overlays).toEqual([])
    expect(client.getQueryCache().findAll({ queryKey: queryKeys.roomTranslations.scope('r1') }).every(query => query.state.data === undefined)).toBe(true)
    expect(container.textContent).toBe('')
  })

  it('keeps a shared full read alive after its initiating owner unmounts', async () => {
    await render(<><Consumer key="a" name="a" /><Consumer key="b" name="b" /></>)
    let release!: (value: unknown) => void
    get.mockImplementationOnce(() => new Promise(resolve => { release = resolve }) as never)
    const a = states.a!.loadFull(states.a!.overlays[0]!).catch(error => error)
    const b = states.b!.loadFull(states.b!.overlays[0]!)
    await render(<><Consumer key="b" name="b" /></>)
    await act(async () => release(full()))
    expect(await a).toBeInstanceOf(DOMException)
    await expect(b).resolves.toEqual(full())
  })

  it.each(['detail', 'retry'] as const)('%s 404 immediately withdraws only that item across differing consumers while REST hangs', async kind => {
    const consumers = [<Consumer key="a" name="a" messages={[message(), message('m2')]} />, <Consumer key="b" name="b" messages={[message(), message('m2'), message('m3')]} />]
    await render(consumers)
    const before = states.a!
    const row = before.overlays[0]!
    client.setQueryData(queryKeys.roomTranslations.full('r1', 'm2', 'source-m2', 3, 8), full('m2'))
    const signals: AbortSignal[] = []
    get.mockImplementation((url, options) => {
      if (url.endsWith('/translation')) return Promise.reject(new ApiError(404, 'Missing source')) as never
      if (options?.signal) signals.push(options.signal)
      return new Promise(() => undefined) as never
    })
    post.mockRejectedValueOnce(new ApiError(404, 'Missing source'))
    await act(async () => {
      await expect(kind === 'detail' ? before.loadFull(row) : before.retry(row)).rejects.toBeTruthy()
      // No React render or replacement snapshot is needed to invalidate an old action.
      expect(before.isCurrent(row)).toBe(false)
      expect(states.b!.isCurrent(row)).toBe(false)
    })
    await flush()
    expect(states.a!.overlays.map(row => row.messageId)).toEqual(['m2'])
    expect(states.b!.overlays.map(row => row.messageId)).toEqual(['m2', 'm3'])
    expect(signals.length).toBeGreaterThanOrEqual(2)
    expect(client.getQueryCache().findAll({ queryKey: [...queryKeys.roomTranslations.details('r1'), 'm1'] })).toHaveLength(0)
    expect(client.getQueryData(queryKeys.roomTranslations.full('r1', 'm2', 'source-m2', 3, 8))).toEqual(full('m2'))
    await expect(before.retry(row)).rejects.toBeInstanceOf(DOMException)
    // A new consumer must not resurrect a revoked cached summary variant.
    await render([...consumers, <Consumer key="c" name="c" />])
    expect(states.c!.overlays).toEqual([])
    expect(states.b!.overlays.map(row => row.messageId)).toEqual(['m2', 'm3'])
  })

  it('cancels pre-404 summary/detail, ignores their late bytes and permits only fresh REST recovery', async () => {
    await render(<><Consumer key="a" name="a" messages={[message(), message('m2')]} /><Consumer key="b" name="b" messages={[message(), message('m2')]} /></>)
    const before = states.a!; const row = before.overlays[0]!
    const summaries: { resolve: (value: unknown) => void; signal?: AbortSignal | null }[] = []
    const details = new Map<string, { resolve: (value: unknown) => void; signal?: AbortSignal | null }>()
    get.mockImplementation((url, options) => new Promise(resolve => {
      const pending = { resolve, signal: options?.signal }
      if (url.endsWith('/translation')) details.set(url.includes('/m1/') ? 'm1' : 'm2', pending)
      else summaries.push(pending)
    }) as never)
    act(() => { void client.invalidateQueries({ queryKey: queryKeys.roomTranslations.summaries('r1') }) }); await flush()
    const stale = before.loadFull(row).catch(error => error)
    const unaffected = before.loadFull(before.overlays[1]!)
    post.mockRejectedValueOnce(new ApiError(404, 'Missing source'))
    await act(async () => { await expect(before.retry(row)).rejects.toBeTruthy() }); await flush()
    expect(summaries).toHaveLength(2)
    expect(summaries[0]!.signal?.aborted).toBe(true)
    expect(details.get('m1')!.signal?.aborted).toBe(true)
    expect(details.get('m2')!.signal?.aborted).toBe(false)
    await act(async () => {
      summaries[0]!.resolve({ items: [overlay(), overlay('m2')] })
      details.get('m1')!.resolve(full())
      details.get('m2')!.resolve(full('m2'))
    }); await flush()
    expect(await stale).toBeInstanceOf(Error)
    await expect(unaffected).resolves.toEqual(full('m2'))
    expect(states.a!.overlays.map(row => row.messageId)).toEqual(['m2'])
    expect(client.getQueryCache().findAll({ queryKey: [...queryKeys.roomTranslations.details('r1'), 'm1'] })).toHaveLength(0)
    // Same source/revisions may become readable again, but old closures stay revoked.
    await act(async () => summaries[1]!.resolve({ items: [overlay(), overlay('m2')] })); await flush()
    expect(states.a!.overlays.map(row => row.messageId)).toEqual(['m1', 'm2'])
    expect(states.a!.isCurrent(states.a!.overlays[0]!)).toBe(true)
    expect(before.isCurrent(row)).toBe(false)
    get.mockResolvedValue(full())
    await expect(states.b!.loadFull(states.b!.overlays[0]!)).resolves.toEqual(full())
  })

  it.each(['detail', 'retry'] as const)('%s 404 unmounts an open real RoomTimeline comparison and blocks stale clipboard output', async kind => {
    const teamRun = { id: 'r1', taskId: 'task', members: [], invocations: [], mode: 'AUTO' } as unknown as TeamRun
    await render(<I18nProvider><section data-timeline><RoomTimeline teamRun={teamRun} messages={[message(), message('m2')]} onSendMessage={vi.fn()} /></section><Consumer name="b" messages={[message(), message('m2')]} /></I18nProvider>)
    const copy = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } })
    const row = states.b!.overlays[0]!
    let release!: (value: unknown) => void
    let detailSignal: AbortSignal | null | undefined
    if (kind === 'retry') get.mockImplementationOnce((_url, options) => {
      detailSignal = options?.signal
      return new Promise(resolve => { release = resolve }) as never
    })
    await act(async () => (container.querySelector('[aria-haspopup="dialog"]') as HTMLButtonElement).click()); await flush()
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    const staleCopy = document.querySelector<HTMLButtonElement>('[aria-label="Copy original"]')!
    if (kind === 'retry') await act(async () => staleCopy.click())
    get.mockImplementation(url => url.endsWith('/translation') ? Promise.reject(new ApiError(404, 'Missing source')) as never : new Promise(() => undefined) as never)
    post.mockRejectedValueOnce(new ApiError(404, 'Missing source'))
    await act(async () => {
      await expect(kind === 'detail' ? states.b!.loadFull(row) : states.b!.retry(row)).rejects.toBeTruthy()
      // The DOM may still exist until React commits; its copy guard is already closed.
      if (kind === 'detail') staleCopy.click()
    }); await flush()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(container.querySelectorAll('[aria-haspopup="dialog"]')).toHaveLength(1)
    expect(states.b!.overlays.map(row => row.messageId)).toEqual(['m2'])
    expect(client.getQueryCache().findAll({ queryKey: [...queryKeys.roomTranslations.details('r1'), 'm1'] })).toHaveLength(0)
    if (kind === 'retry') {
      expect(detailSignal?.aborted).toBe(true)
      await act(async () => release(full())); await flush()
    }
    expect(copy).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('Original complete')
    // The unrelated message remains readable and its sole comparison copy
    // action still loads the complete original after the first item is revoked.
    get.mockImplementationOnce(() => Promise.resolve(full('m2')) as never)
    await act(async () => (container.querySelector('[data-timeline] [aria-haspopup="dialog"]') as HTMLButtonElement).click()); await flush()
    await act(async () => (document.querySelector('[role="dialog"] [aria-label="Copy original"]') as HTMLButtonElement).click())
    expect(copy).toHaveBeenCalledExactlyOnceWith('Original complete\n\n')
  })

  it('subscription rejection clears readable data, and reconnect requires a fresh REST success', async () => {
    await render(<Consumer name="a" />)
    socket.emit.mockImplementation((_event, _payload, ack) => { if (typeof ack === 'function') queueMicrotask(() => ack({ success: false })) })
    act(() => event('connect')); await flush(); expect(states.a!.overlays).toEqual([])
    expect(client.getQueryCache().findAll({ queryKey: queryKeys.roomTranslations.details('r1') })).toHaveLength(0)
    socket.emit.mockImplementation((_event, _payload, ack) => { if (typeof ack === 'function') queueMicrotask(() => ack({ success: true })) })
    act(() => event('connect')); await flush(); await flush(); expect(container.textContent).toBe('译文')
  })

  it('server disconnect immediately revokes all owners before the next REST poll', async () => {
    await render(<><Consumer key="a" name="a" /><Consumer key="b" name="b" /></>)
    act(() => event('disconnect', 'io server disconnect'))
    expect(states.a!.overlays).toEqual([]); expect(states.b!.overlays).toEqual([])
    expect(client.getQueryCache().findAll({ queryKey: queryKeys.roomTranslations.details('r1') })).toHaveLength(0)
    act(() => event('connect')); await flush(); await flush()
    expect(states.a!.overlays).toHaveLength(1); expect(states.b!.overlays).toHaveLength(1)
  })

  it('removes authoritative missing records and refuses an old full response after PUBLIC identity changes', async () => {
    await render(<Consumer name="a" />)
    let release!: (value: unknown) => void; let signal: AbortSignal | undefined
    get.mockImplementationOnce((_url, options) => { signal = options?.signal ?? undefined; return new Promise(resolve => { release = resolve }) as never })
    const pending = states.a!.loadFull(states.a!.overlays[0]!).catch(error => error)
    await render(<Consumer name="a" messages={[message('m1', { visibility: 'PRIVATE' })]} />)
    expect(states.a!.overlays).toEqual([])
    expect(signal?.aborted).toBe(true)
    expect(client.getQueryCache().findAll({ queryKey: queryKeys.roomTranslations.details('r1') })).toHaveLength(0)
    await act(async () => release(full())); expect(await pending).toBeInstanceOf(Error)
    get.mockResolvedValue({ items: [] })
    await render(<Consumer name="a" />); expect(states.a!.overlays).toEqual([])
  })

  it('clears identity-scoped full data before login and prevents an old identity’s late response from filling the new scope', async () => {
    await render(<><Consumer name="a" /><Login /></>)
    let release!: (value: unknown) => void; let loginDone!: (value: unknown) => void
    get.mockImplementationOnce(() => new Promise(resolve => { release = resolve }) as never)
    const pending = states.a!.loadFull(states.a!.overlays[0]!).catch(error => error)
    post.mockImplementationOnce(() => new Promise(resolve => { loginDone = resolve }) as never)
    await act(async () => container.querySelector('button')!.click()); await flush()
    expect(states.a!.overlays).toEqual([])
    await act(async () => release(full())); expect(await pending).toBeInstanceOf(Error)
    await act(async () => loginDone({ enabled: false, authenticated: true })); await flush()
    expect(container.textContent).toContain('译文')
  })

  it('rejects lower full revisions; single retry uses sourceRevision and never automatically repeats a failed POST', async () => {
    await render(<Consumer name="a" />)
    get.mockResolvedValue(full('m1', { overlayRevision: 7 }))
    await expect(states.a!.loadFull(states.a!.overlays[0]!)).rejects.toThrow('detail changed')
    const row = states.a!.overlays[0]!
    post.mockRejectedValueOnce(new Error('Network result unknown'))
    await expect(states.a!.retry(row)).rejects.toThrow('Network result unknown')
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith('/team-runs/r1/translations/source-m1/retry', { expectedRevision: 3 })
  })
})
