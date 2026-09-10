import { describe, expect, it } from 'vitest'
import {
  AGENT_RUNTIME_SUPPORT,
  USER_VISIBLE_AGENT_TYPES,
  isUserVisibleAgentType,
  supportsAgentRuntime,
} from '../agent-runtime-support.js'
import { AgentType, RuntimeType } from '../types.js'

describe('Agent Runtime support catalog', () => {
  it('keeps identity and protocol support explicit', () => {
    expect(AGENT_RUNTIME_SUPPORT).toEqual({
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
    })
    expect(supportsAgentRuntime(AgentType.QWEN_CODE, RuntimeType.ACP)).toBe(true)
    expect(supportsAgentRuntime(AgentType.QWEN_CODE, RuntimeType.CLI)).toBe(false)
    expect(supportsAgentRuntime(AgentType.GEMINI_CLI, RuntimeType.ACP)).toBe(true)
    expect(supportsAgentRuntime(AgentType.CURSOR_AGENT, RuntimeType.ACP)).toBe(true)
    expect(supportsAgentRuntime(AgentType.PI_CODING_AGENT, RuntimeType.CLI)).toBe(false)
    expect(supportsAgentRuntime(AgentType.DEEPSEEK_HERMES, RuntimeType.ACP)).toBe(true)
    expect(supportsAgentRuntime(AgentType.DEEPSEEK_HERMES, RuntimeType.CLI)).toBe(false)
  })

  it('keeps compatibility-only Agents out of user-facing choices', () => {
    expect(USER_VISIBLE_AGENT_TYPES).not.toContain(AgentType.MINION_CODE)
    expect(isUserVisibleAgentType(AgentType.MINION_CODE)).toBe(false)
    expect(isUserVisibleAgentType('UNKNOWN')).toBe(false)
    expect(supportsAgentRuntime(AgentType.MINION_CODE, RuntimeType.ACP)).toBe(true)
  })
})
