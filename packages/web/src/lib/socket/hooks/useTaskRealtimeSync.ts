import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { socketManager } from '../manager.js'
import {
  ClientEvents,
  ServerEvents,
  type TaskUpdatedPayload,
  type TaskDeletedPayload,
  type AckResponse,
} from '@agent-tower/shared/socket'
import { queryKeys } from '@/hooks/query-keys'

/**
 * 实时同步 Task 状态的 Hook
 *
 * 功能：
 * 1. 订阅当前可见项目的 project room（WebSocket）
 * 2. 监听 TASK_UPDATED / TASK_DELETED 事件
 * 3. 收到事件后自动 invalidate TanStack Query 缓存，触发前端数据刷新
 *
 * @param projectIds - 当前需要订阅的项目 ID 列表
 */
export function useTaskRealtimeSync(projectIds: string[]) {
  const queryClient = useQueryClient()
  const subscribedRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (projectIds.length === 0) return

    const socket = socketManager.connect()
    const currentSubscribed = subscribedRef.current
    const targetIds = new Set(projectIds)

    // Subscribe to new project rooms
    for (const id of targetIds) {
      if (!currentSubscribed.has(id)) {
        socket.emit(
          ClientEvents.SUBSCRIBE,
          { topic: 'project', id },
          (res: AckResponse) => {
            if (res.success) {
              currentSubscribed.add(id)
            }
          },
        )
      }
    }

    // Unsubscribe from project rooms that are no longer needed
    for (const id of currentSubscribed) {
      if (!targetIds.has(id)) {
        socket.emit(
          ClientEvents.UNSUBSCRIBE,
          { topic: 'project', id },
          () => {
            currentSubscribed.delete(id)
          },
        )
      }
    }

    // --- Event handlers ---
    const handleTaskUpdated = (payload: TaskUpdatedPayload) => {
      // Invalidate the specific project's task list
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.list(payload.projectId),
      })
      // Also invalidate the task detail if it's being viewed
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.detail(payload.taskId),
      })
    }

    const handleTaskDeleted = (payload: TaskDeletedPayload) => {
      // Invalidate the project's task list
      queryClient.invalidateQueries({
        queryKey: queryKeys.tasks.list(payload.projectId),
      })
      // Remove the deleted task's detail from cache
      queryClient.removeQueries({
        queryKey: queryKeys.tasks.detail(payload.taskId),
      })
    }

    socket.on(ServerEvents.TASK_UPDATED, handleTaskUpdated)
    socket.on(ServerEvents.TASK_DELETED, handleTaskDeleted)

    return () => {
      socket.off(ServerEvents.TASK_UPDATED, handleTaskUpdated)
      socket.off(ServerEvents.TASK_DELETED, handleTaskDeleted)

      // Unsubscribe all on cleanup
      for (const id of currentSubscribed) {
        socket.emit(ClientEvents.UNSUBSCRIBE, { topic: 'project', id })
      }
      currentSubscribed.clear()
    }
  }, [projectIds, queryClient])
}
