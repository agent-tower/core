import { describe, expect, it } from 'vitest'
import { AgentType, PROVIDER_CAPABILITIES, type RedactedProvider } from '@agent-tower/shared'
import { parse as parseToml } from 'smol-toml'
import {
  buildProviderEnvWrites,
  createProviderDraftTestSequence,
  createProviderEnvDraftRows,
  getApiBaseUrlValidationError,
  getApiKeyDraftStatus,
  getExecutionPermissionState,
  getProviderBooleanConfigState,
  isProviderEnvDraftRowSensitive,
  isSameProviderEnvKey,
  markActiveCredentialEnvRowSensitive,
  resolveProviderDraftConflict,
  syncSimplifiedFromConfig,
  syncSimplifiedFromSettings,
  updateSimplifiedDraftValue,
  updateExecutionPermission,
  updateProviderBooleanConfig,
  usesCodexNativeModelProvider,
} from '../provider-draft'

describe('provider draft helpers', () => {
  it('creates write-only env rows without materializing saved values', () => {
    const provider: RedactedProvider = {
      id: 'codex-1',
      name: 'Codex',
      agentType: AgentType.CODEX,
      env: {},
      redactedEnv: {
        OPENAI_API_KEY: { configured: true, sensitive: true },
        OPENAI_BASE_URL: { configured: true, sensitive: false },
        UNKNOWN_ENV: { configured: true, sensitive: false },
      },
      config: {},
      simplified: { apiBaseUrl: 'https://proxy.example', model: 'gpt-test' },
      isDefault: false,
    }

    const rows = createProviderEnvDraftRows(provider, PROVIDER_CAPABILITIES[AgentType.CODEX])
    expect(rows.find(row => row.key === 'OPENAI_API_KEY')).toMatchObject({ value: '', write: { action: 'keep' } })
    expect(rows.find(row => row.key === 'OPENAI_BASE_URL')).toMatchObject({ value: '', write: { action: 'keep' } })
    expect(rows.find(row => row.key === 'UNKNOWN_ENV')).toMatchObject({ value: '', write: { action: 'keep' } })
    expect(JSON.stringify(rows)).not.toContain('sk-')
  })

  it('forces a non-typical active credential env row to stay sensitive', () => {
    const provider: RedactedProvider = {
      id: 'codex-dynamic',
      name: 'Codex Dynamic',
      agentType: AgentType.CODEX,
      env: {},
      redactedEnv: {
        PROXY_ACCESS: { configured: true, sensitive: false },
        VISIBLE_SETTING: { configured: true, sensitive: false },
      },
      config: {},
      simplified: { apiKey: { configured: true, envKey: 'PROXY_ACCESS' } },
      isDefault: false,
    }

    const rows = createProviderEnvDraftRows(provider, PROVIDER_CAPABILITIES[AgentType.CODEX])
    expect(rows.find(row => row.key === 'PROXY_ACCESS')?.sensitive).toBe(true)
    expect(rows.find(row => row.key === 'VISIBLE_SETTING')?.sensitive).toBe(false)

    const switched = markActiveCredentialEnvRowSensitive(rows.map(row => ({ ...row, sensitive: false })), provider.simplified!)
    expect(switched.find(row => row.key === 'PROXY_ACCESS')?.sensitive).toBe(true)
    expect(switched.find(row => row.key === 'VISIBLE_SETTING')?.sensitive).toBe(false)

    expect(isProviderEnvDraftRowSensitive(
      { key: '  PROXY_ACCESS  ', sensitive: false },
      provider.simplified!,
    )).toBe(true)
    expect(isProviderEnvDraftRowSensitive(
      { key: 'RENAMED_SETTING', sensitive: true },
      provider.simplified!,
    )).toBe(true)
    expect(isSameProviderEnvKey('  PROXY_ACCESS  ', 'PROXY_ACCESS')).toBe(true)
    expect(isSameProviderEnvKey('  ', 'PROXY_ACCESS')).toBe(false)
    expect(getApiKeyDraftStatus(
      { key: '  PROXY_ACCESS  ', value: '', write: { action: 'keep' }, configured: true, sensitive: true },
      false,
      undefined,
    )).toBe('configured')
  })

  it('syncs Codex built-in and custom active connection fields from TOML', () => {
    expect(syncSimplifiedFromSettings(
      { apiKey: { configured: true, envKey: 'OPENAI_API_KEY' } },
      'openai_base_url = "https://api.example/v1"\nmodel_reasoning_effort = "high"\n',
      AgentType.CODEX,
    )).toEqual({
      apiBaseUrl: 'https://api.example/v1',
      apiKey: { configured: true, envKey: 'OPENAI_API_KEY' },
      reasoningEffort: 'high',
    })

    expect(syncSimplifiedFromSettings(
      { apiKey: { configured: false, envKey: 'OPENAI_API_KEY' } },
      [
        'model_provider = "proxy"',
        '[model_providers.proxy]',
        'base_url = "https://proxy.example/v1"',
        'env_key = "PROXY_TOKEN"',
      ].join('\n'),
      AgentType.CODEX,
      new Set(['  PROXY_TOKEN  ']),
    )).toEqual({
      apiBaseUrl: 'https://proxy.example/v1',
      apiKey: { configured: true, envKey: 'PROXY_TOKEN' },
      reasoningEffort: '',
    })
  })

  it.each(['oss', 'ollama', 'lmstudio', 'amazon-bedrock'])(
    'keeps the native Codex %s connection out of simplified URL and key fields',
    modelProviderId => {
      const settings = `model_provider = "${modelProviderId}"\nmodel_reasoning_effort = "medium"\n`
      expect(usesCodexNativeModelProvider(settings)).toBe(true)
      expect(syncSimplifiedFromSettings(
        {
          apiBaseUrl: 'https://previous.example/v1',
          apiKey: { configured: true, envKey: 'OPENAI_API_KEY' },
        },
        settings,
        AgentType.CODEX,
        new Set(['OPENAI_API_KEY']),
      )).toEqual({
        apiBaseUrl: undefined,
        apiKey: undefined,
        reasoningEffort: 'medium',
      })
    },
  )

  it('accepts only the latest test request after edits or overlapping requests', () => {
    const sequence = createProviderDraftTestSequence()
    const first = sequence.begin()
    const second = sequence.begin()
    expect(sequence.isCurrent(first)).toBe(false)
    expect(sequence.isCurrent(second)).toBe(true)

    sequence.invalidate()
    expect(sequence.isCurrent(second)).toBe(false)
    const third = sequence.begin()
    expect(sequence.isCurrent(third)).toBe(true)
  })

  it('keeps, replaces, and clears env entries explicitly', () => {
    expect(buildProviderEnvWrites([
      { key: 'KEEP', value: '', write: { action: 'keep' }, configured: true, sensitive: false },
      { key: 'REPLACE', value: 'new', write: { action: 'replace', value: 'new' }, configured: true, sensitive: true },
      { key: 'CLEAR', value: '', write: { action: 'clear' }, configured: true, sensitive: true },
    ])).toEqual({
      KEEP: { action: 'keep' },
      REPLACE: { action: 'replace', value: 'new' },
      CLEAR: { action: 'clear' },
    })
  })

  it.each([
    ['canonical first', ['PROXY_ACCESS', '  PROXY_ACCESS  ']],
    ['spaced alias first', ['  PROXY_ACCESS  ', 'PROXY_ACCESS']],
  ] as const)('keeps a duplicate-alias explicit write when %s', (_label, keys) => {
    for (const write of [
      { action: 'replace', value: 'replacement-value' } as const,
      { action: 'clear' } as const,
    ]) {
      const rows = keys.map((key, index) => ({
        key,
        value: index === 0 && write.action === 'replace' ? write.value : '',
        write: index === 0 ? write : { action: 'keep' } as const,
        configured: true,
        sensitive: true,
      }))
      expect(buildProviderEnvWrites(rows)).toEqual({ PROXY_ACCESS: write })
    }
  })

  it('resolves conflicting explicit duplicate rows deterministically', () => {
    const rows = [
      { key: 'PROXY_ACCESS', value: 'z', write: { action: 'replace', value: 'z' } as const, configured: true, sensitive: true },
      { key: 'PROXY_ACCESS', value: 'a', write: { action: 'replace', value: 'a' } as const, configured: true, sensitive: true },
      { key: '  PROXY_ACCESS  ', value: '', write: { action: 'clear' } as const, configured: true, sensitive: true },
    ]
    const expected = { PROXY_ACCESS: { action: 'replace', value: 'a' } } as const

    expect(buildProviderEnvWrites(rows)).toEqual(expected)
    expect(buildProviderEnvWrites([...rows].reverse())).toEqual(expected)
  })

  it('syncs advanced config model and Claude effort back to simple fields', () => {
    expect(syncSimplifiedFromConfig(
      {},
      { model: 'claude-new', effort: 'high', unknown: true },
      PROVIDER_CAPABILITIES[AgentType.CLAUDE_CODE],
    )).toMatchObject({ model: 'claude-new', reasoningEffort: 'high' })
  })

  it.each(Object.values(AgentType))('reads and immutably updates %s execution permission', agentType => {
    const capability = PROVIDER_CAPABILITIES[agentType]
    const path = capability.executionPermission.path
    const draft = { config: { unknown: { keep: true } } }

    // An agent that exposes no permission-bypass surface has no path and must
    // keep reporting "not enabled" without inventing a config key.
    if (!path) {
      expect(getExecutionPermissionState(draft.config, capability)).toEqual({ enabled: false, error: null })
      expect(updateExecutionPermission(draft, capability, true).config).toEqual({ unknown: { keep: true } })
      return
    }

    expect(getExecutionPermissionState(draft.config, capability)).toEqual({ enabled: false, error: null })

    const enabled = updateExecutionPermission(draft, capability, true)
    expect(enabled.config).toEqual({ unknown: { keep: true }, [path]: true })
    expect(getExecutionPermissionState(enabled.config, capability)).toEqual({ enabled: true, error: null })
    expect(draft.config).toEqual({ unknown: { keep: true } })

    const disabled = updateExecutionPermission(enabled, capability, false)
    expect(disabled.config[path]).toBe(false)
  })

  it('reports a non-boolean permission without applying truthy coercion', () => {
    const capability = PROVIDER_CAPABILITIES[AgentType.CODEX]
    expect(getExecutionPermissionState({
      dangerouslyBypassApprovalsAndSandbox: 'true',
    }, capability)).toEqual({
      enabled: false,
      error: 'dangerouslyBypassApprovalsAndSandbox must be true or false',
    })
  })

  it('reads and immutably updates the Codex WebSocket control without coercion', () => {
    const capability = PROVIDER_CAPABILITIES[AgentType.CODEX].disableResponsesWebsocket!
    const draft = { config: { unknown: { keep: true } } }

    expect(getProviderBooleanConfigState(draft.config, capability))
      .toEqual({ enabled: false, error: null })
    const enabled = updateProviderBooleanConfig(draft, capability, true)
    expect(enabled.config).toEqual({ unknown: { keep: true }, disableResponsesWebsocket: true })
    expect(getProviderBooleanConfigState(enabled.config, capability))
      .toEqual({ enabled: true, error: null })
    expect(draft.config).toEqual({ unknown: { keep: true } })

    expect(getProviderBooleanConfigState({ disableResponsesWebsocket: 'true' }, capability))
      .toEqual({
        enabled: false,
        error: 'disableResponsesWebsocket must be true or false',
      })
  })

  it('reads and immutably updates Codex Fast mode without coercion', () => {
    const capability = PROVIDER_CAPABILITIES[AgentType.CODEX].fastMode!
    const draft = { config: { unknown: { keep: true } } }

    expect(getProviderBooleanConfigState(draft.config, capability))
      .toEqual({ enabled: false, error: null })
    const enabled = updateProviderBooleanConfig(draft, capability, true)
    expect(enabled.config).toEqual({ unknown: { keep: true }, fastMode: true })
    expect(getProviderBooleanConfigState(enabled.config, capability))
      .toEqual({ enabled: true, error: null })
    expect(draft.config).toEqual({ unknown: { keep: true } })
    expect(updateProviderBooleanConfig(enabled, capability, undefined).config)
      .toEqual({ unknown: { keep: true } })

    expect(getProviderBooleanConfigState({ fastMode: 'true' }, capability))
      .toEqual({ enabled: false, error: 'fastMode must be true or false' })
  })

  it('writes simplified Codex fields into Advanced sources without losing unknown values', () => {
    const settings = [
      '# keep leading',
      'openai_base_url = "https://old.example/v1" # keep URL note',
      'model = "toml-model" # keep model note',
      '  model_reasoning_effort = "medium" # keep inline',
      '',
      '[profile.team]',
      'model_reasoning_effort = "low" # table value is unrelated',
      'unknown = "keep"',
      '',
      '[[hooks]]',
      'model_reasoning_effort = "minimal" # array value is unrelated',
    ].join('\n')
    const capability = PROVIDER_CAPABILITIES[AgentType.CODEX]
    const initial = {
      agentType: AgentType.CODEX,
      config: { model: 'old-model', unknownConfig: { keep: true } },
      simplified: {
        apiBaseUrl: 'https://old.example/v1',
        model: 'old-model',
        reasoningEffort: 'medium',
      },
      settings,
    }
    const withUrl = updateSimplifiedDraftValue(
      initial,
      'apiBaseUrl',
      'https://new.example/v1',
      capability,
    )
    const withModel = updateSimplifiedDraftValue(
      withUrl,
      'model',
      'gpt-new',
      capability,
    )
    const updated = updateSimplifiedDraftValue(
      withModel,
      'reasoningEffort',
      'high',
      capability,
    )

    expect(updated.simplified.apiBaseUrl).toBe('https://new.example/v1')
    expect(updated.simplified.model).toBe('gpt-new')
    expect(updated.simplified.reasoningEffort).toBe('high')
    expect(updated.config).toEqual({
      model: 'gpt-new',
      unknownConfig: { keep: true },
    })
    expect(updated.settings).toContain('# keep leading')
    expect(updated.settings).toContain('openai_base_url = "https://new.example/v1" # keep URL note')
    expect(updated.settings).toContain('# keep model note')
    expect(updated.settings).not.toContain('model = "toml-model"')
    expect(updated.settings).toContain('model_reasoning_effort = "high" # keep inline')
    expect(updated.settings).toContain(
      '[profile.team]\nmodel_reasoning_effort = "low" # table value is unrelated\nunknown = "keep"',
    )
    expect(updated.settings).toContain(
      '[[hooks]]\nmodel_reasoning_effort = "minimal" # array value is unrelated',
    )
  })

  it('preserves multiline TOML contents while updating the top-level reasoning effort', () => {
    const settings = [
      'developer_instructions = """',
      'model_reasoning_effort = "keep-inside-basic-string"',
      '[profile.fake_basic_table]',
      '"""',
      "review_instructions = '''",
      'model_reasoning_effort = "keep-inside-literal-string"',
      '[profile.fake_literal_table]',
      "'''",
      'model_reasoning_effort = "medium" # keep target note',
      'unknown = "keep"',
      '',
      '[profile.real]',
      'model_reasoning_effort = "low" # real table value is unrelated',
    ].join('\n')

    const updated = updateSimplifiedDraftValue(
      {
        agentType: AgentType.CODEX,
        config: { model: 'gpt-test', unknownConfig: { keep: true } },
        simplified: { model: 'gpt-test', reasoningEffort: 'medium' },
        settings,
      },
      'reasoningEffort',
      'high',
      PROVIDER_CAPABILITIES[AgentType.CODEX],
    )

    expect(updated.settings).toBe(settings.replace(
      'model_reasoning_effort = "medium" # keep target note',
      'model_reasoning_effort = "high" # keep target note',
    ))
    expect(updated.config).toEqual({ model: 'gpt-test', unknownConfig: { keep: true } })
  })

  it.each([
    {
      label: 'folded multiline basic string',
      target: [
        'model_reasoning_effort = """\\',
        'medium\\',
        '"""   # keep closing note',
      ].join('\n'),
    },
    {
      label: 'multiline literal string',
      target: [
        "model_reasoning_effort = '''",
        "medium'''   # keep closing note",
      ].join('\n'),
    },
  ])('preserves the closing-line suffix of a $label target', ({ target }) => {
    const settings = [
      '# keep leading',
      target,
      'unknown = "keep"',
      '',
      '[profile.real]',
      'model_reasoning_effort = "low" # keep table value',
    ].join('\n')

    expect(syncSimplifiedFromSettings({}, settings, AgentType.CODEX).reasoningEffort).toBe('medium')

    const updated = updateSimplifiedDraftValue(
      {
        agentType: AgentType.CODEX,
        config: { model: 'gpt-test', unknownConfig: { keep: true } },
        simplified: { model: 'gpt-test', reasoningEffort: 'medium' },
        settings,
      },
      'reasoningEffort',
      'high',
      PROVIDER_CAPABILITIES[AgentType.CODEX],
    )

    expect(updated.settings).toBe(settings.replace(
      target,
      'model_reasoning_effort = "high"   # keep closing note',
    ))
    expect(updated.config).toEqual({ model: 'gpt-test', unknownConfig: { keep: true } })
  })

  it.each([
    {
      label: 'multiline basic string with four closing quotes',
      opening: '"""',
      closing: '""""',
      originalValue: 'medium"',
    },
    {
      label: 'multiline basic string with five closing quotes',
      opening: '"""',
      closing: '"""""',
      originalValue: 'medium""',
    },
    {
      label: 'multiline literal string with four closing quotes',
      opening: "'''",
      closing: "''''",
      originalValue: "medium'",
    },
    {
      label: 'multiline literal string with five closing quotes',
      opening: "'''",
      closing: "'''''",
      originalValue: "medium''",
    },
  ])('uses the final delimiter in a $label', ({ opening, closing, originalValue }) => {
    const target = [
      `model_reasoning_effort = ${opening}`,
      `medium${closing}   # keep closing note`,
    ].join('\n')
    const settings = [
      '# keep leading',
      target,
      'unknown = "keep"',
      '',
      '[profile.real]',
      'model_reasoning_effort = "low" # keep table value',
    ].join('\n')

    expect(parseToml(settings)).toMatchObject({
      model_reasoning_effort: originalValue,
      unknown: 'keep',
      profile: { real: { model_reasoning_effort: 'low' } },
    })

    const updated = updateSimplifiedDraftValue(
      {
        agentType: AgentType.CODEX,
        config: { model: 'gpt-test', unknownConfig: { keep: true } },
        simplified: { model: 'gpt-test', reasoningEffort: originalValue },
        settings,
      },
      'reasoningEffort',
      'high',
      PROVIDER_CAPABILITIES[AgentType.CODEX],
    )

    expect(updated.settings).toBe(settings.replace(
      target,
      'model_reasoning_effort = "high"   # keep closing note',
    ))
    expect(parseToml(updated.settings!)).toMatchObject({
      model_reasoning_effort: 'high',
      unknown: 'keep',
      profile: { real: { model_reasoning_effort: 'low' } },
    })
    expect(updated.config).toEqual({ model: 'gpt-test', unknownConfig: { keep: true } })
  })

  it('updates only the active custom Codex API URL in Advanced TOML', () => {
    const settings = [
      '# keep leading',
      'model_provider = "proxy"',
      '[model_providers.proxy]',
      'base_url = "https://old-proxy.example/v1" # keep proxy note',
      'env_key = "PROXY_TOKEN"',
      'query_params = { api-version = "v1" }',
      '',
      '[model_providers.other]',
      'base_url = "https://other.example/v1"',
    ].join('\n')

    const updated = updateSimplifiedDraftValue(
      {
        agentType: AgentType.CODEX,
        config: { unknownConfig: true },
        simplified: { apiBaseUrl: 'https://old-proxy.example/v1' },
        settings,
      },
      'apiBaseUrl',
      'https://new-proxy.example/v1',
      PROVIDER_CAPABILITIES[AgentType.CODEX],
    )

    expect(updated.settings).toContain('base_url = "https://new-proxy.example/v1" # keep proxy note')
    expect(updated.settings).toContain('query_params = { api-version = "v1" }')
    expect(updated.settings).toContain('[model_providers.other]\nbase_url = "https://other.example/v1"')
    expect(updated.config).toEqual({ unknownConfig: true })
  })

  it.each([
    'https://proxy.example/v1',
    'http://localhost:8080',
    '  https://proxy.example/v1  ',
  ])('accepts a complete HTTP API URL: %s', value => {
    expect(getApiBaseUrlValidationError(value)).toBeNull()
  })

  it.each([
    'proxy.example/v1',
    'ftp://proxy.example',
    'http:host',
    'https:/host',
    'https:host',
    'https://',
  ])('rejects an incomplete HTTP API URL: %s', value => {
    expect(getApiBaseUrlValidationError(value)).toContain('http:// or https://')
  })

  it('allows an empty optional API URL', () => {
    expect(getApiBaseUrlValidationError('')).toBeNull()
  })

  it('immediately reflects the advanced source after resolving a conflict', () => {
    const capability = PROVIDER_CAPABILITIES[AgentType.CLAUDE_CODE]
    const draft = {
      agentType: AgentType.CLAUDE_CODE,
      config: { model: 'claude-test' },
      settings: JSON.stringify({
        env: {
          ANTHROPIC_BASE_URL: 'https://advanced.example',
          ANTHROPIC_API_KEY: '__AGENT_TOWER_REDACTED__',
        },
      }),
      env: [
        { key: 'ANTHROPIC_BASE_URL', value: 'https://simple.example', write: { action: 'keep' as const }, configured: true, sensitive: false },
        { key: 'ANTHROPIC_API_KEY', value: '', write: { action: 'keep' as const }, configured: true, sensitive: true },
      ],
      simplified: {
        apiBaseUrl: 'https://simple.example',
        apiKey: { configured: true, envKey: 'ANTHROPIC_API_KEY' },
      },
    }

    const urlResolved = resolveProviderDraftConflict(draft, 'apiBaseUrl', 'advanced', capability)
    expect(urlResolved.simplified.apiBaseUrl).toBe('https://advanced.example')
    expect(urlResolved.env[0]).toMatchObject({ value: '', write: { action: 'clear' } })

    const keyResolved = resolveProviderDraftConflict(draft, 'apiKey', 'advanced', capability)
    expect(keyResolved.simplified.apiKey).toEqual({ configured: true, envKey: 'ANTHROPIC_API_KEY' })
    expect(keyResolved.env[1]).toMatchObject({ value: '', write: { action: 'clear' } })
    expect(getApiKeyDraftStatus(
      keyResolved.env[1],
      keyResolved.simplified.apiKey.configured,
      'advanced',
    )).toBe('advanced')
  })

  it('immediately reflects advanced Codex model settings after resolving conflicts', () => {
    const capability = PROVIDER_CAPABILITIES[AgentType.CODEX]
    const draft = {
      agentType: AgentType.CODEX,
      config: { model: 'config-model', unknown: true },
      settings: [
        'model = "settings-model"',
        'model_reasoning_effort = "high"',
      ].join('\n'),
      env: [],
      simplified: {
        model: 'config-model',
        reasoningEffort: 'medium',
      },
    }

    const modelResolved = resolveProviderDraftConflict(draft, 'model', 'advanced', capability)
    expect(modelResolved.simplified.model).toBe('settings-model')
    expect(modelResolved.config).toEqual({ unknown: true })

    const effortResolved = resolveProviderDraftConflict(draft, 'reasoningEffort', 'advanced', capability)
    expect(effortResolved.simplified.reasoningEffort).toBe('high')
    expect(effortResolved.settings).toBe(draft.settings)
  })

  it('creates a write-only Gemini key row from redacted metadata', () => {
    const provider: RedactedProvider = {
      id: 'gemini-1',
      name: 'Gemini',
      agentType: AgentType.GEMINI_CLI,
      env: {},
      redactedEnv: { GEMINI_API_KEY: { configured: true, sensitive: true } },
      config: { model: 'gemini-test' },
      simplified: {
        apiKey: { configured: true, envKey: 'GEMINI_API_KEY' },
        model: 'gemini-test',
      },
      isDefault: false,
    }

    expect(createProviderEnvDraftRows(provider, PROVIDER_CAPABILITIES[AgentType.GEMINI_CLI]))
      .toMatchObject([{ key: 'GEMINI_API_KEY', value: '', write: { action: 'keep' }, configured: true }])
  })
})
