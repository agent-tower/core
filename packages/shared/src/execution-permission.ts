import { AgentType, RuntimeType, type ExecutionPermissionMode, type ProviderConfigDiagnostic } from './types.js'
import { getProviderCapability } from './provider-capabilities.js'

export const EXECUTION_PERMISSION_MODES: readonly ExecutionPermissionMode[] = ['ASK', 'AUTO_SANDBOX', 'FULL_ACCESS']

export function isExecutionPermissionMode(value: unknown): value is ExecutionPermissionMode {
  return EXECUTION_PERMISSION_MODES.includes(value as ExecutionPermissionMode)
}

interface PermissionConfig {
  agentType: AgentType | string
  runtimeType?: RuntimeType
  executionPermission?: unknown
  executionPermissionReviewRequired?: boolean
  config?: Record<string, unknown>
}

/** One compatibility reader for Provider, backup and legacy profile boundaries. No automatic upgrades. */
export function resolveProviderExecutionPermission(provider: PermissionConfig): {
  mode: ExecutionPermissionMode
  diagnostics: ProviderConfigDiagnostic[]
} {
  const diagnostics: ProviderConfigDiagnostic[] = []
  const config = provider.config ?? {}
  const candidates: ExecutionPermissionMode[] = []
  const invalid = (message: string, code: ProviderConfigDiagnostic['code'] = 'INVALID_ENUM') => {
    diagnostics.push({ field: 'executionPermission', code, message })
  }
  for (const key of ['permissionMode', 'acpPermissionMode']) {
    if (config[key] === undefined) continue
    if (config[key] === 'ASK') candidates.push('ASK')
    else if (config[key] === 'UNRESTRICTED' || config[key] === 'AUTO_APPROVE') candidates.push('FULL_ACCESS')
    else invalid(`${key} contains an invalid legacy permission mode`)
  }
  const legacyKey = getProviderCapability(provider.agentType)?.executionPermission.path
  if (legacyKey && config[legacyKey] !== undefined) {
    if (typeof config[legacyKey] !== 'boolean') invalid(`${legacyKey} must be true or false`, 'INVALID_TYPE')
    else candidates.push(config[legacyKey] ? 'FULL_ACCESS' : 'ASK')
  }
  const canonical = provider.executionPermission
  if (canonical !== undefined && !isExecutionPermissionMode(canonical)) invalid('executionPermission must be ASK, AUTO_SANDBOX or FULL_ACCESS')
  const mode = isExecutionPermissionMode(canonical) ? canonical : candidates[0] ?? 'ASK'
  if (candidates.some(candidate => candidate !== mode)) invalid('Legacy permission fields conflict with executionPermission', 'CONFLICT')
  if (provider.executionPermissionReviewRequired || (
    diagnostics.length === 0 && canonical === undefined && mode === 'ASK' && provider.agentType === AgentType.CODEX
  )) {
    invalid('Legacy Codex permissions did not establish an explicit reviewer policy. Select an execution permission mode.', 'LEGACY_PERMISSION_REVIEW_REQUIRED')
  }
  return { mode, diagnostics }
}

/** New writes keep the canonical field only; unrelated runtime settings are preserved. */
export function withoutLegacyPermissionConfig(agentType: AgentType | string, config: Record<string, unknown>): Record<string, unknown> {
  const next = { ...config }
  delete next.permissionMode
  delete next.acpPermissionMode
  const key = getProviderCapability(agentType)?.executionPermission.path
  if (key) delete next[key]
  return next
}
