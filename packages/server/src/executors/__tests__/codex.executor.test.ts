import { describe, expect, it, afterAll, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildAgentTowerMcpEnvConfigOverrides,
  getCodexDeclaredMcpServerNames,
  queryCodexMcpServerNames,
  detectDeclaredMcpServers,
  getCachedCodexMcpServerNames,
  resetCodexMcpServerCache,
  waitForCodexMcpServerCacheRefresh,
  CODEX_HTTP_ONLY_OPENAI_PROVIDER_ID,
  getCodexPermissionMode,
  CodexExecutor,
} from '../codex.executor.js';
import {
  AGENT_SUBPROCESS_BLOCKED_ENV_KEYS,
  AGENT_TOWER_MCP_IDENTITY_ENV_KEYS,
  AGENT_TOWER_MCP_SERVICE_ENV_KEYS,
  ExecutionEnv,
} from '../execution-env.js';
import { getExecutorByProvider, createExecutorFromProvider } from '../index.js';
import { createProvider as createRawProvider, reloadProviders, updateProvider } from '../providers.js';
import type { BaseExecutor } from '../base.executor.js';
import type { CmdOverrides, CommandBuilder } from '../command-builder.js';
import { AgentType } from '../../types/index.js';
import * as codexAskCapabilities from '../../services/codex-cli-capabilities.service.js';
import { CODEX_NATIVE_MODEL_PROVIDER_IDS } from '@agent-tower/shared';
import {
  CODEX_OPENAI_COMPATIBLE_ENV_KEY,
  CODEX_OPENAI_COMPATIBLE_PROVIDER_ID,
  probeEffectiveProviderConnection,
  resolveEffectiveProviderConnection,
} from '../../services/provider-effective-connection.service.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-executor-test-'));
afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

const protectedSubprocessEnvKeys = [
  ...AGENT_SUBPROCESS_BLOCKED_ENV_KEYS,
  ...AGENT_TOWER_MCP_IDENTITY_ENV_KEYS,
  ...AGENT_TOWER_MCP_SERVICE_ENV_KEYS,
];

