import { AgentType, RuntimeType } from '@agent-tower/shared';
import { describe, expect, it, vi } from 'vitest';
import { ExecutionEnv } from '../../executors/execution-env.js';
import { getDefaultProviders } from '../../executors/providers.js';
import { AcpRuntimeDriver } from '../acp/acp-driver.js';
import { projectCodexAcpProvider } from '../acp/codex-provider-config.js';

describe('AcpRuntimeDriver', () => {
  it('projects the Codex ACP context window default into custom settings that omit it', () => {
    const builtInProvider = getDefaultProviders().find(provider => provider.id === 'codex-acp-default');
    expect(builtInProvider).toBeDefined();

    const projection = projectCodexAcpProvider({
      ...builtInProvider!,
      settings: 'model_reasoning_effort = "high"\n',
    }, {});
    expect(JSON.parse(projection.environment.CODEX_CONFIG!)).toMatchObject({
      model_context_window: 800000,
      model_reasoning_effort: 'high',
    });
  });

  it.each([0, 123456])('preserves an explicit Codex ACP context window of %i', (modelContextWindow) => {
    const builtInProvider = getDefaultProviders().find(provider => provider.id === 'codex-acp-default');
    expect(builtInProvider).toBeDefined();

    const overriddenProjection = projectCodexAcpProvider({
      ...builtInProvider!,
      settings: `model_context_window = ${modelContextWindow}\n`,
    }, {});
    expect(JSON.parse(overriddenProjection.environment.CODEX_CONFIG!)).toMatchObject({
      model_context_window: modelContextWindow,
    });
  });

  it('projects Provider credentials, model, TOML, and ACP controls into the adapter contract', () => {
    const projection = projectCodexAcpProvider({
      id: 'codex-acp-custom',
      name: 'Codex ACP Custom',
      agentType: AgentType.CODEX,
      runtimeType: RuntimeType.ACP,
      env: { PROXY_ACCESS: 'provider-secret' },
      config: {
        model: 'gpt-custom',
        fastMode: true,
        disableResponsesWebsocket: true,
        permissionMode: 'AUTO_APPROVE',
        appendPrompt: '\nFollow repository instructions.',
      },
      settings: [
        'model_provider = "proxy"',
        'model_reasoning_effort = "high"',
        '[model_providers.proxy]',
        'base_url = "https://proxy.example/v1"',
        'env_key = "PROXY_ACCESS"',
        'wire_api = "responses"',
      ].join('\n'),
      isDefault: false,
    }, {
      OPENAI_BASE_URL: 'https://stale.example/v1',
      CODEX_API_KEY: 'stale-key',
      PROXY_ACCESS: 'stale-proxy-key',
      DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: 'api-key', apiKey: 'stale-auth-secret' }),
    });

    expect(projection.permissionMode).toBe('UNRESTRICTED');
    expect(projection.fastMode).toBe(true);
    expect(projection.appendPrompt).toBe('\nFollow repository instructions.');
    expect(projection.environment.OPENAI_BASE_URL).toBeUndefined();
    expect(projection.environment.CODEX_API_KEY).toBeUndefined();
    expect(projection.environment.DEFAULT_AUTH_REQUEST).toBeUndefined();
    expect(projection.environment.PROXY_ACCESS).toBe('provider-secret');
    expect(projection.environment.MODEL_PROVIDER).toBe('proxy');
    expect(projection.authenticationRequest).toBeUndefined();
    expect(JSON.parse(projection.environment.CODEX_CONFIG!)).toMatchObject({
      model: 'gpt-custom',
      model_provider: 'proxy',
      model_reasoning_effort: 'high',
      model_providers: {
        proxy: {
          base_url: 'https://proxy.example/v1',
          env_key: 'PROXY_ACCESS',
          http_headers: { originator: 'codex_exec' },
          wire_api: 'responses',
          supports_websockets: false,
        },
      },
    });
  });

  it('projects a simple third-party OpenAI-compatible URL through a dedicated env_key', () => {
    const projection = projectCodexAcpProvider({
      id: 'codex-acp-gateway',
      name: 'Codex ACP Gateway',
      agentType: AgentType.CODEX,
      runtimeType: RuntimeType.ACP,
      env: { OPENAI_API_KEY: 'provider-secret' },
      config: { model: 'gpt-gateway' },
      settings: [
        'openai_base_url = "https://gateway.example/v1"',
        '[model_providers.agent-tower-openai-compatible]',
        'http_headers = { "x-existing" = "keep", originator = "stale" }',
      ].join('\n'),
      isDefault: false,
    }, {
      OPENAI_API_KEY: 'stale-openai-key',
      CODEX_API_KEY: 'stale-codex-key',
      OPENAI_BASE_URL: 'https://stale.example/v1',
    });

    expect(projection.environment.OPENAI_API_KEY).toBeUndefined();
    expect(projection.environment.CODEX_API_KEY).toBeUndefined();
    expect(projection.environment.OPENAI_BASE_URL).toBeUndefined();
    expect(projection.environment.AGENT_TOWER_CODEX_PROVIDER_KEY).toBe('provider-secret');
    expect(projection.authenticationRequest).toEqual({
      methodId: 'gateway',
      _meta: {
        gateway: {
          baseUrl: 'https://gateway.example/v1',
          providerName: 'Codex ACP Gateway',
          headers: {
            Authorization: 'Bearer provider-secret',
            'x-existing': 'keep',
            originator: 'stale',
          },
        },
      },
    });
    expect(JSON.parse(projection.environment.CODEX_CONFIG!)).toMatchObject({
      model: 'gpt-gateway',
      model_provider: 'agent-tower-openai-compatible',
      model_providers: {
        'agent-tower-openai-compatible': {
          name: 'Agent Tower OpenAI Compatible',
          base_url: 'https://gateway.example/v1',
          env_key: 'AGENT_TOWER_CODEX_PROVIDER_KEY',
          http_headers: { 'x-existing': 'keep', originator: 'stale' },
          wire_api: 'responses',
        },
      },
    });
  });

  it('projects an official OpenAI key into explicit Codex ACP authentication', () => {
    const projection = projectCodexAcpProvider({
      id: 'codex-acp-openai',
      name: 'Codex ACP OpenAI',
      agentType: AgentType.CODEX,
      runtimeType: RuntimeType.ACP,
      env: { OPENAI_API_KEY: 'official-provider-secret' },
      config: {},
      isDefault: false,
    }, {
      CODEX_API_KEY: 'stale-codex-key',
      DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: 'gateway' }),
    });

    expect(projection.environment.CODEX_API_KEY).toBe('official-provider-secret');
    expect(projection.environment.DEFAULT_AUTH_REQUEST).toBeUndefined();
    expect(projection.authenticationRequest).toEqual({ methodId: 'api-key' });
  });

  it('rejects agent identities that do not advertise ACP support', async () => {
    const driver = new AcpRuntimeDriver();

    await expect(driver.open({
      towerSessionId: 'tower-1',
      agentType: 'UNKNOWN_AGENT' as AgentType,
      runtimeType: RuntimeType.ACP,
      variant: 'DEFAULT',
      workingDir: process.cwd(),
      env: ExecutionEnv.default(process.cwd()),
    }, {
      stream: vi.fn(),
      process: vi.fn(async () => undefined),
    })).rejects.toMatchObject({ code: 'runtime_not_supported', stage: 'open' });
  });

  it('rejects a CLI Provider passed to the ACP runtime', async () => {
    const driver = new AcpRuntimeDriver();

    await expect(driver.open({
      towerSessionId: 'tower-provider-runtime-mismatch',
      agentType: AgentType.CODEX,
      runtimeType: RuntimeType.ACP,
      variant: 'DEFAULT',
      providerId: 'codex-default',
      workingDir: process.cwd(),
      env: ExecutionEnv.default(process.cwd()),
    }, {
      stream: vi.fn(),
      process: vi.fn(async () => undefined),
    })).rejects.toMatchObject({ code: 'provider_config_invalid', stage: 'provider_config' });
  });
});
