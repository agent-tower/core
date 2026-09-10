import { parse as parseToml } from 'smol-toml';
import {
  AgentType,
  isCodexNativeModelProviderId,
  type Provider,
  type ProviderConfigDiagnostic,
  type ProviderDraftTestErrorKind,
  type ProviderDraftTestResult,
} from '@agent-tower/shared';
import { isAgentSubprocessProtectedEnvKey } from '../executors/execution-env.js';

export const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';
export const DEFAULT_XAI_BASE_URL = 'https://api.x.ai/v1';
export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const CODEX_OPENAI_COMPATIBLE_PROVIDER_ID = 'agent-tower-openai-compatible';
export const CODEX_OPENAI_COMPATIBLE_PROVIDER_NAME = 'Agent Tower OpenAI Compatible';
export const CODEX_OPENAI_COMPATIBLE_ENV_KEY = 'AGENT_TOWER_CODEX_PROVIDER_KEY';

export type EffectiveProviderConnectionSource =
  | 'codex-openai'
  | 'codex-openai-compatible'
  | 'codex-custom'
  | 'codex-native'
  | 'legacy-env'
  | 'provider-env'
  | 'default';

export interface EffectiveProviderConnection {
  agentType: AgentType | string;
  protocol: 'openai-compatible' | 'anthropic-compatible' | null;
  providerKind: 'built-in' | 'custom' | 'native' | 'direct' | 'none';
  modelProviderId?: string;
  baseUrl?: string;
  envKey?: string;
  /** Persisted Provider env key that owns the secret; may differ from the child env_key. */
  credentialEnvKey?: string;
  /** Server-only value. Never serialize this object into an API response or log. */
  secret?: string;
  source: EffectiveProviderConnectionSource;
  legacyBaseUrl: boolean;
  diagnostics: ProviderConfigDiagnostic[];
}

export interface ProviderConnectionProbeOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function diagnostic(
  field: ProviderConfigDiagnostic['field'],
  code: ProviderConfigDiagnostic['code'],
  message: string,
): ProviderConfigDiagnostic {
  return { field, code, message };
}

function validateHttpBaseUrl(baseUrl: string | undefined): ProviderConfigDiagnostic[] {
  if (!baseUrl) return [];
  try {
    if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) throw new Error();
    const parsed = new URL(baseUrl);
    if (!parsed.host) throw new Error();
    return [];
  } catch {
    return [diagnostic('apiBaseUrl', 'INVALID_URL', 'API URL must be a complete http:// or https:// URL')];
  }
}

function isOfficialOpenAiBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'api.openai.com';
  } catch {
    return false;
  }
}

