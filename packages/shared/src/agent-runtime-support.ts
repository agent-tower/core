import { AgentType, RuntimeType } from './types.js'

export type AgentRuntimeSupportMatrix = Record<AgentType, readonly RuntimeType[]>

/**
 * Product capability catalog. Agent identity and execution protocol remain
 * independent even when an Agent currently supports only one Runtime.
 */
export const AGENT_RUNTIME_SUPPORT: AgentRuntimeSupportMatrix = {
  [AgentType.CLAUDE_CODE]: [RuntimeType.CLI, RuntimeType.ACP],
  [AgentType.GEMINI_CLI]: [RuntimeType.CLI, RuntimeType.ACP],
  [AgentType.CURSOR_AGENT]: [RuntimeType.CLI, RuntimeType.ACP],
  [AgentType.CODEX]: [RuntimeType.CLI, RuntimeType.ACP],
  [AgentType.QWEN_CODE]: [RuntimeType.ACP],
  [AgentType.KIRO_CLI]: [RuntimeType.ACP],
  [AgentType.OPENCODE]: [RuntimeType.ACP],
  [AgentType.PI_CODING_AGENT]: [RuntimeType.ACP],
  [AgentType.GROK_BUILD]: [RuntimeType.ACP],
  [AgentType.MINION_CODE]: [RuntimeType.ACP],
  [AgentType.DEEPSEEK_HERMES]: [RuntimeType.ACP],
}

export const USER_VISIBLE_AGENT_TYPES: readonly AgentType[] = Object.freeze(
  Object.values(AgentType).filter(agentType => agentType !== AgentType.MINION_CODE),
)

const USER_VISIBLE_AGENT_TYPE_SET = new Set<string>(USER_VISIBLE_AGENT_TYPES)

export function isUserVisibleAgentType(agentType: AgentType | string): boolean {
  return USER_VISIBLE_AGENT_TYPE_SET.has(agentType)
}

export function supportsAgentRuntime(
  agentType: AgentType | string,
  runtimeType: RuntimeType | string,
): boolean {
  return AGENT_RUNTIME_SUPPORT[agentType as AgentType]?.includes(runtimeType as RuntimeType) ?? false
}
