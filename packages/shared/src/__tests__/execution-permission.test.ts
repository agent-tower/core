import { describe, expect, it } from 'vitest'
import { AgentType, RuntimeType } from '../types.js'
import { resolveProviderExecutionPermission, withoutLegacyPermissionConfig } from '../execution-permission.js'

describe('execution permission compatibility', () => {
  it.each(['UNRESTRICTED', 'AUTO_APPROVE'])('keeps legacy %s as full access', permissionMode => {
    expect(resolveProviderExecutionPermission({ agentType: AgentType.CODEX, config: { permissionMode } }))
      .toEqual({ mode: 'FULL_ACCESS', diagnostics: [] })
  })
  it.each(Object.values(AgentType))('never upgrades a missing or ASK config for %s', agentType => {
    expect(resolveProviderExecutionPermission({ agentType, config: {} }).mode).toBe('ASK')
  })
  it.each([RuntimeType.CLI, RuntimeType.ACP])('requires reselection for ambiguous old Codex %s configs', runtimeType => {
    for (const config of [{}, { permissionMode: 'ASK' }, { acpPermissionMode: 'ASK' }]) {
      expect(resolveProviderExecutionPermission({ agentType: AgentType.CODEX, runtimeType, config }))
        .toMatchObject({ mode: 'ASK', diagnostics: [{ code: 'LEGACY_PERMISSION_REVIEW_REQUIRED' }] })
    }
    expect(resolveProviderExecutionPermission({ agentType: AgentType.CODEX, runtimeType, executionPermission: 'ASK' }))
      .toEqual({ mode: 'ASK', diagnostics: [] })
  })
  it('rejects conflicting legacy fields and unknown canonical values', () => {
    expect(resolveProviderExecutionPermission({ agentType: AgentType.GEMINI_CLI, executionPermission: 'ASK', config: { yolo: true } }).diagnostics)
      .toMatchObject([{ code: 'CONFLICT' }])
    expect(resolveProviderExecutionPermission({ agentType: AgentType.CODEX, executionPermission: 'AUTO_APPROVE' }).diagnostics)
      .toMatchObject([{ code: 'INVALID_ENUM' }])
  })
  it('retains migration confirmation through a normalized reload and removes legacy keys only on canonical writes', () => {
    expect(resolveProviderExecutionPermission({ agentType: AgentType.CODEX, executionPermission: 'ASK', executionPermissionReviewRequired: true }).diagnostics)
      .toMatchObject([{ code: 'LEGACY_PERMISSION_REVIEW_REQUIRED' }])
    expect(withoutLegacyPermissionConfig(AgentType.CODEX, { permissionMode: 'ASK', dangerouslyBypassApprovalsAndSandbox: false, model: 'model' }))
      .toEqual({ model: 'model' })
  })
})
