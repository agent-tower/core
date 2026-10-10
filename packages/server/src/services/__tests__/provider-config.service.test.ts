import { describe, expect, it, vi } from 'vitest';
import {
  AgentType,
  CODEX_NATIVE_MODEL_PROVIDER_IDS,
  type ProviderBackupFile,
  type ProviderDraftInput,
} from '@agent-tower/shared';
import {
  applySecretWrites,
  detectDraftConflicts,
  detectAdvancedConflicts,
  mapAdvancedToSimple,
  mapSimpleToAdvanced,
  normalizeProviderDraft,
  redactProvider,
  redactSettings,
  updateTomlString,
  validateProviderBackupDrafts,
  validateSettings,
  validateProviderMappedFields,
} from '../provider-config.service.js';
import {
  probeEffectiveProviderConnection,
  resolveEffectiveProviderConnection,
} from '../provider-effective-connection.service.js';
import {
  AGENT_SUBPROCESS_BLOCKED_ENV_KEYS,
  AGENT_TOWER_MCP_IDENTITY_ENV_KEYS,
  AGENT_TOWER_MCP_SERVICE_ENV_KEYS,
} from '../../executors/execution-env.js';

const protectedSubprocessEnvKeys = [
  ...AGENT_SUBPROCESS_BLOCKED_ENV_KEYS,
  ...AGENT_TOWER_MCP_IDENTITY_ENV_KEYS,
  ...AGENT_TOWER_MCP_SERVICE_ENV_KEYS,
];

const provider = {
  id: 'provider-1',
  name: 'Codex Proxy',
  agentType: AgentType.CODEX,
  executionPermission: 'ASK' as const,
  env: { OPENAI_API_KEY: 'sk-secret', OPENAI_BASE_URL: 'https://old.example', UNKNOWN_ENV: 'keep-me' },
  config: { model: 'gpt-old', unknown: { enabled: true } },
  settings: '# keep this comment\nmodel_reasoning_effort = "medium" # keep inline\n\n[custom]\nvalue = "keep"\n',
  isDefault: false,
};

