// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedConversation } from '@/stores/session-log-store'
import { useSessionLogStore } from '@/stores/session-log-store'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const SNAPSHOT_RETRY_DELAY_MS = 250

const { socket, apiGet } = vi.hoisted(() => {
  const handlers = new Map<string, Set<(payload?: unknown) => void>>()
  return {
    apiGet: vi.fn(),
    socket: {
      connected: true,
      on: vi.fn((event: string, handler: (payload?: unknown) => void) => {
        const listeners = handlers.get(event) ?? new Set()
        listeners.add(handler)
        handlers.set(event, listeners)
      }),
      off: vi.fn((event: string, handler: (payload?: unknown) => void) => {
        handlers.get(event)?.delete(handler)
      }),
      emit: vi.fn(),
      dispatch(event: string, payload?: unknown) {
        for (const handler of handlers.get(event) ?? []) handler(payload)
      },
      reset() {
        handlers.clear()
        this.connected = true
      },
    },
  }
})

vi.mock('../manager', () => ({
  socketManager: {
    getSocket: () => socket,
    isConnected: () => socket.connected,
  },
}))

vi.mock('../../api-client', () => ({
  apiClient: { get: apiGet },
}))

import { useNormalizedLogs } from '../hooks/useNormalizedLogs'

function message(id: string, content: string) {
  return { id, entryType: 'assistant_message' as const, content, timestamp: Date.now() }
}