function resolveCodexConnection(
  provider: Pick<Provider, 'agentType' | 'env' | 'settings'>,
): EffectiveProviderConnection {
  const diagnostics: ProviderConfigDiagnostic[] = [];
  let settings: Record<string, unknown> = {};
  if (provider.settings?.trim()) {
    try {
      settings = parseToml(provider.settings) as Record<string, unknown>;
    } catch {
      diagnostics.push(diagnostic('settings', 'INVALID_FORMAT', 'Codex settings must be valid TOML'));
    }
  }

  const rawProviderId = settings.model_provider;
  if (rawProviderId !== undefined && typeof rawProviderId !== 'string') {
    diagnostics.push(diagnostic('settings', 'INVALID_TYPE', 'model_provider must be a string'));
  }
  const modelProviderId = typeof rawProviderId === 'string' && rawProviderId.trim()
    ? rawProviderId.trim()
    : 'openai';

  if (modelProviderId === 'openai') {
    const rawBaseUrl = settings.openai_base_url;
    if (rawBaseUrl !== undefined && typeof rawBaseUrl !== 'string') {
      diagnostics.push(diagnostic('apiBaseUrl', 'INVALID_TYPE', 'openai_base_url must be a string'));
    }
    const canonicalBaseUrl = typeof rawBaseUrl === 'string' && rawBaseUrl.trim()
      ? rawBaseUrl.trim()
      : undefined;
    const legacyBaseUrl = provider.env.OPENAI_BASE_URL?.trim() || undefined;
    const baseUrl = canonicalBaseUrl ?? legacyBaseUrl ?? DEFAULT_OPENAI_BASE_URL;
    diagnostics.push(...validateHttpBaseUrl(baseUrl));
    const secret = provider.env.OPENAI_API_KEY;
    if (!isOfficialOpenAiBaseUrl(baseUrl)) {
      return {
        agentType: provider.agentType,
        protocol: 'openai-compatible',
        providerKind: 'custom',
        modelProviderId: CODEX_OPENAI_COMPATIBLE_PROVIDER_ID,
        baseUrl,
        envKey: CODEX_OPENAI_COMPATIBLE_ENV_KEY,
        credentialEnvKey: 'OPENAI_API_KEY',
        secret,
        source: 'codex-openai-compatible',
        legacyBaseUrl: !canonicalBaseUrl && !!legacyBaseUrl,
        diagnostics,
      };
    }
    return {
      agentType: provider.agentType,
      protocol: 'openai-compatible',
      providerKind: 'built-in',
      modelProviderId,
      baseUrl,
      envKey: 'OPENAI_API_KEY',
      credentialEnvKey: 'OPENAI_API_KEY',
      secret,
      source: canonicalBaseUrl ? 'codex-openai' : legacyBaseUrl ? 'legacy-env' : 'default',
      legacyBaseUrl: !canonicalBaseUrl && !!legacyBaseUrl,
      diagnostics,
    };
  }

  if (isCodexNativeModelProviderId(modelProviderId)) {
    return {
      agentType: provider.agentType,
      protocol: null,
      providerKind: 'native',
      modelProviderId,
      source: 'codex-native',
      legacyBaseUrl: false,
      diagnostics,
    };
  }

  const rawProviders = settings.model_providers;
  if (!isRecord(rawProviders)) {
    diagnostics.push(diagnostic('settings', 'CONFLICT', `Active Codex model provider '${modelProviderId}' is not defined`));
    return {
      agentType: provider.agentType,
      protocol: 'openai-compatible',
      providerKind: 'custom',
      modelProviderId,
      source: 'codex-custom',
      legacyBaseUrl: false,
      diagnostics,
    };
  }

  const selected = rawProviders[modelProviderId];
  if (!isRecord(selected)) {
    diagnostics.push(diagnostic('settings', 'CONFLICT', `Active Codex model provider '${modelProviderId}' is not defined`));
    return {
      agentType: provider.agentType,
      protocol: 'openai-compatible',
      providerKind: 'custom',
      modelProviderId,
      source: 'codex-custom',
      legacyBaseUrl: false,
      diagnostics,
    };
  }

  const rawBaseUrl = selected.base_url;
  if (rawBaseUrl === undefined || rawBaseUrl === '') {
    diagnostics.push(diagnostic('apiBaseUrl', 'REQUIRED', `Active Codex model provider '${modelProviderId}' requires base_url`));
  } else if (typeof rawBaseUrl !== 'string') {
    diagnostics.push(diagnostic('apiBaseUrl', 'INVALID_TYPE', `model_providers.${modelProviderId}.base_url must be a string`));
  }
  const rawEnvKey = selected.env_key;
  if (rawEnvKey !== undefined && typeof rawEnvKey !== 'string') {
    diagnostics.push(diagnostic('apiKey', 'INVALID_TYPE', `model_providers.${modelProviderId}.env_key must be a string`));
  }
  const envKey = typeof rawEnvKey === 'string' && rawEnvKey.trim() ? rawEnvKey.trim() : undefined;
  const protectedEnvKey = envKey ? isAgentSubprocessProtectedEnvKey(envKey) : false;
  if (protectedEnvKey) {
    diagnostics.push(diagnostic(
      'apiKey',
      'CONFLICT',
      'Active Codex env_key is reserved for Agent Tower subprocess internals',
    ));
  }
  const baseUrl = typeof rawBaseUrl === 'string' && rawBaseUrl.trim() ? rawBaseUrl.trim() : undefined;
  diagnostics.push(...validateHttpBaseUrl(baseUrl));

  return {
    agentType: provider.agentType,
    protocol: 'openai-compatible',
    providerKind: 'custom',
    modelProviderId,
    baseUrl,
    envKey,
    credentialEnvKey: envKey,
    secret: envKey && !protectedEnvKey ? provider.env[envKey] : undefined,
    source: 'codex-custom',
    legacyBaseUrl: false,
    diagnostics,
  };
}

