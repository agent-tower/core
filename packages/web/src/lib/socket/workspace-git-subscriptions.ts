/**
 * Owns every `workspace-git:*` subscription of this page.
 *
 * Task views retain the workspace they show. The first reference subscribes, the last release
 * unsubscribes, and the server then pushes the workspace's git state whenever it changes. The
 * state is written into the same query caches that the REST hooks read, so no git query needs a
 * timer. The REST queries stay for the first load and as the fallback: they refetch on window
 * focus only while no live subscription covers them.
 */
import type { QueryClient } from '@tanstack/react-query'
import type { Socket } from 'socket.io-client'
import {
  ClientEvents,
  ServerEvents,
  type WorkspaceGitStatePayload,
  type WorkspaceGitSubscriptionEndedPayload,
  type WorkspaceGitSubscribeAck,
} from '@agent-tower/shared/socket'
import { queryKeys } from '@/hooks/query-keys'
import { socketManager } from './manager'

/** The client sends at most one refresh per second and workspace; the server ignores more. */
export const WORKSPACE_GIT_REFRESH_INTERVAL_MS = 1_000
/** A subscribe that is not acknowledged within this time falls back to REST. */
export const WORKSPACE_GIT_SUBSCRIBE_TIMEOUT_MS = 15_000

export type WorkspaceGitSocket = Pick<Socket, 'connected' | 'on' | 'off' | 'emit' | 'timeout'>

export interface WorkspaceGitSubscriptionEnvironment {
  /** Returns the shared socket and starts connecting it when needed. */
  connect(): WorkspaceGitSocket
  isVisible(): boolean
  /** Listens for tab visibility changes and window focus; returns the cleanup. */
  listen(onVisibilityChange: () => void, onFocus: () => void): () => void
  now(): number
}

/** The subscription as the server sees it: none, requested (no acknowledgement yet) or active. */
type ServerSubscription = 'none' | 'pending' | 'active'

interface Entry {
  workspaceId: string
  workingDir: string
  refs: number
  server: ServerSubscription
  /** Changes with every subscribe and unsubscribe, so late acknowledgements are recognized. */
  attempt: number
  /** A failed subscribe is not retried until the task is reopened, the tab becomes visible or the socket reconnects. */
  failed: boolean
  refreshAfterAck: boolean
  /** Throttles what a window focus does: a refresh, or a REST reload in the fallback. */
  lastFocusActionAt: number
  /** A pending release: decided on the next tick. */
  timer?: ReturnType<typeof setTimeout>
}

interface AcceptedState {
  epoch: string
  version: number
  headOid: string | null
}

export class WorkspaceGitSubscriptions {
  private readonly queryClient: QueryClient
  private readonly env: WorkspaceGitSubscriptionEnvironment
  private readonly entries = new Map<string, Entry>()
  /** The last state accepted per workspace. Kept after release: versions keep increasing within an epoch. */
  private readonly accepted = new Map<string, AcceptedState>()
  private socket: WorkspaceGitSocket | undefined
  private stopListening: (() => void) | undefined

  constructor(queryClient: QueryClient, env: WorkspaceGitSubscriptionEnvironment = browserEnvironment) {
    this.queryClient = queryClient
    this.env = env
  }

  /** Keeps the workspace's git state live while the returned release function has not been called. */
  retain(workspaceId: string, workingDir: string): () => void {
    this.attach()
    let entry = this.entries.get(workspaceId)
    if (!entry) {
      entry = {
        workspaceId, workingDir, refs: 0, server: 'none', attempt: 0,
        failed: false, refreshAfterAck: false, lastFocusActionAt: Number.NEGATIVE_INFINITY,
      }
      this.entries.set(workspaceId, entry)
    }
    entry.workingDir = workingDir
    entry.refs += 1
    this.reconcile(entry)

    const retained = entry
    let released = false
    return () => {
      if (released) return
      released = true
      retained.refs -= 1
      // Decide on the next tick, so a release followed at once by a new reference
      // (a re-rendered effect, StrictMode) sends nothing.
      if (retained.refs === 0) this.scheduleRelease(retained)
    }
  }

  /** True while a subscription is expected to keep this directory's git queries current. */
  coversWorkingDir(workingDir: string | undefined): boolean {
    return !!workingDir && this.covers((entry) => entry.workingDir === workingDir)
  }

  coversWorkspace(workspaceId: string | undefined): boolean {
    return !!workspaceId && this.covers((entry) => entry.workspaceId === workspaceId)
  }

  private covers(match: (entry: Entry) => boolean): boolean {
    if (!this.socket?.connected) return false
    for (const entry of this.entries.values()) {
      if (entry.refs > 0 && !entry.failed && match(entry)) return true
    }
    return false
  }

