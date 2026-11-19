// @vitest-environment happy-dom
/**
 * Diff cards fetch a file's diff once per version token: an unchanged token is answered from the
 * cache, a new token loads the new version while the old one stays shown. Binary files and files
 * above the size limit show a notice, "Load anyway" asks again with `force`, and a card that goes
 * away aborts its request.
 */
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitFileDiffResponse } from '@agent-tower/shared'
import { queryKeys } from '@/hooks/query-keys'
import type { GitChangeEntry, GitChangesResponse } from '@/hooks/use-git'
import { MobileChangesView } from '@/components/mobile/MobileChangesView'
import { DiffCard } from '../ReviewView'
import { type CardState } from '../review-rows'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const getMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api-client', () => ({ apiClient: { get: getMock } }))
vi.mock('@/lib/socket/manager', () => {
  const socket = { connected: false, on: () => socket, off: () => socket, emit: () => socket }
  return { socketManager: { connect: () => socket } }
})
vi.mock('@/lib/i18n', () => {
  const t = (source: string, values?: Record<string, unknown>) => (
    source.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key] ?? ''))
  )
  return { useI18n: () => ({ t }), translate: t }
})

function MountedCard({ entry }: { entry: GitChangeEntry }) {
  const [state, setState] = useState<CardState>({})
  return (
    <DiffCard
      row={{ kind: 'card', key: `uncommitted:${entry.path}`, entry, source: { kind: 'working', diffType: 'uncommitted' } }}
      workingDir={DIR}
      state={state}
      onStateChange={(_key, patch) => setState(previous => ({ ...previous, ...patch }))}
      mayLoad
      flash={false}
    />
  )
}

const DIR = '/repo/workspace-1'

