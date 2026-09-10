import * as acp from '@agentclientprotocol/sdk';
import { AgentType, RuntimeType } from '@agent-tower/shared';
import { describe, expect, it, vi } from 'vitest';
import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { ExecutionEnv } from '../../executors/execution-env.js';
import { resolveBundledCodexEntrypoint } from '../acp/agents/executable-resolution.js';
import { getAcpAgentDefinition } from '../acp/agents/registry.js';

function provider(
  agentType: AgentType,
  input: Partial<{
    env: Record<string, string>;
    config: Record<string, unknown>;
    settings: string;
  }> = {},
) {
  return {
    id: `${agentType.toLowerCase()}-acp`,
    name: `${agentType} ACP`,
    agentType,
    runtimeType: RuntimeType.ACP,
    env: input.env ?? {},
    config: input.config ?? {},
    settings: input.settings,
    isDefault: false,
  };
}

describe('ACP Agent definitions', () => {
  it('registers every advertised ACP agent identity', () => {
    for (const agentType of [
      AgentType.CLAUDE_CODE,
      AgentType.GEMINI_CLI,
      AgentType.CURSOR_AGENT,
      AgentType.CODEX,
      AgentType.QWEN_CODE,
      AgentType.KIRO_CLI,
      AgentType.OPENCODE,
      AgentType.PI_CODING_AGENT,
      AgentType.GROK_BUILD,
      AgentType.MINION_CODE,
      AgentType.DEEPSEEK_HERMES,
    ]) {
      expect(getAcpAgentDefinition(agentType).agentType).toBe(agentType);
    }
  });

  it('projects Claude settings, credentials, model, effort and permission mode', () => {
    const definition = getAcpAgentDefinition(AgentType.CLAUDE_CODE);
    const profile = definition.projectProvider(provider(AgentType.CLAUDE_CODE, {
      env: { ANTHROPIC_API_KEY: 'provider-key' },
      config: {
        model: 'claude-sonnet-4-5',
        effort: 'high',
        permissionMode: 'AUTO_APPROVE',
        appendPrompt: '\nUse the repository conventions.',
      },
      settings: JSON.stringify({
        env: { ANTHROPIC_BASE_URL: 'https://gateway.example' },
        permissions: { defaultMode: 'acceptEdits' },
      }),
    }), {
      ANTHROPIC_API_KEY: 'stale-key',
      ANTHROPIC_BASE_URL: 'https://stale.example',
    });

    expect(profile).toMatchObject({
      agentType: AgentType.CLAUDE_CODE,
      model: 'claude-sonnet-4-5',
      effort: 'high',
      permissionMode: 'UNRESTRICTED',
      appendPrompt: '\nUse the repository conventions.',
    });
    expect(profile.environment).toMatchObject({
      ANTHROPIC_API_KEY: 'provider-key',
      ANTHROPIC_BASE_URL: 'https://gateway.example',
      ANTHROPIC_MODEL: 'claude-sonnet-4-5',
    });
    expect(definition.sessionMetadata?.(profile)).toMatchObject({
      _meta: {
        claudeCode: {
          options: {
            settings: {
              model: 'claude-sonnet-4-5',
              effortLevel: 'high',
              permissions: { defaultMode: 'acceptEdits' },
              sandbox: { enabled: false },
            },
          },
        },
      },
    });
  });

  it('configures Claude model, effort and bypass permission mode when advertised', async () => {
    const definition = getAcpAgentDefinition(AgentType.CLAUDE_CODE);
    const profile = definition.projectProvider(provider(AgentType.CLAUDE_CODE, {
      config: { model: 'claude-opus-4-1', effort: 'max', permissionMode: 'AUTO_APPROVE' },
    }), {});
    const request = vi.fn()
      .mockResolvedValueOnce({ configOptions: [{ id: 'model' }, { id: 'effort' }] })
      .mockResolvedValue({});

    await definition.configureSession?.({ request } as unknown as acp.ClientContext, 'session-1', {
      configOptions: [{ id: 'model' }, { id: 'effort' }] as never,
      modes: {
        currentModeId: 'default',
        availableModes: [{ id: 'default' }, { id: 'bypassPermissions' }],
      } as never,
    }, profile);

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.map(call => call[1])).toEqual([
      { sessionId: 'session-1', configId: 'model', value: 'claude-opus-4-1' },
      { sessionId: 'session-1', configId: 'effort', value: 'max' },
      { sessionId: 'session-1', modeId: 'bypassPermissions' },
    ]);
  });

  it('fails Claude unrestricted startup when bypassPermissions is unavailable', async () => {
    const definition = getAcpAgentDefinition(AgentType.CLAUDE_CODE);
    const profile = definition.projectProvider(provider(AgentType.CLAUDE_CODE, {
      config: { permissionMode: 'UNRESTRICTED' },
    }), {});

    await expect(definition.configureSession?.({ request: vi.fn() } as unknown as acp.ClientContext, 'session-1', {
      modes: {
        currentModeId: 'default',
        availableModes: [{ id: 'default' }],
      } as never,
    }, profile)).rejects.toMatchObject({
      code: 'permission_mode_unsupported',
      stage: 'session',
    });
  });

  it('uses the bundled Claude runtime without a global claude command', async () => {
    const definition = getAcpAgentDefinition(AgentType.CLAUDE_CODE);
    const claudeProvider = provider(AgentType.CLAUDE_CODE, {
      env: {
        HOME: '/agent-tower-missing/home',
        PATH: '/agent-tower-missing/bin',
        CLAUDE_PATH: '/agent-tower-missing/bin/claude',
        CLAUDE_CODE_EXECUTABLE: '/agent-tower-missing/bin/claude-fallback',
      },
    });
    const profile = definition.projectProvider(claudeProvider, {});
    const launch = await definition.resolveLaunch({
      towerSessionId: 'tower-bundled-claude',
      agentType: AgentType.CLAUDE_CODE,
      runtimeType: RuntimeType.ACP,
      variant: 'DEFAULT',
      workingDir: process.cwd(),
      env: ExecutionEnv.default(process.cwd()),
    }, profile);

    expect(launch.env.CLAUDE_CODE_EXECUTABLE).toMatch(/claude-agent-sdk[^/\\]*[\\/]claude(?:\.exe)?$/);
    expect(await definition.checkAvailability(claudeProvider)).toEqual({ type: 'INSTALLATION_FOUND' });
  });

  it('uses the Codex runtime bundled by codex-acp without a global codex command', async () => {
    const definition = getAcpAgentDefinition(AgentType.CODEX);
    const codexProvider = provider(AgentType.CODEX, {
      env: {
        HOME: '/agent-tower-missing/home',
        PATH: '/agent-tower-missing/bin',
        CODEX_PATH: '/agent-tower-missing/bin/codex',
      },
    });
    const profile = definition.projectProvider(codexProvider, {});
    const launch = await definition.resolveLaunch({
      towerSessionId: 'tower-bundled-codex',
      agentType: AgentType.CODEX,
      runtimeType: RuntimeType.ACP,
      variant: 'DEFAULT',
      workingDir: process.cwd(),
      env: ExecutionEnv.default(process.cwd()),
    }, profile);

    expect(resolveBundledCodexEntrypoint()).toMatch(/@openai[\\/]codex[\\/]bin[\\/]codex\.js$/);
    expect(launch.env).not.toHaveProperty('CODEX_PATH');
    expect(launch.env.DISABLE_MCP_CONFIG_FILTERING).toBe('true');
    expect(await definition.checkAvailability(codexProvider)).toEqual({ type: 'INSTALLATION_FOUND' });
  });

  it('advertises and invokes the Codex gateway authentication method', async () => {
    const definition = getAcpAgentDefinition(AgentType.CODEX);
    const profile = definition.projectProvider(provider(AgentType.CODEX, {
      env: { OPENAI_API_KEY: 'gateway-provider-secret' },
      settings: 'openai_base_url = "https://gateway.example/v1"',
    }), {});
    const request = vi.fn().mockResolvedValue({});

    expect(definition.clientCapabilities?.(profile)).toEqual({
      auth: { _meta: { gateway: true } },
    });
    await definition.authenticate?.(
      { request } as unknown as acp.ClientContext,
      {
        protocolVersion: acp.PROTOCOL_VERSION,
        authMethods: [{ id: 'gateway', name: 'Custom model gateway' }],
      },
      profile,
    );

    expect(request).toHaveBeenCalledWith(acp.methods.agent.authenticate, profile.authenticationRequest);
  });

  it('invokes Codex API key authentication only when explicitly configured', async () => {
    const definition = getAcpAgentDefinition(AgentType.CODEX);
    const authenticatedProfile = definition.projectProvider(provider(AgentType.CODEX, {
      env: { OPENAI_API_KEY: 'official-provider-secret' },
    }), {});
    const request = vi.fn().mockResolvedValue({});

    expect(definition.clientCapabilities?.(authenticatedProfile)).toEqual({});
    await definition.authenticate?.(
      { request } as unknown as acp.ClientContext,
      {
        protocolVersion: acp.PROTOCOL_VERSION,
        authMethods: [{ id: 'api-key', name: 'API Key' }],
      },
      authenticatedProfile,
    );

    expect(request).toHaveBeenCalledWith(acp.methods.agent.authenticate, { methodId: 'api-key' });

    request.mockClear();
    const globalLoginProfile = definition.projectProvider(provider(AgentType.CODEX), {});
    await definition.authenticate?.(
      { request } as unknown as acp.ClientContext,
      {
        protocolVersion: acp.PROTOCOL_VERSION,
        authMethods: [{ id: 'api-key', name: 'API Key' }],
      },
      globalLoginProfile,
    );

    expect(request).not.toHaveBeenCalled();
  });

  it('rejects an unadvertised Codex authentication method without exposing its secret', async () => {
    const definition = getAcpAgentDefinition(AgentType.CODEX);
    const secret = 'gateway-provider-secret-sentinel';
    const profile = definition.projectProvider(provider(AgentType.CODEX, {
      env: { OPENAI_API_KEY: secret },
      settings: 'openai_base_url = "https://gateway.example/v1"',
    }), {});
    const request = vi.fn();

    let failure: unknown;
    try {
      await definition.authenticate?.(
        { request } as unknown as acp.ClientContext,
        { protocolVersion: acp.PROTOCOL_VERSION, authMethods: [] },
        profile,
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: 'authentication_method_unsupported',
      stage: 'authenticate',
    });
    expect(String(failure)).not.toContain(secret);
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps authentication hooks scoped to the Codex ACP definition', () => {
    for (const agentType of [
      AgentType.CLAUDE_CODE,
      AgentType.GEMINI_CLI,
      AgentType.CURSOR_AGENT,
      AgentType.QWEN_CODE,
      AgentType.KIRO_CLI,
      AgentType.OPENCODE,
      AgentType.PI_CODING_AGENT,
      AgentType.GROK_BUILD,
      AgentType.MINION_CODE,
    ]) {
      const definition = getAcpAgentDefinition(agentType);
      expect(definition.clientCapabilities).toBeUndefined();
      expect(definition.authenticate).toBeUndefined();
    }
  });

  it.each([
    ['boolean', true, false, true],
    ['select', false, 'on', 'off'],
  ] as const)('configures Codex Fast mode through the advertised %s ACP option', async (
    type,
    configured,
    currentValue,
    expectedValue,
  ) => {
    const definition = getAcpAgentDefinition(AgentType.CODEX);
    const profile = definition.projectProvider(provider(AgentType.CODEX, {
      config: { fastMode: configured },
    }), {});
    const request = vi.fn().mockResolvedValue({ configOptions: [] });

    await definition.configureSession?.({ request } as unknown as acp.ClientContext, 'codex-session-1', {
      configOptions: [{
        id: 'fast-mode',
        name: 'Fast mode',
        type,
        currentValue,
        ...(type === 'select' ? { options: [{ value: 'off', name: 'Off' }, { value: 'on', name: 'On' }] } : {}),
      }] as never,
    }, profile);

    expect(request).toHaveBeenCalledWith(acp.methods.agent.session.setConfigOption, {
      sessionId: 'codex-session-1',
      configId: 'fast-mode',
      value: expectedValue,
    });
  });

  it('leaves Codex ACP speed unchanged when the Provider does not configure it', async () => {
    const definition = getAcpAgentDefinition(AgentType.CODEX);
    const profile = definition.projectProvider(provider(AgentType.CODEX), {});
    const request = vi.fn();

    await definition.configureSession?.({ request } as unknown as acp.ClientContext, 'codex-session-2', {
      configOptions: [{ id: 'fast-mode', type: 'boolean', currentValue: false }] as never,
    }, profile);

    expect(request).not.toHaveBeenCalled();
  });

  it('switches Codex unrestricted Providers to agent-full-access without requiring Fast mode', async () => {
    const definition = getAcpAgentDefinition(AgentType.CODEX);
    const profile = definition.projectProvider(provider(AgentType.CODEX, {
      config: { permissionMode: 'UNRESTRICTED' },
    }), {});
    const request = vi.fn().mockResolvedValue({});

    await definition.configureSession?.({ request } as unknown as acp.ClientContext, 'codex-unrestricted', {
      modes: {
        currentModeId: 'agent',
        availableModes: [{ id: 'agent' }, { id: 'agent-full-access' }],
      } as never,
    }, profile);

    expect(request).toHaveBeenCalledWith(acp.methods.agent.session.setMode, {
      sessionId: 'codex-unrestricted',
      modeId: 'agent-full-access',
    });
  });

  it('fails Codex unrestricted startup when full access is unavailable', async () => {
    const definition = getAcpAgentDefinition(AgentType.CODEX);
    const profile = definition.projectProvider(provider(AgentType.CODEX, {
      config: { permissionMode: 'UNRESTRICTED' },
    }), {});

    await expect(definition.configureSession?.({ request: vi.fn() } as unknown as acp.ClientContext, 'codex-limited', {
      modes: {
        currentModeId: 'agent',
        availableModes: [{ id: 'agent' }],
      } as never,
    }, profile)).rejects.toMatchObject({ code: 'permission_mode_unsupported' });
  });

  it('does not configure Codex Fast mode when the current model does not advertise it', async () => {
    const definition = getAcpAgentDefinition(AgentType.CODEX);
    const profile = definition.projectProvider(provider(AgentType.CODEX, {
      config: { fastMode: true },
    }), {});
    const request = vi.fn();

    await definition.configureSession?.(
      { request } as unknown as acp.ClientContext,
      'codex-session-3',
      { configOptions: [] },
      profile,
    );

    expect(request).not.toHaveBeenCalled();
  });

  it('projects Qwen OpenAI-compatible credentials without inheriting stale values', () => {
    const definition = getAcpAgentDefinition(AgentType.QWEN_CODE);
    const profile = definition.projectProvider(provider(AgentType.QWEN_CODE, {
      env: {
        OPENAI_API_KEY: 'qwen-provider-key',
        OPENAI_BASE_URL: 'https://dashscope.example/v1',
      },
      config: { model: 'qwen3-coder-plus', permissionMode: 'AUTO_APPROVE' },
    }), {
      OPENAI_API_KEY: 'stale-key',
      OPENAI_BASE_URL: 'https://stale.example/v1',
    });

    expect(profile).toMatchObject({
      agentType: AgentType.QWEN_CODE,
      model: 'qwen3-coder-plus',
      permissionMode: 'UNRESTRICTED',
      environment: {
        OPENAI_API_KEY: 'qwen-provider-key',
        OPENAI_BASE_URL: 'https://dashscope.example/v1',
      },
    });
  });

  it('switches Qwen to yolo mode only when unrestricted access is requested and available', async () => {
    const definition = getAcpAgentDefinition(AgentType.QWEN_CODE);
    const profile = definition.projectProvider(provider(AgentType.QWEN_CODE, {
      config: { permissionMode: 'AUTO_APPROVE' },
    }), {});
    const request = vi.fn().mockResolvedValue({});

    await definition.configureSession?.({ request } as unknown as acp.ClientContext, 'session-2', {
      configOptions: [],
      modes: {
        currentModeId: 'default',
        availableModes: [{ id: 'default' }, { id: 'yolo' }],
      } as never,
    }, profile);

    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[1]).toEqual({ sessionId: 'session-2', modeId: 'yolo' });
  });

  it('fails Qwen unrestricted startup when yolo mode is unavailable', async () => {
    const definition = getAcpAgentDefinition(AgentType.QWEN_CODE);
    const profile = definition.projectProvider(provider(AgentType.QWEN_CODE, {
      config: { permissionMode: 'UNRESTRICTED' },
    }), {});

    await expect(definition.configureSession?.({ request: vi.fn() } as unknown as acp.ClientContext, 'qwen-limited', {
      modes: {
        currentModeId: 'default',
        availableModes: [{ id: 'default' }],
      } as never,
    }, profile)).rejects.toMatchObject({ code: 'permission_mode_unsupported' });
  });

  it('builds native ACP arguments and managed environments per client', async () => {
    const input = {
      towerSessionId: 'tower-native',
      runtimeType: RuntimeType.ACP,
      variant: 'DEFAULT',
      workingDir: process.cwd(),
      env: ExecutionEnv.default(process.cwd()),
    };

    const kiro = getAcpAgentDefinition(AgentType.KIRO_CLI);
    const kiroProfile = kiro.projectProvider(provider(AgentType.KIRO_CLI, {
      env: { KIRO_CLI_PATH: process.execPath },
      config: { model: 'kiro-model', effort: 'high', trustAllTools: true },
    }), {});
    const kiroLaunch = await kiro.resolveLaunch({ ...input, agentType: AgentType.KIRO_CLI }, kiroProfile);
    expect(kiroLaunch.args).toEqual(['acp', '--model', 'kiro-model', '--effort', 'high', '--trust-all-tools']);
    expect(kiroLaunch.env).not.toHaveProperty('DISABLE_MCP_CONFIG_FILTERING');

    const cursor = getAcpAgentDefinition(AgentType.CURSOR_AGENT);
    const cursorProfile = cursor.projectProvider(provider(AgentType.CURSOR_AGENT, {
      env: { CURSOR_AGENT_PATH: process.execPath },
      config: { permissionMode: 'UNRESTRICTED' },
    }), {});
    const cursorLaunch = await cursor.resolveLaunch({ ...input, agentType: AgentType.CURSOR_AGENT }, cursorProfile);
    expect(cursorLaunch.args).toEqual(['--sandbox', 'disabled', '--force', '--approve-mcps', 'acp']);

    const cursorAskProfile = cursor.projectProvider(provider(AgentType.CURSOR_AGENT, {
      env: { CURSOR_AGENT_PATH: process.execPath },
      config: { permissionMode: 'ASK', force: true },
    }), {});
    const cursorAskLaunch = await cursor.resolveLaunch({ ...input, agentType: AgentType.CURSOR_AGENT }, cursorAskProfile);
    expect(cursorAskProfile.permissionMode).toBe('ASK');
    expect(cursorAskLaunch.args).toEqual(['acp']);

    const gemini = getAcpAgentDefinition(AgentType.GEMINI_CLI);
    const geminiProfile = gemini.projectProvider(provider(AgentType.GEMINI_CLI, {
      env: { GEMINI_PATH: process.execPath },
      config: { permissionMode: 'UNRESTRICTED' },
    }), {});
    const geminiLaunch = await gemini.resolveLaunch({ ...input, agentType: AgentType.GEMINI_CLI }, geminiProfile);
    expect(geminiLaunch.args).toEqual(['--experimental-acp', '--no-sandbox', '--approval-mode', 'yolo']);

    const qwen = getAcpAgentDefinition(AgentType.QWEN_CODE);
    const qwenProfile = qwen.projectProvider(provider(AgentType.QWEN_CODE, {
      env: { QWEN_PATH: process.execPath },
      config: { permissionMode: 'UNRESTRICTED' },
    }), {});
    const qwenLaunch = await qwen.resolveLaunch({ ...input, agentType: AgentType.QWEN_CODE }, qwenProfile);
    expect(qwenLaunch.args).toEqual(['--acp', '--experimental-skills', '--no-sandbox']);

    const openCode = getAcpAgentDefinition(AgentType.OPENCODE);
    const openCodeProfile = openCode.projectProvider(provider(AgentType.OPENCODE, {
      env: {
        OPENCODE_PATH: process.execPath,
        OPENAI_API_KEY: 'open-code-key',
        OPENAI_BASE_URL: 'https://gateway.example/v1',
      },
      config: { model: 'open-code-model' },
    }), {});
    const openCodeLaunch = await openCode.resolveLaunch({ ...input, agentType: AgentType.OPENCODE }, openCodeProfile);
    expect(openCodeLaunch.args).toEqual(['acp']);
    expect(JSON.parse(openCodeLaunch.env.OPENCODE_CONFIG_CONTENT!)).toMatchObject({
      model: 'agent-tower/open-code-model',
      provider: {
        'agent-tower': {
          options: { apiKey: 'open-code-key', baseURL: 'https://gateway.example/v1' },
          models: { 'open-code-model': { name: 'open-code-model' } },
        },
      },
    });

    const grok = getAcpAgentDefinition(AgentType.GROK_BUILD);
    const grokProfile = grok.projectProvider(provider(AgentType.GROK_BUILD, {
      env: {
        GROK_PATH: process.execPath,
        OPENAI_API_KEY: 'grok-key',
        OPENAI_BASE_URL: 'https://xai.example/v1',
      },
      config: { model: 'grok-model', alwaysApprove: true },
    }), {});
    const grokLaunch = await grok.resolveLaunch({ ...input, agentType: AgentType.GROK_BUILD }, grokProfile);
    expect(grokLaunch.args).toEqual([
      'agent', '--model', 'grok-model', '--always-approve',
      '--xai-api-base-url', 'https://xai.example/v1', 'stdio',
    ]);
    expect(grokLaunch.env.XAI_API_KEY).toBe('grok-key');
  });

  it('reports Grok Build as unavailable when no executable can be resolved', async () => {
    const definition = getAcpAgentDefinition(AgentType.GROK_BUILD);
    const availability = await definition.checkAvailability(provider(AgentType.GROK_BUILD, {
      env: {
        GROK_PATH: '/agent-tower-missing/grok',
        HOME: '/agent-tower-missing/home',
        PATH: '/agent-tower-missing/bin',
      },
    }));

    expect(availability).toEqual({
      type: 'NOT_FOUND',
      error: 'Grok Build CLI was not found',
    });
  });

  it('configures the model through native ACP config options', async () => {
    const definition = getAcpAgentDefinition(AgentType.CURSOR_AGENT);
    const profile = definition.projectProvider(provider(AgentType.CURSOR_AGENT, {
      config: { model: 'cursor-model' },
    }), {});
    const request = vi.fn().mockResolvedValue({ configOptions: [] });
    await definition.configureSession?.({ request } as unknown as acp.ClientContext, 'cursor-session', {
      configOptions: [{ id: 'model' }] as never,
    }, profile);
    expect(request).toHaveBeenCalledWith(expect.anything(), {
      sessionId: 'cursor-session',
      configId: 'model',
      value: 'cursor-model',
    });
  });

  it('creates isolated Pi settings, model and MCP files and removes them on cleanup', async () => {
    const definition = getAcpAgentDefinition(AgentType.PI_CODING_AGENT);
    const profile = definition.projectProvider(provider(AgentType.PI_CODING_AGENT, {
      env: {
        PI_PATH: process.execPath,
        AGENT_TOWER_INTERNAL_TOKEN: 'internal-test-token',
        AGENT_TOWER_URL: 'http://127.0.0.1:42232',
        AGENT_TOWER_PORT: '42232',
        OPENAI_API_KEY: 'pi-provider-key',
        OPENAI_BASE_URL: 'https://pi.example/v1',
      },
      config: { model: 'pi-model', effort: 'high' },
    }), {});
    const launch = await definition.resolveLaunch({
      towerSessionId: 'tower-pi',
      agentType: AgentType.PI_CODING_AGENT,
      runtimeType: RuntimeType.ACP,
      variant: 'DEFAULT',
      workingDir: process.cwd(),
      env: ExecutionEnv.default(process.cwd()),
    }, profile);
    const directory = launch.env.PI_CODING_AGENT_DIR!;
    const settings = JSON.parse(await readFile(path.join(directory, 'settings.json'), 'utf-8'));
    const models = JSON.parse(await readFile(path.join(directory, 'models.json'), 'utf-8'));
    const mcp = JSON.parse(await readFile(path.join(directory, 'mcp.json'), 'utf-8'));
    expect(settings).toMatchObject({
      quietStartup: true,
      defaultProvider: 'agent-tower',
      defaultModel: 'pi-model',
      defaultThinkingLevel: 'high',
    });
    expect(settings.packages).toEqual([expect.stringContaining('pi-mcp-adapter')]);
    expect(models.providers['agent-tower']).toMatchObject({
      baseUrl: 'https://pi.example/v1',
      apiKey: '$OPENAI_API_KEY',
    });
    expect(models.providers['agent-tower'].models[0].input).toBeUndefined();
    expect(mcp.settings).toEqual({ toolPrefix: 'none' });
    expect(mcp.mcpServers['agent-tower'].env.AGENT_TOWER_INTERNAL_TOKEN).toBe('internal-test-token');
    if (process.platform !== 'win32') {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(path.join(directory, 'mcp.json'))).mode & 0o777).toBe(0o600);
    }
    await launch.cleanup?.();
    await launch.cleanup?.();
    await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('declares image input for the Pi model when the provider enables vision', async () => {
    const definition = getAcpAgentDefinition(AgentType.PI_CODING_AGENT);
    const profile = definition.projectProvider(provider(AgentType.PI_CODING_AGENT, {
      env: {
        PI_PATH: process.execPath,
        AGENT_TOWER_INTERNAL_TOKEN: 'pi-vision-token',
        AGENT_TOWER_URL: 'http://127.0.0.1:42232',
        AGENT_TOWER_PORT: '42232',
        OPENAI_API_KEY: 'pi-provider-key',
        OPENAI_BASE_URL: 'https://pi.example/v1',
      },
      config: { model: 'pi-vision-model', supportsImages: true },
    }), {});
    const launch = await definition.resolveLaunch({
      towerSessionId: 'tower-pi-vision',
      agentType: AgentType.PI_CODING_AGENT,
      runtimeType: RuntimeType.ACP,
      variant: 'DEFAULT',
      workingDir: process.cwd(),
      env: ExecutionEnv.default(process.cwd()),
    }, profile);
    const directory = launch.env.PI_CODING_AGENT_DIR!;
    const models = JSON.parse(await readFile(path.join(directory, 'models.json'), 'utf-8'));
    expect(models.providers['agent-tower'].models).toEqual([
      expect.objectContaining({ id: 'pi-vision-model', input: ['text', 'image'] }),
    ]);
    await launch.cleanup?.();
  });

  it('uses the bundled Pi executable without a global pi command', async () => {
    const definition = getAcpAgentDefinition(AgentType.PI_CODING_AGENT);
    const piProvider = provider(AgentType.PI_CODING_AGENT, {
      env: {
        AGENT_TOWER_INTERNAL_TOKEN: 'bundled-pi-test-token',
        AGENT_TOWER_URL: 'http://127.0.0.1:42232',
        AGENT_TOWER_PORT: '42232',
        HOME: '/agent-tower-missing/home',
        PATH: '/agent-tower-missing/bin',
        PI_CODING_AGENT_PATH: '/agent-tower-missing/bin/pi',
        PI_PATH: '/agent-tower-missing/bin/pi-fallback',
      },
    });
    const profile = definition.projectProvider(piProvider, {});
    const launch = await definition.resolveLaunch({
      towerSessionId: 'tower-bundled-pi',
      agentType: AgentType.PI_CODING_AGENT,
      runtimeType: RuntimeType.ACP,
      variant: 'DEFAULT',
      workingDir: process.cwd(),
      env: ExecutionEnv.default(process.cwd()),
    }, profile);

    expect(launch.env.PI_ACP_PI_COMMAND).toMatch(
      process.platform === 'win32' ? /node_modules[\\/].bin[\\/]pi\.cmd$/ : /node_modules\/.bin\/pi$/,
    );
    expect(await definition.checkAvailability(piProvider)).toEqual({ type: 'INSTALLATION_FOUND' });
    await launch.cleanup?.();
  });

  it('prepares Minion MCP and OpenAI-compatible config in its isolated runtime', async () => {
    const definition = getAcpAgentDefinition(AgentType.MINION_CODE);
    const profile = definition.projectProvider(provider(AgentType.MINION_CODE, {
      env: {
        MCODE_PATH: process.execPath,
        OPENAI_API_KEY: 'minion-key',
        OPENAI_BASE_URL: 'https://minion.example/v1',
      },
      config: { model: 'minion-model', dangerouslySkipPermissions: true },
    }), {});
    const launch = await definition.resolveLaunch({
      towerSessionId: 'tower-minion',
      agentType: AgentType.MINION_CODE,
      runtimeType: RuntimeType.ACP,
      variant: 'DEFAULT',
      workingDir: process.cwd(),
      env: ExecutionEnv.default(process.cwd()),
    }, profile);
    expect(launch.args).toEqual(['acp', '--model', 'minion-model', '--dangerously-skip-permissions']);
    expect(launch.env.DEFAULT_API_KEY).toBe('minion-key');
    expect(launch.env.DEFAULT_BASE_URL).toBe('https://minion.example/v1');
    expect(await readFile(path.join(launch.env.MINION_ROOT!, 'sitecustomize.py'), 'utf-8'))
      .toContain('MCPToolsLoader');
    expect(JSON.parse(await readFile(path.join(launch.env.MINION_ROOT!, 'config/config.yaml'), 'utf-8')))
      .toMatchObject({ models: { 'minion-model': { api_type: 'openai', model: 'minion-model' } } });
    await launch.cleanup?.();
  });
});