  private attach(): void {
    const socket = this.env.connect()
    if (socket === this.socket) return
    this.detachSocket()
    this.socket = socket
    socket.on('connect', this.handleConnect)
    socket.on('disconnect', this.handleDisconnect)
    socket.on(ServerEvents.WORKSPACE_GIT_STATE, this.handleState)
    socket.on(ServerEvents.WORKSPACE_GIT_SUBSCRIPTION_ENDED, this.handleEnded)
    this.stopListening ??= this.env.listen(this.handleVisibilityChange, this.handleFocus)
    // A different socket holds none of the earlier subscriptions.
    for (const entry of this.entries.values()) this.forgetServer(entry)
    for (const entry of [...this.entries.values()]) this.reconcile(entry)
  }

  private detachSocket(): void {
    if (!this.socket) return
    this.socket.off('connect', this.handleConnect)
    this.socket.off('disconnect', this.handleDisconnect)
    this.socket.off(ServerEvents.WORKSPACE_GIT_STATE, this.handleState)
    this.socket.off(ServerEvents.WORKSPACE_GIT_SUBSCRIPTION_ENDED, this.handleEnded)
    this.socket = undefined
  }

  /** Moves the server subscription towards what the references, the tab and the socket allow. */
  private reconcile(entry: Entry): void {
    if (this.entries.get(entry.workspaceId) !== entry) return
    const socket = this.socket
    if (entry.refs > 0 && !entry.failed && socket?.connected && this.env.isVisible()) {
      this.clearTimer(entry)
      if (entry.server === 'none') this.subscribe(entry)
      return
    }
    if (entry.server !== 'none') {
      // A closed connection has already lost its subscriptions on the server.
      if (socket?.connected) socket.emit(ClientEvents.WORKSPACE_GIT_UNSUBSCRIBE, { workspaceId: entry.workspaceId })
      this.forgetServer(entry)
    }
    if (entry.refs === 0 && !entry.timer) {
      this.entries.delete(entry.workspaceId)
      if (this.entries.size === 0) this.detach()
    }
  }

  private detach(): void {
    this.detachSocket()
    this.stopListening?.()
    this.stopListening = undefined
  }

  private subscribe(entry: Entry): void {
    const socket = this.socket
    if (!socket) return
    const attempt = ++entry.attempt
    entry.server = 'pending'
    socket.timeout(WORKSPACE_GIT_SUBSCRIBE_TIMEOUT_MS).emit(
      ClientEvents.WORKSPACE_GIT_SUBSCRIBE,
      { workspaceId: entry.workspaceId },
      (error: Error | null, ack?: WorkspaceGitSubscribeAck) => this.handleAck(entry, attempt, error, ack),
    )
  }

  private handleAck(entry: Entry, attempt: number, error: Error | null, ack: WorkspaceGitSubscribeAck | undefined): void {
    if (this.entries.get(entry.workspaceId) !== entry || entry.attempt !== attempt || entry.server !== 'pending') return
    if (error) {
      this.forgetServer(entry)
      // A lost connection subscribes again on reconnect. A timeout revokes the request
      // on the server, so a late success cannot leave an unknown subscription behind.
      if (!this.socket?.connected) return
      this.socket.emit(ClientEvents.WORKSPACE_GIT_UNSUBSCRIBE, { workspaceId: entry.workspaceId })
      this.fail(entry)
      return
    }
    if (!ack?.ok) {
      this.forgetServer(entry)
      this.fail(entry)
      return
    }
    entry.server = 'active'
    this.apply(entry, ack)
    if (entry.refreshAfterAck) {
      entry.refreshAfterAck = false
      this.refresh(entry)
    }
  }

  /** Falls back to REST: the open views reload once and then refetch on window focus. */
  private fail(entry: Entry): void {
    entry.failed = true
    this.invalidateRest(entry)
  }

  /**
   * Refetches the workspace's git queries where they are shown; requests already running are kept.
   * File diffs are keyed by the version tokens of the change list, so they follow it by key.
   */
  private invalidateRest(entry: Entry): void {
    const { workingDir, workspaceId } = entry
    for (const queryKey of [
      queryKeys.git.changes(workingDir),
      queryKeys.workspaces.gitStatus(workspaceId),
      queryKeys.git.log(workingDir),
    ]) {
      void this.queryClient.invalidateQueries({ queryKey }, { cancelRefetch: false })
    }
  }

  private handleEnded = (payload: WorkspaceGitSubscriptionEndedPayload): void => {
    const entry = this.entries.get(payload?.workspaceId)
    if (entry?.server !== 'active') return
    this.forgetServer(entry)
    this.fail(entry)
  }

  private handleState = (payload: WorkspaceGitStatePayload): void => {
    const entry = payload?.workspaceId ? this.entries.get(payload.workspaceId) : undefined
    if (entry?.server === 'active') this.apply(entry, payload)
  }

