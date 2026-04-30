import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { socketManager } from '../manager.js'
import {
  ServerEvents,
  type TaskUpdatedPayload,
  type TaskDeletedPayload,
} from '@agent-tower/shared/socket'
import { queryKeys } from '@/hooks/query-keys'

/**
 * 实时同步 Task 状态的 Hook
 *
 * 功能：
 * 1. 监听 TASK_UPDATED / TASK_DELETED 事件（全量广播，前端按 projectId 过滤）
 * 2. 收到事件后自动 invalidate TanStack Query 缓存，触发前端数据刷新
 * 3. 重连时 invalidate 所有 tasks 查询以补齐丢失事件
 */
export function useTaskRealtimeSync() {
  const queryClient = useQueryClient()

  useEffect(() => {
    const socket = socketManager.connect()

    // On reconnect: invalidate all task queries to compensate for missed events
    const handleReconnect = () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all })
    }

    // --- Event handlers ---
    const handleTaskUpdated = async (payload: TaskUpdatedPayload) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.tasks.list(payload.projectId),
      })
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.list(payload.projectId),
      })
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.detail(payload.taskId),
      })
    }

    const handleTaskDeleted = (payload: TaskDeletedPayload) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.list(payload.projectId),
      })
      queryClient.removeQueries({
        queryKey: queryKeys.tasks.detail(payload.taskId),
      })
    }

    socket.on('connect', handleReconnect)
    socket.on(ServerEvents.TASK_UPDATED, handleTaskUpdated)
    socket.on(ServerEvents.TASK_DELETED, handleTaskDeleted)

    return () => {
      socket.off('connect', handleReconnect)
      socket.off(ServerEvents.TASK_UPDATED, handleTaskUpdated)
      socket.off(ServerEvents.TASK_DELETED, handleTaskDeleted)
    }
  }, [queryClient])
}
