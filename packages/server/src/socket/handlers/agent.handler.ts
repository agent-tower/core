import type { Namespace, Socket } from 'socket.io'
import type { SocketHandler } from './base.handler.js'
import {
  AgentClientEvents,
  AgentServerEvents,
  type AgentSubscribePayload,
  type AgentStatusPayload,
  type AckResponse,
} from '../events.js'

// 存储命名空间引用，用于从外部广播
let agentNamespace: Namespace | null = null

/**
 * 获取 Agent 命名空间（用于从外部广播状态）
 */
export function getAgentNamespace(): Namespace | null {
  return agentNamespace
}

/**
 * 广播 Agent 状态变化
 * 可从任何地方调用（如 session service）
 */
export function broadcastAgentStatus(payload: AgentStatusPayload): void {
  if (!agentNamespace) {
    console.warn('[Agent] Namespace not initialized, cannot broadcast')
    return
  }

  // 广播到订阅了特定 agent 的房间
  agentNamespace.to(`agent:${payload.agentId}`).emit(AgentServerEvents.STATUS_CHANGED, payload)

  // 同时广播到订阅了所有 agent 的房间
  agentNamespace.to('agent:all').emit(AgentServerEvents.STATUS_CHANGED, payload)
}

/**
 * Agent Handler
 * 处理 Agent 状态订阅和通知
 */
export class AgentHandler implements SocketHandler {
  register(nsp: Namespace, socket: Socket): void {
    // 保存命名空间引用
    agentNamespace = nsp

    // 订阅 Agent 状态
    socket.on(AgentClientEvents.SUBSCRIBE, (payload: AgentSubscribePayload, ack?: (res: AckResponse) => void) => {
      this.handleSubscribe(socket, payload, ack)
    })

    // 取消订阅
    socket.on(AgentClientEvents.UNSUBSCRIBE, (payload: AgentSubscribePayload, ack?: (res: AckResponse) => void) => {
      this.handleUnsubscribe(socket, payload, ack)
    })

    // 断开连接时清理
    socket.on('disconnect', () => {
      console.log(`[Agent] Socket disconnected: ${socket.id}`)
    })
  }

  private handleSubscribe(
    socket: Socket,
    payload: AgentSubscribePayload,
    ack?: (res: AckResponse) => void
  ): void {
    const { agentId } = payload

    if (agentId) {
      // 订阅特定 agent
      socket.join(`agent:${agentId}`)
      console.log(`[Agent] Socket ${socket.id} subscribed to agent:${agentId}`)
    } else {
      // 订阅所有 agent
      socket.join('agent:all')
      console.log(`[Agent] Socket ${socket.id} subscribed to all agents`)
    }

    ack?.({ success: true })
  }

  private handleUnsubscribe(
    socket: Socket,
    payload: AgentSubscribePayload,
    ack?: (res: AckResponse) => void
  ): void {
    const { agentId } = payload

    if (agentId) {
      socket.leave(`agent:${agentId}`)
      console.log(`[Agent] Socket ${socket.id} unsubscribed from agent:${agentId}`)
    } else {
      socket.leave('agent:all')
      console.log(`[Agent] Socket ${socket.id} unsubscribed from all agents`)
    }

    ack?.({ success: true })
  }
}

/**
 * 创建 Agent Handler 实例
 */
export function createAgentHandler(): AgentHandler {
  return new AgentHandler()
}