  private apply(entry: Entry, payload: WorkspaceGitStatePayload): void {
    const previous = this.accepted.get(entry.workspaceId)
    // A new epoch replaces what is held; within an epoch only a higher version is newer.
    if (previous && previous.epoch === payload.epoch && payload.version <= previous.version) return
    const { changes, status, headOid } = payload.state
    this.accepted.set(entry.workspaceId, { epoch: payload.epoch, version: payload.version, headOid })

    const { workingDir, workspaceId } = entry
    const changesKey = queryKeys.git.changes(workingDir)
    const statusKey = queryKeys.workspaces.gitStatus(workspaceId)
    this.queryClient.setQueryData(changesKey, changes)
    this.queryClient.setQueryData(statusKey, status)
    // A REST request that started earlier must not overwrite this state. Cancelling after a
    // manual update keeps that update (TanStack Query reverts to the last manual state).
    void this.queryClient.cancelQueries({ queryKey: changesKey, exact: true })
    void this.queryClient.cancelQueries({ queryKey: statusKey, exact: true })

    // History follows HEAD. The first state finds it freshly loaded by REST, or refetched on
    // focus while it was not covered, so it only fills the two caches. File diffs are keyed by
    // the version tokens of the entries: a file whose token changed gets a new query, the
    // others keep theirs, so nothing here invalidates them.
    if (!previous) return
    if (previous.headOid !== headOid) {
      void this.queryClient.invalidateQueries({ queryKey: queryKeys.git.log(workingDir) })
    }
    void this.queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.diff(workspaceId) })
  }

  private refresh(entry: Entry): void {
    if (!this.socket?.connected || !this.takeFocusAction(entry)) return
    this.socket.emit(ClientEvents.WORKSPACE_GIT_REFRESH, { workspaceId: entry.workspaceId })
  }

  private reloadRest(entry: Entry): void {
    if (this.takeFocusAction(entry)) this.invalidateRest(entry)
  }

  /** At most one focus action per second and workspace, like the server's refresh limit. */
  private takeFocusAction(entry: Entry): boolean {
    const now = this.env.now()
    if (now - entry.lastFocusActionAt < WORKSPACE_GIT_REFRESH_INTERVAL_MS) return false
    entry.lastFocusActionAt = now
    return true
  }

  private handleConnect = (): void => {
    for (const entry of [...this.entries.values()]) {
      this.forgetServer(entry)
      entry.failed = false
      this.reconcile(entry)
    }
  }

  private handleDisconnect = (): void => {
    // The server drops every subscription of a closed connection.
    for (const entry of this.entries.values()) this.forgetServer(entry)
  }

  private handleVisibilityChange = (): void => {
    const visible = this.env.isVisible()
    for (const entry of [...this.entries.values()]) {
      if (visible) entry.failed = false
      this.reconcile(entry)
      // Returning to the tab counts as a focus, whichever of the two events the browser sends
      // first: the server watches no working files, so edits made meanwhile need a refresh.
      if (visible && entry.server === 'pending') entry.refreshAfterAck = true
    }
  }

  private handleFocus = (): void => {
    const connected = !!this.socket?.connected
    for (const entry of this.entries.values()) {
      if (entry.refs === 0) continue
      if (entry.failed || !connected) {
        // REST fallback. TanStack Query refetches on focus only when the tab becomes visible,
        // so a plain window focus reloads the open views here, as often as a refresh.
        this.reloadRest(entry)
      } else if (entry.server === 'active') {
        this.refresh(entry)
      } else if (entry.server === 'pending') {
        // A refresh during a subscribe could be lost on the server; send it with the acknowledgement.
        entry.refreshAfterAck = true
      }
    }
  }

  private forgetServer(entry: Entry): void {
    if (entry.server !== 'none') entry.attempt += 1
    entry.server = 'none'
    entry.refreshAfterAck = false
  }

  private scheduleRelease(entry: Entry): void {
    this.clearTimer(entry)
    entry.timer = setTimeout(() => {
      entry.timer = undefined
      this.reconcile(entry)
    }, 0)
  }

  private clearTimer(entry: Entry): void {
    if (entry.timer === undefined) return
    clearTimeout(entry.timer)
    entry.timer = undefined
  }
}

const browserEnvironment: WorkspaceGitSubscriptionEnvironment = {
  connect: () => socketManager.connect(),
  isVisible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  listen(onVisibilityChange, onFocus) {
    if (typeof window === 'undefined') return () => undefined
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', onFocus)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', onFocus)
    }
  },
  now: () => Date.now(),
}

const managers = new WeakMap<QueryClient, WorkspaceGitSubscriptions>()

/** One manager per query client; the app has a single client and therefore a single manager. */
export function getWorkspaceGitSubscriptions(queryClient: QueryClient): WorkspaceGitSubscriptions {
  let manager = managers.get(queryClient)
  if (!manager) {
    manager = new WorkspaceGitSubscriptions(queryClient)
    managers.set(queryClient, manager)
  }
  return manager
}

/**
 * Refetch options for git REST queries: while a live subscription covers the query, pushes keep it
 * current; otherwise it refetches on window focus and reconnect. No git query uses a timer.
 */
export function gitRestRefetchOptions(isCovered: () => boolean) {
  const refetch = () => (isCovered() ? false : 'always' as const)
  return { refetchOnWindowFocus: refetch, refetchOnReconnect: refetch }
}
