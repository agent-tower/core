import { describe, expect, it, vi } from 'vitest';
import { AgentType, RuntimeType, type Provider } from '@agent-tower/shared';
import { ExecutionPermissionService } from '../execution-permission.service.js';
import * as codexCapabilities from '../codex-cli-capabilities.service.js';

const provider: Provider = { id: 'codex-acp', name: 'Codex', agentType: AgentType.CODEX, runtimeType: RuntimeType.ACP, executionPermission: 'FULL_ACCESS', env: {}, config: {}, isDefault: false };

describe('ExecutionPermissionService', () => {
  it('returns exactly three options for every Agent and runtime', () => {
    const permissions = new ExecutionPermissionService();
    for (const agentType of Object.values(AgentType)) for (const runtimeType of Object.values(RuntimeType)) {
      const options = permissions.options({ agentType, runtimeType });
      expect(options.map(option => option.mode)).toEqual(['ASK', 'AUTO_SANDBOX', 'FULL_ACCESS']);
      for (const option of options) {
        expect(option.selectable).toBe(option.supported && option.authorized);
        if (!option.selectable) expect(option.reasons.length).toBeGreaterThan(0);
      }
    }
  });
  it('enables all three Codex ACP modes and refuses an unverified sandbox combination', () => {
    const permissions = new ExecutionPermissionService();
    expect(permissions.options({ agentType: AgentType.CODEX, runtimeType: RuntimeType.ACP }).every(option => option.selectable)).toBe(true);
    expect(() => permissions.authorize({ ...provider, agentType: AgentType.CLAUDE_CODE, executionPermission: 'AUTO_SANDBOX' }))
      .toThrow(expect.objectContaining({ code: 'CAPABILITY_UNVERIFIED', statusCode: 400 }));
  });
  it('rejects full access through an injected policy and leaves Pi with no available mode', () => {
    const permissions = new ExecutionPermissionService({ getAllowedModes: () => ['ASK', 'AUTO_SANDBOX'] });
    expect(() => permissions.authorize(provider, 'session-1')).toThrow(expect.objectContaining({ code: 'POLICY_MODE_DENIED', statusCode: 403 }));
    expect(permissions.options({ agentType: AgentType.PI_CODING_AGENT, runtimeType: RuntimeType.ACP }).every(option => !option.selectable)).toBe(true);
  });
  it('rejects raw native overrides rather than permitting an inconsistent launch', () => {
    const permissions = new ExecutionPermissionService();
    expect(() => permissions.authorize({ ...provider, executionPermission: 'ASK', settings: 'approval_policy = "never"' }))
      .toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    expect(() => permissions.authorize({ ...provider, executionPermission: 'ASK', config: { dangerouslyBypassApprovalsAndSandbox: true } }))
      .toThrow(expect.objectContaining({ code: 'CONFLICT' }));
  });
  it('uses the execution context consistently for an injected session policy', () => {
    const permissions = new ExecutionPermissionService({ getAllowedModes: context => context.sessionId === 'allowed-session' ? ['FULL_ACCESS'] : ['ASK'] });
    expect(permissions.authorize(provider, 'allowed-session')).toBe('FULL_ACCESS');
    expect(() => permissions.authorize(provider, 'other-session')).toThrow(expect.objectContaining({ code: 'POLICY_MODE_DENIED' }));
  });
  it('applies deployment policy even when native Codex CLI ASK is verified', () => {
    const support = vi.spyOn(codexCapabilities, 'cachedCodexCliSupport').mockReturnValue({ supported: true });
    try {
      const cli = { ...provider, runtimeType: RuntimeType.CLI, executionPermission: 'ASK' as const };
      expect(new ExecutionPermissionService().authorize(cli)).toBe('ASK');
      const denied = new ExecutionPermissionService({ getAllowedModes: () => [] });
      expect(denied.options({ agentType: AgentType.CODEX, runtimeType: RuntimeType.CLI }).find(o => o.mode === 'ASK')).toMatchObject({ supported: true, authorized: false, selectable: false });
      expect(() => denied.authorize(cli)).toThrow(expect.objectContaining({ statusCode: 403, code: 'POLICY_MODE_DENIED' }));
    } finally { support.mockRestore(); }
  });
  it('enables native Codex auto-review only when the deployment can contain its escalations', () => {
    const support = vi.spyOn(codexCapabilities, 'cachedCodexCliSupport').mockReturnValue({ supported: true });
    try {
      const cli = { ...provider, runtimeType: RuntimeType.CLI, executionPermission: 'AUTO_SANDBOX' as const, config: { model: 'gpt-6-sol' } };
      expect(new ExecutionPermissionService().authorize(cli)).toBe('AUTO_SANDBOX');
      const restricted = new ExecutionPermissionService({ getAllowedModes: () => ['ASK', 'AUTO_SANDBOX'] });
      expect(restricted.options({ agentType: AgentType.CODEX, runtimeType: RuntimeType.CLI, provider: cli }).find(o => o.mode === 'AUTO_SANDBOX'))
        .toMatchObject({ supported: true, authorized: false, selectable: false, reasons: [{ code: 'POLICY_ENFORCEMENT_UNAVAILABLE' }] });
      expect(restricted.options({ agentType: AgentType.CODEX, runtimeType: RuntimeType.ACP }).find(o => o.mode === 'AUTO_SANDBOX'))
        .toMatchObject({ supported: true, authorized: false, selectable: false, reasons: [{ code: 'POLICY_ENFORCEMENT_UNAVAILABLE' }] });
      expect(() => restricted.authorize(cli)).toThrow(expect.objectContaining({ statusCode: 403, code: 'POLICY_ENFORCEMENT_UNAVAILABLE' }));
      const contained = new ExecutionPermissionService({ getAllowedModes: () => ['ASK', 'AUTO_SANDBOX'], allowsNativeAutoReviewEscalation: () => true });
      expect(contained.authorize(cli)).toBe('AUTO_SANDBOX');
      expect(() => restricted.authorizeMode('AUTO_SANDBOX', { agentType: AgentType.CODEX, runtimeType: RuntimeType.CLI }))
        .toThrow(expect.objectContaining({ statusCode: 403, code: 'POLICY_ENFORCEMENT_UNAVAILABLE' }));
    } finally { support.mockRestore(); }
  });
  it.each([undefined, 'gpt-6.1-sol'])('authorizes Codex CLI AUTO_SANDBOX with model %s on a verified build', model => {
    const support = vi.spyOn(codexCapabilities, 'cachedCodexCliSupport').mockReturnValue({ supported: true });
    try {
      const cli = { ...provider, runtimeType: RuntimeType.CLI, executionPermission: 'AUTO_SANDBOX' as const,
        config: model ? { model } : {} };
      const permissions = new ExecutionPermissionService();
      expect(permissions.options({ agentType: AgentType.CODEX, runtimeType: RuntimeType.CLI, provider: cli })
        .find(option => option.mode === 'AUTO_SANDBOX')).toMatchObject({ supported: true, authorized: true, selectable: true, reasons: [] });
      expect(permissions.authorize(cli)).toBe('AUTO_SANDBOX');
    } finally { support.mockRestore(); }
  });
  it.each([
    '[sandbox_workspace_write]\nwritable_roots = ["/outside"]',
    '[sandbox_workspace_write]\nnetwork_access = true',
    '[profiles.unsafe.sandbox_workspace_write]\nnetwork_access = true',
  ])('disables Codex CLI AUTO_SANDBOX for advanced workspace sandbox overrides: %s', settings => {
    const support = vi.spyOn(codexCapabilities, 'cachedCodexCliSupport').mockReturnValue({ supported: true });
    try {
      const cli = { ...provider, runtimeType: RuntimeType.CLI, executionPermission: 'AUTO_SANDBOX' as const,
        config: { model: 'gpt-6-sol' }, settings };
      const permissions = new ExecutionPermissionService();
      expect(permissions.options({ agentType: AgentType.CODEX, runtimeType: RuntimeType.CLI, provider: cli }).find(o => o.mode === 'AUTO_SANDBOX'))
        .toMatchObject({ supported: false, selectable: false, reasons: [{ code: 'CONFLICT' }] });
      expect(permissions.diagnostics(cli)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CONFLICT' })]));
      expect(() => permissions.authorize(cli)).toThrow(expect.objectContaining({ code: 'CONFLICT', statusCode: 400 }));
      expect(permissions.authorize({ ...cli, settings: 'model_reasoning_effort = "high"' })).toBe('AUTO_SANDBOX');
    } finally { support.mockRestore(); }
  });
});