const savedCodexHome = process.env.CODEX_HOME;
const savedPath = process.env.PATH;
const savedDataDir = process.env.AGENT_TOWER_DATA_DIR;
const savedCodexApiKey = process.env.CODEX_API_KEY;
const savedOpenAiBaseUrl = process.env.OPENAI_BASE_URL;
beforeEach(() => {
  resetCodexMcpServerCache();
});
afterEach(() => {
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  process.env.PATH = savedPath;
  if (savedDataDir === undefined) delete process.env.AGENT_TOWER_DATA_DIR;
  else process.env.AGENT_TOWER_DATA_DIR = savedDataDir;
  if (savedCodexApiKey === undefined) delete process.env.CODEX_API_KEY;
  else process.env.CODEX_API_KEY = savedCodexApiKey;
  if (savedOpenAiBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = savedOpenAiBaseUrl;
});

function inspectRuntime(executor: BaseExecutor, sessionEnv: Record<string, string> = {}) {
  const inspectable = executor as unknown as {
    buildCommandBuilder(): CommandBuilder;
    cmdOverrides?: CmdOverrides;
  };
  const args = inspectable.buildCommandBuilder().buildInitial().args;
  const env = ExecutionEnv.default(tmpDir)
    .merge(sessionEnv)
    .withProfile(inspectable.cmdOverrides)
    .getFullEnv();
  return { args, env };
}

function createProvider(input: Parameters<typeof createRawProvider>[0]) {
  return createRawProvider({ executionPermission: 'FULL_ACCESS', ...input });
}

describe('Codex Provider runtime connection snapshots', () => {
  it.each(['ASK', 'AUTO_SANDBOX'] as const)('launches %s app-server with model, effort, authentication and MCP config on initial and resume paths', async executionPermission => {
    const refresh = vi.spyOn(codexAskCapabilities, 'refreshCodexCliSupport').mockResolvedValue({ supported: true, executable: '/verified/codex' });
    const support = vi.spyOn(codexAskCapabilities, 'cachedCodexCliSupport').mockReturnValue({ supported: true, executable: '/verified/codex' });
    const executor = new CodexExecutor({ executionPermission, model: 'gpt-6-sol', fastMode: true,
      settings: 'model_reasoning_effort="ultra"\n[mcp_servers.agent-tower]\ncommand="tower-mcp"',
      cmd: { env: { AUTH_VALUE: 'credential' } } });
    const spawn = vi.spyOn(executor as any, 'spawnWithDuplex').mockResolvedValueOnce({}).mockResolvedValueOnce({});
    try {
      const env = ExecutionEnv.default(tmpDir).set('AGENT_TOWER_SESSION_ID', 'session');
      const config = { workingDir: tmpDir, prompt: 'task', env };
      const initial = await executor.spawn(config); const follow = await executor.spawnFollowUp(config, 'native-thread');
      for (const call of spawn.mock.calls as any[]) {
        const parts = call[1];
        expect(parts.program).toBe('/verified/codex');
        expect(parts.args).toEqual(expect.arrayContaining(['app-server', '--listen', 'stdio://', 'approval_policy=on-request', `approvals_reviewer=${executionPermission === 'ASK' ? 'user' : 'auto_review'}`, 'sandbox_mode=workspace-write', 'model="gpt-6-sol"', 'model_reasoning_effort="ultra"', 'service_tier="fast"', 'mcp_servers.agent-tower.env.AGENT_TOWER_SESSION_ID="session"']));
        expect(parts.args).not.toContain('exec'); expect(parts.args).not.toContain('--model');
        if (executionPermission === 'AUTO_SANDBOX') {
          expect(parts.args).toEqual(expect.arrayContaining([
            'sandbox_workspace_write.writable_roots=[]', 'sandbox_workspace_write.network_access=false',
          ]));
        }
      }
      expect(JSON.parse(initial.initialInput!).input[0].text).toBe('task');
      expect(JSON.parse(initial.initialInput!).resumeThreadId).toBeUndefined();
      expect(JSON.parse(follow.initialInput!).resumeThreadId).toBe('native-thread');
      expect(inspectRuntime(executor).env.AUTH_VALUE).toBe('credential');
    } finally { spawn.mockRestore(); refresh.mockRestore(); support.mockRestore(); }
  });
  it.each([undefined, 'gpt-6.1-sol'])('keeps AUTO_SANDBOX on initial and resumed launches with model %s', async model => {
    const refresh = vi.spyOn(codexAskCapabilities, 'refreshCodexCliSupport').mockResolvedValue({ supported: true, executable: '/verified/codex' });
    const support = vi.spyOn(codexAskCapabilities, 'cachedCodexCliSupport').mockReturnValue({ supported: true, executable: '/verified/codex' });
    const executor = new CodexExecutor({ executionPermission: 'AUTO_SANDBOX', ...(model ? { model } : {}) });
    const spawn = vi.spyOn(executor as any, 'spawnWithDuplex').mockResolvedValue({});
    try {
      const config = { workingDir: tmpDir, prompt: 'task', env: ExecutionEnv.default(tmpDir) };
      await executor.spawn(config);
      await executor.spawnFollowUp(config, 'native-thread');
      expect(spawn).toHaveBeenCalledTimes(2);
      for (const [, parts] of spawn.mock.calls as any[]) {
        expect(parts.args).toEqual(expect.arrayContaining([
          'approval_policy=on-request', 'approvals_reviewer=auto_review', 'sandbox_mode=workspace-write',
          'sandbox_workspace_write.writable_roots=[]', 'sandbox_workspace_write.network_access=false',
        ]));
        expect(parts.args).not.toContain('approvals_reviewer=user');
        expect(parts.args).not.toContain('sandbox_mode=danger-full-access');
        expect(parts.args.filter((arg: string) => arg.startsWith('model='))).toEqual(model ? [`model="${model}"`] : []);
      }
    } finally { spawn.mockRestore(); refresh.mockRestore(); support.mockRestore(); }
  });
  it('projects the AUTO_SANDBOX workspace boundary after advanced settings on new and resumed launches', async () => {
    const refresh = vi.spyOn(codexAskCapabilities, 'refreshCodexCliSupport').mockResolvedValue({ supported: true, executable: '/verified/codex' });
    const support = vi.spyOn(codexAskCapabilities, 'cachedCodexCliSupport').mockReturnValue({ supported: true, executable: '/verified/codex' });
    const executor = new CodexExecutor({ executionPermission: 'AUTO_SANDBOX', model: 'gpt-6-sol',
      settings: '[sandbox_workspace_write]\nwritable_roots=["/outside"]\nnetwork_access=true' });
    const spawn = vi.spyOn(executor as any, 'spawnWithDuplex').mockResolvedValue({});
    try {
      const config = { workingDir: tmpDir, prompt: 'task', env: ExecutionEnv.default(tmpDir) };
      await executor.spawn(config);
      await executor.spawnFollowUp(config, 'native-thread');
      for (const [, parts] of spawn.mock.calls as any[]) {
        expect(parts.args.lastIndexOf('sandbox_workspace_write.writable_roots=[]')).toBeGreaterThan(parts.args.indexOf('sandbox_workspace_write.writable_roots=["/outside"]'));
        expect(parts.args.lastIndexOf('sandbox_workspace_write.network_access=false')).toBeGreaterThan(parts.args.indexOf('sandbox_workspace_write.network_access=true'));
      }
    } finally { spawn.mockRestore(); refresh.mockRestore(); support.mockRestore(); }
  });
  it('preserves unrelated legacy profile command overrides while projecting the explicit permission', () => {
    const executor = createExecutorFromProvider({ id: '', name: 'Legacy profile', agentType: AgentType.CLAUDE_CODE,
      executionPermission: 'FULL_ACCESS', env: {}, config: { dangerouslySkipPermissions: true,
        cmd: { baseCommandOverride: 'profile-claude', env: { PROFILE_SETTING: 'profile-value' } } }, isDefault: false });
    const runtime = inspectRuntime(executor);
    expect(runtime.env.PROFILE_SETTING).toBe('profile-value');
    expect(runtime.args).toEqual(expect.arrayContaining(['--permission-mode', 'bypassPermissions']));
    const inspectable = executor as unknown as { buildCommandBuilder(): CommandBuilder };
    expect(inspectable.buildCommandBuilder().buildInitial().program).toBe('profile-claude');
  });
  let providerDataDir = '';

  beforeEach(() => {
    providerDataDir = fs.mkdtempSync(path.join(tmpDir, 'provider-runtime-'));
    process.env.AGENT_TOWER_DATA_DIR = providerDataDir;
    process.env.CODEX_API_KEY = 'parent-codex-sentinel';
    process.env.OPENAI_BASE_URL = 'https://parent-legacy.example';
    reloadProviders();
  });

  afterEach(() => {
    fs.rmSync(providerDataDir, { recursive: true, force: true });
  });

  it.each([
    ['gpt-6-sol', 'ultra'],
    ['gpt-6-luna', 'max'],
  ])('passes %s effort %s through Codex CLI arguments', (model, effort) => {
    const provider = createProvider({
      name: `${model} ${effort}`,
      agentType: AgentType.CODEX,
      env: {},
      config: { model },
      settings: `model_reasoning_effort = "${effort}"\n`,
      isDefault: false,
    });
    const runtime = inspectRuntime(getExecutorByProvider(provider.id)!);
    expect(runtime.args).toContain(`model_reasoning_effort="${effort}"`);
  });

  it.each([
    ['missing', undefined],
    ['false', false],
    ['string true', 'true'],
    ['number one', 1],
    ['null', null],
  ])('requires review or rejects invalid legacy %s permission values', (_label, value) => {
    expect(getCodexPermissionMode({
      dangerouslyBypassApprovalsAndSandbox: value as never,
    })).toBe('noninteractive-workspace');

    const provider = createRawProvider({
      name: `Codex safe mode ${String(value)}`,
      agentType: AgentType.CODEX,
      env: {},
      config: value === undefined ? {} : { dangerouslyBypassApprovalsAndSandbox: value },
      settings: '',
      isDefault: false,
    });
    expect(() => getExecutorByProvider(provider.id)).toThrow(value === undefined || value === false
      ? 'Select an execution permission mode' : 'must be true or false');
  });

  it('uses full bypass only for strict boolean true and omits safe defaults', () => {
    expect(getCodexPermissionMode({ dangerouslyBypassApprovalsAndSandbox: true })).toBe('full-bypass');
    const provider = createProvider({
      name: 'Codex full bypass',
      agentType: AgentType.CODEX,
      env: {},
      config: { dangerouslyBypassApprovalsAndSandbox: true },
      settings: '',
      isDefault: false,
    });
    const runtime = inspectRuntime(getExecutorByProvider(provider.id)!);

    expect(runtime.args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(runtime.args).not.toContain('approval_policy=never');
    expect(runtime.args).not.toContain('sandbox_mode=workspace-write');

  });

  it('requires explicit permission selection for legacy fullAuto providers', () => {
    const provider = createRawProvider({
      name: 'Codex legacy fullAuto',
      agentType: AgentType.CODEX,
      env: {},
      config: { fullAuto: true },
      settings: '',
      isDefault: false,
    });
    expect(() => getExecutorByProvider(provider.id)).toThrow('Select an execution permission mode');
  });

  it('projects explicit native ASK defaults for the built-in Codex provider', () => {
    const runtime = inspectRuntime(getExecutorByProvider('codex-default')!);

    expect(runtime.args).toEqual(expect.arrayContaining([
      'approval_policy=on-request',
      'sandbox_mode=workspace-write',
      'approvals_reviewer=user',
    ]));
    expect(runtime.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('applies an enabled Fast mode after conflicting raw Codex settings', () => {
    const provider = createProvider({
      name: 'Codex Fast mode',
      agentType: AgentType.CODEX,
      env: {},
      config: { fastMode: true },
      settings: [
        'service_tier = "flex"',
        '[features]',
        'fast_mode = false',
      ].join('\n'),
      isDefault: false,
    });
    const runtime = inspectRuntime(getExecutorByProvider(provider.id)!);

    expect(runtime.args.lastIndexOf('features.fast_mode=true'))
      .toBeGreaterThan(runtime.args.lastIndexOf('features.fast_mode=false'));
    expect(runtime.args.lastIndexOf('service_tier="fast"'))
      .toBeGreaterThan(runtime.args.lastIndexOf('service_tier="flex"'));
  });

  it('explicitly disables Fast mode without selecting a service tier', () => {
    const provider = createProvider({
      name: 'Codex standard mode',
      agentType: AgentType.CODEX,
      env: {},
      config: { fastMode: false },
      settings: [
        'service_tier = "fast"',
        '[features]',
        'fast_mode = true',
      ].join('\n'),
      isDefault: false,
    });
    const runtime = inspectRuntime(getExecutorByProvider(provider.id)!);

    expect(runtime.args.lastIndexOf('features.fast_mode=false'))
      .toBeGreaterThan(runtime.args.lastIndexOf('features.fast_mode=true'));
    expect(runtime.args.filter(arg => arg === 'service_tier="fast"')).toHaveLength(1);
  });

  it('leaves Codex speed settings untouched when Fast mode is not configured', () => {
    const provider = createProvider({
      name: 'Codex inherited speed',
      agentType: AgentType.CODEX,
      env: {},
      config: {},
      settings: '',
      isDefault: false,
    });
    const runtime = inspectRuntime(getExecutorByProvider(provider.id)!);

    expect(runtime.args.some(arg => arg.startsWith('features.fast_mode='))).toBe(false);
    expect(runtime.args.some(arg => arg.startsWith('service_tier='))).toBe(false);
  });

  it.each([
    [AgentType.CLAUDE_CODE, { dangerouslySkipPermissions: true }],
    [AgentType.GEMINI_CLI, { yolo: true }],
    [AgentType.CURSOR_AGENT, { force: true }],
  ] as const)('does not project Codex permission flags for %s', (agentType, config) => {
    const provider = createProvider({
      name: `${agentType} permission isolation`,
      agentType,
      env: {},
      config,
      settings: '',
      isDefault: false,
    });
    const runtime = inspectRuntime(getExecutorByProvider(provider.id)!);

    expect(runtime.args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(runtime.args).not.toContain('approval_policy=never');
    expect(runtime.args).not.toContain('sandbox_mode=workspace-write');
    if (agentType === AgentType.CLAUDE_CODE) {
      expect(runtime.args).toEqual(expect.arrayContaining(['--permission-mode', 'bypassPermissions']));
      const settingsIndex = runtime.args.lastIndexOf('--settings');
      expect(JSON.parse(runtime.args[settingsIndex + 1]!)).toMatchObject({ sandbox: { enabled: false } });
    } else if (agentType === AgentType.GEMINI_CLI) {
      expect(runtime.args).toEqual(expect.arrayContaining(['--approval-mode', 'yolo', '--no-sandbox']));
    } else if (agentType === AgentType.CURSOR_AGENT) {
      expect(runtime.args).toEqual(expect.arrayContaining(['--sandbox', 'disabled', '--force', '--approve-mcps']));
    }
  });

  it('uses saved connection A for the existing executor and connection B for the next spawn factory lookup', () => {
    const keyA = 'runtime-key-a-sentinel';
    const keyB = 'runtime-key-b-sentinel';
    const provider = createProvider({
      name: 'Codex Runtime Snapshot',
      agentType: AgentType.CODEX,
      env: { OPENAI_API_KEY: keyA, OPENAI_BASE_URL: 'https://legacy-ignored.example' },
      config: {},
      settings: 'openai_base_url = "https://runtime-a.example/v1"\n',
      isDefault: false,
    });

    const executorA = getExecutorByProvider(provider.id)!;
    const runtimeA = inspectRuntime(executorA, { OPENAI_BASE_URL: 'https://session-old.example' });
    expect(runtimeA.args).toContain(`model_provider="${CODEX_OPENAI_COMPATIBLE_PROVIDER_ID}"`);
    expect(runtimeA.args).toContain(
      `model_providers.${CODEX_OPENAI_COMPATIBLE_PROVIDER_ID}.base_url="https://runtime-a.example/v1"`,
    );
    expect(runtimeA.args).toContain(
      `model_providers.${CODEX_OPENAI_COMPATIBLE_PROVIDER_ID}.name="Agent Tower OpenAI Compatible"`,
    );
    expect(runtimeA.args).toContain(
      `model_providers.${CODEX_OPENAI_COMPATIBLE_PROVIDER_ID}.wire_api="responses"`,
    );
    expect(runtimeA.args).toContain(
      `model_providers.${CODEX_OPENAI_COMPATIBLE_PROVIDER_ID}.env_key="${CODEX_OPENAI_COMPATIBLE_ENV_KEY}"`,
    );
    expect(runtimeA.env[CODEX_OPENAI_COMPATIBLE_ENV_KEY] === keyA).toBe(true);
    expect(runtimeA.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(runtimeA.env).not.toHaveProperty('CODEX_API_KEY');
    expect(runtimeA.env).not.toHaveProperty('OPENAI_BASE_URL');
    expect(JSON.stringify(runtimeA.args)).not.toContain(keyA);
    expect(runtimeA.args.some(arg => arg.includes('supports_websockets'))).toBe(false);
    expect(runtimeA.args).not.toContain(`model_provider="${CODEX_HTTP_ONLY_OPENAI_PROVIDER_ID}"`);

    updateProvider(provider.id, {
      env: { OPENAI_API_KEY: keyB },
      config: { disableResponsesWebsocket: true },
      settings: 'openai_base_url = "https://runtime-b.example/v1"\n',
    });
    const executorB = getExecutorByProvider(provider.id)!;
    const runtimeB = inspectRuntime(executorB, { OPENAI_BASE_URL: 'https://session-old.example' });
    expect(runtimeB.args).toContain(
      `model_providers.${CODEX_OPENAI_COMPATIBLE_PROVIDER_ID}.base_url="https://runtime-b.example/v1"`,
    );
    expect(runtimeB.env[CODEX_OPENAI_COMPATIBLE_ENV_KEY] === keyB).toBe(true);
    expect(runtimeB.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(runtimeB.env).not.toHaveProperty('CODEX_API_KEY');
    expect(runtimeB.args).toEqual(expect.arrayContaining([
      `model_providers.${CODEX_OPENAI_COMPATIBLE_PROVIDER_ID}.env_key="${CODEX_OPENAI_COMPATIBLE_ENV_KEY}"`,
      `model_providers.${CODEX_OPENAI_COMPATIBLE_PROVIDER_ID}.supports_websockets=false`,
      `model_provider="${CODEX_OPENAI_COMPATIBLE_PROVIDER_ID}"`,
    ]));
    expect(runtimeB.args.filter(arg => arg.includes('.supports_websockets=')).at(-1)).toBe(
      `model_providers.${CODEX_OPENAI_COMPATIBLE_PROVIDER_ID}.supports_websockets=false`,
    );

    const oldSnapshot = inspectRuntime(executorA);
    expect(oldSnapshot.args).toContain(
      `model_providers.${CODEX_OPENAI_COMPATIBLE_PROVIDER_ID}.base_url="https://runtime-a.example/v1"`,
    );
    expect(oldSnapshot.env[CODEX_OPENAI_COMPATIBLE_ENV_KEY] === keyA).toBe(true);
    expect(oldSnapshot.args.some(arg => arg.includes('supports_websockets'))).toBe(false);
  });

  it('keeps explicit false byte-for-byte equivalent to a missing transport control', () => {
    const baseProvider = {
      name: 'Codex transport default',
      agentType: AgentType.CODEX,
      env: {},
      settings: 'openai_base_url = "https://runtime-default.example/v1"\n',
      isDefault: false,
    };
    const missing = createProvider({ ...baseProvider, config: {} });
    const explicitFalse = createProvider({
      ...baseProvider,
      name: 'Codex transport explicit false',
      config: { disableResponsesWebsocket: false },
    });

    expect(inspectRuntime(getExecutorByProvider(explicitFalse.id)!).args)
      .toEqual(inspectRuntime(getExecutorByProvider(missing.id)!).args);
  });

  it('does not enable transport overrides for a non-boolean historical value', () => {
    const provider = createProvider({
      name: 'Codex transport historical string false',
      agentType: AgentType.CODEX,
      env: {},
      config: { disableResponsesWebsocket: 'false' },
      settings: 'openai_base_url = "https://runtime-historical.example/v1"\n',
      isDefault: false,
    });

    const runtime = inspectRuntime(getExecutorByProvider(provider.id)!);
    expect(runtime.args.some(arg => arg.includes('supports_websockets'))).toBe(false);
    expect(runtime.args).not.toContain(`model_provider="${CODEX_HTTP_ONLY_OPENAI_PROVIDER_ID}"`);
  });

  it('uses a custom env_key and masks inherited CODEX_API_KEY for a custom model provider', () => {
    const customKey = 'runtime-custom-sentinel';
    const provider = createProvider({
      name: 'Codex Custom Runtime',
      agentType: AgentType.CODEX,
      env: { PROXY_TOKEN: customKey, CODEX_API_KEY: 'provider-stale-codex-sentinel' },
      config: { disableResponsesWebsocket: true },
      settings: [
        'model_provider = "proxy"',
        '[model_providers.proxy]',
        'base_url = "https://custom-runtime.example/v1"',
        'env_key = "PROXY_TOKEN"',
        'supports_websockets = true',
      ].join('\n'),
      isDefault: false,
    });

    const runtime = inspectRuntime(getExecutorByProvider(provider.id)!);
    expect(runtime.args).toContain('model_provider="proxy"');
    expect(runtime.args).toContain('model_providers.proxy.base_url="https://custom-runtime.example/v1"');
    expect(runtime.args).toContain('model_providers.proxy.env_key="PROXY_TOKEN"');
    expect(runtime.args.filter(arg => arg === 'model_providers.proxy.supports_websockets=true')).toHaveLength(1);
    expect(runtime.args.filter(arg => arg === 'model_providers.proxy.supports_websockets=false')).toHaveLength(1);
    expect(runtime.args.filter(arg => arg.startsWith('model_providers.proxy.supports_websockets=')).at(-1)).toBe('model_providers.proxy.supports_websockets=false');
    expect(runtime.env.PROXY_TOKEN === customKey).toBe(true);
    expect(runtime.env).not.toHaveProperty('CODEX_API_KEY');
    expect(JSON.stringify(runtime.args)).not.toContain(customKey);
  });

  it('projects a legacy OpenAI-compatible URL through a dedicated provider without exposing the key', () => {
    const key = 'legacy-runtime-key-sentinel';
    const provider = createProvider({
      name: 'Codex Legacy HTTP-only',
      agentType: AgentType.CODEX,
      env: {
        OPENAI_API_KEY: key,
        OPENAI_BASE_URL: 'https://legacy-runtime.example/v1',
      },
      config: { disableResponsesWebsocket: true },
      settings: '',
      isDefault: false,
    });

    const runtime = inspectRuntime(getExecutorByProvider(provider.id)!);
    expect(runtime.args).toContain(
      `model_providers.${CODEX_OPENAI_COMPATIBLE_PROVIDER_ID}.base_url="https://legacy-runtime.example/v1"`,
    );
    expect(runtime.args).toContain(
      `model_providers.${CODEX_OPENAI_COMPATIBLE_PROVIDER_ID}.supports_websockets=false`,
    );
    expect(runtime.args).not.toContain(
      `model_providers.${CODEX_OPENAI_COMPATIBLE_PROVIDER_ID}.requires_openai_auth=true`,
    );
    expect(runtime.args).toContain(`model_provider="${CODEX_OPENAI_COMPATIBLE_PROVIDER_ID}"`);
    expect(runtime.env[CODEX_OPENAI_COMPATIBLE_ENV_KEY] === key).toBe(true);
    expect(runtime.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(runtime.env).not.toHaveProperty('CODEX_API_KEY');
    expect(runtime.env).not.toHaveProperty('OPENAI_BASE_URL');
    expect(JSON.stringify(runtime.args)).not.toContain(key);
  });

  it('fails clearly when raw settings already declare the reserved built-in alias', () => {
    const provider = createProvider({
      name: 'Codex Reserved Alias Collision',
      agentType: AgentType.CODEX,
      env: { OPENAI_API_KEY: 'alias-collision-key-sentinel' },
      config: { disableResponsesWebsocket: true },
      settings: [
        'model_provider = "openai"',
        '[model_providers.agent-tower-openai-http]',
        'name = "User alias"',
        'env_key = "STALE_ALIAS_KEY"',
      ].join('\n'),
      isDefault: false,
    });

    expect(() => inspectRuntime(getExecutorByProvider(provider.id)!)).toThrow(
      "disableResponsesWebsocket conflicts with reserved Codex model provider alias 'agent-tower-openai-http'",
    );
  });

  it('uses the same HTTP-only override for initial and follow-up command paths', async () => {
    const binDir = createFakeCodex('spawn-transport-paths', '[]');
    process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ''}`;
    const provider = createProvider({
      name: 'Codex Custom Spawn Paths',
      agentType: AgentType.CODEX,
      env: { PROXY_TOKEN: 'spawn-path-key-sentinel' },
      config: { disableResponsesWebsocket: true },
      settings: [
        'model_provider = "proxy"',
        '[model_providers.proxy]',
        'base_url = "https://spawn-path.example/v1"',
        'env_key = "PROXY_TOKEN"',
      ].join('\n'),
      isDefault: false,
    });
    const executor = getExecutorByProvider(provider.id)!;
    const spawnWithStdin = vi.spyOn(
      executor as unknown as { spawnWithStdin: (...args: unknown[]) => Promise<unknown> },
      'spawnWithStdin',
    ).mockResolvedValue({ pid: 1 });
    const spawnConfig = {
      workingDir: tmpDir,
      prompt: 'synthetic prompt',
      env: ExecutionEnv.default(tmpDir),
    };

    await executor.spawn(spawnConfig);
    await executor.spawnFollowUp!(spawnConfig, 'codex-thread-1');

    expect(spawnWithStdin).toHaveBeenCalledTimes(2);
    const initialArgs = (spawnWithStdin.mock.calls[0]![1] as { args: string[] }).args;
    const followUpArgs = (spawnWithStdin.mock.calls[1]![1] as { args: string[] }).args;
    for (const args of [initialArgs, followUpArgs]) {
      expect(args.filter(arg => arg === 'model_providers.proxy.supports_websockets=false'))
        .toHaveLength(1);
      expect(JSON.stringify(args)).not.toContain('spawn-path-key-sentinel');
    }
    expect(initialArgs).toEqual(expect.arrayContaining(['exec', '--json', '--skip-git-repo-check', '-']));
    expect(followUpArgs).toEqual(expect.arrayContaining([
      'exec', 'resume', '--json', '--skip-git-repo-check', 'codex-thread-1', '-',
    ]));
    await waitForCodexMcpServerCacheRefresh();
  });

  it('keeps a custom credential when env_key collides with the legacy OPENAI_BASE_URL name', async () => {
    const keyA = 'runtime-collision-a-sentinel';
    const keyB = 'runtime-collision-b-sentinel';
    const provider = createProvider({
      name: 'Codex Custom Legacy Env Collision',
      agentType: AgentType.CODEX,
      env: { OPENAI_BASE_URL: keyA, CODEX_API_KEY: 'provider-stale-codex-sentinel' },
      config: {},
      settings: [
        'model_provider = "proxy"',
        '[model_providers.proxy]',
        'base_url = "https://custom-collision.example/v1"',
        'env_key = "OPENAI_BASE_URL"',
      ].join('\n'),
      isDefault: false,
    });

    const effectiveA = resolveEffectiveProviderConnection(provider);
    let probeUsedKeyA = false;
    const probeA = await probeEffectiveProviderConnection(effectiveA, {
      fetchImpl: (async (_input, init) => {
        probeUsedKeyA = new Headers(init?.headers).get('authorization') === `Bearer ${keyA}`;
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    });
    const executorA = getExecutorByProvider(provider.id)!;
    const runtimeA = inspectRuntime(executorA, { OPENAI_BASE_URL: 'session-stale-legacy-sentinel' });

    expect(effectiveA.envKey).toBe('OPENAI_BASE_URL');
    expect(effectiveA.secret === keyA).toBe(true);
    expect(probeA.ok).toBe(true);
    expect(probeUsedKeyA).toBe(true);
    expect(runtimeA.args).toContain('model_providers.proxy.env_key="OPENAI_BASE_URL"');
    expect(runtimeA.env.OPENAI_BASE_URL === keyA).toBe(true);
    expect(runtimeA.env).not.toHaveProperty('CODEX_API_KEY');
    expect(JSON.stringify(runtimeA.args)).not.toContain(keyA);
    expect(JSON.stringify(probeA)).not.toContain(keyA);

    const updated = updateProvider(provider.id, {
      env: { OPENAI_BASE_URL: keyB },
    });
    const effectiveB = resolveEffectiveProviderConnection(updated!);
    let probeUsedKeyB = false;
    const probeB = await probeEffectiveProviderConnection(effectiveB, {
      fetchImpl: (async (_input, init) => {
        probeUsedKeyB = new Headers(init?.headers).get('authorization') === `Bearer ${keyB}`;
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    });
    const executorB = getExecutorByProvider(provider.id)!;
    const runtimeB = inspectRuntime(executorB, { OPENAI_BASE_URL: 'session-stale-legacy-sentinel' });
    const oldSnapshot = inspectRuntime(executorA);

    expect(effectiveB.secret === keyB).toBe(true);
    expect(probeB.ok).toBe(true);
    expect(probeUsedKeyB).toBe(true);
    expect(runtimeB.env.OPENAI_BASE_URL === keyB).toBe(true);
    expect(runtimeB.env.OPENAI_BASE_URL === process.env.OPENAI_BASE_URL).toBe(false);
    expect(runtimeB.env).not.toHaveProperty('CODEX_API_KEY');
    expect(oldSnapshot.env.OPENAI_BASE_URL === keyA).toBe(true);
    expect(JSON.stringify(runtimeB.args)).not.toContain(keyB);
    expect(JSON.stringify(probeB)).not.toContain(keyB);
  });

  it.each(protectedSubprocessEnvKeys)(
    'returns the same diagnostic and skips probe/spawn for protected env_key %s',
    async envKey => {
      const secret = 'protected-runtime-value-sentinel';
      const provider = createProvider({
        name: 'Codex Protected Runtime',
        agentType: AgentType.CODEX,
        env: { [envKey]: secret },
        config: { disableResponsesWebsocket: true },
        settings: [
          'model_provider = "proxy"',
          '[model_providers.proxy]',
          'base_url = "https://protected-runtime.example/v1"',
          `env_key = ${JSON.stringify(envKey)}`,
        ].join('\n'),
        isDefault: false,
      });
      const expectedDiagnostic = {
        field: 'apiKey' as const,
        code: 'CONFLICT' as const,
        message: 'Active Codex env_key is reserved for Agent Tower subprocess internals',
      };
      const connection = resolveEffectiveProviderConnection(provider);
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      const probe = await probeEffectiveProviderConnection(connection, { fetchImpl });

      expect(connection.diagnostics).toEqual([expectedDiagnostic]);
      expect(connection.secret).toBeUndefined();
      expect(probe).toMatchObject({
        ok: false,
        stage: 'validation',
        diagnostics: [expectedDiagnostic],
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(() => getExecutorByProvider(provider.id)).toThrow(expectedDiagnostic.message);
      expect(JSON.stringify(probe).includes(secret)).toBe(false);
      expect(expectedDiagnostic.message.includes(secret)).toBe(false);
    },
  );

  it.each(CODEX_NATIVE_MODEL_PROVIDER_IDS)(
    'keeps the native %s provider on the CLI path when the transport control is enabled',
    modelProviderId => {
      const provider = createProvider({
        name: `Codex native ${modelProviderId}`,
        agentType: AgentType.CODEX,
        env: { NATIVE_PROVIDER_OPTION: 'native-value' },
        config: { disableResponsesWebsocket: true },
        settings: `model_provider = "${modelProviderId}"\n`,
        isDefault: false,
      });

      const runtime = inspectRuntime(getExecutorByProvider(provider.id)!);
      expect(runtime.args.filter(arg => arg === `model_provider="${modelProviderId}"`)).toHaveLength(1);
      expect(runtime.args.some(arg => arg.startsWith('openai_base_url='))).toBe(false);
      expect(runtime.args.some(arg => arg.startsWith(`model_providers.${modelProviderId}.`))).toBe(false);
      expect(runtime.args.some(arg => arg.includes('supports_websockets'))).toBe(false);
      expect(runtime.args).not.toContain(`model_provider="${CODEX_HTTP_ONLY_OPENAI_PROVIDER_ID}"`);
      expect(runtime.env.NATIVE_PROVIDER_OPTION).toBe('native-value');
      expect(runtime.env.CODEX_API_KEY).toBe('parent-codex-sentinel');
      expect(runtime.env.OPENAI_BASE_URL).toBe('https://parent-legacy.example');
    },
  );
});

/**
 * Create a fake `codex` executable that writes argv to a file and outputs the given stdout.
 * Returns the directory containing the fake binary (for prepending to PATH).
 */
function createFakeCodex(name: string, stdout: string, exitCode = 0): string {
  const binDir = path.join(tmpDir, `fake-codex-${name}`);
  fs.mkdirSync(binDir, { recursive: true });
  const argsFile = path.join(binDir, 'captured-args.json');
  const script = `#!/bin/sh
printf '%s\\n' "$@" > "${argsFile}"
cat <<'FAKE_EOF'
${stdout}
FAKE_EOF
exit ${exitCode}
`;
  fs.writeFileSync(path.join(binDir, 'codex'), script, { mode: 0o755 });
  return binDir;
}

function readCapturedArgs(binDir: string): string[] {
  const argsFile = path.join(binDir, 'captured-args.json');
  return fs.readFileSync(argsFile, 'utf-8').trim().split('\n');
}

function createAsyncProbeCodex(
  name: string,
  stdout: string,
  options: { exitCode?: number; delayMs?: number } = {},
): string {
  const binDir = path.join(tmpDir, `async-probe-${name}`);
  fs.mkdirSync(binDir, { recursive: true });
  const countFile = path.join(binDir, 'probe-count');
  const delaySeconds = ((options.delayMs ?? 0) / 1000).toFixed(3);
  const script = [
    '#!/bin/sh',
    `printf '1\\n' >> "${countFile}"`,
    `sleep ${delaySeconds}`,
    'cat <<\'FAKE_EOF\'',
    stdout,
    'FAKE_EOF',
    `exit ${options.exitCode ?? 0}`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(binDir, 'codex'), script, { mode: 0o755 });
  return binDir;
}

function probeCount(binDir: string): number {
  const file = path.join(binDir, 'probe-count');
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, 'utf-8').trim().split('\n').filter(Boolean).length;
}

describe('getCachedCodexMcpServerNames', () => {
  it('returns fallback names immediately and probes without blocking the event loop', async () => {
    const binDir = createAsyncProbeCodex(
      'nonblocking',
      JSON.stringify([{ name: 'agent-tower' }]),
      { delayMs: 500 },
    );
    process.env.PATH = `${binDir}:${savedPath}`;
    const configPath = path.join(tmpDir, 'nonblocking.toml');
    fs.writeFileSync(configPath, '[mcp_servers.agent-tower]\ncommand = "agent-tower-mcp"\n');

    const startedAt = performance.now();
    const initial = getCachedCodexMcpServerNames([], configPath);
    const elapsed = performance.now() - startedAt;

    expect(initial).toEqual(new Set(['agent-tower']));
    expect(elapsed).toBeLessThan(100);

    await waitForCodexMcpServerCacheRefresh();
    expect(probeCount(binDir)).toBe(1);
    expect(getCachedCodexMcpServerNames([], configPath)).toEqual(new Set(['agent-tower']));
  });

  it('uses one in-flight probe for concurrent callers', async () => {
    const binDir = createAsyncProbeCodex('single-flight', JSON.stringify([{ name: 'agent-tower' }]), { delayMs: 100 });
    process.env.PATH = `${binDir}:${savedPath}`;
    const configPath = path.join(tmpDir, 'single-flight.toml');

    for (let i = 0; i < 8; i += 1) {
      expect(getCachedCodexMcpServerNames([], configPath)).toEqual(new Set());
    }
    await waitForCodexMcpServerCacheRefresh();

    expect(probeCount(binDir)).toBe(1);
    expect(getCachedCodexMcpServerNames([], configPath)).toEqual(new Set(['agent-tower']));
  });

  it('isolates cache entries by config/override inputs', async () => {
    const binDir = createAsyncProbeCodex('isolated', JSON.stringify([{ name: 'agent-tower' }]));
    process.env.PATH = `${binDir}:${savedPath}`;

    getCachedCodexMcpServerNames(['--profile', 'one'], path.join(tmpDir, 'one.toml'));
    getCachedCodexMcpServerNames(['--profile', 'two'], path.join(tmpDir, 'two.toml'));
    await waitForCodexMcpServerCacheRefresh();

    expect(probeCount(binDir)).toBe(2);
  });

  it('fails open and refreshes after the cache TTL', async () => {
    const binDir = createAsyncProbeCodex('failure-refresh', 'not json', { exitCode: 1 });
    process.env.PATH = `${binDir}:${savedPath}`;
    const configPath = path.join(tmpDir, 'failure-refresh.toml');
    fs.writeFileSync(configPath, '[mcp_servers.agent-tower]\ncommand = "agent-tower-mcp"\n');

    const now = Date.now();
    const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect(getCachedCodexMcpServerNames([], configPath)).toEqual(new Set(['agent-tower']));
      await waitForCodexMcpServerCacheRefresh();
      dateSpy.mockReturnValue(now + 30_001);
      expect(getCachedCodexMcpServerNames([], configPath)).toEqual(new Set(['agent-tower']));
      await waitForCodexMcpServerCacheRefresh();
      expect(probeCount(binDir)).toBe(2);
    } finally {
      dateSpy.mockRestore();
    }
  });

  it('uses the provider HOME/CODEX_HOME fallback on the first non-blocking lookup', async () => {
    const binDir = createAsyncProbeCodex('custom-home', JSON.stringify([]), { delayMs: 100 });
    const customHome = path.join(tmpDir, 'provider-codex-home');
    const customUserHome = path.join(tmpDir, 'provider-home');
    fs.mkdirSync(customHome, { recursive: true });
    fs.mkdirSync(customUserHome, { recursive: true });
    fs.writeFileSync(path.join(customHome, 'config.toml'), '[mcp_servers.agent-tower]\ncommand = "agent-tower-mcp"\n');

    const environment = {
      ...process.env,
      PATH: `${binDir}:${savedPath}`,
      CODEX_HOME: customHome,
      HOME: customUserHome,
    };
    const initial = getCachedCodexMcpServerNames([], undefined, { program: 'codex', args: [] }, environment);

    expect(initial).toEqual(new Set(['agent-tower']));
    await waitForCodexMcpServerCacheRefresh();
    expect(probeCount(binDir)).toBe(1);
  });
});

// ─── getCodexDeclaredMcpServerNames (config.toml fallback) ───────

describe('getCodexDeclaredMcpServerNames', () => {
  it('returns mcp_servers keys from a valid config.toml', () => {
    const configPath = path.join(tmpDir, 'both.toml');
    fs.writeFileSync(configPath, `
[mcp_servers.agent-tower]
command = "agent-tower-mcp"

[mcp_servers.agent-tower.env]
AGENT_TOWER_URL = "http://127.0.0.1:12580"

[mcp_servers.agent-tower-dev]
command = "npx"
args = ["tsx", "index.ts"]
`);
    const result = getCodexDeclaredMcpServerNames(configPath);
    expect(result).toEqual(new Set(['agent-tower', 'agent-tower-dev']));
  });

  it('returns only declared servers when agent-tower-dev is absent', () => {
    const configPath = path.join(tmpDir, 'only-at.toml');
    fs.writeFileSync(configPath, `
[mcp_servers.agent-tower]
command = "agent-tower-mcp"
`);
    const result = getCodexDeclaredMcpServerNames(configPath);
    expect(result).toEqual(new Set(['agent-tower']));
  });

  it('returns empty set when config file does not exist', () => {
    const result = getCodexDeclaredMcpServerNames(path.join(tmpDir, 'nonexistent.toml'));
    expect(result).toEqual(new Set());
  });

  it('returns empty set when config has no mcp_servers section', () => {
    const configPath = path.join(tmpDir, 'no-mcp.toml');
    fs.writeFileSync(configPath, `model = "gpt-5.5"\n`);
    const result = getCodexDeclaredMcpServerNames(configPath);
    expect(result).toEqual(new Set());
  });

  it('uses CODEX_HOME env to resolve config path when no explicit path given', () => {
    const customDir = path.join(tmpDir, 'custom-codex-home');
    fs.mkdirSync(customDir, { recursive: true });
    fs.writeFileSync(path.join(customDir, 'config.toml'), `
[mcp_servers.agent-tower]
command = "agent-tower-mcp"
`);
    process.env.CODEX_HOME = customDir;
    const result = getCodexDeclaredMcpServerNames();
    expect(result).toEqual(new Set(['agent-tower']));
  });

  it('returns empty set for invalid TOML content', () => {
    const configPath = path.join(tmpDir, 'invalid.toml');
    fs.writeFileSync(configPath, `[mcp_servers.agent-tower\nbroken`);
    const result = getCodexDeclaredMcpServerNames(configPath);
    expect(result).toEqual(new Set());
  });

  it('returns empty set when mcp_servers is not an object', () => {
    const configPath = path.join(tmpDir, 'mcp-string.toml');
    fs.writeFileSync(configPath, `mcp_servers = "not-an-object"\n`);
    const result = getCodexDeclaredMcpServerNames(configPath);
    expect(result).toEqual(new Set());
  });
});

// ─── queryCodexMcpServerNames (CLI primary path, fake codex) ─────

describe('queryCodexMcpServerNames', () => {
  it('parses valid JSON array and returns server names', () => {
    const json = JSON.stringify([
      { name: 'agent-tower', transport: 'stdio', enabled: true },
      { name: 'agent-tower-dev', transport: 'stdio', enabled: true },
    ]);
    const binDir = createFakeCodex('valid', json);
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${origPath}`;
    try {
      const result = queryCodexMcpServerNames();
      expect(result).toEqual(new Set(['agent-tower', 'agent-tower-dev']));
    } finally {
      process.env.PATH = origPath;
    }
  });

  it('places configOverrideArgs before subcommand (codex ...args mcp list --json)', () => {
    const json = JSON.stringify([{ name: 'agent-tower', transport: 'stdio', enabled: true }]);
    const binDir = createFakeCodex('arg-order', json);
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${origPath}`;
    try {
      queryCodexMcpServerNames(['--profile', 'myprofile', '-c', 'mcp_servers.x.command="y"']);
      const args = readCapturedArgs(binDir);
      expect(args).toEqual([
        '--profile', 'myprofile',
        '-c', 'mcp_servers.x.command="y"',
        'mcp', 'list', '--json',
      ]);
    } finally {
      process.env.PATH = origPath;
    }
  });

  it('returns only agent-tower when CLI output has one server', () => {
    const json = JSON.stringify([{ name: 'agent-tower', transport: 'stdio', enabled: true }]);
    const binDir = createFakeCodex('one-server', json);
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${origPath}`;
    try {
      const result = queryCodexMcpServerNames();
      expect(result).toEqual(new Set(['agent-tower']));
    } finally {
      process.env.PATH = origPath;
    }
  });

  it('returns empty set when CLI outputs empty array', () => {
    const binDir = createFakeCodex('empty-array', '[]');
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${origPath}`;
    try {
      const result = queryCodexMcpServerNames();
      expect(result).toEqual(new Set());
    } finally {
      process.env.PATH = origPath;
    }
  });

  it('returns null when CLI outputs non-JSON', () => {
    const binDir = createFakeCodex('non-json', 'not json at all');
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${origPath}`;
    try {
      expect(queryCodexMcpServerNames()).toBeNull();
    } finally {
      process.env.PATH = origPath;
    }
  });

  it('returns null when CLI outputs non-array JSON (object)', () => {
    const binDir = createFakeCodex('non-array', '{"servers": []}');
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${origPath}`;
    try {
      expect(queryCodexMcpServerNames()).toBeNull();
    } finally {
      process.env.PATH = origPath;
    }
  });

  it('returns null when array contains element without name field', () => {
    const json = JSON.stringify([
      { name: 'agent-tower', transport: 'stdio' },
      { transport: 'stdio', enabled: true },
    ]);
    const binDir = createFakeCodex('missing-name', json);
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${origPath}`;
    try {
      expect(queryCodexMcpServerNames()).toBeNull();
    } finally {
      process.env.PATH = origPath;
    }
  });

  it('returns null when array contains element with non-string name', () => {
    const json = JSON.stringify([
      { name: 'agent-tower', transport: 'stdio' },
      { name: 123, transport: 'stdio' },
    ]);
    const binDir = createFakeCodex('bad-name-type', json);
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${origPath}`;
    try {
      expect(queryCodexMcpServerNames()).toBeNull();
    } finally {
      process.env.PATH = origPath;
    }
  });

  it('returns null when array contains non-object element', () => {
    const json = JSON.stringify([
      { name: 'agent-tower', transport: 'stdio' },
      'not-an-object',
    ]);
    const binDir = createFakeCodex('non-object-element', json);
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${origPath}`;
    try {
      expect(queryCodexMcpServerNames()).toBeNull();
    } finally {
      process.env.PATH = origPath;
    }
  });

  it('returns null when CLI exits with non-zero code', () => {
    const binDir = createFakeCodex('exit-error', '', 1);
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${origPath}`;
    try {
      expect(queryCodexMcpServerNames()).toBeNull();
    } finally {
      process.env.PATH = origPath;
    }
  });

  it('returns null when codex CLI is not in PATH', () => {
    const origPath = process.env.PATH;
    process.env.PATH = '/nonexistent-path-only';
    try {
      expect(queryCodexMcpServerNames()).toBeNull();
    } finally {
      process.env.PATH = origPath;
    }
  });
});

// ─── detectDeclaredMcpServers (CLI + fallback) ──────────────────

describe('detectDeclaredMcpServers', () => {
  it('uses CLI result when available', () => {
    const json = JSON.stringify([
      { name: 'agent-tower', transport: 'stdio', enabled: true },
      { name: 'injected-mcp', transport: 'stdio', enabled: true },
    ]);
    const binDir = createFakeCodex('detect-cli', json);
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${origPath}`;
    try {
      const result = detectDeclaredMcpServers(['-c', 'mcp_servers.injected-mcp.command="x"']);
      expect(result).toEqual(new Set(['agent-tower', 'injected-mcp']));
    } finally {
      process.env.PATH = origPath;
    }
  });

  it('falls back to config.toml when CLI is unavailable', () => {
    const configPath = path.join(tmpDir, 'fallback.toml');
    fs.writeFileSync(configPath, `
[mcp_servers.agent-tower]
command = "echo"
`);
    const origPath = process.env.PATH;
    process.env.PATH = '/nonexistent-path-only';
    try {
      const result = detectDeclaredMcpServers([], configPath);
      expect(result).toEqual(new Set(['agent-tower']));
    } finally {
      process.env.PATH = origPath;
    }
  });

  it('falls back to config.toml when CLI output has bad schema', () => {
    const binDir = createFakeCodex('detect-bad-schema', '{"not": "array"}');
    const configPath = path.join(tmpDir, 'fallback-schema.toml');
    fs.writeFileSync(configPath, `
[mcp_servers.agent-tower]
command = "echo"
[mcp_servers.agent-tower-dev]
command = "npx"
`);
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${origPath}`;
    try {
      const result = detectDeclaredMcpServers([], configPath);
      expect(result).toEqual(new Set(['agent-tower', 'agent-tower-dev']));
    } finally {
      process.env.PATH = origPath;
    }
  });

  it('returns empty set when both CLI and config.toml fail', () => {
    const origPath = process.env.PATH;
    process.env.PATH = '/nonexistent-path-only';
    try {
      const result = detectDeclaredMcpServers([], path.join(tmpDir, 'no-such-file.toml'));
      expect(result).toEqual(new Set());
    } finally {
      process.env.PATH = origPath;
    }
  });
});

// ─── buildAgentTowerMcpEnvConfigOverrides ────────────────────────

describe('buildAgentTowerMcpEnvConfigOverrides', () => {
  it('generates overrides only for declared MCP servers (both present)', () => {
    const env = ExecutionEnv.default('/tmp/worktree').merge({
      AGENT_TOWER_SESSION_ID: 'session-1',
      AGENT_TOWER_INVOCATION_ID: 'invocation-1',
      AGENT_TOWER_TEAM_RUN_ID: 'team-run-1',
      AGENT_TOWER_MEMBER_ID: 'member-1',
      AGENT_TOWER_URL: 'http://127.0.0.1:42232',
      AGENT_TOWER_PORT: '42232',
      AGENT_TOWER_INTERNAL_TOKEN: 'internal-token',
    });
    const declared = new Set(['agent-tower', 'agent-tower-dev']);

    expect(buildAgentTowerMcpEnvConfigOverrides(env, declared)).toEqual([
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_SESSION_ID="session-1"',
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_INVOCATION_ID="invocation-1"',
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_TEAM_RUN_ID="team-run-1"',
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_MEMBER_ID="member-1"',
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_URL="http://127.0.0.1:42232"',
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_PORT="42232"',
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_INTERNAL_TOKEN="internal-token"',
      '-c',
      'mcp_servers.agent-tower-dev.env.AGENT_TOWER_SESSION_ID="session-1"',
      '-c',
      'mcp_servers.agent-tower-dev.env.AGENT_TOWER_INVOCATION_ID="invocation-1"',
      '-c',
      'mcp_servers.agent-tower-dev.env.AGENT_TOWER_TEAM_RUN_ID="team-run-1"',
      '-c',
      'mcp_servers.agent-tower-dev.env.AGENT_TOWER_MEMBER_ID="member-1"',
      '-c',
      'mcp_servers.agent-tower-dev.env.AGENT_TOWER_URL="http://127.0.0.1:42232"',
      '-c',
      'mcp_servers.agent-tower-dev.env.AGENT_TOWER_PORT="42232"',
      '-c',
      'mcp_servers.agent-tower-dev.env.AGENT_TOWER_INTERNAL_TOKEN="internal-token"',
    ]);
  });

  it('generates overrides only for agent-tower when agent-tower-dev is not declared', () => {
    const env = ExecutionEnv.default('/tmp/worktree').merge({
      AGENT_TOWER_SESSION_ID: 'session-1',
      AGENT_TOWER_INVOCATION_ID: 'invocation-1',
      AGENT_TOWER_TEAM_RUN_ID: 'team-run-1',
      AGENT_TOWER_MEMBER_ID: 'member-1',
      AGENT_TOWER_URL: 'http://127.0.0.1:42232',
      AGENT_TOWER_INTERNAL_TOKEN: 'internal-token',
    });
    const declared = new Set(['agent-tower']);

    expect(buildAgentTowerMcpEnvConfigOverrides(env, declared)).toEqual([
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_SESSION_ID="session-1"',
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_INVOCATION_ID="invocation-1"',
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_TEAM_RUN_ID="team-run-1"',
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_MEMBER_ID="member-1"',
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_URL="http://127.0.0.1:42232"',
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_INTERNAL_TOKEN="internal-token"',
    ]);
  });

  it('returns empty array when no MCP servers are declared', () => {
    const env = ExecutionEnv.default('/tmp/worktree').merge({
      AGENT_TOWER_SESSION_ID: 'session-1',
      AGENT_TOWER_TEAM_RUN_ID: 'team-run-1',
    });
    const declared = new Set<string>();

    expect(buildAgentTowerMcpEnvConfigOverrides(env, declared)).toEqual([]);
  });

  it('omits MCP identity overrides for non-TeamRun sessions', () => {
    const env = ExecutionEnv.default('/tmp/worktree');
    const declared = new Set(['agent-tower', 'agent-tower-dev']);

    expect(buildAgentTowerMcpEnvConfigOverrides(env, declared)).toEqual([]);
  });

  it('only projects Agent Tower MCP env keys', () => {
    const env = ExecutionEnv.default('/tmp/worktree').merge({
      AGENT_TOWER_TEAM_RUN_ID: 'team-run-1',
      AGENT_TOWER_URL: 'http://127.0.0.1:42232',
      AGENT_TOWER_INTERNAL_TOKEN: 'internal-token',
      OPENAI_API_KEY: 'provider-secret',
    });
    const declared = new Set(['agent-tower', 'agent-tower-dev']);

    expect(buildAgentTowerMcpEnvConfigOverrides(env, declared)).toEqual([
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_TEAM_RUN_ID="team-run-1"',
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_URL="http://127.0.0.1:42232"',
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_INTERNAL_TOKEN="internal-token"',
      '-c',
      'mcp_servers.agent-tower-dev.env.AGENT_TOWER_TEAM_RUN_ID="team-run-1"',
      '-c',
      'mcp_servers.agent-tower-dev.env.AGENT_TOWER_URL="http://127.0.0.1:42232"',
      '-c',
      'mcp_servers.agent-tower-dev.env.AGENT_TOWER_INTERNAL_TOKEN="internal-token"',
    ]);
  });
});
