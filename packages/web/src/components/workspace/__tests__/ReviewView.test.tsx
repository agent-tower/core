// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitDiffResponse } from '@/hooks/use-git'
import { queryKeys } from '@/hooks/query-keys'
import { ReviewView } from '../ReviewView'
import { buildReviewRows, estimateReviewRow, ROW_GAP, SECTION_HEIGHT } from '../review-rows'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const get = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api-client', () => ({ apiClient: { get } }))
vi.mock('@/lib/i18n', () => {
  const t = (source: string, values?: Record<string, unknown>) =>
    source.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key] ?? ''))
  return { useI18n: () => ({ t }), translate: t }
})
vi.mock('@/lib/socket/manager', () => {
  const socket = { connected: false, on: () => socket, off: () => socket, emit: () => socket }
  return { socketManager: { connect: () => socket } }
})

const dir = '/review'
const entries = Array.from({ length: 300 }, (_, i) => ({
  path: `dir/file-${i}.ts`, status: 'M', additions: 1, token: 'v1',
}))
const changes = { uncommitted: entries, committed: [] }
const rows = buildReviewRows(changes)
const cardHeight = estimateReviewRow(rows[1])
const start = (file: number) => SECTION_HEIGHT + ROW_GAP + file * (cardHeight + ROW_GAP)

class RowObserver {
  static observers: RowObserver[] = []
  targets = new Set<Element>()
  private callback: ResizeObserverCallback
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    RowObserver.observers.push(this)
  }
  observe(target: Element) { this.targets.add(target) }
  unobserve(target: Element) { this.targets.delete(target) }
  disconnect() { this.targets.clear() }
  static resize(target: Element) {
    const observer = this.observers.find(item => item.targets.has(target))
    if (!observer) throw new Error('Row is not observed')
    observer.callback([{ target } as ResizeObserverEntry], observer as unknown as ResizeObserver)
  }
}

