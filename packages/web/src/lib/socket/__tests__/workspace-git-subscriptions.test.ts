import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import {
  ClientEvents,
  ServerEvents,
  type WorkspaceGitState,
  type WorkspaceGitStatePayload,
  type WorkspaceGitSubscribeAck,
} from '@agent-tower/shared/socket'
import { queryKeys } from '@/hooks/query-keys'
import {
  WORKSPACE_GIT_SUBSCRIBE_TIMEOUT_MS,
  WorkspaceGitSubscriptions,
  gitRestRefetchOptions,
  type WorkspaceGitSocket,
  type WorkspaceGitSubscriptionEnvironment,
} from '../workspace-git-subscriptions'

type Listener = (...args: unknown[]) => void
type AckCallback = (error: Error | null, ack?: WorkspaceGitSubscribeAck) => void

/** Records what the client sends and lets a test play the server. */
class FakeSocket {
  connected = true
  readonly sent: Array<{ event: string; payload: unknown }> = []
  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly acks: Array<{ payload: unknown; callback: AckCallback; settled: boolean }> = []

  on(event: string, listener: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(listener)
    return this
  }

  off(event: string, listener: Listener) {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  emit(event: string, payload: unknown) {
    this.sent.push({ event, payload })
    return this
  }

  /** Mirrors socket.io: the callback gets an error after the timeout or on disconnect. */
  timeout(ms: number) {
    return {
      emit: (event: string, payload: unknown, callback: AckCallback) => {
        this.sent.push({ event, payload })
        const ack = { payload, callback, settled: false }
        this.acks.push(ack)
        setTimeout(() => this.settle(ack, new Error('operation has timed out')), ms)
      },
    }
  }

  listenerCount(event: string) {
    return this.listeners.get(event)?.size ?? 0
  }

  count(event: string) {
    return this.sent.filter((message) => message.event === event).length
  }

  /** Answers the oldest unanswered subscribe. */
  acknowledge(response: WorkspaceGitSubscribeAck) {
    const ack = this.acks.find((candidate) => !candidate.settled)
    if (!ack) throw new Error('no subscribe is waiting for an acknowledgement')
    this.settle(ack, null, response)
  }

  push(payload: WorkspaceGitStatePayload) {
    this.fire(ServerEvents.WORKSPACE_GIT_STATE, payload)
  }

  end() {
    this.fire(ServerEvents.WORKSPACE_GIT_SUBSCRIPTION_ENDED, { workspaceId: 'workspace-1', code: 'WORKSPACE_GIT_UNAVAILABLE', message: 'Unavailable' })
  }

  disconnect() {
    this.connected = false
    this.fire('disconnect', 'transport close')
    for (const ack of this.acks) this.settle(ack, new Error('socket has been disconnected'))
  }

  reconnect() {
    this.connected = true
    this.fire('connect')
  }

  private settle(ack: { callback: AckCallback; settled: boolean }, error: Error | null, response?: WorkspaceGitSubscribeAck) {
    if (ack.settled) return
    ack.settled = true
    ack.callback(error, response)
  }

  private fire(event: string, ...args: unknown[]) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
  }
}

const DIR = '/repo/workspace-1'

function gitState(overrides: Partial<WorkspaceGitState> = {}): WorkspaceGitState {
  return {
    changes: { uncommitted: [{ status: 'M', path: 'src/a.ts', additions: 2, deletions: 1, token: 'token-a' }], committed: [] },
    status: {
      operation: 'idle', conflictedFiles: [], conflictOp: null, ahead: 1, behind: 0,
      hasUncommittedChanges: true, uncommittedCount: 1, untrackedCount: 0,
    },
    headOid: 'head-a',
    baseBranch: 'main',
    ...overrides,
  }
}

function payload(version: number, overrides: Partial<WorkspaceGitState> = {}, epoch = 'epoch-1', workspaceId = 'workspace-1'): WorkspaceGitStatePayload {
  return { workspaceId, epoch, version, state: gitState(overrides) }
}

function ok(version: number, overrides: Partial<WorkspaceGitState> = {}, epoch = 'epoch-1'): WorkspaceGitSubscribeAck {
  return { ok: true, ...payload(version, overrides, epoch) }
}