function userMessage(id: string, content: string, timestamp = Date.now()) {
  return { id, entryType: 'user_message' as const, content, timestamp }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('useNormalizedLogs reconnect recovery', () => {
  let root: Root
  let container: HTMLDivElement
  let latest: ReturnType<typeof useNormalizedLogs>

  function Harness({
    sessionStatus = 'RUNNING',
    sessionStartedAt,
    sessionEndedAt,
  }: {
    sessionStatus?: string
    sessionStartedAt?: string | number | null
    sessionEndedAt?: string | number | null
  }) {
    const result = useNormalizedLogs({
      sessionId: 'session-1',
      sessionStatus,
      sessionStartedAt,
      sessionEndedAt,
    })
    useEffect(() => {
      latest = result
    }, [result])
    return null
  }

  beforeEach(() => {
    socket.reset()
    apiGet.mockReset()
    useSessionLogStore.getState().clear()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('tracks output activity across exit and a later follow-up patch', async () => {
    const initial: NormalizedConversation = { entries: [message('one', 'before')], seq: 1 }
    apiGet.mockResolvedValueOnce(initial)

    await act(async () => { root.render(<Harness />) })
    await act(async () => { await latest.attach() })
    expect(latest.isOutputActive).toBe(true)

    await act(async () => {
      socket.dispatch('session:exit', { sessionId: 'session-1', exitCode: 0 })
    })
    expect(latest.isOutputActive).toBe(false)
    expect(latest.lastExitAt).toEqual(expect.any(Number))

    await act(async () => {
      socket.dispatch('session:patch', {
        sessionId: 'session-1',
        seq: 2,
        patch: [{ op: 'add', path: '/entries/1', value: message('two', 'follow-up') }],
      })
    })
    expect(latest.isOutputActive).toBe(true)
    expect(latest.lastExitAt).toBeNull()
  })

  it('fetches an authoritative snapshot after reconnect and restores missed entries', async () => {
    const initial: NormalizedConversation = { entries: [message('one', 'before')], seq: 1 }
    const recovered: NormalizedConversation = {
      entries: [message('one', 'before'), message('two', 'missed while offline')],
      seq: 2,
    }
    apiGet.mockResolvedValueOnce(initial).mockResolvedValueOnce(recovered)

    await act(async () => { root.render(<Harness />) })
    await act(async () => { await latest.attach() })
    expect(latest.entries.map((entry) => entry.content)).toEqual(['before'])

    await act(async () => {
      socket.connected = false
      socket.dispatch('disconnect')
    })
    await act(async () => {
      socket.connected = true
      socket.dispatch('connect')
      // Existing consumers also call attach() when isConnected changes. It
      // must share the reconnect request instead of forcing another fetch.
      await latest.attach()
    })

    expect(apiGet).toHaveBeenCalledTimes(2)
    expect(latest.entries.map((entry) => entry.content)).toEqual([
      'before',
      'missed while offline',
    ])
    expect(latest.isAttached).toBe(true)
  })

  it('tracks the current processing cycle and latest live agent output', async () => {
    vi.useFakeTimers()
    const now = new Date('2026-07-16T12:00:00Z').getTime()
    vi.setSystemTime(now)
    const userTimestamp = now - 10_000
    const outputTimestamp = now - 5_000
    apiGet.mockResolvedValue({
      entries: [
        userMessage('user-one', 'question', userTimestamp),
        { ...message('assistant-one', 'initial output'), timestamp: outputTimestamp },
      ],
      seq: 2,
    } satisfies NormalizedConversation)

    await act(async () => { root.render(<Harness />) })
    await act(async () => { await latest.attach() })

    expect(latest.logs.at(-1)?.cursorActivity).toEqual({
      processingStartedAt: userTimestamp,
      lastOutputAt: outputTimestamp,
    })

    await act(async () => {
      socket.dispatch('session:patch', {
        sessionId: 'session-1',
        seq: 3,
        patch: [{ op: 'replace', path: '/entries/1/content', value: 'streamed output' }],
      })
    })
    expect(latest.logs.at(-1)?.cursorActivity?.lastOutputAt).toBe(now)

    const nextUserTimestamp = now + 1_000
    await act(async () => {
      socket.dispatch('session:patch', {
        sessionId: 'session-1',
        seq: 4,
        patch: [{
          op: 'add',
          path: '/entries/2',
          value: userMessage('user-two', 'follow-up', nextUserTimestamp),
        }],
      })
    })
    expect(latest.logs.at(-1)?.cursorActivity).toEqual({
      processingStartedAt: nextUserTimestamp,
      lastOutputAt: undefined,
    })
  })

  it('uses the persisted session start when the initial user entry is missing after refresh', async () => {
    vi.useFakeTimers()
    const now = new Date('2026-07-16T12:00:00Z').getTime()
    vi.setSystemTime(now)
    const sessionStartedAt = now - 27_000
    const sessionStartedAtIso = new Date(sessionStartedAt).toISOString()
    const firstOutputAt = now - 11_000
    apiGet.mockResolvedValue({
      entries: [{ ...message('assistant-one', 'first output'), timestamp: firstOutputAt }],
      seq: 1,
    } satisfies NormalizedConversation)

    await act(async () => { root.render(<Harness sessionStartedAt={sessionStartedAtIso} />) })
    await act(async () => { await latest.attach() })

    expect(latest.logs.at(-1)?.cursorActivity?.processingStartedAt).toBe(sessionStartedAt)
  })

  it('restores the persisted exit time for a completed text-only response', async () => {
    const startedAt = new Date('2026-07-16T12:00:00Z').getTime()
    const firstOutputAt = startedAt + 4_000
    const endedAt = startedAt + 27_000
    apiGet.mockResolvedValue({
      entries: [{ ...message('assistant-one', 'text-only response'), timestamp: firstOutputAt }],
      seq: 1,
    } satisfies NormalizedConversation)

    await act(async () => {
      root.render(
        <Harness
          sessionStatus="COMPLETED"
          sessionStartedAt={new Date(startedAt).toISOString()}
          sessionEndedAt={new Date(endedAt).toISOString()}
        />,
      )
    })
    await act(async () => { await latest.attach() })

    expect(latest.isOutputActive).toBe(false)
    expect(latest.lastExitAt).toBe(endedAt)
  })

  it('discards an in-flight snapshot from an older connection epoch', async () => {
    const staleRequest = deferred<NormalizedConversation>()
    const initial: NormalizedConversation = { entries: [message('one', 'before')], seq: 1 }
    const recovered: NormalizedConversation = {
      entries: [message('one', 'before'), message('two', 'after second reconnect')],
      seq: 2,
    }
    apiGet
      .mockResolvedValueOnce(initial)
      .mockImplementationOnce(() => staleRequest.promise)
      .mockResolvedValueOnce(recovered)

    await act(async () => { root.render(<Harness />) })
    await act(async () => { await latest.attach() })

    await act(async () => {
      socket.connected = false
      socket.dispatch('disconnect')
      socket.connected = true
      socket.dispatch('connect')
      await Promise.resolve()
    })
    expect(apiGet).toHaveBeenCalledTimes(2)

    await act(async () => {
      socket.connected = false
      socket.dispatch('disconnect')
      socket.connected = true
      socket.dispatch('connect')
      staleRequest.resolve({ entries: [message('one', 'stale response')], seq: 1 })
      await staleRequest.promise
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(apiGet).toHaveBeenCalledTimes(3)
    expect(latest.entries.map((entry) => entry.content)).toEqual([
      'before',
      'after second reconnect',
    ])
    expect(latest.isAttached).toBe(true)
  })

  it('keeps the session unsynced and retries a transient snapshot failure', async () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const initial: NormalizedConversation = { entries: [message('one', 'before')], seq: 1 }
    const recovered: NormalizedConversation = {
      entries: [message('one', 'before'), message('two', 'recovered after retry')],
      seq: 2,
    }
    apiGet
      .mockResolvedValueOnce(initial)
      .mockRejectedValueOnce(new TypeError('temporary network failure'))
      .mockResolvedValueOnce(recovered)

    await act(async () => { root.render(<Harness />) })
    await act(async () => { await latest.attach() })

    await act(async () => {
      socket.connected = false
      socket.dispatch('disconnect')
      socket.connected = true
      socket.dispatch('connect')
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(latest.isAttached).toBe(false)
    expect(apiGet).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SNAPSHOT_RETRY_DELAY_MS)
    })

    expect(apiGet).toHaveBeenCalledTimes(3)
    expect(latest.entries.map((entry) => entry.content)).toEqual([
      'before',
      'recovered after retry',
    ])
    expect(latest.isAttached).toBe(true)
    consoleError.mockRestore()
  })

  it('refetches when buffered patches reveal a sequence gap', async () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const staleRequest = deferred<NormalizedConversation>()
    const initial: NormalizedConversation = { entries: [message('one', 'before')], seq: 1 }
    const recovered: NormalizedConversation = {
      entries: [
        message('one', 'before'),
        message('two', 'missing seq two'),
        message('three', 'seq three'),
      ],
      seq: 3,
    }
    apiGet
      .mockResolvedValueOnce(initial)
      .mockImplementationOnce(() => staleRequest.promise)
      .mockResolvedValueOnce(recovered)

    await act(async () => { root.render(<Harness />) })
    await act(async () => { await latest.attach() })

    await act(async () => {
      socket.connected = false
      socket.dispatch('disconnect')
      socket.connected = true
      socket.dispatch('connect')
      socket.dispatch('session:patch', {
        sessionId: 'session-1',
        seq: 3,
        patch: [{ op: 'add', path: '/entries/1', value: message('three', 'seq three') }],
      })
      staleRequest.resolve(initial)
      await staleRequest.promise
      await Promise.resolve()
    })

    expect(latest.isAttached).toBe(false)
    expect(apiGet).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SNAPSHOT_RETRY_DELAY_MS)
    })

    expect(apiGet).toHaveBeenCalledTimes(3)
    expect(latest.entries.map((entry) => entry.content)).toEqual([
      'before',
      'missing seq two',
      'seq three',
    ])
    expect(latest.isAttached).toBe(true)
    consoleError.mockRestore()
  })

  it('does not retry a non-retryable HTTP error', async () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const initial: NormalizedConversation = { entries: [message('one', 'before')], seq: 1 }
    apiGet
      .mockResolvedValueOnce(initial)
      .mockRejectedValueOnce({ status: 404, message: 'Session not found' })

    await act(async () => { root.render(<Harness />) })
    await act(async () => { await latest.attach() })

    let reconnectResult = true
    await act(async () => {
      socket.connected = false
      socket.dispatch('disconnect')
      socket.connected = true
      socket.dispatch('connect')
      reconnectResult = await latest.attach()
    })

    expect(reconnectResult).toBe(false)
    expect(latest.isAttached).toBe(false)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(apiGet).toHaveBeenCalledTimes(2)
    consoleError.mockRestore()
  })

  it('continues recovery in the background after foreground retries are exhausted', async () => {
    vi.useFakeTimers()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const initial: NormalizedConversation = { entries: [message('one', 'before')], seq: 1 }
    const recovered: NormalizedConversation = {
      entries: [message('one', 'before'), message('two', 'background recovery')],
      seq: 2,
    }
    apiGet
      .mockResolvedValueOnce(initial)
      .mockRejectedValueOnce(new TypeError('failure one'))
      .mockRejectedValueOnce(new TypeError('failure two'))
      .mockRejectedValueOnce(new TypeError('failure three'))
      .mockRejectedValueOnce(new TypeError('failure four'))
      .mockResolvedValueOnce(recovered)

    await act(async () => { root.render(<Harness />) })
    await act(async () => { await latest.attach() })
    await act(async () => {
      socket.connected = false
      socket.dispatch('disconnect')
      socket.connected = true
      socket.dispatch('connect')
      await vi.runAllTimersAsync()
    })

    expect(apiGet).toHaveBeenCalledTimes(6)
    expect(latest.entries.map((entry) => entry.content)).toEqual([
      'before',
      'background recovery',
    ])
    expect(latest.isAttached).toBe(true)
    consoleError.mockRestore()
  })
})