function readClaudeSettingsEnv(settings: string | undefined): Record<string, unknown> {
  if (!settings?.trim()) return {};
  try {
    const parsed = JSON.parse(settings) as unknown;
    return isRecord(parsed) && isRecord(parsed.env) ? parsed.env : {};
  } catch {
    return {};
  }
}

export function resolveEffectiveProviderConnection(
  provider: Pick<Provider, 'agentType' | 'env' | 'settings'>,
): EffectiveProviderConnection {
  if (provider.agentType === AgentType.CODEX) return resolveCodexConnection(provider);

  if (provider.agentType === AgentType.CLAUDE_CODE) {
    const settingsEnv = readClaudeSettingsEnv(provider.settings);
    const rawBaseUrl = provider.env.ANTHROPIC_BASE_URL
      ?? (typeof settingsEnv.ANTHROPIC_BASE_URL === 'string' ? settingsEnv.ANTHROPIC_BASE_URL : undefined);
    const baseUrl = rawBaseUrl?.trim() || undefined;
    const secret = provider.env.ANTHROPIC_API_KEY
      ?? (typeof settingsEnv.ANTHROPIC_API_KEY === 'string' ? settingsEnv.ANTHROPIC_API_KEY : undefined);
    const effectiveBaseUrl = baseUrl ?? (secret ? DEFAULT_ANTHROPIC_BASE_URL : undefined);
    return {
      agentType: provider.agentType,
      protocol: effectiveBaseUrl ? 'anthropic-compatible' : null,
      providerKind: 'direct',
      baseUrl: effectiveBaseUrl,
      envKey: 'ANTHROPIC_API_KEY',
      credentialEnvKey: 'ANTHROPIC_API_KEY',
      secret,
      source: 'provider-env',
      legacyBaseUrl: false,
      diagnostics: validateHttpBaseUrl(effectiveBaseUrl),
    };
  }

  if (
    provider.agentType === AgentType.QWEN_CODE
    || provider.agentType === AgentType.OPENCODE
    || provider.agentType === AgentType.PI_CODING_AGENT
    || provider.agentType === AgentType.GROK_BUILD
    || provider.agentType === AgentType.MINION_CODE
  ) {
    const secret = provider.env.OPENAI_API_KEY;
    const defaultBaseUrl = provider.agentType === AgentType.GROK_BUILD
      ? DEFAULT_XAI_BASE_URL
      : DEFAULT_OPENAI_BASE_URL;
    const baseUrl = provider.env.OPENAI_BASE_URL?.trim() || (secret ? defaultBaseUrl : undefined);
    return {
      agentType: provider.agentType,
      protocol: baseUrl ? 'openai-compatible' : null,
      providerKind: 'direct',
      baseUrl,
      envKey: 'OPENAI_API_KEY',
      credentialEnvKey: 'OPENAI_API_KEY',
      secret,
      source: 'provider-env',
      legacyBaseUrl: false,
      diagnostics: validateHttpBaseUrl(baseUrl),
    };
  }

  if (provider.agentType === AgentType.DEEPSEEK_HERMES) {
    // DeepSeek Harness reads its own credential variables; the launch
    // environment outranks the harness credential store.
    const secret = provider.env.DEEPSEEK_API_KEY;
    const baseUrl = provider.env.DEEPSEEK_BASE_URL?.trim()
      || (secret ? DEFAULT_DEEPSEEK_BASE_URL : undefined);
    return {
      agentType: provider.agentType,
      protocol: baseUrl ? 'openai-compatible' : null,
      providerKind: 'direct',
      baseUrl,
      envKey: 'DEEPSEEK_API_KEY',
      credentialEnvKey: 'DEEPSEEK_API_KEY',
      secret,
      source: 'provider-env',
      legacyBaseUrl: false,
      diagnostics: validateHttpBaseUrl(baseUrl),
    };
  }

  return {
    agentType: provider.agentType,
    protocol: null,
    providerKind: 'none',
    source: 'default',
    legacyBaseUrl: false,
    diagnostics: [],
  };
}

function buildModelsProbeUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = `${path}/models`.replace(/^\/\//, '/');
  return url;
}

function publicEndpoint(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

function classifyFetchError(error: unknown, timedOut: boolean): ProviderDraftTestErrorKind {
  if (timedOut || (error instanceof Error && error.name === 'AbortError')) return 'timeout';
  const cause = error instanceof Error && isRecord(error.cause) ? error.cause : undefined;
  const code = cause && typeof cause.code === 'string' ? cause.code : '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
  if (/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) return 'tls';
  return 'network';
}

function httpErrorKind(status: number): ProviderDraftTestErrorKind {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 404 || status === 405 || status === 501) return 'unsupported';
  if (status === 400 || status === 422) return 'model';
  if (status === 429) return 'rate-limit';
  if (status >= 500) return 'server';
  return 'unknown';
}

function errorSummary(kind: ProviderDraftTestErrorKind): string {
  switch (kind) {
    case 'authentication': return 'Authentication failed for the configured API connection';
    case 'unsupported': return 'The configured endpoint does not support the minimal models probe';
    case 'model': return 'The configured model is unavailable or not permitted';
    case 'rate-limit': return 'The configured API is rate limited or out of quota';
    case 'server': return 'The configured API returned a server error';
    case 'timeout': return 'The configured API connection timed out';
    case 'dns': return 'The configured API host could not be resolved';
    case 'tls': return 'The configured API TLS connection failed';
    case 'network': return 'The configured API could not be reached';
    default: return 'The configured API connection could not be verified';
  }
}

export async function probeEffectiveProviderConnection(
  connection: EffectiveProviderConnection,
  options: ProviderConnectionProbeOptions = {},
): Promise<ProviderDraftTestResult> {
  const testedAt = new Date().toISOString();
  if (connection.diagnostics.length > 0) {
    return {
      ok: false,
      stage: 'validation',
      summary: 'Configuration validation failed',
      diagnostics: connection.diagnostics,
      testedAt,
    };
  }
  if (!connection.protocol || !connection.baseUrl) {
    return {
      ok: true,
      stage: 'availability',
      summary: 'CLI availability checked; no API connection was configured for probing',
      target: { kind: 'cli', source: connection.source },
      testedAt,
    };
  }

  let probeUrl: URL;
  try {
    probeUrl = buildModelsProbeUrl(connection.baseUrl);
  } catch {
    return {
      ok: false,
      stage: 'connection',
      errorKind: 'unknown',
      summary: 'The configured API URL is invalid',
      target: { kind: 'api', source: connection.source },
      testedAt,
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? 5000);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (connection.secret) {
    if (connection.protocol === 'anthropic-compatible') {
      headers['x-api-key'] = connection.secret;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers.authorization = `Bearer ${connection.secret}`;
    }
  }

  try {
    const response = await (options.fetchImpl ?? fetch)(probeUrl, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    await response.body?.cancel();
    const target = { kind: 'api' as const, endpoint: publicEndpoint(probeUrl), source: connection.source };
    if (response.ok) {
      return {
        ok: true,
        stage: 'connection',
        summary: 'API connection verified with the current Provider draft',
        target,
        testedAt,
      };
    }
    const errorKind = httpErrorKind(response.status);
    return {
      ok: false,
      stage: 'connection',
      errorKind,
      summary: errorSummary(errorKind),
      target,
      testedAt,
    };
  } catch (error) {
    const errorKind = classifyFetchError(error, timedOut);
    return {
      ok: false,
      stage: 'connection',
      errorKind,
      summary: errorSummary(errorKind),
      target: { kind: 'api', endpoint: publicEndpoint(probeUrl), source: connection.source },
      testedAt,
    };
  } finally {
    clearTimeout(timeout);
  }
}