/** TanStack Query notifies observers in a macrotask; let those (and the renders they cause) run. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

interface DiffCall {
  params: Record<string, string>
  signal: AbortSignal | undefined
  answer: (value: GitFileDiffResponse) => Promise<void>
}

let diffCalls: DiffCall[] = []
let changes: GitChangesResponse = { uncommitted: [], committed: [] }

function text(token: string, diff: string): GitFileDiffResponse {
  return { kind: 'text', token, diff }
}

function tooLarge(token: string, canForce = true): GitFileDiffResponse {
  return { kind: 'too_large', token, oldSize: 1000, newSize: 1_500_000, limit: 1024 * 1024, canForce }
}

describe('diff cards', () => {
  let container: HTMLDivElement
  let root: Root
  let queryClient: QueryClient

  async function render(element: React.ReactElement) {
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>)
    })
    await settle()
  }

  const card = (entry: GitChangeEntry) => <MountedCard entry={entry} />

  const button = (label: string) => [...container.querySelectorAll('button')].find((node) => node.textContent?.trim() === label)
  const fileButton = (name: string) => [...container.querySelectorAll('button')].find((node) => node.textContent?.includes(name))
  const notice = () => container.querySelector('[data-testid="file-diff-notice"]')

  async function click(node: Element | undefined) {
    if (!node) throw new Error('nothing to click')
    await act(async () => { (node as HTMLElement).click() })
    await settle()
  }

  beforeEach(() => {
    diffCalls = []
    changes = { uncommitted: [], committed: [] }
    getMock.mockReset()
    getMock.mockImplementation((url: string, options: { params: Record<string, string>; signal?: AbortSignal }) => {
      if (url === '/git/changes') return Promise.resolve(changes)
      if (url !== '/git/diff') return Promise.reject(new Error(`unexpected request ${url}`))
      return new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        diffCalls.push({
          params: options.params,
          signal: options.signal,
          answer: async (value) => {
            await act(async () => resolve(value))
            await settle()
          },
        })
      })
    })
    // The app's defaults: the diff hooks must override the 60 s staleness and the retry.
    queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: 1 } } })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    queryClient.clear()
  })

  it('fetches a file diff once per version token and keeps the old version shown while the new one loads', async () => {
    const entry = { status: 'M', path: 'src/a.ts', additions: 1, deletions: 0, token: 't1' }
    await render(card(entry))
    expect(diffCalls.map((call) => call.params)).toEqual([{ workingDir: DIR, path: 'src/a.ts', type: 'uncommitted' }])
    expect(diffCalls[0]!.signal).toBeInstanceOf(AbortSignal)
    await diffCalls[0]!.answer(text('t1', '+first version'))
    expect(container.textContent).toContain('+first version')

    // A new state that did not change this file (same token): no request.
    await render(card({ ...entry }))
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await settle()
    expect(diffCalls).toHaveLength(1)

    // The file changed: one request for the new version; the old one stays until it arrives.
    await render(card({ ...entry, additions: 2, token: 't2' }))
    expect(diffCalls).toHaveLength(2)
    expect(container.textContent).toContain('+first version')
    await diffCalls[1]!.answer(text('t2', '+second version'))
    expect(container.textContent).toContain('+second version')

    // A version answered before comes from the cache.
    await render(card({ ...entry, token: 't1' }))
    expect(diffCalls).toHaveLength(2)
    expect(container.textContent).toContain('+first version')
  })

  it('shows a too-large notice with the sizes, and "Load anyway" asks again with force, also for later versions', async () => {
    const entry = { status: 'M', path: 'big.txt', token: 't1' }
    await render(card(entry))
    await diffCalls[0]!.answer(tooLarge('t1'))
    expect(notice()?.textContent).toContain('Diff not shown: the file is larger than 1 MB.')
    expect(notice()?.textContent).toContain('1000 B → 1.4 MB')

    await click(button('Load anyway'))
    expect(diffCalls[1]!.params).toEqual({ workingDir: DIR, path: 'big.txt', type: 'uncommitted', force: '1' })
    // The notice stays while the forced request runs; its button shows that it is loading.
    expect(button('Load anyway')?.getAttribute('aria-busy')).toBe('true')
    await diffCalls[1]!.answer(text('t1', '+big content'))
    expect(notice()).toBeNull()
    expect(container.textContent).toContain('+big content')

    await render(card({ ...entry, token: 't2' }))
    expect(diffCalls[2]!.params).toEqual({ workingDir: DIR, path: 'big.txt', type: 'uncommitted', force: '1' })
    await diffCalls[2]!.answer(tooLarge('t2', false))
    expect(notice()?.textContent).toContain('Diff not shown: the file is too large.')
    expect(button('Load anyway')).toBeUndefined()
  })

  it('shows a binary file as a notice with its sizes and no "Load anyway"', async () => {
    await render(card({ status: 'A', path: 'image.png', token: 't1' }))
    await diffCalls[0]!.answer({ kind: 'binary', token: 't1', oldSize: null, newSize: 2048 })
    expect(notice()?.textContent).toContain('Binary file, no diff shown.')
    expect(notice()?.textContent).toContain('2 KB')
    expect(notice()?.textContent).not.toContain('→')
    expect(button('Load anyway')).toBeUndefined()
  })

  it('aborts the request when the card is collapsed or the view goes away', async () => {
    await render(card({ status: 'M', path: 'src/a.ts', token: 't1' }))
    expect(diffCalls[0]!.signal?.aborted).toBe(false)
    await click(container.querySelector('button')!)
    expect(diffCalls[0]!.signal?.aborted).toBe(true)

    // Opening it again asks again (the aborted request left no answer).
    await click(container.querySelector('button')!)
    expect(diffCalls).toHaveLength(2)
    expect(diffCalls[1]!.signal?.aborted).toBe(false)
    await render(<></>)
    expect(diffCalls[1]!.signal?.aborted).toBe(true)
  })

  it('mobile: opens a file diff once per version token, with the size notice and "Load anyway"', async () => {
    changes = { uncommitted: [{ status: 'M', path: 'big.txt', token: 't1' }], committed: [] }
    await render(<MobileChangesView workingDir={DIR} />)
    expect(diffCalls).toHaveLength(0)
    await click(fileButton('big.txt'))
    expect(diffCalls.map((call) => call.params)).toEqual([{ workingDir: DIR, path: 'big.txt', type: 'uncommitted' }])
    await diffCalls[0]!.answer(tooLarge('t1'))
    expect(notice()?.textContent).toContain('Diff not shown: the file is larger than 1 MB.')

    await click(button('Load anyway'))
    expect(diffCalls[1]!.params).toMatchObject({ force: '1' })
    await diffCalls[1]!.answer(text('t1', '+big content'))
    expect(container.textContent).toContain('+big content')

    // A pushed state that leaves the token alone does not refetch; a new token does.
    await act(async () => {
      queryClient.setQueryData(queryKeys.git.changes(DIR), { uncommitted: [{ status: 'M', path: 'big.txt', token: 't1' }], committed: [] })
    })
    await settle()
    expect(diffCalls).toHaveLength(2)
    await act(async () => {
      queryClient.setQueryData(queryKeys.git.changes(DIR), { uncommitted: [{ status: 'M', path: 'big.txt', token: 't2' }], committed: [] })
    })
    await settle()
    expect(diffCalls).toHaveLength(3)
    expect(diffCalls[2]!.params).toMatchObject({ force: '1' })

    // Closing the file aborts its running request.
    await click(fileButton('big.txt'))
    expect(diffCalls[2]!.signal?.aborted).toBe(true)
  })
})
