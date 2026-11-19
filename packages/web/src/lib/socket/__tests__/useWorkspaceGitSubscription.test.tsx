// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ClientEvents,
  ServerEvents,
  type WorkspaceGitState,
  type WorkspaceGitSubscribeAck,
} from '@agent-tower/shared/socket'
import { useGitChanges, useGitDiff, useGitLogPages } from '@/hooks/use-git'
import { useGitStatus } from '@/hooks/use-workspaces'
import { useWorkspaceGitSubscription } from '../hooks/useWorkspaceGitSubscription'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type AckCallback = (error: Error | null, ack?: WorkspaceGitSubscribeAck) => void

const { socket, getMock } = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const socket = {
    /** A server event, as the socket delivers it. */
    fire(event: string, payload: unknown) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(payload)
    },
    connected: true,
    sent: [] as Array<{ event: string; payload: unknown }>,
    acks: [] as AckCallback[],
    on(event: string, listener: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(listener)
      return socket
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(listener)
      return socket
    },
    emit(event: string, payload: unknown) {
      socket.sent.push({ event, payload })
      return socket
    },
    timeout() {
      return {
        emit(event: string, payload: unknown, callback: AckCallback) {
          socket.sent.push({ event, payload })
          socket.acks.push(callback)
        },
      }
    },
    count(event: string) {
      return socket.sent.filter((message) => message.event === event).length
    },
    reset() {
      socket.connected = true
      socket.sent.length = 0
      socket.acks.length = 0
      listeners.clear()
    },
  }
  return { socket, getMock: vi.fn() }
})

vi.mock('../manager', () => ({ socketManager: { connect: () => socket } }))
vi.mock('@/lib/api-client', () => ({ apiClient: { get: getMock } }))

const DIR = '/repo/workspace-1'

/** The file's token follows its line counts unless given. */
function gitState(ahead: number, token = `token-${ahead}`): WorkspaceGitState {
  return {
    changes: { uncommitted: [{ status: 'M', path: 'src/a.ts', additions: ahead, deletions: 0, token }], committed: [] },
    status: {
      operation: 'idle', conflictedFiles: [], conflictOp: null, ahead, behind: 0,
      hasUncommittedChanges: true, uncommittedCount: 1, untrackedCount: 0,
    },
    headOid: 'head-a',
    baseBranch: 'main',
  }
}

function restAnswer(url: string) {
  // The same state the first acknowledgement brings.
  if (url === '/git/changes') return Promise.resolve(gitState(4).changes)
  if (url === '/git/diff') return Promise.resolve({ kind: 'text', token: 'token', diff: 'diff --git a/src/a.ts b/src/a.ts' })
  if (url === '/git/log') return Promise.resolve({ commits: [] })
  if (url.endsWith('/git-status')) return Promise.resolve(gitState(0).status)
  return Promise.reject(new Error(`unexpected request ${url}`))
}

function Probe({ subscribe = true }: { subscribe?: boolean }) {
  useWorkspaceGitSubscription(subscribe ? 'workspace-1' : undefined, DIR)
  const changes = useGitChanges(DIR)
  const status = useGitStatus('workspace-1')
  const entry = changes.data?.uncommitted.find((change) => change.path === 'src/a.ts')
  useGitDiff(DIR, entry ? entry.path : null, 'uncommitted', entry?.token)
  useGitLogPages(DIR)
  return <span data-ahead={status.data?.ahead ?? ''} data-additions={changes.data?.uncommitted[0]?.additions ?? ''} />
}

