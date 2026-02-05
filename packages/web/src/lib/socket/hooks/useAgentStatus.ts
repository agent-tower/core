import { useEffect, useState } from 'react'
import { socketManager } from '../manager.js'
import { useAgentStore } from '@/stores/agent-store'
import {
  AgentClientEvents,
  AgentServerEvents,
  type AgentStatusPayload,
} from '@agent-tower/shared/socket'

interface UseAgentStatusOptions {
  agentId?: string // 不传则订阅所有
  autoConnect?: boolean
}

interface UseAgentStatusReturn {
  isConnected: boolean
  subscribe: () => void
  unsubscribe: () => void
}

/**
 * Agent 状态订阅 Hook
 * 自动连接并订阅 Agent 状态变化，更新到 Zustand store
 */
export function useAgentStatus(options: UseAgentStatusOptions = {}): UseAgentStatusReturn {
  const { agentId, autoConnect = true } = options
  const [isConnected, setIsConnected] = useState(false)
  const updateAgentStatus = useAgentStore((state) => state.updateAgentStatus)

  useEffect(() => {
    if (!autoConnect) return

    const socket = socketManager.connect('AGENTS')

    // 连接状态
    const handleConnect = () => {
      setIsConnected(true)
      // 连接后自动订阅
      socket.emit(AgentClientEvents.SUBSCRIBE, { agentId })
    }

    const handleDisconnect = () => {
      setIsConnected(false)
    }

    // Agent 状态变化
    const handleStatusChanged = (payload: AgentStatusPayload) => {
      updateAgentStatus(payload)
    }

    // 注册事件监听
    socket.on('connect', handleConnect)
    socket.on('disconnect', handleDisconnect)
    socket.on(AgentServerEvents.STATUS_CHANGED, handleStatusChanged)

    // 如果已连接，立即订阅
    if (socket.connected) {
      setIsConnected(true)
      socket.emit(AgentClientEvents.SUBSCRIBE, { agentId })
    }

    // 清理
    return () => {
      socket.off('connect', handleConnect)
      socket.off('disconnect', handleDisconnect)
      socket.off(AgentServerEvents.STATUS_CHANGED, handleStatusChanged)

      // 取消订阅
      if (socket.connected) {
        socket.emit(AgentClientEvents.UNSUBSCRIBE, { agentId })
      }
    }
  }, [agentId, autoConnect, updateAgentStatus])

  // 手动订阅
  const subscribe = () => {
    const socket = socketManager.connect('AGENTS')
    socket.emit(AgentClientEvents.SUBSCRIBE, { agentId })
  }

  // 手动取消订阅
  const unsubscribe = () => {
    const socket = socketManager.getSocket('AGENTS')
    socket.emit(AgentClientEvents.UNSUBSCRIBE, { agentId })
  }

  return {
    isConnected,
    subscribe,
    unsubscribe,
  }
}