describe('WorkspaceGitSubscriptions', () => {
  let socket: FakeSocket
  let queryClient: QueryClient
  let manager: WorkspaceGitSubscriptions
  let visible: boolean
  let listening: boolean
  let handlers: { visibility?: () => void; focus?: () => void }

  function setVisible(next: boolean) {
    visible = next
    handlers.visibility?.()
  }

  function focus() {
    handlers.focus?.()
  }

  /** Releases are decided on the next tick. */
  function settle() {
    vi.advanceTimersByTime(0)
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: 10_000 })
    socket = new FakeSocket()
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
    visible = true
    listening = false
    handlers = {}
    const env: WorkspaceGitSubscriptionEnvironment = {
      connect: () => socket as unknown as WorkspaceGitSocket,
      isVisible: () => visible,
      listen(onVisibilityChange, onFocus) {
        listening = true
        handlers = { visibility: onVisibilityChange, focus: onFocus }
        return () => {
          listening = false
          handlers = {}
        }
      },
      now: () => Date.now(),
    }
    manager = new WorkspaceGitSubscriptions(queryClient, env)
  })

  afterEach(() => {
    queryClient.clear()
    vi.useRealTimers()
  })

  it('fills the changes and git status caches from the acknowledgement', () => {
    manager.retain('workspace-1', DIR)

    expect(socket.sent).toEqual([{ event: ClientEvents.WORKSPACE_GIT_SUBSCRIBE, payload: { workspaceId: 'workspace-1' } }])
    socket.acknowledge(ok(3))

    expect(queryClient.getQueryData(queryKeys.git.changes(DIR))).toEqual(gitState().changes)
    expect(queryClient.getQueryData(queryKeys.workspaces.gitStatus('workspace-1'))).toEqual(gitState().status)
    expect(manager.coversWorkingDir(DIR)).toBe(true)
    expect(manager.coversWorkspace('workspace-1')).toBe(true)
    expect(manager.coversWorkingDir('/repo/other')).toBe(false)
  })

  it('applies a higher version, ignores a lower or equal one, and lets a new epoch replace the state', () => {
    const changes = () => queryClient.getQueryData(queryKeys.git.changes(DIR))
    manager.retain('workspace-1', DIR)
    socket.acknowledge(ok(5, { changes: { uncommitted: [], committed: [] } }))

    socket.push(payload(4, { changes: { uncommitted: [{ status: 'A', path: 'old.ts', token: 't-old.ts' }], committed: [] } }))
    expect(changes()).toEqual({ uncommitted: [], committed: [] })
    socket.push(payload(5, { changes: { uncommitted: [{ status: 'A', path: 'same.ts', token: 't-same.ts' }], committed: [] } }))
    expect(changes()).toEqual({ uncommitted: [], committed: [] })

    socket.push(payload(6, { changes: { uncommitted: [{ status: 'A', path: 'new.ts', token: 't-new.ts' }], committed: [] } }))
    expect(changes()).toEqual({ uncommitted: [{ status: 'A', path: 'new.ts', token: 't-new.ts' }], committed: [] })

    // A new epoch restarts the versions, so its first state replaces even a higher version.
    socket.push(payload(1, { changes: { uncommitted: [{ status: 'D', path: 'gone.ts', token: 't-gone.ts' }], committed: [] } }, 'epoch-2'))
    expect(changes()).toEqual({ uncommitted: [{ status: 'D', path: 'gone.ts', token: 't-gone.ts' }], committed: [] })
    socket.push(payload(2, { changes: { uncommitted: [], committed: [{ status: 'M', path: 'c.ts', token: 't-c.ts' }] } }, 'epoch-2'))
    expect(changes()).toEqual({ uncommitted: [], committed: [{ status: 'M', path: 'c.ts', token: 't-c.ts' }] })
  })

  it('subscribes again after the socket reconnects', () => {
    manager.retain('workspace-1', DIR)
    socket.acknowledge(ok(1))

    socket.disconnect()
    expect(manager.coversWorkingDir(DIR)).toBe(false)
    expect(socket.count(ClientEvents.WORKSPACE_GIT_UNSUBSCRIBE)).toBe(0)

    socket.reconnect()
    expect(socket.count(ClientEvents.WORKSPACE_GIT_SUBSCRIBE)).toBe(2)
    const status = { ...gitState().status, ahead: 2 }
    socket.acknowledge(ok(2, { status }))
    expect(queryClient.getQueryData(queryKeys.workspaces.gitStatus('workspace-1'))).toEqual(status)
    expect(manager.coversWorkingDir(DIR)).toBe(true)
  })

  it('waits for the connection before subscribing', () => {
    socket.connected = false
    manager.retain('workspace-1', DIR)
    expect(socket.sent).toEqual([])
    socket.reconnect()
    expect(socket.count(ClientEvents.WORKSPACE_GIT_SUBSCRIBE)).toBe(1)
  })

  it('keeps one subscription for several users and unsubscribes after the last release', () => {
    const releaseFirst = manager.retain('workspace-1', DIR)
    const releaseSecond = manager.retain('workspace-1', DIR)
    expect(socket.count(ClientEvents.WORKSPACE_GIT_SUBSCRIBE)).toBe(1)
    socket.acknowledge(ok(1))

    releaseFirst()
    releaseFirst()
    settle()
    expect(socket.count(ClientEvents.WORKSPACE_GIT_UNSUBSCRIBE)).toBe(0)
    expect(manager.coversWorkingDir(DIR)).toBe(true)

    releaseSecond()
    settle()
    expect(socket.sent.at(-1)).toEqual({ event: ClientEvents.WORKSPACE_GIT_UNSUBSCRIBE, payload: { workspaceId: 'workspace-1' } })
    expect(socket.count(ClientEvents.WORKSPACE_GIT_UNSUBSCRIBE)).toBe(1)
    expect(manager.coversWorkingDir(DIR)).toBe(false)
    // Nothing is referenced any more, so the manager stops listening.
    expect(socket.listenerCount(ServerEvents.WORKSPACE_GIT_STATE)).toBe(0)
    expect(socket.listenerCount('connect')).toBe(0)
    expect(listening).toBe(false)
  })

  it('sends nothing when a release is followed at once by a new reference', () => {
    const release = manager.retain('workspace-1', DIR)
    socket.acknowledge(ok(1))
    release()
    const releaseAgain = manager.retain('workspace-1', DIR)
    settle()

    expect(socket.sent.map((message) => message.event)).toEqual([ClientEvents.WORKSPACE_GIT_SUBSCRIBE])
    releaseAgain()
    settle()
    expect(socket.count(ClientEvents.WORKSPACE_GIT_UNSUBSCRIBE)).toBe(1)
  })

  it('subscribes per workspace', () => {
    manager.retain('workspace-1', DIR)
    manager.retain('workspace-2', '/repo/workspace-2')
    expect(socket.sent.map((message) => message.payload)).toEqual([{ workspaceId: 'workspace-1' }, { workspaceId: 'workspace-2' }])
  })

  it('releases the subscription while the tab is hidden and subscribes again when it is visible', () => {
    manager.retain('workspace-1', DIR)
    socket.acknowledge(ok(1))

    setVisible(false)
    expect(socket.sent.at(-1)).toEqual({ event: ClientEvents.WORKSPACE_GIT_UNSUBSCRIBE, payload: { workspaceId: 'workspace-1' } })
    socket.push(payload(2, { changes: { uncommitted: [], committed: [] } }))
    expect(queryClient.getQueryData(queryKeys.git.changes(DIR))).toEqual(gitState().changes)

    setVisible(true)
    expect(socket.sent.at(-1)).toEqual({ event: ClientEvents.WORKSPACE_GIT_SUBSCRIBE, payload: { workspaceId: 'workspace-1' } })
    socket.acknowledge(ok(2, { changes: { uncommitted: [], committed: [] } }))
    expect(queryClient.getQueryData(queryKeys.git.changes(DIR))).toEqual({ uncommitted: [], committed: [] })
  })

  it('refreshes once after the new acknowledgement when the tab becomes visible, whichever event comes first', () => {
    manager.retain('workspace-1', DIR)
    socket.acknowledge(ok(1))
    setVisible(false)
    vi.advanceTimersByTime(5_000)

    // The window focus arrives before the visibility change: there is no subscription yet.
    focus()
    expect(socket.count(ClientEvents.WORKSPACE_GIT_REFRESH)).toBe(0)
    setVisible(true)
    expect(socket.count(ClientEvents.WORKSPACE_GIT_REFRESH)).toBe(0)
    socket.acknowledge(ok(1))
    expect(socket.sent.at(-1)).toEqual({ event: ClientEvents.WORKSPACE_GIT_REFRESH, payload: { workspaceId: 'workspace-1' } })

    // A focus right after it stays within the one-per-second limit.
    focus()
    expect(socket.count(ClientEvents.WORKSPACE_GIT_REFRESH)).toBe(1)
  })

  it('does not subscribe while the tab is hidden', () => {
    visible = false
    manager.retain('workspace-1', DIR)
    expect(socket.sent).toEqual([])
    setVisible(true)
    expect(socket.count(ClientEvents.WORKSPACE_GIT_SUBSCRIBE)).toBe(1)
  })

  it('sends a refresh on window focus, at most once per second', () => {
    manager.retain('workspace-1', DIR)
    socket.acknowledge(ok(1))

    focus()
    expect(socket.sent.at(-1)).toEqual({ event: ClientEvents.WORKSPACE_GIT_REFRESH, payload: { workspaceId: 'workspace-1' } })
    vi.advanceTimersByTime(500)
    focus()
    expect(socket.count(ClientEvents.WORKSPACE_GIT_REFRESH)).toBe(1)
    vi.advanceTimersByTime(500)
    focus()
    expect(socket.count(ClientEvents.WORKSPACE_GIT_REFRESH)).toBe(2)
  })

  it('sends a refresh asked for during a subscribe once the subscription is acknowledged', () => {
    manager.retain('workspace-1', DIR)
    focus()
    expect(socket.count(ClientEvents.WORKSPACE_GIT_REFRESH)).toBe(0)
    socket.acknowledge(ok(1))
    expect(socket.sent.at(-1)).toEqual({ event: ClientEvents.WORKSPACE_GIT_REFRESH, payload: { workspaceId: 'workspace-1' } })
  })

  it('unsubscribes right after a refresh without waiting for it', () => {
    // The server drops a refresh whose subscription ends while it is being validated.
    const release = manager.retain('workspace-1', DIR)
    socket.acknowledge(ok(1))
    focus()
    release()
    settle()
    expect(socket.sent.slice(-2).map((message) => message.event))
      .toEqual([ClientEvents.WORKSPACE_GIT_REFRESH, ClientEvents.WORKSPACE_GIT_UNSUBSCRIBE])
  })

  it.each(['reopen', 'visible', 'reconnect'])('falls back once after an active subscription ends and resubscribes on %s', (trigger) => {
    const invalidated = vi.spyOn(queryClient, 'invalidateQueries')
    const release = manager.retain('workspace-1', DIR)
    socket.acknowledge(ok(1))
    socket.end()
    socket.end()
    expect(invalidated.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([
      queryKeys.git.changes(DIR), queryKeys.workspaces.gitStatus('workspace-1'), queryKeys.git.log(DIR),
    ])
    expect(manager.coversWorkspace('workspace-1')).toBe(false)
    expect(gitRestRefetchOptions(() => manager.coversWorkingDir(DIR)).refetchOnWindowFocus()).toBe('always')
    vi.advanceTimersByTime(60_000)
    focus()
    expect(socket.sent.map(item => item.event)).toEqual([ClientEvents.WORKSPACE_GIT_SUBSCRIBE])
    if (trigger === 'reopen') { release(); settle(); manager.retain('workspace-1', DIR) }
    if (trigger === 'visible') { setVisible(false); setVisible(true) }
    if (trigger === 'reconnect') { socket.disconnect(); socket.reconnect() }
    expect(socket.count(ClientEvents.WORKSPACE_GIT_SUBSCRIBE)).toBe(2)
    socket.acknowledge(ok(1, {}, 'new'))
    expect(manager.coversWorkspace('workspace-1')).toBe(true)
  })

  it('ignores an end while pending, hidden or unreferenced', () => {
    const invalidated = vi.spyOn(queryClient, 'invalidateQueries')
    const release = manager.retain('workspace-1', DIR)
    socket.end()
    socket.acknowledge(ok(1))
    expect(manager.coversWorkspace('workspace-1')).toBe(true)
    setVisible(false)
    socket.end()
    release()
    settle()
    socket.end()
    expect(invalidated).not.toHaveBeenCalled()
    expect(socket.listenerCount(ServerEvents.WORKSPACE_GIT_SUBSCRIPTION_ENDED)).toBe(0)
  })

  it('falls back to REST after a failed acknowledgement and does not retry in a loop', () => {
    const fallback = gitRestRefetchOptions(() => manager.coversWorkingDir(DIR))
    const release = manager.retain('workspace-1', DIR)
    expect(fallback.refetchOnWindowFocus()).toBe(false)
    socket.acknowledge({ ok: false, code: 'WORKSPACE_GIT_UNAVAILABLE', message: 'Workspace git subscription is unavailable' })

    expect(manager.coversWorkingDir(DIR)).toBe(false)
    expect(fallback.refetchOnWindowFocus()).toBe('always')
    expect(fallback.refetchOnReconnect()).toBe('always')
    vi.advanceTimersByTime(60_000)
    focus()
    expect(socket.count(ClientEvents.WORKSPACE_GIT_SUBSCRIBE)).toBe(1)
    expect(socket.count(ClientEvents.WORKSPACE_GIT_REFRESH)).toBe(0)

    // Retry points: the tab becomes visible again, the socket reconnects, the task is reopened.
    setVisible(false)
    setVisible(true)
    expect(socket.count(ClientEvents.WORKSPACE_GIT_SUBSCRIBE)).toBe(2)
    socket.acknowledge({ ok: false, code: 'WORKSPACE_GIT_SUBSCRIPTION_DENIED', message: 'denied' })
    socket.disconnect()
    socket.reconnect()
    expect(socket.count(ClientEvents.WORKSPACE_GIT_SUBSCRIBE)).toBe(3)
    socket.acknowledge({ ok: false, code: 'NOT_FOUND', message: 'Workspace not found' })
    release()
    settle()
    manager.retain('workspace-1', DIR)
    expect(socket.count(ClientEvents.WORKSPACE_GIT_SUBSCRIBE)).toBe(4)
  })

  it('does not retry a failed workspace when another reference arrives while it is still held', () => {
    const release = manager.retain('workspace-1', DIR)
    socket.acknowledge({ ok: false, code: 'WORKSPACE_GIT_UNAVAILABLE', message: 'unavailable' })

    // For example an effect that runs again, or a second view of the same workspace.
    manager.retain('workspace-1', DIR)
    release()
    manager.retain('workspace-1', DIR)
    settle()
    expect(socket.count(ClientEvents.WORKSPACE_GIT_SUBSCRIBE)).toBe(1)
    expect(manager.coversWorkingDir(DIR)).toBe(false)
  })

  it('reloads the open REST queries once when the subscription fails', () => {
    queryClient.setQueryData(queryKeys.git.changes(DIR), { uncommitted: [], committed: [] })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    manager.retain('workspace-1', DIR)
    socket.acknowledge({ ok: false, code: 'WORKSPACE_GIT_UNAVAILABLE', message: 'unavailable' })

    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.git.changes(DIR) }, { cancelRefetch: false })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.workspaces.gitStatus('workspace-1') }, { cancelRefetch: false })
    expect(queryClient.getQueryState(queryKeys.git.changes(DIR))?.isInvalidated).toBe(true)
  })

  it('reloads the REST queries on window focus while there is no live subscription, at most once per second', () => {
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const reloads = () => invalidate.mock.calls.filter(([filters]) => (
      JSON.stringify(filters?.queryKey) === JSON.stringify(queryKeys.git.changes(DIR))
    )).length
    manager.retain('workspace-1', DIR)
    socket.acknowledge({ ok: false, code: 'WORKSPACE_GIT_UNAVAILABLE', message: 'unavailable' })
    expect(reloads()).toBe(1)

    focus()
    expect(reloads()).toBe(2)
    expect(invalidate).toHaveBeenLastCalledWith({ queryKey: queryKeys.git.log(DIR) }, { cancelRefetch: false })
    // File diffs follow the tokens of the reloaded change list.
    expect(invalidate.mock.calls.some(([filters]) => JSON.stringify(filters?.queryKey ?? []).includes('diff'))).toBe(false)
    focus()
    expect(reloads()).toBe(2)
    vi.advanceTimersByTime(1_000)
    focus()
    expect(reloads()).toBe(3)

    // The same applies while the socket is down, and nothing is sent meanwhile.
    setVisible(false)
    setVisible(true)
    socket.acknowledge(ok(1))
    socket.disconnect()
    vi.advanceTimersByTime(1_000)
    const sent = socket.sent.length
    focus()
    expect(reloads()).toBe(4)
    expect(socket.sent.length).toBe(sent)
  })

  it('treats an acknowledgement timeout as a failure and revokes the request', () => {
    manager.retain('workspace-1', DIR)
    vi.advanceTimersByTime(WORKSPACE_GIT_SUBSCRIBE_TIMEOUT_MS)

    expect(socket.sent.at(-1)).toEqual({ event: ClientEvents.WORKSPACE_GIT_UNSUBSCRIBE, payload: { workspaceId: 'workspace-1' } })
    expect(manager.coversWorkingDir(DIR)).toBe(false)
    vi.advanceTimersByTime(60_000)
    expect(socket.count(ClientEvents.WORKSPACE_GIT_SUBSCRIBE)).toBe(1)
  })

  it('reloads the history when headOid changes and leaves file diffs to their tokens', () => {
    const diffKeys = [
      queryKeys.gitDiffs.file(DIR, 'uncommitted', 'src/a.ts', 'token-a', false),
      queryKeys.gitDiffs.file(DIR, 'committed', 'src/b.ts', 'token-b', false),
      queryKeys.gitDiffs.commit(DIR, 'abc123', 'src/a.ts'),
    ]
    const seed = () => {
      queryClient.setQueryData(queryKeys.git.log(DIR), { pages: [{ commits: [] }], pageParams: [0] })
      for (const key of diffKeys) queryClient.setQueryData(key, { kind: 'text', token: 'token', diff: 'old' })
    }
    const invalidated = (key: readonly unknown[]) => queryClient.getQueryState(key)?.isInvalidated
    const diffsInvalidated = () => diffKeys.some((key) => invalidated(key))
    seed()
    manager.retain('workspace-1', DIR)

    // The first state only fills the changes and status caches.
    socket.acknowledge(ok(1, { headOid: 'head-a' }))
    expect(invalidated(queryKeys.git.log(DIR))).toBe(false)
    expect(diffsInvalidated()).toBe(false)

    // A new version brings new tokens for the files that changed; their cards ask for new keys.
    socket.push(payload(2, { headOid: 'head-a' }))
    expect(invalidated(queryKeys.git.log(DIR))).toBe(false)
    expect(diffsInvalidated()).toBe(false)

    seed()
    socket.push(payload(3, { headOid: 'head-b' }))
    expect(invalidated(queryKeys.git.log(DIR))).toBe(true)
    expect(diffsInvalidated()).toBe(false)

    // An ignored (not newer) state changes nothing.
    seed()
    socket.push(payload(3, { headOid: 'head-c' }))
    expect(invalidated(queryKeys.git.log(DIR))).toBe(false)
    expect(diffsInvalidated()).toBe(false)
  })

  it('compares a reopened workspace with the last state it accepted', () => {
    queryClient.setQueryData(queryKeys.git.log(DIR), { pages: [{ commits: [] }], pageParams: [0] })
    const release = manager.retain('workspace-1', DIR)
    socket.acknowledge(ok(4, { headOid: 'head-a' }))
    release()
    settle()

    manager.retain('workspace-1', DIR)
    socket.acknowledge(ok(4, { headOid: 'head-a' }))
    expect(queryClient.getQueryState(queryKeys.git.log(DIR))?.isInvalidated).toBe(false)

    setVisible(false)
    setVisible(true)
    socket.acknowledge(ok(7, { headOid: 'head-b' }))
    expect(queryClient.getQueryState(queryKeys.git.log(DIR))?.isInvalidated).toBe(true)
  })

  it('keeps pushed data when an earlier REST request answers later', async () => {
    let answer: (value: unknown) => void = () => undefined
    const stale = { uncommitted: [{ status: 'M', path: 'stale.ts', token: 't-stale.ts' }], committed: [] }
    const request = queryClient.fetchQuery({
      queryKey: queryKeys.git.changes(DIR),
      queryFn: () => new Promise((resolve) => { answer = resolve }),
    })

    manager.retain('workspace-1', DIR)
    socket.acknowledge(ok(1))
    answer(stale)

    await expect(request).resolves.toEqual(gitState().changes)
    expect(queryClient.getQueryData(queryKeys.git.changes(DIR))).toEqual(gitState().changes)
  })

  it('ignores pushes for workspaces it does not hold and late acknowledgements', () => {
    socket.push(payload(1))
    const release = manager.retain('workspace-1', DIR)
    release()
    settle()
    // Released while the subscribe was pending: the request is revoked and its answer ignored.
    expect(socket.count(ClientEvents.WORKSPACE_GIT_UNSUBSCRIBE)).toBe(1)
    socket.acknowledge(ok(1))
    socket.push(payload(2))
    expect(queryClient.getQueryData(queryKeys.git.changes(DIR))).toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.workspaces.gitStatus('workspace-1'))).toBeUndefined()
  })
})
