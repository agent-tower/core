import { AgentType } from '@agent-tower/shared'

export interface AgentMeta {
  agentType: AgentType
  label: string
  logoSrc: string
}

export const AGENT_META_BY_TYPE: Record<AgentType, AgentMeta> = {
  [AgentType.CLAUDE_CODE]: {
    agentType: AgentType.CLAUDE_CODE,
    label: 'Claude Code',
    logoSrc: '/agent-icons/claude-code.svg',
  },
  [AgentType.GEMINI_CLI]: {
    agentType: AgentType.GEMINI_CLI,
    label: 'Gemini CLI',
    logoSrc: '/agent-icons/gemini-cli.svg',
  },
  [AgentType.CURSOR_AGENT]: {
    agentType: AgentType.CURSOR_AGENT,
    label: 'Cursor Agent',
    logoSrc: '/agent-icons/cursor-agent.svg',
  },
  [AgentType.CODEX]: {
    agentType: AgentType.CODEX,
    label: 'Codex',
    logoSrc: '/agent-icons/codex.svg',
  },
}

export function getAgentMeta(agentType?: AgentType | string | null): AgentMeta | null {
  if (!agentType) return null
  return AGENT_META_BY_TYPE[agentType as AgentType] ?? null
}

export function getAgentLabel(agentType?: AgentType | string | null, fallback?: string): string {
  return getAgentMeta(agentType)?.label ?? fallback ?? (agentType ? String(agentType) : '')
}