describe('useWorkspaceGitSubscription with the git query hooks', () => {
  let container: HTMLDivElement
  let root: Root
  let queryClient: QueryClient

  const probe = () => container.querySelector('span')!
  const restCalls = () => getMock.mock.calls.length

  async function render(element: React.ReactElement) {
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>)
    })
  }

  /** TanStack Query notifies observers in a macrotask; let those (and the renders they cause) run. */
  async function settle() {
    await act(async () => {
      for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }

  async function acknowledge(response: WorkspaceGitSubscribeAck) {
    const callback = socket.acks.shift()
    if (!callback) throw new Error('no subscribe is waiting')
    await act(async () => callback(null, response))
  }

  async function setVisibility(state: 'visible' | 'hidden') {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'))
      // TanStack Query's focus refetch, as on a real visibility change.
      focusManager.setFocused(state === 'visible')
    })
  }

  beforeEach(() => {
    socket.reset()
    getMock.mockReset()
    getMock.mockImplementation((url: string) => restAnswer(url))
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    queryClient.clear()
    focusManager.setFocused(undefined)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  })

  it('shows the acknowledged state, and no git query has a refetch interval', async () => {
    await render(<Probe />)
    expect(socket.sent).toEqual([{ event: ClientEvents.WORKSPACE_GIT_SUBSCRIBE, payload: { workspaceId: 'workspace-1' } }])

    await acknowledge({ ok: true, workspaceId: 'workspace-1', epoch: 'epoch-1', version: 1, state: gitState(4) })
    expect(probe().dataset.ahead).toBe('4')
    expect(probe().dataset.additions).toBe('4')

    // The diff query before the change list arrived (no path yet) has no observer left.
    const queries = queryClient.getQueryCache().getAll().filter((query) => query.getObserversCount() > 0)
    const gitQueries = queries.filter((query) => (
      query.queryKey[0] === 'git' || query.queryKey[0] === 'git-diffs' || query.queryKey[1] === 'gitStatus'
    ))
    expect(gitQueries.map((query) => query.queryKey[1]).sort()).toEqual(['changes', 'file', 'gitStatus', 'log'])
    for (const query of gitQueries) {
      expect(query.observers.length).toBeGreaterThan(0)
      for (const observer of query.observers) expect(observer.options.refetchInterval).toBeUndefined()
    }
  })

  it('does not refetch over REST on focus while the subscription covers the queries', async () => {
    await render(<Probe />)
    await acknowledge({ ok: true, workspaceId: 'workspace-1', epoch: 'epoch-1', version: 1, state: gitState(4) })
    await settle()
    const before = restCalls()

    await setVisibility('hidden')
    expect(socket.sent.at(-1)).toEqual({ event: ClientEvents.WORKSPACE_GIT_UNSUBSCRIBE, payload: { workspaceId: 'workspace-1' } })
    await setVisibility('visible')
    expect(socket.sent.at(-1)).toEqual({ event: ClientEvents.WORKSPACE_GIT_SUBSCRIBE, payload: { workspaceId: 'workspace-1' } })
    await acknowledge({ ok: true, workspaceId: 'workspace-1', epoch: 'epoch-1', version: 2, state: gitState(6) })

    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(socket.sent.at(-1)).toEqual({ event: ClientEvents.WORKSPACE_GIT_REFRESH, payload: { workspaceId: 'workspace-1' } })
    expect(probe().dataset.ahead).toBe('6')
    // Version 2 changed the file's token: its open diff loads that version once; nothing else goes over REST.
    expect(getMock.mock.calls.slice(before).map(([url]) => url)).toEqual(['/git/diff'])
  })

  it('loads an open diff again only when a pushed state changes its token', async () => {
    await render(<Probe />)
    await acknowledge({ ok: true, workspaceId: 'workspace-1', epoch: 'epoch-1', version: 1, state: gitState(4) })
    await settle()
    const diffRequests = () => getMock.mock.calls.filter(([url]) => url === '/git/diff').length
    expect(diffRequests()).toBe(1)
    const before = restCalls()

    // Another part of the state changed (status), the file did not.
    await act(async () => {
      socket.fire(ServerEvents.WORKSPACE_GIT_STATE, { workspaceId: 'workspace-1', epoch: 'epoch-1', version: 2, state: gitState(5, 'token-4') })
    })
    await settle()
    expect(probe().dataset.ahead).toBe('5')
    expect(diffRequests()).toBe(1)

    await act(async () => {
      socket.fire(ServerEvents.WORKSPACE_GIT_STATE, { workspaceId: 'workspace-1', epoch: 'epoch-1', version: 3, state: gitState(5) })
    })
    await settle()
    expect(diffRequests()).toBe(2)
    expect(getMock.mock.calls.slice(before).map(([url]) => url)).toEqual(['/git/diff'])
  })

  it('falls back to REST, which reloads on window focus, when the subscription fails', async () => {
    await render(<Probe />)
    await acknowledge({ ok: false, code: 'WORKSPACE_GIT_UNAVAILABLE', message: 'Workspace git subscription is unavailable' })
    const before = restCalls()

    await act(async () => { window.dispatchEvent(new Event('focus')) })
    await settle()
    const urls = getMock.mock.calls.slice(before).map(([url]) => url)
    expect(urls).toEqual(expect.arrayContaining(['/git/changes', '/workspaces/workspace-1/git-status', '/git/log']))
    // The reloaded change list has the same token, so the open diff is not asked again.
    expect(urls).not.toContain('/git/diff')
    expect(socket.count(ClientEvents.WORKSPACE_GIT_REFRESH)).toBe(0)

    // The visible tab is a retry point for the subscription; when it fails again, REST reloads again.
    await setVisibility('hidden')
    await setVisibility('visible')
    expect(socket.count(ClientEvents.WORKSPACE_GIT_SUBSCRIBE)).toBe(2)
    const beforeRetry = restCalls()
    await acknowledge({ ok: false, code: 'WORKSPACE_GIT_UNAVAILABLE', message: 'Workspace git subscription is unavailable' })
    expect(restCalls()).toBeGreaterThan(beforeRetry)
  })

  it('refetches on window focus over REST while the socket is disconnected', async () => {
    socket.connected = false
    await render(<Probe />)
    expect(socket.sent).toEqual([])
    const before = restCalls()
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(getMock.mock.calls.slice(before).map(([url]) => url))
      .toEqual(expect.arrayContaining(['/git/changes', '/workspaces/workspace-1/git-status']))
  })

  it('refetches on focus without a subscription and unsubscribes when the view unmounts', async () => {
    await render(<Probe subscribe={false} />)
    expect(socket.sent).toEqual([])
    const before = restCalls()
    await act(async () => { focusManager.setFocused(false) })
    await act(async () => { focusManager.setFocused(true) })
    expect(restCalls()).toBeGreaterThan(before)

    await render(<Probe />)
    await acknowledge({ ok: true, workspaceId: 'workspace-1', epoch: 'epoch-1', version: 1, state: gitState(1) })
    await act(async () => root.render(<QueryClientProvider client={queryClient}>{null}</QueryClientProvider>))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(socket.sent.at(-1)).toEqual({ event: ClientEvents.WORKSPACE_GIT_UNSUBSCRIBE, payload: { workspaceId: 'workspace-1' } })
  })
})
