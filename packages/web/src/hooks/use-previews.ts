import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { OpenPreviewSessionInput, PreviewSession, PreviewStatus } from '@agent-tower/shared'
import { apiClient, ApiError } from '@/lib/api-client'
import { resolvePreviewViewUrl } from '@/lib/preview-url'
import { queryKeys } from './query-keys'

const GATEWAY_PROBE_TIMEOUT_MS = 2500
const GATEWAY_PROBE_FAILURE_TTL_MS = 60_000
const GATEWAY_HEARTBEAT_PATH = '/__agent_tower_preview_heartbeat'

function resolvePreviewStatus(status: PreviewStatus): PreviewStatus {
  return {
    ...status,
    viewUrl: status.viewUrl ? resolvePreviewViewUrl(status.viewUrl) : null,
  }
}

function resolvePreviewSession(session: PreviewSession): PreviewSession {
  return {
    ...session,
    viewUrl: session.kind === 'same-origin' ? resolvePreviewViewUrl(session.viewUrl) : session.viewUrl,
  }
}

export function usePreviewStatus(workspaceId?: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.previews.status(workspaceId ?? ''),
    queryFn: async () => {
      const status = await apiClient.get<PreviewStatus>(`/previews/${workspaceId}/status`)
      return resolvePreviewStatus(status)
    },
    enabled: Boolean(workspaceId) && enabled,
    refetchOnWindowFocus: false,
  })
}

export function useUpdatePreviewConfig(workspaceId?: string) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (target: string | null) => {
      const status = await apiClient.put<PreviewStatus>(`/previews/${workspaceId}/config`, { target })
      return resolvePreviewStatus(status)
    },
    onSuccess: (status) => {
      if (!workspaceId) return
      queryClient.setQueryData(queryKeys.previews.status(workspaceId), status)
      queryClient.invalidateQueries({ queryKey: queryKeys.workspaces.all })
    },
  })
}

/**
 * HTTPS pages (tunnels, reverse proxies) cannot embed a plain-HTTP gateway port,
 * so they always ask for the same-origin proxy. Plain-HTTP pages try the
 * dedicated gateway first and fall back when the browser cannot reach it.
 */
export function currentPreviewMode(): 'local' | 'remote' {
  return window.location.protocol === 'https:' ? 'remote' : 'local'
}

const gatewayProbeResults = new Map<string, { reachable: boolean; checkedAt: number }>()

/**
 * Check whether this browser can open the dedicated gateway origin at all.
 * The request is opaque (`no-cors`), so any HTTP answer counts as reachable;
 * only network failures (unreachable host, blocked port, mixed content) fail.
 */
export async function probeGatewayReachability(
  viewUrl: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<boolean> {
  let origin: string
  try {
    origin = new URL(viewUrl).origin
  } catch {
    return false
  }

  const cached = gatewayProbeResults.get(origin)
  if (cached && (cached.reachable || now() - cached.checkedAt < GATEWAY_PROBE_FAILURE_TTL_MS)) {
    return cached.reachable
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GATEWAY_PROBE_TIMEOUT_MS)
  let reachable = false
  try {
    await fetchImpl(`${origin}${GATEWAY_HEARTBEAT_PATH}`, {
      mode: 'no-cors',
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
    })
    reachable = true
  } catch {
    reachable = false
  } finally {
    clearTimeout(timer)
  }
  gatewayProbeResults.set(origin, { reachable, checkedAt: now() })
  return reachable
}

export function resetGatewayProbeCache(): void {
  gatewayProbeResults.clear()
}

export async function openPreviewSession(workspaceId: string): Promise<PreviewSession> {
  const localHostname = window.location.hostname
  const input: OpenPreviewSessionInput = { mode: currentPreviewMode(), localHostname }
  const opened = resolvePreviewSession(
    await apiClient.post<PreviewSession>(`/previews/${workspaceId}/sessions`, input),
  )
  if (opened.kind !== 'gateway') return opened
  if (await probeGatewayReachability(opened.viewUrl)) return opened

  // The gateway port is not reachable from here (reverse proxy, firewall,
  // another network); release it and use the same-origin proxy instead.
  void apiClient.delete(`/previews/${workspaceId}/sessions/${opened.id}`).catch(() => {})
  const fallback: OpenPreviewSessionInput = { mode: 'remote', localHostname }
  return resolvePreviewSession(
    await apiClient.post<PreviewSession>(`/previews/${workspaceId}/sessions`, fallback),
  )
}

export function usePreviewSession(
  workspaceId: string | undefined,
  status: PreviewStatus | undefined,
  enabled = true,
) {
  const [session, setSession] = useState<PreviewSession | null>(null)
  const [isOpening, setIsOpening] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    if (!enabled || !workspaceId || !status?.ready || !status.target) {
      setSession(null)
      setIsOpening(false)
      setError(null)
      return
    }

    let cancelled = false
    let sessionId: string | null = null
    let heartbeatTimer: number | null = null
    setSession(null)

    const release = (id: string) => {
      void apiClient.delete(`/previews/${workspaceId}/sessions/${id}`).catch(() => {})
    }

    const open = async () => {
      setIsOpening(true)
      setError(null)
      try {
        const opened = await openPreviewSession(workspaceId)
        if (cancelled) {
          if (opened.kind === 'gateway') release(opened.id)
          return
        }

        setSession(opened)
        if (opened.kind !== 'gateway') return

        sessionId = opened.id
        heartbeatTimer = window.setInterval(async () => {
          if (!sessionId) return
          try {
            const refreshed = resolvePreviewSession(await apiClient.post<PreviewSession>(
              `/previews/${workspaceId}/sessions/${sessionId}/heartbeat`,
            ))
            if (!cancelled) {
              setSession(refreshed)
              setError(null)
            }
          } catch (err) {
            if (!cancelled && err instanceof ApiError && err.status === 404) {
              setGeneration((current) => current + 1)
            } else if (!cancelled) {
              setError(err instanceof Error ? err : new Error('Preview session heartbeat failed'))
            }
          }
        }, 30_000)
      } catch (err) {
        if (!cancelled) {
          setSession(null)
          setError(err instanceof Error ? err : new Error('Failed to open preview session'))
        }
      } finally {
        if (!cancelled) setIsOpening(false)
      }
    }

    void open()
    return () => {
      cancelled = true
      if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer)
      if (sessionId) release(sessionId)
    }
  }, [enabled, generation, status?.ready, status?.target, workspaceId])

  return {
    session,
    isOpening,
    error,
    retry: () => setGeneration((current) => current + 1),
  }
}