describe('provider config mapper', () => {
  it('maps simplified fields and preserves unknown values and TOML comments', () => {
    const mapped = mapSimpleToAdvanced(provider, {
      apiBaseUrl: 'https://new.example',
      model: 'gpt-new',
      reasoningEffort: 'high',
    });

    expect(mapped.env).toEqual({
      OPENAI_API_KEY: 'sk-secret',
      UNKNOWN_ENV: 'keep-me',
    });
    expect(mapped.config).toEqual({ model: 'gpt-new', unknown: { enabled: true } });
    expect(mapped.settings).toContain('# keep this comment');
    expect(mapped.settings).toContain('openai_base_url = "https://new.example"');
    expect(mapped.settings).toContain('model_reasoning_effort = "high" # keep inline');
    expect(mapped.settings).toContain('[custom]\nvalue = "keep"');
    expect(mapAdvancedToSimple(mapped)).toMatchObject({
      apiBaseUrl: 'https://new.example',
      model: 'gpt-new',
      reasoningEffort: 'high',
      apiKey: { configured: true, envKey: 'OPENAI_API_KEY' },
    });
  });

  it('resolves built-in Codex connection from canonical settings and projects the canonical key', () => {
    const connection = resolveEffectiveProviderConnection({
      agentType: AgentType.CODEX,
      env: { OPENAI_API_KEY: 'built-in-sentinel', OPENAI_BASE_URL: 'https://legacy.example/v1' },
      settings: 'openai_base_url = "https://api.openai.com/v1"\nunknown = true\n',
    });

    expect(connection).toMatchObject({
      providerKind: 'built-in',
      modelProviderId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      envKey: 'OPENAI_API_KEY',
      source: 'codex-openai',
      legacyBaseUrl: false,
      diagnostics: [],
    });
    expect(connection.secret).toBe('built-in-sentinel');
  });

  it('resolves custom Codex provider URL and dynamic env_key', () => {
    const connection = resolveEffectiveProviderConnection({
      agentType: AgentType.CODEX,
      env: { PROXY_TOKEN: 'custom-sentinel', OPENAI_API_KEY: 'unselected-sentinel' },
      settings: [
        'model_provider = "proxy"',
        '[model_providers.proxy]',
        'base_url = "https://proxy.example/v1"',
        'env_key = "PROXY_TOKEN"',
      ].join('\n'),
    });

    expect(connection).toMatchObject({
      providerKind: 'custom',
      modelProviderId: 'proxy',
      baseUrl: 'https://proxy.example/v1',
      envKey: 'PROXY_TOKEN',
      source: 'codex-custom',
      diagnostics: [],
    });
    expect(connection.secret).toBe('custom-sentinel');
    expect(mapAdvancedToSimple({
      agentType: AgentType.CODEX,
      env: { PROXY_TOKEN: 'custom-sentinel' },
      config: {},
      settings: [
        'model_provider = "proxy"',
        '[model_providers.proxy]',
        'base_url = "https://proxy.example/v1"',
        'env_key = "PROXY_TOKEN"',
      ].join('\n'),
    })).toMatchObject({
      apiBaseUrl: 'https://proxy.example/v1',
      apiKey: { configured: true, envKey: 'PROXY_TOKEN' },
    });
  });

  it.each([
    [AgentType.QWEN_CODE, 'https://api.openai.com/v1'],
    [AgentType.OPENCODE, 'https://api.openai.com/v1'],
    [AgentType.PI_CODING_AGENT, 'https://api.openai.com/v1'],
    [AgentType.GROK_BUILD, 'https://api.x.ai/v1'],
    [AgentType.MINION_CODE, 'https://api.openai.com/v1'],
  ])('resolves the default OpenAI-compatible connection for %s', (agentType, baseUrl) => {
    const connection = resolveEffectiveProviderConnection({
      agentType,
      env: { OPENAI_API_KEY: 'compatible-provider-sentinel' },
      settings: undefined,
    });

    expect(connection).toMatchObject({
      agentType,
      protocol: 'openai-compatible',
      providerKind: 'direct',
      baseUrl,
      envKey: 'OPENAI_API_KEY',
      credentialEnvKey: 'OPENAI_API_KEY',
      source: 'provider-env',
      diagnostics: [],
    });
    expect(connection.secret).toBe('compatible-provider-sentinel');
  });

  it.each(protectedSubprocessEnvKeys)(
    'rejects protected subprocess env_key %s before normalization or probe',
    async envKey => {
      const secret = 'protected-provider-value-sentinel';
      const candidate = {
        id: 'protected-provider',
        name: 'Protected custom credential',
        agentType: AgentType.CODEX,
        env: { [envKey]: secret },
        config: {},
        settings: [
          'model_provider = "proxy"',
          '[model_providers.proxy]',
          'base_url = "https://proxy.example/v1"',
          `env_key = ${JSON.stringify(envKey)}`,
        ].join('\n'),
        isDefault: false,
      };
      const expectedDiagnostic = {
        field: 'apiKey' as const,
        code: 'CONFLICT' as const,
        message: 'Active Codex env_key is reserved for Agent Tower subprocess internals',
      };
      const connection = resolveEffectiveProviderConnection(candidate);
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      const probe = await probeEffectiveProviderConnection(connection, { fetchImpl });
      const normalized = normalizeProviderDraft({
        name: candidate.name,
        agentType: AgentType.CODEX,
        env: { [envKey]: { action: 'replace', value: secret } },
        settings: candidate.settings,
      });

      expect(connection.diagnostics).toEqual([expectedDiagnostic]);
      expect(connection.secret).toBeUndefined();
      expect(probe).toMatchObject({
        ok: false,
        stage: 'validation',
        diagnostics: [expectedDiagnostic],
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(normalized.diagnostics).toContainEqual(expectedDiagnostic);
      expect(JSON.stringify(probe).includes(secret)).toBe(false);
      expect(JSON.stringify(normalized.diagnostics).includes(secret)).toBe(false);
    },
  );

  it.each(CODEX_NATIVE_MODEL_PROVIDER_IDS)(
    'preserves the Codex-native %s provider without inventing a custom connection',
    modelProviderId => {
      const settings = `# keep native\nmodel_provider = "${modelProviderId}"\nmodel_reasoning_effort = "high"\n`;
      const nativeProvider = {
        ...provider,
        env: { NATIVE_PROVIDER_OPTION: 'keep-me', OPENAI_BASE_URL: 'https://parent-compatible.example' },
        settings,
      };
      const connection = resolveEffectiveProviderConnection(nativeProvider);
      expect(connection).toMatchObject({
        providerKind: 'native',
        modelProviderId,
        protocol: null,
        source: 'codex-native',
        diagnostics: [],
      });
      expect(connection.baseUrl).toBeUndefined();
      expect(connection.envKey).toBeUndefined();
      expect(connection.secret).toBeUndefined();
      expect(mapAdvancedToSimple(nativeProvider)).toEqual({
        model: 'gpt-old',
        reasoningEffort: 'high',
      });

      const metadataOnly = normalizeProviderDraft({
        name: 'Renamed native provider',
        agentType: AgentType.CODEX,
      }, nativeProvider);
      expect(metadataOnly.diagnostics).toEqual([]);
      expect(metadataOnly.provider.settings).toBe(settings);
      expect(metadataOnly.provider.env).toEqual(nativeProvider.env);
    },
  );

  it('rejects a simplified URL edit for a native Codex provider without rewriting its settings', () => {
    const settings = 'model_provider = "ollama"\n';
    const result = normalizeProviderDraft({
      name: 'Native Codex',
      agentType: AgentType.CODEX,
      simplified: { apiBaseUrl: 'http://localhost:11434/v1' },
    }, {
      ...provider,
      settings,
    });

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      field: 'apiBaseUrl',
      code: 'CONFLICT',
    }));
    expect(result.provider.settings).toBe(settings);
  });

  it('reads legacy Codex URL without migrating it until the URL is explicitly edited', () => {
    const existing = {
      ...provider,
      settings: '# preserve\nunknown = "keep"\n',
    };
    const metadataOnly = normalizeProviderDraft({
      name: 'Renamed',
      agentType: AgentType.CODEX,
    }, existing);
    expect(metadataOnly.provider.env.OPENAI_BASE_URL).toBe('https://old.example');
    expect(metadataOnly.provider.settings).toBe(existing.settings);
    expect(mapAdvancedToSimple(metadataOnly.provider).apiBaseUrl).toBe('https://old.example');

    const migrated = normalizeProviderDraft({
      name: existing.name,
      agentType: AgentType.CODEX,
      simplified: { apiBaseUrl: 'https://canonical.example/v1' },
    }, existing);
    expect(migrated.diagnostics).toEqual([]);
    expect(migrated.provider.env.OPENAI_BASE_URL).toBeUndefined();
    expect(migrated.provider.env.UNKNOWN_ENV).toBe('keep-me');
    expect(migrated.provider.settings).toContain('# preserve');
    expect(migrated.provider.settings).toContain('unknown = "keep"');
    expect(migrated.provider.settings).toContain('openai_base_url = "https://canonical.example/v1"');
  });

  it('updates only the active custom provider URL and preserves TOML comments and other tables', () => {
    const existing = {
      ...provider,
      env: { PROXY_TOKEN: 'custom-sentinel', UNKNOWN_ENV: 'keep-me', OPENAI_BASE_URL: 'https://legacy.example' },
      settings: [
        '# keep leading',
        'model_provider = "proxy"',
        '',
        '[model_providers.proxy]',
        'base_url = "https://old-proxy.example/v1" # keep proxy note',
        'env_key = "PROXY_TOKEN"',
        'query_params = { api-version = "v1" }',
        '',
        '[model_providers.other]',
        'base_url = "https://other.example/v1"',
      ].join('\n'),
    };
    const result = normalizeProviderDraft({
      name: existing.name,
      agentType: AgentType.CODEX,
      simplified: { apiBaseUrl: 'https://new-proxy.example/v1' },
    }, existing);

    expect(result.diagnostics).toEqual([]);
    expect(result.provider.env).toEqual({ PROXY_TOKEN: 'custom-sentinel', UNKNOWN_ENV: 'keep-me' });
    expect(result.provider.settings).toContain('base_url = "https://new-proxy.example/v1" # keep proxy note');
    expect(result.provider.settings).toContain('query_params = { api-version = "v1" }');
    expect(result.provider.settings).toContain('[model_providers.other]\nbase_url = "https://other.example/v1"');
  });

  it('reports active custom provider diagnostics instead of guessing a hidden mapping', () => {
    const missing = normalizeProviderDraft({
      name: 'Missing custom provider',
      agentType: AgentType.CODEX,
      settings: 'model_provider = "missing"\n',
    });
    expect(missing.diagnostics).toContainEqual(expect.objectContaining({ field: 'settings', code: 'CONFLICT' }));

    const inline = normalizeProviderDraft({
      name: 'Inline custom provider',
      agentType: AgentType.CODEX,
      settings: 'model_provider = "proxy"\nmodel_providers = { proxy = { base_url = "https://old.example/v1", env_key = "PROXY_TOKEN" } }\n',
      simplified: { apiBaseUrl: 'https://new.example/v1' },
    });
    expect(inline.diagnostics).toContainEqual(expect.objectContaining({ field: 'apiBaseUrl', code: 'CONFLICT' }));
    expect(inline.provider.settings).toContain('https://old.example/v1');
  });

  it.each([
    ['ENOTFOUND', 'dns'],
    ['CERT_HAS_EXPIRED', 'tls'],
    ['ECONNREFUSED', 'network'],
  ] as const)('classifies %s probe failures as %s without exposing the secret', async (code, errorKind) => {
    const fetchImpl = vi.fn(async () => {
      const error = new TypeError('synthetic connection failure');
      Object.assign(error, { cause: { code } });
      throw error;
    }) as unknown as typeof fetch;
    const connection = resolveEffectiveProviderConnection({
      agentType: AgentType.CODEX,
      env: { OPENAI_API_KEY: 'probe-classification-sentinel' },
      settings: 'openai_base_url = "https://probe.invalid/v1"',
    });
    const result = await probeEffectiveProviderConnection(connection, { fetchImpl, timeoutMs: 50 });

    expect(result).toMatchObject({ ok: false, stage: 'connection', errorKind });
    expect(JSON.stringify(result)).not.toContain('probe-classification-sentinel');
  });

  it.each([
    'http:host',
    'https:/host',
    'https:host',
  ])('rejects an API URL without an explicit protocol separator: %s', apiBaseUrl => {
    const result = normalizeProviderDraft({
      name: 'Invalid URL',
      agentType: AgentType.CODEX,
      simplified: { apiBaseUrl },
    });

    expect(result.diagnostics).toContainEqual({
      field: 'apiBaseUrl',
      code: 'INVALID_URL',
      message: 'API URL must be a complete http:// or https:// URL',
    });
  });

  it('rejects invalid canonical and custom Codex URLs from advanced TOML', () => {
    expect(normalizeProviderDraft({
      name: 'Invalid canonical URL',
      agentType: AgentType.CODEX,
      settings: 'openai_base_url = "proxy.example/v1"',
    }).diagnostics).toContainEqual(expect.objectContaining({ field: 'apiBaseUrl', code: 'INVALID_URL' }));

    expect(normalizeProviderDraft({
      name: 'Invalid custom URL',
      agentType: AgentType.CODEX,
      settings: [
        'model_provider = "proxy"',
        '[model_providers.proxy]',
        'base_url = "proxy.example/v1"',
      ].join('\n'),
    }).diagnostics).toContainEqual(expect.objectContaining({ field: 'apiBaseUrl', code: 'INVALID_URL' }));
  });

  it.each([
    'http://localhost:8080',
    'https://proxy.example/v1',
  ])('accepts a complete API URL: %s', apiBaseUrl => {
    const result = normalizeProviderDraft({
      name: 'Valid URL',
      agentType: AgentType.CODEX,
      simplified: { apiBaseUrl },
    });

    expect(result.diagnostics).toEqual([]);
  });

  it('normalizes API URL boundary whitespace without changing secret values', () => {
    const secret = '  key-whitespace-sentinel  ';
    const result = normalizeProviderDraft({
      name: 'Whitespace URL',
      agentType: AgentType.CODEX,
      env: { OPENAI_API_KEY: { action: 'replace', value: secret } },
      simplified: { apiBaseUrl: '  https://proxy.example/v1  ' },
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.provider.settings).toContain('openai_base_url = "https://proxy.example/v1"');
    expect(result.provider.env.OPENAI_API_KEY === secret).toBe(true);
  });

  it('maps and redacts the Gemini API key with keep, replace, and clear writes', () => {
    const existing = {
      ...provider,
      id: 'gemini-provider',
      name: 'Gemini',
      agentType: AgentType.GEMINI_CLI,
      env: { GEMINI_API_KEY: 'gemini-old-secret', UNKNOWN_ENV: 'keep-me' },
      config: { model: 'gemini-old' },
      settings: undefined,
    };

    expect(mapAdvancedToSimple(existing)).toMatchObject({
      apiKey: { configured: true, envKey: 'GEMINI_API_KEY' },
      model: 'gemini-old',
    });
    expect(JSON.stringify(redactProvider(existing))).not.toContain('gemini-old-secret');

    const kept = normalizeProviderDraft({
      name: existing.name,
      agentType: AgentType.GEMINI_CLI,
      env: { GEMINI_API_KEY: { action: 'keep' } },
    }, existing);
    expect(kept.provider.env.GEMINI_API_KEY).toBe('gemini-old-secret');

    const replaced = normalizeProviderDraft({
      name: existing.name,
      agentType: AgentType.GEMINI_CLI,
      env: { GEMINI_API_KEY: { action: 'replace', value: 'gemini-new-secret' } },
    }, existing);
    expect(replaced.provider.env.GEMINI_API_KEY).toBe('gemini-new-secret');

    const cleared = normalizeProviderDraft({
      name: existing.name,
      agentType: AgentType.GEMINI_CLI,
      env: { GEMINI_API_KEY: { action: 'clear' } },
    }, existing);
    expect(cleared.provider.env.GEMINI_API_KEY).toBeUndefined();
    expect(cleared.provider.env.UNKNOWN_ENV).toBe('keep-me');
  });

  it('migrates a top-level Codex model without losing its comment or unrelated TOML', () => {
    const existing = {
      ...provider,
      config: { unknown: { enabled: true } },
      settings: [
        '# keep leading comment',
        '  model = "gpt-old" # keep model note',
        'unmapped = "keep-me"',
        '',
        '[profile.default]',
        'model = "table-model" # keep table model',
        'custom = "keep-table-value"',
        '',
      ].join('\n'),
    };

    const result = normalizeProviderDraft({
      providerId: existing.id,
      name: existing.name,
      agentType: AgentType.CODEX,
      simplified: { model: 'gpt-new' },
    }, existing);

    expect(result.diagnostics).toEqual([]);
    expect(result.provider.config).toEqual({
      model: 'gpt-new',
      unknown: { enabled: true },
    });
    expect(result.provider.settings).toBe([
      '# keep leading comment',
      '  # keep model note',
      'unmapped = "keep-me"',
      '',
      '[profile.default]',
      'model = "table-model" # keep table model',
      'custom = "keep-table-value"',
      '',
    ].join('\n'));
    expect(validateSettings(AgentType.CODEX, result.provider.settings)).toEqual([]);
  });

  it('keeps invalid historical settings byte-for-byte for metadata-only updates', () => {
    const existing = { ...provider, settings: 'invalid = [toml' };
    const input: ProviderDraftInput = {
      providerId: existing.id,
      name: 'Renamed',
      agentType: AgentType.CODEX,
      isDefault: true,
    };
    const result = normalizeProviderDraft(input, existing);
    expect(result.diagnostics).toEqual([]);
    expect(result.provider.settings).toBe(existing.settings);

    const mappedChange = normalizeProviderDraft({
      providerId: existing.id,
      name: existing.name,
      agentType: AgentType.CODEX,
      simplified: { reasoningEffort: 'high' },
    }, existing);
    expect(mappedChange.diagnostics).toMatchObject([{ field: 'settings', code: 'INVALID_FORMAT' }]);
    expect(mappedChange.provider.settings).toBe(existing.settings);
  });

  it('reports format errors and draft conflicts without rewriting input', () => {
    expect(validateSettings(AgentType.CODEX, 'broken = [toml')).toMatchObject([{ field: 'settings', code: 'INVALID_FORMAT' }]);
    expect(updateTomlString('broken = [toml', 'model_reasoning_effort', 'high')).toBe('broken = [toml');
    expect(detectDraftConflicts(provider, { model: 'different' })).toMatchObject([{ field: 'model', code: 'CONFLICT' }]);
  });

  it.each([
    [AgentType.CLAUDE_CODE, 'dangerouslySkipPermissions'],
    [AgentType.GEMINI_CLI, 'yolo'],
    [AgentType.CURSOR_AGENT, 'force'],
    [AgentType.CODEX, 'dangerouslyBypassApprovalsAndSandbox'],
    [AgentType.KIRO_CLI, 'trustAllTools'],
    [AgentType.OPENCODE, 'autoApprove'],
    [AgentType.PI_CODING_AGENT, 'autoApprove'],
    [AgentType.GROK_BUILD, 'alwaysApprove'],
    [AgentType.MINION_CODE, 'dangerouslySkipPermissions'],
  ])('requires a boolean execution permission for %s', (agentType, path) => {
    for (const invalidValue of ['true', 1, null, {}]) {
      const invalid = normalizeProviderDraft({
        name: 'Invalid permission',
        agentType,
        config: { [path]: invalidValue, unknown: 'keep' },
      });
      expect(invalid.diagnostics).toContainEqual({
        field: 'executionPermission',
        code: 'INVALID_TYPE',
        message: `${path} must be true or false`,
      });
      expect(invalid.provider.config.unknown).toBe('keep');
    }

    for (const value of [undefined, false, true]) {
      expect(validateProviderMappedFields({
        agentType,
        config: value === undefined ? {} : { [path]: value },
      })).toEqual([]);
    }
  });

  it.each([
    ['string', 'true'],
    ['number', 1],
    ['null', null],
    ['object', { enabled: true }],
  ])('rejects a %s Codex permission in an imported backup draft', (_label, invalidValue) => {
    const secret = 'backup-service-secret-sentinel';
    const backup: ProviderBackupFile = {
      version: 1,
      kind: 'provider-backup',
      exportedAt: new Date().toISOString(),
      mode: 'full',
      providers: [{
        id: 'invalid-backup-provider',
        name: 'Invalid backup provider',
        agentType: AgentType.CODEX,
        env: { OPENAI_API_KEY: secret },
        config: { dangerouslyBypassApprovalsAndSandbox: invalidValue },
        isDefault: false,
      }],
    };

    const diagnostics = validateProviderBackupDrafts(backup);

    expect(diagnostics).toContainEqual({
      providerIndex: 0,
      providerId: 'invalid-backup-provider',
      field: 'executionPermission',
      code: 'INVALID_TYPE',
      message: 'dangerouslyBypassApprovalsAndSandbox must be true or false',
    });
    expect(JSON.stringify(diagnostics)).not.toContain(secret);
    expect(backup.providers[0]!.config.dangerouslyBypassApprovalsAndSandbox).toEqual(invalidValue);
  });

  it('accepts strict true and false backup permissions without changing them', () => {
    const backup: ProviderBackupFile = {
      version: 1,
      kind: 'provider-backup',
      exportedAt: new Date().toISOString(),
      mode: 'full',
      providers: [true, false].map((value, index) => ({
        id: `valid-backup-provider-${index}`,
        name: `Valid backup provider ${index}`,
        agentType: AgentType.CODEX,
        env: {},
        config: { dangerouslyBypassApprovalsAndSandbox: value },
        isDefault: false,
      })),
    };

    expect(validateProviderBackupDrafts(backup)).toEqual([]);
    expect(backup.providers.map(item => item.config.dangerouslyBypassApprovalsAndSandbox))
      .toEqual([true, false]);
  });

  it('applies settings and effective connection validation to backup drafts', () => {
    const backup: ProviderBackupFile = {
      version: 1,
      kind: 'provider-backup',
      exportedAt: new Date().toISOString(),
      mode: 'full',
      providers: [{
        id: 'invalid-backup-settings',
        name: 'Invalid backup settings',
        agentType: AgentType.CODEX,
        env: {},
        config: {},
        settings: 'broken = [toml',
        isDefault: false,
      }, {
        id: 'missing-backup-connection',
        name: 'Missing backup connection',
        agentType: AgentType.CODEX,
        env: {},
        config: {},
        settings: 'model_provider = "missing"\n',
        isDefault: false,
      }],
    };

    expect(validateProviderBackupDrafts(backup)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerId: 'invalid-backup-settings',
        field: 'settings',
        code: 'INVALID_FORMAT',
      }),
      expect.objectContaining({
        providerId: 'missing-backup-connection',
        field: 'settings',
        code: 'CONFLICT',
      }),
    ]));
  });

  it('round-trips the Codex WebSocket disable control and rejects non-booleans', () => {
    for (const value of [undefined, false, true]) {
      const result = normalizeProviderDraft({
        name: 'Codex transport',
        agentType: AgentType.CODEX,
        config: value === undefined
          ? { unknown: { keep: true } }
          : { disableResponsesWebsocket: value, unknown: { keep: true } },
      });
      expect(result.diagnostics).toEqual([]);
      expect(result.provider.config.disableResponsesWebsocket).toBe(value);
      expect(result.provider.config.unknown).toEqual({ keep: true });
      expect(redactProvider(result.provider).config.disableResponsesWebsocket).toBe(value);
    }

    for (const value of ['true', 1, null, {}]) {
      const result = normalizeProviderDraft({
        name: 'Invalid Codex transport',
        agentType: AgentType.CODEX,
        config: { disableResponsesWebsocket: value, unknown: 'keep' },
      });
      expect(result.diagnostics).toContainEqual({
        field: 'disableResponsesWebsocket',
        code: 'INVALID_TYPE',
        message: 'disableResponsesWebsocket must be true or false',
      });
      expect(result.provider.config.unknown).toBe('keep');
    }

    expect(validateProviderMappedFields({
      agentType: AgentType.CLAUDE_CODE,
      config: { disableResponsesWebsocket: 'legacy-unknown-value' },
    })).toEqual([]);
  });

  it('round-trips Codex Fast mode and rejects non-booleans', () => {
    for (const value of [undefined, false, true]) {
      const result = normalizeProviderDraft({
        name: 'Codex speed',
        agentType: AgentType.CODEX,
        config: value === undefined
          ? { unknown: { keep: true } }
          : { fastMode: value, unknown: { keep: true } },
      });
      expect(result.diagnostics).toEqual([]);
      expect(result.provider.config.fastMode).toBe(value);
      expect(result.provider.config.unknown).toEqual({ keep: true });
      expect(redactProvider(result.provider).config.fastMode).toBe(value);
    }

    for (const value of ['true', 1, null, {}]) {
      const result = normalizeProviderDraft({
        name: 'Invalid Codex speed',
        agentType: AgentType.CODEX,
        config: { fastMode: value, unknown: 'keep' },
      });
      expect(result.diagnostics).toContainEqual({
        field: 'fastMode',
        code: 'INVALID_TYPE',
        message: 'fastMode must be true or false',
      });
      expect(result.provider.config.unknown).toBe('keep');
    }

    expect(validateProviderMappedFields({
      agentType: AgentType.CLAUDE_CODE,
      config: { fastMode: 'legacy-unknown-value' },
    })).toEqual([]);
  });

  it('rejects a reserved built-in Codex alias when transport disable is enabled', () => {
    const aliasTable = [
      '[model_providers.agent-tower-openai-http]',
      'name = "User alias"',
      'env_key = "STALE_ALIAS_KEY"',
    ].join('\n');

    for (const modelProvider of [undefined, 'openai', '   ']) {
      const settings = modelProvider === undefined
        ? aliasTable
        : `model_provider = ${JSON.stringify(modelProvider)}\n${aliasTable}`;
      const conflict = normalizeProviderDraft({
        name: 'Codex alias collision',
        agentType: AgentType.CODEX,
        config: { disableResponsesWebsocket: true },
        settings,
      });
      expect(conflict.diagnostics).toContainEqual({
        field: 'disableResponsesWebsocket',
        code: 'CONFLICT',
        message: "disableResponsesWebsocket conflicts with reserved Codex model provider alias 'agent-tower-openai-http'",
      });
    }

    expect(validateProviderMappedFields({
      agentType: AgentType.CODEX,
      config: { disableResponsesWebsocket: false },
      settings: `model_provider = "openai"\n${aliasTable}`,
    })).toEqual([]);
    for (const modelProvider of ['proxy', 'ollama']) {
      expect(validateProviderMappedFields({
        agentType: AgentType.CODEX,
        config: { disableResponsesWebsocket: true },
        settings: `model_provider = ${JSON.stringify(modelProvider)}\n${aliasTable}`,
      })).toEqual([]);
    }
    expect(validateProviderMappedFields({
      agentType: AgentType.CODEX,
      config: { disableResponsesWebsocket: true },
      settings: 'model_provider = "openai"\n',
    })).toEqual([]);
  });

  it('preserves the transport control when reopening and updating unrelated fields', () => {
    const existing = {
      ...provider,
      config: {
        ...provider.config,
        disableResponsesWebsocket: true,
      },
    };
    const result = normalizeProviderDraft({
      providerId: existing.id,
      name: 'Renamed Codex Proxy',
      agentType: AgentType.CODEX,
      config: existing.config,
    }, existing);

    expect(result.diagnostics).toEqual([]);
    expect(result.provider.config).toEqual(existing.config);
    expect(redactProvider(result.provider).config.disableResponsesWebsocket).toBe(true);
  });

  it('validates mapped effort enums and accepts explicit unset', () => {
    expect(normalizeProviderDraft({
      name: 'Invalid Claude effort',
      agentType: AgentType.CLAUDE_CODE,
      config: { effort: 'extreme' },
    }).diagnostics).toMatchObject([{ field: 'reasoningEffort', code: 'INVALID_ENUM' }]);
    expect(normalizeProviderDraft({
      name: 'Invalid Codex effort',
      agentType: AgentType.CODEX,
      settings: 'model_reasoning_effort = "extreme"\nunknown = "keep"\n',
    }).diagnostics).toMatchObject([{ field: 'reasoningEffort', code: 'INVALID_ENUM' }]);
    expect(normalizeProviderDraft({
      name: 'Unset effort',
      agentType: AgentType.CODEX,
      simplified: { reasoningEffort: '' },
    }).diagnostics).toEqual([]);
  });

  it('removes only the mapped Codex effort while preserving TOML layout', () => {
    const existing = {
      ...provider,
      settings: '# before\nmodel_reasoning_effort = "high" # keep note\n\n[profile.team]\nmodel_reasoning_effort = "low"\n',
    };
    const result = normalizeProviderDraft({
      name: existing.name,
      agentType: AgentType.CODEX,
      simplified: { reasoningEffort: '' },
    }, existing);
    expect(result.diagnostics).toEqual([]);
    expect(result.provider.settings).toBe('# before\n# keep note\n\n[profile.team]\nmodel_reasoning_effort = "low"\n');
  });

  it('redacts secrets and restores keep values during an update', () => {
    const redacted = redactProvider({
      ...provider,
      config: { ...provider.config, auth_token: 'config-secret' },
      settings: '{"env":{"ANTHROPIC_API_KEY":"settings-secret"}}',
      agentType: AgentType.CLAUDE_CODE,
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('sk-secret');
    expect(serialized).not.toContain('config-secret');
    expect(serialized).not.toContain('settings-secret');

    const result = normalizeProviderDraft({
      providerId: provider.id,
      name: provider.name,
      agentType: AgentType.CODEX,
      env: {
        OPENAI_API_KEY: { action: 'keep' },
        OPENAI_BASE_URL: { action: 'replace', value: 'https://new.example' },
      },
      config: provider.config,
      settings: provider.settings,
    }, provider);
    expect(result.provider.env.OPENAI_API_KEY).toBe('sk-secret');
    expect(result.provider.env.OPENAI_BASE_URL).toBe('https://new.example');
  });

  it('atomically canonicalizes trim-equivalent aliases for explicit secret writes', () => {
    const canonicalKey = 'PROXY_ACCESS';
    const spacedKey = `  ${canonicalKey}  `;
    const oldAliasSentinel = 'old-alias-sentinel';
    const oldCanonicalSentinel = 'old-canonical-sentinel';
    const replacementSentinel = 'replacement-sentinel';
    const existing = {
      [spacedKey]: oldAliasSentinel,
      [canonicalKey]: oldCanonicalSentinel,
      UNKNOWN_ENV: 'unknown-env-sentinel',
    };

    for (const writes of [
      {
        [canonicalKey]: { action: 'replace' as const, value: replacementSentinel },
        [spacedKey]: { action: 'keep' as const },
      },
      {
        [spacedKey]: { action: 'keep' as const },
        [canonicalKey]: { action: 'replace' as const, value: replacementSentinel },
      },
    ]) {
      const replaced = applySecretWrites(existing, writes);
      expect(Object.keys(replaced).filter(key => key.trim() === canonicalKey)).toEqual([canonicalKey]);
      expect(replaced[canonicalKey] === replacementSentinel).toBe(true);
      expect(replaced[spacedKey]).toBeUndefined();
      expect(replaced.UNKNOWN_ENV === existing.UNKNOWN_ENV).toBe(true);
    }

    for (const writes of [
      {
        [canonicalKey]: { action: 'keep' as const },
        [spacedKey]: { action: 'clear' as const },
      },
      {
        [spacedKey]: { action: 'clear' as const },
        [canonicalKey]: { action: 'keep' as const },
      },
    ]) {
      const cleared = applySecretWrites(existing, writes);
      expect(Object.keys(cleared).some(key => key.trim() === canonicalKey)).toBe(false);
      expect(cleared.UNKNOWN_ENV === existing.UNKNOWN_ENV).toBe(true);
    }
  });

  it('leaves conflicting trim-equivalent aliases untouched for keep-only writes', () => {
    const canonicalKey = 'PROXY_ACCESS';
    const spacedKey = ` ${canonicalKey} `;
    const existing: Record<string, string> = {
      [canonicalKey]: 'canonical-keep-sentinel',
      [spacedKey]: 'alias-keep-sentinel',
    };

    const kept = applySecretWrites(existing, {
      [spacedKey]: { action: 'keep' },
      [canonicalKey]: { action: 'keep' },
    });

    expect(Object.keys(kept)).toEqual(Object.keys(existing));
    expect(Object.keys(kept).filter(key => key.trim() === canonicalKey)).toHaveLength(2);
    expect(Object.entries(kept).every(([key, value]) => value === existing[key])).toBe(true);
  });

  it('marks the active custom credential env key as sensitive without relying on its name', () => {
    const secret = 'dynamic-provider-value-sentinel';
    const redacted = redactProvider({
      ...provider,
      env: { PROXY_ACCESS: secret, VISIBLE_SETTING: 'visible' },
      settings: [
        'model_provider = "proxy"',
        '[model_providers.proxy]',
        'base_url = "https://proxy.example/v1"',
        'env_key = "PROXY_ACCESS"',
      ].join('\n'),
    });

    expect(redacted.redactedEnv).toMatchObject({
      PROXY_ACCESS: { configured: true, sensitive: true },
      VISIBLE_SETTING: { configured: true, sensitive: false },
    });
    expect(JSON.stringify(redacted).includes(secret)).toBe(false);
  });

  it('structurally redacts JSON strings, arrays, and objects without producing invalid JSON', () => {
    const escapedSecret = 'abc"supersecret\\tail';
    const arraySecret = 'array-secret';
    const objectSecret = 'object-secret';
    const settings = JSON.stringify({
      api_key: escapedSecret,
      authorization: [arraySecret, { nested: objectSecret }],
      safe: { value: 'visible' },
    });

    const redacted = redactSettings(settings)!;
    expect(redacted).not.toContain('supersecret');
    expect(redacted).not.toContain('array-secret');
    expect(redacted).not.toContain('object-secret');
    expect(JSON.parse(redacted)).toEqual({
      api_key: '__AGENT_TOWER_REDACTED__',
      authorization: '__AGENT_TOWER_REDACTED__',
      safe: { value: 'visible' },
    });
  });

  it('redacts complete TOML secret values while preserving comments, tables, and unrelated text', () => {
    const settings = [
      '# keep leading comment',
      'api_key = ["toml-array-secret", { value = "toml-object-secret" }] # keep inline',
      'auth = [',
      '  "toml-multiline-secret", # keep nested comment',
      '] # keep multiline comment',
      'connection = { api_key = "nested-inline-secret", visible = true }',
      '',
      '[profile.team]',
      'auth = { token = "nested-secret" } # keep table comment',
      'unknown = "keep-me"',
    ].join('\n');

    const redacted = redactSettings(settings)!;
    expect(redacted).not.toContain('toml-array-secret');
    expect(redacted).not.toContain('toml-object-secret');
    expect(redacted).not.toContain('toml-multiline-secret');
    expect(redacted).not.toContain('nested-inline-secret');
    expect(redacted).not.toContain('nested-secret');
    expect(redacted).toContain('# keep leading comment');
    expect(redacted).toContain('# keep inline');
    expect(redacted).toContain('# keep nested comment');
    expect(redacted).toContain('# keep multiline comment');
    expect(redacted).toContain('[profile.team]');
    expect(redacted).toContain('# keep table comment');
    expect(redacted).toContain('unknown = "keep-me"');
    expect(() => validateSettings(AgentType.CODEX, redacted)).not.toThrow();
    expect(validateSettings(AgentType.CODEX, redacted)).toEqual([]);
  });

  it('reads legacy Claude settings env without migrating it on metadata-only updates', () => {
    const existing = {
      ...provider,
      agentType: AgentType.CLAUDE_CODE,
      env: { UNKNOWN_ENV: 'keep-me' },
      settings: JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: 'https://legacy.example',
          ANTHROPIC_API_KEY: 'legacy-secret',
        },
        unknown: true,
      }, null, 2),
    };
    expect(mapAdvancedToSimple(existing)).toMatchObject({
      apiBaseUrl: 'https://legacy.example',
      apiKey: { configured: true },
    });

    const metadataOnly = normalizeProviderDraft({
      name: 'Renamed',
      agentType: AgentType.CLAUDE_CODE,
    }, existing);
    expect(metadataOnly.provider.settings).toBe(existing.settings);
    expect(metadataOnly.provider.env).toEqual(existing.env);

    const changed = normalizeProviderDraft({
      name: existing.name,
      agentType: AgentType.CLAUDE_CODE,
      simplified: { apiBaseUrl: 'https://new.example' },
      env: { ANTHROPIC_API_KEY: { action: 'replace', value: 'new-secret' } },
    }, existing);
    expect(changed.provider.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://new.example',
      ANTHROPIC_API_KEY: 'new-secret',
      UNKNOWN_ENV: 'keep-me',
    });
    expect(changed.provider.settings).not.toContain('ANTHROPIC_BASE_URL');
    expect(changed.provider.settings).not.toContain('legacy-secret');
    expect(changed.provider.settings).toContain('"unknown": true');
  });

  it('requires an explicit resolution for duplicate known paths', () => {
    const conflicting = {
      ...provider,
      config: { ...provider.config, model: 'config-model' },
      settings: 'model = "settings-model"\nmodel_reasoning_effort = "high"\n',
    };
    expect(detectAdvancedConflicts(conflicting)).toMatchObject([{ field: 'model', code: 'CONFLICT' }]);

    const unresolved = normalizeProviderDraft({
      name: conflicting.name,
      agentType: AgentType.CODEX,
    }, conflicting);
    expect(unresolved.diagnostics).toMatchObject([{ field: 'model', code: 'CONFLICT' }]);

    const resolved = normalizeProviderDraft({
      name: conflicting.name,
      agentType: AgentType.CODEX,
      conflictResolutions: { model: 'advanced' },
    }, conflicting);
    expect(resolved.diagnostics).toEqual([]);
    expect(resolved.provider.config.model).toBeUndefined();
    expect(resolved.provider.settings).toContain('model = "settings-model"');
  });

  it.each([
    ['model', { model: 'gpt-new' }],
    ['reasoning effort', { reasoningEffort: 'high' }],
  ])('blocks %s mapping when historical Codex settings are invalid', (_label, simplified) => {
    const existing = { ...provider, settings: 'invalid = [toml' };
    const result = normalizeProviderDraft({
      providerId: existing.id,
      name: existing.name,
      agentType: AgentType.CODEX,
      config: { ...existing.config, model: 'client-prewrite-must-not-stick' },
      settings: existing.settings,
      simplified,
    }, existing);

    expect(result.diagnostics).toMatchObject([{ field: 'settings', code: 'INVALID_FORMAT' }]);
    expect(result.provider.config).toEqual(existing.config);
    expect(result.provider.settings).toBe(existing.settings);
  });
});
