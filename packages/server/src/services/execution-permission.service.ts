import { parse as parseToml } from 'smol-toml';
import {
  AgentType, RuntimeType, EXECUTION_PERMISSION_MODES, resolveProviderExecutionPermission,
  supportsAgentRuntime, type ExecutionPermissionMode, type ExecutionPermissionOption,
  type Provider, type ProviderConfigDiagnostic,
} from '@agent-tower/shared';
import { cachedClaudeCliAskSupport, refreshClaudeCliAskSupport } from './claude-cli-capabilities.service.js';
import { cachedCodexCliSupport, refreshCodexCliSupport } from './codex-cli-capabilities.service.js';
import { ServiceError } from '../errors.js';

export interface ExecutionPermissionContext {
  sessionId?: string;
  providerId?: string;
  agentType: AgentType | string;
  runtimeType: RuntimeType;
  provider?: Provider;
}

/** Deployment-level extension point. User/tenant identity and resource isolation are separate future work. */
export interface ExecutionPermissionPolicy {
  getAllowedModes(context: ExecutionPermissionContext): readonly ExecutionPermissionMode[];
  /** An outer boundary must contain native auto-approved sandbox escalations for restricted subjects. */
  allowsNativeAutoReviewEscalation?(context: ExecutionPermissionContext): boolean;
}

export class LocalOwnerExecutionPolicy implements ExecutionPermissionPolicy {
  getAllowedModes(): readonly ExecutionPermissionMode[] { return EXECUTION_PERMISSION_MODES; }
  allowsNativeAutoReviewEscalation(): boolean { return true; }
}

function nativeSupport(agent: string, runtime: RuntimeType, mode: ExecutionPermissionMode): {
  supported: boolean; reason?: { code: string; message: string }; sandboxScope?: 'tools';
} {
  const unsupported = (code: string, message: string) => ({ supported: false, reason: { code, message } });
  if (!supportsAgentRuntime(agent, runtime)) return unsupported('RUNTIME_MODE_UNSUPPORTED', 'This Agent does not support this runtime.');
  if (runtime === RuntimeType.CLI && mode === 'ASK') {
    return unsupported('RUNTIME_MODE_UNSUPPORTED', 'The current headless CLI integration cannot forward native approval requests. Use ACP.');
  }
  if (agent === AgentType.CURSOR_AGENT && mode === 'ASK') return unsupported('CAPABILITY_UNVERIFIED', 'A per-launch allowlist configuration has not been verified for Cursor ACP.');
  if (mode === 'AUTO_SANDBOX') {
    if (agent === AgentType.CODEX && runtime === RuntimeType.ACP) return { supported: true, sandboxScope: 'tools' };
    const noSandbox = [AgentType.PI_CODING_AGENT, AgentType.OPENCODE, AgentType.KIRO_CLI, AgentType.MINION_CODE];
    return unsupported(noSandbox.includes(agent as AgentType) ? 'AGENT_MODE_UNSUPPORTED' : 'CAPABILITY_UNVERIFIED',
      noSandbox.includes(agent as AgentType)
        ? 'This integration has no native sandbox permission mode.'
        : 'A native sandbox mode has not been verified for this integration.');
  }
  if (agent === AgentType.PI_CODING_AGENT && mode === 'ASK') return unsupported('AGENT_MODE_UNSUPPORTED', 'Pi ordinary tools do not provide a complete approval gate.');
  // Kiro V3 removed V2 trust flags; until both versions can be reliably projected, retain ASK only.
  if (agent === AgentType.KIRO_CLI && mode === 'FULL_ACCESS') return unsupported('CAPABILITY_UNVERIFIED', 'Kiro V2/V3 trust configuration has not been verified for this integration.');
  return { supported: true };
}

function resolvedNativeSupport(context: ExecutionPermissionContext, mode: ExecutionPermissionMode): ReturnType<typeof nativeSupport> {
  if (context.runtimeType === RuntimeType.CLI && context.agentType === AgentType.CODEX && (mode === 'ASK' || mode === 'AUTO_SANDBOX')) {
    const native = cachedCodexCliSupport(context.provider);
    return { supported: native.supported, ...(native.code ? { reason: { code: native.code, message: native.message! } } : {}),
      ...(mode === 'AUTO_SANDBOX' ? { sandboxScope: 'tools' as const } : {}) };
  }
  if (context.runtimeType === RuntimeType.CLI && context.agentType === AgentType.CLAUDE_CODE && mode === 'ASK') {
    const native = cachedClaudeCliAskSupport(context.provider);
    return { supported: native.supported, ...(native.code ? { reason: { code: native.code, message: native.message! } } : {}) };
  }
  return nativeSupport(String(context.agentType), context.runtimeType, mode);
}

function codexCliSandboxOverride(provider?: Provider): boolean {
  if (!provider?.settings?.trim()) return false;
  try {
    const containsOverride = (value: unknown): boolean => {
      if (Array.isArray(value)) return value.some(containsOverride);
      if (!value || typeof value !== 'object') return false;
      const settings = value as Record<string, unknown>;
      return Object.hasOwn(settings, 'sandbox_workspace_write') || Object.values(settings).some(containsOverride);
    };
    return containsOverride(parseToml(provider.settings));
  } catch { return false; } // Settings syntax is reported by Provider validation.
}

export class ExecutionPermissionService {
  constructor(private readonly policy: ExecutionPermissionPolicy = new LocalOwnerExecutionPolicy()) {}

