import { useState, useEffect, useRef } from 'react'
import { socketManager } from '../manager.js'
import {
  ClientEvents,
  ServerEvents,
  type WorkspaceSetupProgressPayload,
  type AckResponse,
} from '@agent-tower/shared/socket'

export interface SetupProgress {
  status: 'running' | 'completed' | 'failed'
  currentCommand?: string
  currentIndex?: number
  totalCommands: number
  error?: string
}

/** running 状态最少展示时长（ms），避免快速闪过 */
const MIN_RUNNING_MS = 1500
/** 终态（completed/failed）展示时长（ms），之后自动清除 */
const CLEAR_DELAY_MS = 3000

/**
 * 订阅 workspace setup 脚本的执行进度。
 * 通过 task room 接收 WORKSPACE_SETUP_PROGRESS 事件。
 *
 * 为避免 setup 执行过快导致 running 状态一闪而过，
 * 内部保证 running 至少展示 MIN_RUNNING_MS 后才切换到终态。
 */
export function useWorkspaceSetupProgress(taskId: string | undefined): SetupProgress | null {
  const [progress, setProgress] = useState<SetupProgress | null>(null)

  // 记录 running 首次展示的时间戳
  const runningStartRef = useRef<number>(0)
  // 缓存待延迟展示的终态
  const pendingTerminalRef = useRef<SetupProgress | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!taskId) return

    const clearTimer = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }

    const socket = socketManager.connect()

    // 加入 task room（TaskDetail 可能已订阅，重复 join 是幂等的）
    socket.emit(
      ClientEvents.SUBSCRIBE,
      { topic: 'task', id: taskId },
      (_res: AckResponse) => {},
    )

    const applyTerminal = (p: SetupProgress) => {
      setProgress(p)
      timerRef.current = setTimeout(() => setProgress(null), CLEAR_DELAY_MS)
    }

    const handler = (payload: WorkspaceSetupProgressPayload) => {
      if (payload.taskId !== taskId) return

      const incoming: SetupProgress = {
        status: payload.status,
        currentCommand: payload.currentCommand,
        currentIndex: payload.currentIndex,
        totalCommands: payload.totalCommands,
        error: payload.error,
      }

      if (payload.status === 'running') {
        clearTimer()
        pendingTerminalRef.current = null
        if (runningStartRef.current === 0) {
          runningStartRef.current = Date.now()
        }
        setProgress(incoming)
        return
      }

      // 终态：completed / failed
      const elapsed = runningStartRef.current > 0 ? Date.now() - runningStartRef.current : 0
      const remaining = MIN_RUNNING_MS - elapsed

      if (runningStartRef.current === 0) {
        // 从未收到 running 事件 — 先合成一个 running 再延迟切换
        runningStartRef.current = Date.now()
        setProgress({
          status: 'running',
          totalCommands: payload.totalCommands,
          currentIndex: payload.totalCommands,
        })
        pendingTerminalRef.current = incoming
        timerRef.current = setTimeout(() => applyTerminal(incoming), MIN_RUNNING_MS)
      } else if (remaining > 0) {
        // running 展示不够久 — 延迟切换
        pendingTerminalRef.current = incoming
        clearTimer()
        timerRef.current = setTimeout(() => applyTerminal(incoming), remaining)
      } else {
        // running 已展示足够久 — 立即切换
        applyTerminal(incoming)
      }
    }

    socket.on(ServerEvents.WORKSPACE_SETUP_PROGRESS, handler)

    return () => {
      socket.off(ServerEvents.WORKSPACE_SETUP_PROGRESS, handler)
      clearTimer()
      runningStartRef.current = 0
      pendingTerminalRef.current = null
    }
  }, [taskId])

  return progress
}
