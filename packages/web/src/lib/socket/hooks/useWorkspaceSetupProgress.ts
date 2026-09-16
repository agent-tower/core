import { useState, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { socketManager } from '../manager.js'
import { apiClient } from '@/lib/api-client'
import { queryKeys } from '@/hooks/query-keys'
import {
  ServerEvents,
  type WorkspaceSetupProgressPayload,
} from '@agent-tower/shared/socket'

export interface SetupProgress {
  status: 'running' | 'completed' | 'failed'
  currentCommand?: string
  currentIndex?: number
  totalCommands: number
  error?: string
  output?: string
}

/** Setup 终态展示时长（ms），之后卡片自动收起。 */
const CLEAR_DELAY_MS = 3000

function mergeProgress(snapshots: WorkspaceSetupProgressPayload[], updates: WorkspaceSetupProgressPayload[]) {
  const byWorkspace = new Map(snapshots.map(progress => [progress.workspaceId, progress]))
  for (const progress of updates) {
    const previous = byWorkspace.get(progress.workspaceId)
    if (!previous || progress.updatedAt >= previous.updatedAt) byWorkspace.set(progress.workspaceId, progress)
  }
  return [...byWorkspace.values()]
}

/** Restore missed setup events on mount/reconnect; keep newer events during a snapshot request. */
export function useWorkspaceSetupProgress(taskId: string | undefined): SetupProgress | null {
  const queryClient = useQueryClient()
  const liveUpdates = useRef({ version: 0, values: new Map<string, { version: number; progress: WorkspaceSetupProgressPayload }>() })
  const [dismissedTerminalAt, setDismissedTerminalAt] = useState(0)
  const { data = [] } = useQuery<WorkspaceSetupProgressPayload[]>({
    queryKey: queryKeys.workspaces.setupProgress(taskId ?? ''),
    enabled: Boolean(taskId),
    refetchOnMount: 'always',
    refetchInterval: query => query.state.data?.some(progress => progress.status === 'running') ? 3000 : false,
    queryFn: async ({ signal }) => {
      const version = liveUpdates.current.version
      const snapshot = await apiClient.get<WorkspaceSetupProgressPayload[]>(`/tasks/${taskId}/setup-progress`, { signal })
      const updates = [...liveUpdates.current.values.values()]
        .filter(update => update.version > version && update.progress.taskId === taskId)
        .map(update => update.progress)
      return mergeProgress(snapshot, updates)
    },
  })

  useEffect(() => {
    if (!taskId) return
    const socket = socketManager.connect()
    const queryKey = queryKeys.workspaces.setupProgress(taskId)
    const handler = (payload: WorkspaceSetupProgressPayload) => {
      if (payload.taskId !== taskId) return
      const previous = liveUpdates.current.values.get(payload.workspaceId)
      if (previous && previous.progress.updatedAt > payload.updatedAt) return
      liveUpdates.current.values.set(payload.workspaceId, {
        version: ++liveUpdates.current.version,
        progress: payload,
      })
      queryClient.setQueryData<WorkspaceSetupProgressPayload[]>(queryKey,
        previous => mergeProgress(previous ?? [], [payload]))
    }
    const onConnect = () => {
      void queryClient.invalidateQueries({ queryKey })
    }

    socket.on(ServerEvents.WORKSPACE_SETUP_PROGRESS, handler)
    socket.on('connect', onConnect)
    return () => {
      socket.off(ServerEvents.WORKSPACE_SETUP_PROGRESS, handler)
      socket.off('connect', onConnect)
    }
  }, [taskId, queryClient])

  const sorted = [...data].sort((a, b) => b.updatedAt - a.updatedAt)
  const progress = sorted.find(item => item.status === 'running')
    ?? sorted.find(item => item.status !== 'running' && item.updatedAt > dismissedTerminalAt)

  const terminalAt = progress?.status !== 'running' ? progress?.updatedAt ?? null : null
  useEffect(() => {
    if (terminalAt === null) return
    const timer = setTimeout(() => setDismissedTerminalAt(terminalAt), CLEAR_DELAY_MS)
    return () => clearTimeout(timer)
  }, [terminalAt])

  return progress ?? null
}
