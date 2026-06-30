import type { AgentCliToolId, AgentCliToolStatus } from '@agent-tower/shared'

export const INSTALLABLE_AGENT_CLI_TOOL_IDS: AgentCliToolId[] = ['codex', 'claude-code', 'cursor-agent']

export function isInstallableAgentCliTool(toolId: AgentCliToolId): boolean {
  return INSTALLABLE_AGENT_CLI_TOOL_IDS.includes(toolId)
}

export function hasAnyCoreAgentCli(statuses: AgentCliToolStatus[] | undefined): boolean {
  return INSTALLABLE_AGENT_CLI_TOOL_IDS.some(toolId => (
    statuses?.some(status => status.toolId === toolId && status.installStatus === 'installed')
  ))
}
