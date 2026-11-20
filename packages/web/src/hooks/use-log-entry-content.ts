import { useQuery, type QueryClient } from '@tanstack/react-query'
import { apiClient } from '@/lib/api-client'
import { queryKeys } from './query-keys'

/**
 * Full tool outputs that the light log view (`?view=light`) left out.
 *
 * The log view shows a tool's output only after the user expands it, so the
 * opening download carries a prefix (`contentOmitted` = full length) and the
 * text comes from `GET /sessions/:id/logs/entries` on demand. Requests issued
 * in the same tick share one HTTP request.
 */

/** Server limit for one `GET /sessions/:id/logs/entries` request. */
const MAX_ENTRIES_PER_REQUEST = 50
/** Opening a tool group prefetches its outputs when they are at most this long in total. */
export const GROUP_PREFETCH_CHAR_LIMIT = 200_000
const CONTENT_GC_MS = 10 * 60_000

interface PendingContent {
  id: string
  length: number
  resolve: (content: string) => void
  reject: (error: unknown) => void
}

const queues = new Map<string, PendingContent[]>()

function flush(sessionId: string): void {
  const pending = queues.get(sessionId) ?? []
  queues.delete(sessionId)
  for (let start = 0; start < pending.length; start += MAX_ENTRIES_PER_REQUEST) {
    const batch = pending.slice(start, start + MAX_ENTRIES_PER_REQUEST)
    // IDs are encoded one by one, so `,` and `:` inside an ID stay unambiguous.
    const keys = [...new Set(batch.map((item) => `${encodeURIComponent(item.id)}:${item.length}`))]
    apiClient.get<{ entries: Array<{ id: string; length?: number; content: string }> }>(
      `/sessions/${encodeURIComponent(sessionId)}/logs/entries`,
      { params: { entries: keys.join(',') } },
    ).then(({ entries }) => {
      // Entry IDs repeat in long logs; the echoed length tells the answers apart.
      const byKey = new Map(entries.map((entry) => [`${entry.id}:${entry.length}`, entry.content]))
      for (const item of batch) {
        const content = byKey.get(`${item.id}:${item.length}`)
        if (content === undefined) item.reject(new Error('Log entry is no longer available'))
        else item.resolve(content)
      }
    })
    // Also catches a malformed answer, so no output stays loading forever.
    .catch((error: unknown) => {
      for (const item of batch) item.reject(error)
    })
  }
}

export function loadLogEntryContent(sessionId: string, id: string, length: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let queue = queues.get(sessionId)
    if (!queue) {
      queue = []
      queues.set(sessionId, queue)
      setTimeout(() => flush(sessionId), 0)
    }
    queue.push({ id, length, resolve, reject })
  })
}

/** Loads the full output of an omitted entry (`length` = its `contentOmitted`); idle without a session. */
export function useLogEntryContent(sessionId: string | undefined, id: string, length: number) {
  return useQuery({
    queryKey: queryKeys.sessionLogEntries.content(sessionId ?? '', id, length),
    queryFn: () => loadLogEntryContent(sessionId!, id, length),
    enabled: Boolean(sessionId),
    staleTime: Infinity,
    gcTime: CONTENT_GC_MS,
    retry: 1,
  })
}

/** Starts loading the omitted outputs of a tool group the user just opened. */
export function prefetchLogEntryContents(
  client: QueryClient,
  sessionId: string,
  entries: ReadonlyArray<{ id: string; length: number }>,
): void {
  let total = 0
  for (const entry of entries) total += entry.length
  if (entries.length === 0 || total > GROUP_PREFETCH_CHAR_LIMIT) return
  for (const entry of entries) {
    void client.prefetchQuery({
      queryKey: queryKeys.sessionLogEntries.content(sessionId, entry.id, entry.length),
      queryFn: () => loadLogEntryContent(sessionId, entry.id, entry.length),
      staleTime: Infinity,
      gcTime: CONTENT_GC_MS,
    })
  }
}
