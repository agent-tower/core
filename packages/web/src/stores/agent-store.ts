import { create } from 'zustand'
import type { AgentStatus, AgentStatusPayload } from '@agent-tower/shared/socket'

interface AgentState {
  agentId: string
  sessionId: string
  status: AgentStatus
  error?: string
  timestamp: number
}

interface AgentStoreState {
  agents: Map<string, AgentState>

  // Actions
  updateAgentStatus: (payload: AgentStatusPayload) => void
  getAgent: (agentId: string) => AgentState | undefined
  getAllAgents: () => AgentState[]
  clearAgents: () => void
}

export const useAgentStore = create<AgentStoreState>((set, get) => ({
  agents: new Map(),

  updateAgentStatus: (payload: AgentStatusPayload) => {
    set((state) => {
      const newAgents = new Map(state.agents)
      newAgents.set(payload.agentId, {
        agentId: payload.agentId,
        sessionId: payload.sessionId,
        status: payload.status,
        error: payload.error,
        timestamp: payload.timestamp,
      })
      return { agents: newAgents }
    })
  },

  getAgent: (agentId: string) => {
    return get().agents.get(agentId)
  },

  getAllAgents: () => {
    return Array.from(get().agents.values())
  },

  clearAgents: () => {
    set({ agents: new Map() })
  },
}))
