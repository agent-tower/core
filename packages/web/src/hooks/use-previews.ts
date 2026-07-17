import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { OpenPreviewSessionInput, PreviewSession, PreviewStatus } from '@agent-tower/shared'
import { apiClient, ApiError } from '@/lib/api-client'
import { resolvePreviewViewUrl } from '@/lib/preview-url'
import { queryKeys } from './query-keys'

function resolvePreviewStatus(status: PreviewStatus): PreviewStatus {
  return {
    ...status,
    viewUrl: status.viewUrl ? resolvePreviewViewUrl(status.viewUrl) : null,
  }
}

export function usePreviewStatus(workspaceId?: string) {
  return useQuery({
    queryKey: queryKeys.previews.status(workspaceId ?? ''),
    queryFn: async () => {
      const status = await apiClient.get<PreviewStatus>(`/previews/${workspaceId}/status`)
      return resolvePreviewStatus(status)
    },
    enabled: Boolean(workspaceId),
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

function currentPreviewMode(): 'local' | 'remote' {
  return window.location.protocol === 'https:' ? 'remote' : 'local'
}

export function usePreviewSession(workspaceId: string | undefined, status: PreviewStatus | undefined) {
  const [session, setSession] = useState<PreviewSession | null>(null)
  const [isOpening, setIsOpening] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [generation, setGeneration] = useState(0)

  useEffect(() => {
    if (!workspaceId || !status?.ready || !status.target) {
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
        const input: OpenPreviewSessionInput = {
          mode: currentPreviewMode(),
          localHostname: window.location.hostname,
        }
        const opened = await apiClient.post<PreviewSession>(`/previews/${workspaceId}/sessions`, input)
        if (cancelled) {
          release(opened.id)
          return
        }

        sessionId = opened.id
        setSession(opened)
        heartbeatTimer = window.setInterval(async () => {
          if (!sessionId) return
          try {
            const refreshed = await apiClient.post<PreviewSession>(
              `/previews/${workspaceId}/sessions/${sessionId}/heartbeat`,
            )
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
  }, [generation, status?.ready, status?.target, workspaceId])

  return {
    session,
    isOpening,
    error,
    retry: () => setGeneration((current) => current + 1),
  }
}