  options(context: ExecutionPermissionContext): ExecutionPermissionOption[] {
    const allowed = this.policy.getAllowedModes(context);
    return EXECUTION_PERMISSION_MODES.map(mode => {
      const support = resolvedNativeSupport(context, mode);
      const sandboxOverride = mode === 'AUTO_SANDBOX' && context.agentType === AgentType.CODEX
        && context.runtimeType === RuntimeType.CLI && codexCliSandboxOverride(context.provider);
      const autoReviewBoundaryMissing = mode === 'AUTO_SANDBOX' && context.agentType === AgentType.CODEX
        && !this.policy.allowsNativeAutoReviewEscalation?.(context);
      const authorized = allowed.includes(mode) && !autoReviewBoundaryMissing;
      return {
        mode, supported: support.supported && !sandboxOverride, authorized, selectable: support.supported && !sandboxOverride && authorized,
        reasons: [
          ...(support.reason ? [support.reason] : []),
          ...(sandboxOverride ? [{ code: 'CONFLICT', message: 'Remove sandbox_workspace_write from Codex advanced settings before using automatic sandbox approval.' }] : []),
          ...(!allowed.includes(mode) ? [{ code: 'POLICY_MODE_DENIED', message: 'Your deployment does not allow this permission mode.' }] : []),
          ...(autoReviewBoundaryMissing && allowed.includes(mode) ? [{ code: 'POLICY_ENFORCEMENT_UNAVAILABLE', message: 'This deployment cannot contain Codex native auto-approved sandbox escalations for this execution subject.' }] : []),
        ],
        ...(support.sandboxScope ? { sandboxScope: support.sandboxScope } : {}),
      };
    });
  }

  async prepare(): Promise<void> { await Promise.all([refreshClaudeCliAskSupport(), refreshCodexCliSupport()]); }

  diagnostics(provider: Provider, sessionId?: string): ProviderConfigDiagnostic[] {
    const resolved = resolveProviderExecutionPermission(provider);
    const option = this.options({ agentType: provider.agentType, runtimeType: provider.runtimeType ?? RuntimeType.CLI, providerId: provider.id, sessionId, provider })
      .find(item => item.mode === resolved.mode)!;
    return [...resolved.diagnostics, ...option.reasons.map(reason => ({
      field: 'executionPermission' as const, code: reason.code as ProviderConfigDiagnostic['code'], message: reason.message,
    })), ...nativeOverrideDiagnostics(provider, resolved.mode)];
  }

  authorize(provider: Provider, sessionId?: string): ExecutionPermissionMode {
    const diagnostics = this.diagnostics(provider, sessionId);
    if (diagnostics.length) {
      const denied = diagnostics.find(item => item.code === 'POLICY_MODE_DENIED' || item.code === 'POLICY_ENFORCEMENT_UNAVAILABLE');
      const problem = denied ?? diagnostics[0]!;
      throw new ServiceError(problem.message, problem.code, denied ? 403 : 400);
    }
    const mode = resolveProviderExecutionPermission(provider).mode;
    this.authorizeMode(mode, { agentType: provider.agentType, runtimeType: provider.runtimeType ?? RuntimeType.CLI, providerId: provider.id, sessionId });
    return mode;
  }

  /** A reused ACP runtime keeps its launch mode; authorize that actual mode, not the edited Provider. */
  authorizeMode(mode: ExecutionPermissionMode, context: ExecutionPermissionContext): void {
    if (!this.policy.getAllowedModes(context).includes(mode)) {
      throw new ServiceError('Your deployment does not allow this permission mode.', 'POLICY_MODE_DENIED', 403);
    }
    if (mode === 'AUTO_SANDBOX' && context.agentType === AgentType.CODEX && !this.policy.allowsNativeAutoReviewEscalation?.(context)) {
      throw new ServiceError('This deployment cannot contain Codex native auto-approved sandbox escalations for this execution subject.', 'POLICY_ENFORCEMENT_UNAVAILABLE', 403);
    }
  }
}

function nativeOverrideDiagnostics(provider: Provider, mode: ExecutionPermissionMode): ProviderConfigDiagnostic[] {
  let settings: Record<string, unknown> = {};
  try {
    settings = provider.settings?.trim()
      ? provider.agentType === AgentType.CODEX ? parseToml(provider.settings) : JSON.parse(provider.settings)
      : {};
  } catch { return []; } // Provider config service reports syntax errors.
  const expected = provider.agentType === AgentType.CODEX
    ? { approval_policy: mode === 'FULL_ACCESS' ? 'never' : 'on-request', sandbox_mode: mode === 'FULL_ACCESS' ? 'danger-full-access' : 'workspace-write', approvals_reviewer: mode === 'AUTO_SANDBOX' ? 'auto_review' : 'user' }
    : {};
  const conflicts = Object.entries(expected).filter(([key, value]) => settings[key] !== undefined && settings[key] !== value);
  if (provider.agentType === AgentType.CLAUDE_CODE) {
    const permissions = settings.permissions as Record<string, unknown> | undefined;
    if (permissions?.defaultMode !== undefined && permissions.defaultMode !== (mode === 'FULL_ACCESS' ? 'bypassPermissions' : 'default')) conflicts.push(['permissions.defaultMode', '']);
    const cmd = provider.config.cmd as { additionalParams?: string[] } | undefined;
    if (mode === 'ASK' && cmd?.additionalParams?.length) conflicts.push(['cmd.additionalParams', '']);
    if (mode === 'ASK' && Object.keys({ ...provider.env, ...(settings.env as Record<string, unknown> ?? {}) }).some(key => /(?:PERMISSION|BYPASS|SKIP.*CHECK)/i.test(key))) conflicts.push(['permission environment override', '']);
    if (provider.config.plan === true || provider.config.approvals === true) conflicts.push(['plan/approvals', '']);
  }
  return conflicts.map(([key]) => ({ field: 'executionPermission', code: 'CONFLICT', message: `${key} conflicts with executionPermission. Remove the native override.` }));
}

export const executionPermissionService = new ExecutionPermissionService();