describe('virtual review', () => {
  let container: HTMLDivElement
  let root: Root
  let client: QueryClient
  let viewport: HTMLElement
  const heights = new Map<number, number>()
  const requests: { path: string; force?: string; signal: AbortSignal; answer: (answer: GitDiffResponse) => void }[] = []
  const scrollOptions: ScrollToOptions[] = []

  const card = (i: number) => container.querySelector<HTMLElement>(`[data-card-key="uncommitted:${entries[i].path}"]`)
  const mounted = () => [...container.querySelectorAll('[data-card-key]')]
  async function scroll(top: number) {
    await act(async () => {
      viewport.scrollTop = top
      viewport.dispatchEvent(new Event('scroll'))
    })
  }
  async function jump(i: number) {
    await act(async () => container.querySelector<HTMLButtonElement>(`[title="${entries[i].path}"]`)!.click())
  }
  async function advance(ms: number) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
  }
  async function answer(i: number, response: GitDiffResponse) {
    const request = requests.filter(item => item.path === entries[i].path).at(-1)!
    await act(async () => { request.answer(response) })
    await advance(1)
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.stubGlobal('ResizeObserver', RowObserver)
    RowObserver.observers = []
    heights.clear()
    requests.length = 0
    scrollOptions.length = 0
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute('data-review-scroll')) return 600
      if (this.dataset.index === '0') return SECTION_HEIGHT
      return heights.get(Number(this.dataset.index)) ?? cardHeight
    })
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(100_000)
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    vi.spyOn(Element.prototype, 'scrollTo').mockImplementation(function (this: Element, options?: ScrollToOptions | number) {
      if (typeof options !== 'object') return
      scrollOptions.push(options)
      if (options.top === undefined || options.top === this.scrollTop) return
      this.scrollTop = options.top
      queueMicrotask(() => this.dispatchEvent(new Event('scroll')))
    })
    get.mockImplementation((url: string, { params, signal }) => {
      if (url === '/git/changes') return Promise.resolve(changes)
      if (url === '/git/log') return Promise.resolve({ commits: [] })
      if (url !== '/git/diff') throw new Error(url)
      return new Promise<GitDiffResponse>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        requests.push({ ...params, signal, answer: resolve })
      })
    })
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(queryKeys.git.changes(dir), changes)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(<QueryClientProvider client={client}><ReviewView workingDir={dir} /></QueryClientProvider>)
    })
    viewport = container.querySelector('[data-review-scroll]')!
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    client.clear()
    container.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('requests the clicked row first during a scroll and aligns it below the pinned label', async () => {
    await scroll(start(25))
    const before = requests.length
    await jump(190)
    expect(scrollOptions.at(-1)).toMatchObject({ top: start(190) - SECTION_HEIGHT })
    expect(scrollOptions.some(options => options.behavior === 'smooth')).toBe(false)
    expect(requests.slice(before).map(item => item.path)).toEqual([entries[190].path])
    expect(card(190)?.className).toContain('ring-2')
    expect(container.querySelector('[aria-current="true"]')?.getAttribute('title')).toBe(entries[190].path)
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })

    await advance(151)
    expect(requests.length - before).toBe(mounted().length)

    const top = viewport.scrollTop
    const resize = async (file: number, delta: number) => {
      heights.set(file + 1, cardHeight + delta)
      await act(async () => RowObserver.resize(card(file)!.closest('[data-index]')!))
    }
    // A wheel step can reach the DOM just before an observer delivery, while
    // the virtualizer still holds the preceding scroll event's offset.
    viewport.scrollTop -= 20
    await resize(189, 250)
    expect(viewport.scrollTop).toBe(top - 20 + 250)
    await resize(190, 200)
    await resize(191, 100)
    expect(viewport.scrollTop).toBe(top - 20 + 250)
  })

  it('keeps the target aligned when equal-height placeholders receive their cached answers together', async () => {
    await jump(190)
    await advance(151)
    const top = viewport.scrollTop
    const windowKeys = () => mounted().map(node => node.getAttribute('data-card-key'))
    const originalWindow = windowKeys()
    const originalRequests = requests.length
    const response: GitDiffResponse = { kind: 'text', token: 'v1', diff: Array(10).fill('+line').join('\n') }
    const neighbors = [188, 189]
    await act(async () => {
      for (const i of neighbors) requests.find(request => request.path === entries[i].path)!.answer(response)
    })
    await advance(1)
    // The cache can resolve both queries before ResizeObserver delivers the second row.
    for (const i of neighbors) {
      heights.set(i + 1, estimateReviewRow(rows[i + 1], {}, response))
      await act(async () => RowObserver.resize(card(i)!.closest('[data-index]')!))
    }
    expect(viewport.scrollTop).toBe(top - 2 * 3 * 20)
    const targetStart = parseFloat(card(190)!.closest<HTMLElement>('[data-index]')!.style.top)
    expect(targetStart - viewport.scrollTop).toBe(SECTION_HEIGHT)
    expect(windowKeys()).toEqual(originalWindow)
    expect(requests).toHaveLength(originalRequests)
  })

  it('keeps a bounded window, cancels departing requests and waits for scrolling to settle', async () => {
    const initial = requests.slice()
    expect(initial.length).toBeGreaterThan(0)
    expect(mounted().length).toBeLessThan(9)
    for (const i of [10, 60, 110, 160, 210, 260, 299]) {
      await scroll(start(i))
      expect(mounted().length).toBeLessThan(9)
    }
    expect(initial.every(request => request.signal.aborted)).toBe(true)
    expect(requests).toHaveLength(initial.length)
    await advance(149)
    expect(requests).toHaveLength(initial.length)
    await advance(2)
    expect(requests.length - initial.length).toBe(mounted().length)
  })

  it('keeps collapse, forced loading and expanded lines through eviction, and forgets removed files', async () => {
    await act(async () => card(0)!.querySelector('button')!.click())
    await answer(1, { kind: 'too_large', token: 'v1', limit: 1_048_576, oldSize: 5, newSize: 1_500_000, canForce: true })
    await act(async () => card(1)!.querySelector<HTMLElement>('[data-testid="file-diff-notice"] button')!.click())
    expect(requests.at(-1)).toMatchObject({ path: entries[1].path, force: '1' })
    const diff = Array.from({ length: 402 }, (_, i) => `+line-${i}`).join('\n')
    await answer(1, { kind: 'text', token: 'v1', diff })
    expect(card(1)?.textContent).not.toContain('+line-401')
    await act(async () => card(1)!.querySelectorAll('button')[1].click())
    expect(card(1)?.textContent).toContain('+line-401')

    await scroll(start(110))
    expect(card(0)).toBeNull()
    expect(card(1)).toBeNull()
    const before = requests.length
    await scroll(0)
    expect(card(0)?.querySelector('button')?.getAttribute('aria-expanded')).toBe('false')
    expect(card(1)?.textContent).toContain('+line-401')
    expect(requests).toHaveLength(before)

    await act(async () => { client.setQueryData(queryKeys.git.changes(dir), { ...changes, uncommitted: entries.slice(2) }) })
    await advance(1)
    await act(async () => { client.setQueryData(queryKeys.git.changes(dir), changes) })
    await advance(1)
    expect(card(0)?.querySelector('button')?.getAttribute('aria-expanded')).toBe('true')
    expect(card(1)?.textContent).not.toContain('+line-401')
  })
})
