import { describe, expect, it } from 'vitest'
import { AgentType } from '../types.js'
import {
  CODEX_NATIVE_MODEL_PROVIDER_IDS,
  PROVIDER_CAPABILITIES,
  getProviderCapability,
  isCodexNativeModelProviderId,
} from '../provider-capabilities.js'

describe('provider capability matrix', () => {
  it('declares the stable simplified paths for Claude and Codex', () => {
    expect(PROVIDER_CAPABILITIES[AgentType.CLAUDE_CODE]).toMatchObject({
      apiBaseUrl: { kind: 'env', path: 'ANTHROPIC_BASE_URL' },
      apiKey: { kind: 'env', path: 'ANTHROPIC_API_KEY' },
      model: { kind: 'config', path: 'model' },
      reasoningEffort: { kind: 'config', path: 'effort' },
      executionPermission: {
        kind: 'config', path: 'dangerouslySkipPermissions', riskKind: 'skip-permissions',
      },
    })
    expect(PROVIDER_CAPABILITIES[AgentType.CODEX]).toMatchObject({
      apiBaseUrl: { kind: 'settings', path: 'openai_base_url' },
      apiKey: { kind: 'env', path: 'OPENAI_API_KEY' },
      model: { kind: 'config', path: 'model' },
      reasoningEffort: { kind: 'settings', path: 'model_reasoning_effort' },
      executionPermission: {
        kind: 'config', path: 'dangerouslyBypassApprovalsAndSandbox', riskKind: 'bypass-approvals-and-sandbox',
      },
      fastMode: { kind: 'config', path: 'fastMode' },
      disableResponsesWebsocket: { kind: 'config', path: 'disableResponsesWebsocket' },
    })
  })

  it('exposes Fast mode only for Codex', () => {
    expect(PROVIDER_CAPABILITIES[AgentType.CODEX].fastMode)
      .toEqual({ kind: 'config', path: 'fastMode' })
    for (const agentType of Object.values(AgentType).filter(type => type !== AgentType.CODEX)) {
      expect(PROVIDER_CAPABILITIES[agentType].fastMode).toBeUndefined()
    }
  })

  it('exposes the Responses WebSocket control only for Codex', () => {
    expect(PROVIDER_CAPABILITIES[AgentType.CODEX].disableResponsesWebsocket)
      .toEqual({ kind: 'config', path: 'disableResponsesWebsocket' })
    expect(PROVIDER_CAPABILITIES[AgentType.CLAUDE_CODE].disableResponsesWebsocket).toBeUndefined()
    expect(PROVIDER_CAPABILITIES[AgentType.GEMINI_CLI].disableResponsesWebsocket).toBeUndefined()
    expect(PROVIDER_CAPABILITIES[AgentType.CURSOR_AGENT].disableResponsesWebsocket).toBeUndefined()
    expect(PROVIDER_CAPABILITIES[AgentType.QWEN_CODE].disableResponsesWebsocket).toBeUndefined()
    expect(PROVIDER_CAPABILITIES[AgentType.KIRO_CLI].disableResponsesWebsocket).toBeUndefined()
    expect(PROVIDER_CAPABILITIES[AgentType.OPENCODE].disableResponsesWebsocket).toBeUndefined()
    expect(PROVIDER_CAPABILITIES[AgentType.PI_CODING_AGENT].disableResponsesWebsocket).toBeUndefined()
    expect(PROVIDER_CAPABILITIES[AgentType.GROK_BUILD].disableResponsesWebsocket).toBeUndefined()
    expect(PROVIDER_CAPABILITIES[AgentType.MINION_CODE].disableResponsesWebsocket).toBeUndefined()
  })

  it('declares ordered effort options', () => {
    expect(PROVIDER_CAPABILITIES[AgentType.CLAUDE_CODE].reasoningEffort?.options)
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(PROVIDER_CAPABILITIES[AgentType.CODEX].reasoningEffort?.options)
      .toEqual(['minimal', 'low', 'medium', 'high', 'xhigh'])
    expect(PROVIDER_CAPABILITIES[AgentType.KIRO_CLI].reasoningEffort?.options)
      .toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('identifies only the Codex-reserved native and local model providers', () => {
    expect(CODEX_NATIVE_MODEL_PROVIDER_IDS).toEqual([
      'oss',
      'ollama',
      'lmstudio',
      'amazon-bedrock',
    ])
    for (const providerId of CODEX_NATIVE_MODEL_PROVIDER_IDS) {
      expect(isCodexNativeModelProviderId(providerId)).toBe(true)
    }
    expect(isCodexNativeModelProviderId('openai')).toBe(false)
    expect(isCodexNativeModelProviderId('team-proxy')).toBe(false)
  })

  it('exposes the Gemini API key and model without unrelated fields', () => {
    expect(getProviderCapability(AgentType.GEMINI_CLI)).toMatchObject({
      agentType: AgentType.GEMINI_CLI,
      apiKey: { kind: 'env', path: 'GEMINI_API_KEY' },
      model: { kind: 'config', path: 'model' },
      executionPermission: { kind: 'config', path: 'yolo', riskKind: 'auto-approve' },
    })
    expect(getProviderCapability(AgentType.GEMINI_CLI)?.apiBaseUrl).toBeUndefined()
    expect(getProviderCapability(AgentType.GEMINI_CLI)?.reasoningEffort).toBeUndefined()
  })

  it('only exposes model for Cursor', () => {
    expect(getProviderCapability(AgentType.CURSOR_AGENT)).toMatchObject({
      agentType: AgentType.CURSOR_AGENT,
      model: { kind: 'config', path: 'model' },
      executionPermission: { kind: 'config', path: 'force', riskKind: 'force-execution' },
    })
    expect(getProviderCapability(AgentType.CURSOR_AGENT)?.apiBaseUrl).toBeUndefined()
    expect(getProviderCapability(AgentType.CURSOR_AGENT)?.apiKey).toBeUndefined()
    expect(getProviderCapability(AgentType.CURSOR_AGENT)?.reasoningEffort).toBeUndefined()
  })

  it('exposes Qwen OpenAI-compatible connection fields for ACP', () => {
    expect(getProviderCapability(AgentType.QWEN_CODE)).toMatchObject({
      agentType: AgentType.QWEN_CODE,
      apiBaseUrl: { kind: 'env', path: 'OPENAI_BASE_URL' },
      apiKey: { kind: 'env', path: 'OPENAI_API_KEY' },
      model: { kind: 'config', path: 'model' },
    })
  })

  it('declares provider fields for every additional ACP agent', () => {
    expect(getProviderCapability(AgentType.KIRO_CLI)).toMatchObject({
      model: { path: 'model' },
      reasoningEffort: { path: 'effort' },
      executionPermission: { path: 'trustAllTools' },
    })
    for (const agentType of [
      AgentType.OPENCODE,
      AgentType.PI_CODING_AGENT,
      AgentType.GROK_BUILD,
      AgentType.MINION_CODE,
    ]) {
      expect(getProviderCapability(agentType)).toMatchObject({
        apiBaseUrl: { kind: 'env', path: 'OPENAI_BASE_URL' },
        apiKey: { kind: 'env', path: 'OPENAI_API_KEY' },
        model: { kind: 'config', path: 'model' },
      })
    }
  })

  it('declares the DeepSeek Harness connection, effort scale and missing bypass surface', () => {
    expect(getProviderCapability(AgentType.DEEPSEEK_HERMES)).toMatchObject({
      agentType: AgentType.DEEPSEEK_HERMES,
      apiBaseUrl: { kind: 'env', path: 'DEEPSEEK_BASE_URL' },
      apiKey: { kind: 'env', path: 'DEEPSEEK_API_KEY' },
      model: { kind: 'config', path: 'model' },
      // The harness owns its own effort scale; it does not reuse the
      // Claude/Kiro `low|medium|high|xhigh|max` ladder.
      reasoningEffort: { kind: 'config', path: 'effort', options: ['off', 'low', 'high', 'max'] },
    })
    // `dsh` exposes no permission-bypass flag, so no toggle may be rendered.
    expect(getProviderCapability(AgentType.DEEPSEEK_HERMES)?.executionPermission.path).toBeUndefined()
  })
})
