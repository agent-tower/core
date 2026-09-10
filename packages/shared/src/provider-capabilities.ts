import { AgentType } from './types.js'

export type ProviderConfigPathKind = 'env' | 'config' | 'settings'

export interface ProviderMappedFieldCapability {
  kind: ProviderConfigPathKind
  path: string
  placeholder?: string
  options?: string[]
}

export type ProviderExecutionPermissionRiskKind =
  | 'skip-permissions'
  | 'auto-approve'
  | 'force-execution'
  | 'bypass-approvals-and-sandbox'

/**
 * Execution-permission toggle for a Provider.
 *
 * `path` is optional: an agent that never offers a permission-bypass surface
 * (for example an ACP agent that only advertises interactive approval) omits it,
 * and consumers must not render or validate a toggle in that case.
 */
export interface ProviderExecutionPermissionCapability
  extends Omit<ProviderMappedFieldCapability, 'path'> {
  kind: 'config'
  path?: string
  riskKind: ProviderExecutionPermissionRiskKind
}

export interface ProviderBooleanConfigCapability extends ProviderMappedFieldCapability {
  kind: 'config'
}

export interface ProviderCapability {
  agentType: AgentType
  apiBaseUrl?: ProviderMappedFieldCapability
  apiKey?: ProviderMappedFieldCapability
  model: ProviderMappedFieldCapability
  reasoningEffort?: ProviderMappedFieldCapability
  executionPermission: ProviderExecutionPermissionCapability
  fastMode?: ProviderBooleanConfigCapability
  disableResponsesWebsocket?: ProviderBooleanConfigCapability
  settingsFormat?: 'json' | 'toml'
}

export type ProviderCapabilityMatrix = Record<AgentType, ProviderCapability>

export const CODEX_NATIVE_MODEL_PROVIDER_IDS = [
  'oss',
  'ollama',
  'lmstudio',
  'amazon-bedrock',
] as const

export function isCodexNativeModelProviderId(providerId: string): boolean {
  return (CODEX_NATIVE_MODEL_PROVIDER_IDS as readonly string[]).includes(providerId)
}

export const PROVIDER_CAPABILITIES: ProviderCapabilityMatrix = {
  [AgentType.CLAUDE_CODE]: {
    agentType: AgentType.CLAUDE_CODE,
    apiBaseUrl: {
      kind: 'env',
      path: 'ANTHROPIC_BASE_URL',
      placeholder: 'https://api.anthropic.com',
    },
    apiKey: { kind: 'env', path: 'ANTHROPIC_API_KEY' },
    model: { kind: 'config', path: 'model', placeholder: 'claude-sonnet-4-20250514' },
    reasoningEffort: {
      kind: 'config',
      path: 'effort',
      options: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    executionPermission: {
      kind: 'config',
      path: 'dangerouslySkipPermissions',
      riskKind: 'skip-permissions',
    },
    settingsFormat: 'json',
  },
  [AgentType.CODEX]: {
    agentType: AgentType.CODEX,
    apiBaseUrl: {
      kind: 'settings',
      path: 'openai_base_url',
      placeholder: 'https://api.openai.com/v1',
    },
    apiKey: { kind: 'env', path: 'OPENAI_API_KEY' },
    model: { kind: 'config', path: 'model', placeholder: 'gpt-5.3-codex' },
    reasoningEffort: {
      kind: 'settings',
      path: 'model_reasoning_effort',
      options: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    },
    executionPermission: {
      kind: 'config',
      path: 'dangerouslyBypassApprovalsAndSandbox',
      riskKind: 'bypass-approvals-and-sandbox',
    },
    fastMode: {
      kind: 'config',
      path: 'fastMode',
    },
    disableResponsesWebsocket: {
      kind: 'config',
      path: 'disableResponsesWebsocket',
    },
    settingsFormat: 'toml',
  },
  [AgentType.GEMINI_CLI]: {
    agentType: AgentType.GEMINI_CLI,
    apiKey: { kind: 'env', path: 'GEMINI_API_KEY' },
    model: { kind: 'config', path: 'model', placeholder: 'gemini-2.5-pro' },
    executionPermission: { kind: 'config', path: 'yolo', riskKind: 'auto-approve' },
  },
  [AgentType.CURSOR_AGENT]: {
    agentType: AgentType.CURSOR_AGENT,
    model: { kind: 'config', path: 'model' },
    executionPermission: { kind: 'config', path: 'force', riskKind: 'force-execution' },
  },
  [AgentType.QWEN_CODE]: {
    agentType: AgentType.QWEN_CODE,
    apiBaseUrl: {
      kind: 'env',
      path: 'OPENAI_BASE_URL',
      placeholder: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    },
    apiKey: { kind: 'env', path: 'OPENAI_API_KEY' },
    model: { kind: 'config', path: 'model', placeholder: 'qwen3-coder-plus' },
    executionPermission: { kind: 'config', path: 'yolo', riskKind: 'auto-approve' },
  },
  [AgentType.KIRO_CLI]: {
    agentType: AgentType.KIRO_CLI,
    model: { kind: 'config', path: 'model' },
    reasoningEffort: {
      kind: 'config',
      path: 'effort',
      options: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    executionPermission: { kind: 'config', path: 'trustAllTools', riskKind: 'auto-approve' },
  },
  [AgentType.OPENCODE]: {
    agentType: AgentType.OPENCODE,
    apiBaseUrl: { kind: 'env', path: 'OPENAI_BASE_URL', placeholder: 'https://api.openai.com/v1' },
    apiKey: { kind: 'env', path: 'OPENAI_API_KEY' },
    model: { kind: 'config', path: 'model' },
    executionPermission: { kind: 'config', path: 'autoApprove', riskKind: 'auto-approve' },
  },
  [AgentType.PI_CODING_AGENT]: {
    agentType: AgentType.PI_CODING_AGENT,
    apiBaseUrl: { kind: 'env', path: 'OPENAI_BASE_URL', placeholder: 'https://api.openai.com/v1' },
    apiKey: { kind: 'env', path: 'OPENAI_API_KEY' },
    model: { kind: 'config', path: 'model' },
    reasoningEffort: {
      kind: 'config',
      path: 'effort',
      options: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    },
    executionPermission: { kind: 'config', path: 'autoApprove', riskKind: 'auto-approve' },
  },
  [AgentType.GROK_BUILD]: {
    agentType: AgentType.GROK_BUILD,
    apiBaseUrl: { kind: 'env', path: 'OPENAI_BASE_URL', placeholder: 'https://api.x.ai/v1' },
    apiKey: { kind: 'env', path: 'OPENAI_API_KEY' },
    model: { kind: 'config', path: 'model' },
    executionPermission: { kind: 'config', path: 'alwaysApprove', riskKind: 'auto-approve' },
  },
  [AgentType.MINION_CODE]: {
    agentType: AgentType.MINION_CODE,
    apiBaseUrl: { kind: 'env', path: 'OPENAI_BASE_URL', placeholder: 'https://api.openai.com/v1' },
    apiKey: { kind: 'env', path: 'OPENAI_API_KEY' },
    model: { kind: 'config', path: 'model' },
    executionPermission: {
      kind: 'config',
      path: 'dangerouslySkipPermissions',
      riskKind: 'skip-permissions',
    },
  },
  /**
   * DeepSeek Harness (`dsh --profile acp`). Credentials are read from the launch
   * environment, which outranks the harness credential store, so the Provider
   * owns them without writing any harness config file.
   */
  [AgentType.DEEPSEEK_HERMES]: {
    agentType: AgentType.DEEPSEEK_HERMES,
    apiBaseUrl: {
      kind: 'env',
      path: 'DEEPSEEK_BASE_URL',
      placeholder: 'https://api.deepseek.com',
    },
    apiKey: { kind: 'env', path: 'DEEPSEEK_API_KEY' },
    model: { kind: 'config', path: 'model', placeholder: 'deepseek-v4-pro' },
    reasoningEffort: {
      kind: 'config',
      path: 'effort',
      options: ['off', 'low', 'high', 'max'],
    },
    // `dsh` advertises no ACP mode selector and no permission-bypass flag: every
    // tool call routes through interactive `session/request_permission`.
    executionPermission: { kind: 'config', riskKind: 'auto-approve' },
  },
}

export function getProviderCapability(agentType: AgentType | string): ProviderCapability | undefined {
  return PROVIDER_CAPABILITIES[agentType as AgentType]
}
