import Fastify from 'fastify';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentType,
  CODEX_NATIVE_MODEL_PROVIDER_IDS,
  RuntimeType,
  type ProviderSecretWriteState,
} from '@agent-tower/shared';
import { providerRoutes } from '../providers.js';
import { getAllProviders, getProviderById, reloadProviders } from '../../executors/providers.js';
import { resetCodexModelCatalogForTests } from '../../services/codex-model-capabilities.service.js';
import { ExecutionPermissionService } from '../../services/execution-permission.service.js';
import * as claudeCapabilities from '../../services/claude-cli-capabilities.service.js';
import * as codexCapabilities from '../../services/codex-cli-capabilities.service.js';
import {
  AGENT_SUBPROCESS_BLOCKED_ENV_KEYS,
  AGENT_TOWER_MCP_IDENTITY_ENV_KEYS,
  AGENT_TOWER_MCP_SERVICE_ENV_KEYS,
} from '../../executors/execution-env.js';

const originalDataDir = process.env.AGENT_TOWER_DATA_DIR;
const originalPath = process.env.PATH;
let dataDir = '';
const protectedSubprocessEnvKeys = [
  ...AGENT_SUBPROCESS_BLOCKED_ENV_KEYS,
  ...AGENT_TOWER_MCP_IDENTITY_ENV_KEYS,
  ...AGENT_TOWER_MCP_SERVICE_ENV_KEYS,
];

interface WebProviderEnvDraftRow {
  key: string;
  value: string;
  write: ProviderSecretWriteState;
  configured: boolean;
  sensitive: boolean;
}

async function buildWebProviderEnvWrites(
  rows: WebProviderEnvDraftRow[],
): Promise<Record<string, ProviderSecretWriteState>> {
  const moduleUrl = new URL('../../../../web/src/components/provider/provider-draft.ts', import.meta.url);
  const webDraftModule = await import(moduleUrl.href) as {
    buildProviderEnvWrites: (
      draftRows: WebProviderEnvDraftRow[],
    ) => Record<string, ProviderSecretWriteState>;
  };
  return webDraftModule.buildProviderEnvWrites(rows);
}

async function buildBasicCredentialWire(
  redactedEnv: Record<string, { configured: boolean; sensitive: boolean }>,
  credentialKey: string,
  write: ProviderSecretWriteState,
): Promise<Record<string, ProviderSecretWriteState>> {
  const rows: WebProviderEnvDraftRow[] = Object.entries(redactedEnv).map(([key, metadata]) => ({
    key,
    value: '',
    write: { action: 'keep' },
    configured: metadata.configured,
    sensitive: metadata.sensitive,
  }));
  const activeIndex = rows.findIndex(row => row.key.trim() === credentialKey.trim());
  if (activeIndex < 0) throw new Error('Credential row was not returned by provider detail');
  rows[activeIndex] = {
    ...rows[activeIndex]!,
    value: write.action === 'replace' ? write.value : '',
    write,
  };
  return buildWebProviderEnvWrites(rows);
}

async function startLoopback(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback server did not bind a TCP port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

describe('provider routes', () => {
  it('resolves the current draft and lets an ASK-only deployment repair an imported invalid ASK Provider', async () => {
    const nativeSupport = claudeCapabilities.cachedClaudeCliAskSupport;
    // Host-build verification is covered separately; retain the real override check.
    const refresh = vi.spyOn(claudeCapabilities, 'refreshClaudeCliAskSupport').mockResolvedValue({ supported: true });
    const support = vi.spyOn(claudeCapabilities, 'cachedClaudeCliAskSupport').mockImplementation(provider => {
      const actual = nativeSupport(provider);
      return actual.message?.startsWith('Claude router,') ? actual : { supported: true };
    });
    const app = Fastify();
    await app.register(providerRoutes, { prefix: '/api', executionPermissions: new ExecutionPermissionService({ getAllowedModes: () => ['ASK'] }) });
    const providerId = 'imported-claude-router';
    const secret = 'private-capability-sentinel';
    try {
      const imported = await app.inject({ method: 'POST', url: '/api/providers/import', payload: {
        version: 2, kind: 'provider-backup', mode: 'full', exportedAt: new Date().toISOString(),
        providers: [{ id: providerId, name: 'Imported ASK', agentType: AgentType.CLAUDE_CODE, runtimeType: RuntimeType.CLI, executionPermission: 'ASK', config: { claudeCodeRouter: true }, env: { ANTHROPIC_API_KEY: secret } }],
      } });
      expect(imported.statusCode).toBe(200);
      const ask = (response: Awaited<ReturnType<typeof app.inject>>) => response.json().CLAUDE_CODE.executionPermissionOptions.CLI.find((option: { mode: string }) => option.mode === 'ASK');
      const saved = await app.inject({ method: 'GET', url: `/api/providers/capabilities?providerId=${providerId}` });
      expect(ask(saved).selectable).toBe(false);
      for (const config of [{}, { claudeCodeRouter: true }, { cmd: { baseCommandOverride: 'wrapper' } }, { cmd: { additionalParams: ['--extra'] } }, {}]) {
        const response = await app.inject({ method: 'POST', url: '/api/providers/capabilities', payload: { providerId, agentType: AgentType.CLAUDE_CODE, runtimeType: RuntimeType.CLI, config } });
        expect(response.statusCode).toBe(200);
        expect(ask(response)).toMatchObject({ selectable: Object.keys(config).length === 0, authorized: true });
        expect(response.json().CLAUDE_CODE.executionPermissionOptions.CLI.find((option: { mode: string }) => option.mode === 'FULL_ACCESS')).toMatchObject({ authorized: false, selectable: false });
        expect(response.body).not.toContain(secret);
        expect(response.json().CLAUDE_CODE).not.toHaveProperty('env');
        expect(response.json().CLAUDE_CODE).not.toHaveProperty('config');
        expect(response.json().CLAUDE_CODE).not.toHaveProperty('settings');
      }
      // Capability resolution is read-only; persisted invalid state remains until save.
      expect(ask(await app.inject({ method: 'GET', url: `/api/providers/capabilities?providerId=${providerId}` })).selectable).toBe(false);
      const fixed = await app.inject({ method: 'PUT', url: `/api/providers/${providerId}`, payload: { config: {}, executionPermission: 'ASK' } });
      expect(fixed.statusCode).toBe(200); expect(fixed.json().executionPermission).toBe('ASK');
      const rejected = await app.inject({ method: 'PUT', url: `/api/providers/${providerId}`, payload: { config: { cmd: { baseCommandOverride: 'wrapper' } }, executionPermission: 'ASK' } });
      expect(rejected.statusCode).toBe(400); expect(rejected.json().diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CAPABILITY_UNVERIFIED' })]));
    } finally { await app.close(); refresh.mockRestore(); support.mockRestore(); }
  });
  it('uses the injected allowed-mode policy for capability UI, save and test', async () => {
    const app = Fastify();
    const executionPermissions = new ExecutionPermissionService({ getAllowedModes: () => ['ASK', 'AUTO_SANDBOX'] });
    await app.register(providerRoutes, { prefix: '/api', executionPermissions });
    const capabilities = (await app.inject({ method: 'GET', url: '/api/providers/capabilities' })).json();
    expect(capabilities.CODEX.executionPermissionOptions.ACP).toEqual(expect.arrayContaining([
      expect.objectContaining({ mode: 'FULL_ACCESS', supported: true, authorized: false, selectable: false }),
    ]));
    expect(capabilities.PI_CODING_AGENT.executionPermissionOptions.ACP.every((option: { selectable: boolean }) => !option.selectable)).toBe(true);
    for (const url of ['/api/providers', '/api/providers/test']) {
      const response = await app.inject({ method: 'POST', url, payload: {
        name: 'Restricted', agentType: AgentType.CODEX, runtimeType: RuntimeType.ACP, executionPermission: 'FULL_ACCESS',
      } });
      expect(response.statusCode).toBe(403);
      expect(response.json().diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'POLICY_MODE_DENIED' })]));
    }
    await app.close();
  });
  it('keeps the deployment boundary for Codex CLI auto-review across draft models', async () => {
    const refresh = vi.spyOn(codexCapabilities, 'refreshCodexCliSupport').mockResolvedValue({ supported: true });
    const support = vi.spyOn(codexCapabilities, 'cachedCodexCliSupport').mockReturnValue({ supported: true });
    const app = Fastify();
    await app.register(providerRoutes, { prefix: '/api', executionPermissions: new ExecutionPermissionService({ getAllowedModes: () => ['ASK', 'AUTO_SANDBOX'] }) });
    try {
      const option = (response: Awaited<ReturnType<typeof app.inject>>) => response.json().CODEX.executionPermissionOptions.CLI.find((item: { mode: string }) => item.mode === 'AUTO_SANDBOX');
      for (const config of [{}, { model: 'gpt-6.1-sol' }]) {
        const restricted = await app.inject({ method: 'POST', url: '/api/providers/capabilities', payload: { agentType: AgentType.CODEX, runtimeType: RuntimeType.CLI, config } });
        expect(option(restricted)).toMatchObject({ supported: true, authorized: false, selectable: false, reasons: [{ code: 'POLICY_ENFORCEMENT_UNAVAILABLE' }] });
        expect(restricted.body).not.toContain('model_providers');
        for (const url of ['/api/providers', '/api/providers/test']) {
          const response = await app.inject({ method: 'POST', url, payload: {
            name: 'Restricted auto-review', agentType: AgentType.CODEX, runtimeType: RuntimeType.CLI,
            executionPermission: 'AUTO_SANDBOX', config,
          } });
          expect(response.statusCode, response.body).toBe(403);
          expect(response.json().diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'POLICY_ENFORCEMENT_UNAVAILABLE' })]));
        }
      }
      const backup = { version: 2, kind: 'provider-backup', mode: 'full', exportedAt: new Date().toISOString(), providers: [{
        id: 'restricted-auto-review', name: 'Restricted auto-review', agentType: AgentType.CODEX,
        runtimeType: RuntimeType.CLI, executionPermission: 'AUTO_SANDBOX', config: { model: 'gpt-6-sol' }, env: {},
      }] };
      for (const url of ['/api/providers/import/preview', '/api/providers/import']) {
        const response = await app.inject({ method: 'POST', url, payload: backup });
        expect(response.statusCode, response.body).toBe(403);
        expect(response.json().diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'POLICY_ENFORCEMENT_UNAVAILABLE' })]));
      }
    } finally { await app.close(); refresh.mockRestore(); support.mockRestore(); }
  });

  it.each([{}, { model: 'gpt-6.1-sol' }])('accepts Codex CLI AUTO_SANDBOX drafts, saves and tests with config %j', async config => {
    const refresh = vi.spyOn(codexCapabilities, 'refreshCodexCliSupport').mockResolvedValue({ supported: true });
    const support = vi.spyOn(codexCapabilities, 'cachedCodexCliSupport').mockReturnValue({ supported: true });
    const app = await createApp();
    try {
      const draft = { name: 'Codex AUTO', agentType: AgentType.CODEX, runtimeType: RuntimeType.CLI,
        executionPermission: 'AUTO_SANDBOX' as const, config };
      const capabilities = await app.inject({ method: 'POST', url: '/api/providers/capabilities', payload: draft });
      expect(capabilities.json().CODEX.executionPermissionOptions.CLI.find((option: { mode: string }) => option.mode === 'AUTO_SANDBOX'))
        .toMatchObject({ supported: true, authorized: true, selectable: true, reasons: [] });
      const created = await app.inject({ method: 'POST', url: '/api/providers', payload: draft });
      expect(created.statusCode, created.body).toBe(201);
      expect(created.json().executionPermission).toBe('AUTO_SANDBOX');
      const saved = await app.inject({ method: 'GET', url: `/api/providers/capabilities?providerId=${created.json().id}` });
      expect(saved.json().CODEX.executionPermissionOptions.CLI.find((option: { mode: string }) => option.mode === 'AUTO_SANDBOX'))
        .toMatchObject({ supported: true, authorized: true, selectable: true, reasons: [] });
      const tested = await app.inject({ method: 'POST', url: '/api/providers/test', payload: draft });
      expect(tested.statusCode, tested.body).toBe(200);
      expect(tested.json().diagnostics ?? []).not.toEqual(expect.arrayContaining([expect.objectContaining({ field: 'executionPermission' })]));
    } finally { await app.close(); refresh.mockRestore(); support.mockRestore(); }
  });

  it('rejects Codex CLI AUTO_SANDBOX advanced sandbox overrides in draft, save, test and import', async () => {
    const refresh = vi.spyOn(codexCapabilities, 'refreshCodexCliSupport').mockResolvedValue({ supported: true });
    const support = vi.spyOn(codexCapabilities, 'cachedCodexCliSupport').mockReturnValue({ supported: true });
    const app = await createApp();
    const providerId = 'codex-auto-safe';
    const settings = '[sandbox_workspace_write]\nwritable_roots=["/outside"]\nnetwork_access=true';
    try {
      const draft = { name: 'Codex AUTO', agentType: AgentType.CODEX, runtimeType: RuntimeType.CLI,
        executionPermission: 'AUTO_SANDBOX' as const, config: { model: 'gpt-6-sol' }, settings };
      const option = (response: Awaited<ReturnType<typeof app.inject>>) => response.json().CODEX.executionPermissionOptions.CLI.find((item: { mode: string }) => item.mode === 'AUTO_SANDBOX');
      const capabilities = await app.inject({ method: 'POST', url: '/api/providers/capabilities', payload: { ...draft, model: 'gpt-6-sol' } });
      expect(option(capabilities)).toMatchObject({ supported: false, selectable: false, reasons: [{ code: 'CONFLICT' }] });
      expect(option(await app.inject({ method: 'POST', url: '/api/providers/capabilities', payload: { ...draft, model: 'gpt-6-sol', settings: '' } })))
        .toMatchObject({ supported: true, selectable: true });
      for (const url of ['/api/providers', '/api/providers/test']) {
        const response = await app.inject({ method: 'POST', url, payload: draft });
        expect(response.statusCode, response.body).toBe(url === '/api/providers/test' ? 200 : 400);
        if (url === '/api/providers/test') expect(response.json()).toMatchObject({ ok: false, stage: 'validation' });
        expect(response.json().diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CONFLICT' })]));
      }
      const created = await app.inject({ method: 'POST', url: '/api/providers', payload: { ...draft, settings: '' } });
      expect(created.statusCode, created.body).toBe(201);
      const savedId = created.json().id as string;
      const update = await app.inject({ method: 'PUT', url: `/api/providers/${savedId}`, payload: { settings } });
      expect(update.statusCode, update.body).toBe(400);
      expect(update.json().diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CONFLICT' })]));
      const backup = { version: 2, kind: 'provider-backup', mode: 'full', exportedAt: new Date().toISOString(),
        providers: [{ ...draft, id: providerId, env: {}, isDefault: false }] };
      for (const url of ['/api/providers/import/preview', '/api/providers/import']) {
        const response = await app.inject({ method: 'POST', url, payload: backup });
        expect(response.statusCode, response.body).toBe(400);
        expect(response.json().diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CONFLICT' })]));
      }
      expect(getProviderById(providerId)).toBeNull();
    } finally { await app.close(); refresh.mockRestore(); support.mockRestore(); }
  });

  it('defaults fresh Providers to ASK, blocks unsupported selections and never upgrades them', async () => {
    const app = Fastify();
    await app.register(providerRoutes, { prefix: '/api' });
    const created = await app.inject({ method: 'POST', url: '/api/providers', payload: {
      name: 'New Codex ACP', agentType: AgentType.CODEX, runtimeType: RuntimeType.ACP,
    } });
    expect(created.statusCode).toBe(201);
    expect(created.json().executionPermission).toBe('ASK');
    const blocked = await app.inject({ method: 'POST', url: '/api/providers', payload: {
      name: 'New Pi', agentType: AgentType.PI_CODING_AGENT, runtimeType: RuntimeType.ACP,
    } });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json().diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'AGENT_MODE_UNSUPPORTED' })]));
    await app.close();
  });
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-provider-routes-'));
    process.env.AGENT_TOWER_DATA_DIR = dataDir;
    reloadProviders();
    const binDir = path.join(dataDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`;
  });

  afterEach(() => {
    resetCodexModelCatalogForTests();
    if (originalDataDir === undefined) delete process.env.AGENT_TOWER_DATA_DIR;
    else process.env.AGENT_TOWER_DATA_DIR = originalDataDir;
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    fs.rmSync(dataDir, { recursive: true, force: true });
    reloadProviders();
  });

  async function createApp(connectionProbe?: { timeoutMs?: number }) {
    const app = Fastify();
    await app.register(providerRoutes, { prefix: '/api', connectionProbe });
    return app;
  }

  it('returns the shared capability matrix', async () => {
    const app = await createApp();
    const response = await app.inject({ method: 'GET', url: '/api/providers/capabilities' });
    expect(response.statusCode).toBe(200);
    expect(response.json()[AgentType.CODEX]).toMatchObject({
      apiKey: { path: 'OPENAI_API_KEY' },
      reasoningEffort: { path: 'model_reasoning_effort' },
      fastMode: { kind: 'config', path: 'fastMode' },
      disableResponsesWebsocket: { kind: 'config', path: 'disableResponsesWebsocket' },
    });
    expect(response.json()[AgentType.GEMINI_CLI]).toMatchObject({
      apiKey: { kind: 'env', path: 'GEMINI_API_KEY' },
      model: { kind: 'config', path: 'model' },
    });
    expect(response.json()[AgentType.QWEN_CODE]).toMatchObject({
      apiBaseUrl: { kind: 'env', path: 'OPENAI_BASE_URL' },
      apiKey: { kind: 'env', path: 'OPENAI_API_KEY' },
      model: { kind: 'config', path: 'model' },
    });
    expect(response.json()[AgentType.PI_CODING_AGENT]).toMatchObject({
      apiBaseUrl: { kind: 'env', path: 'OPENAI_BASE_URL' },
      apiKey: { kind: 'env', path: 'OPENAI_API_KEY' },
      reasoningEffort: { kind: 'config', path: 'effort' },
    });
    expect(response.json()[AgentType.MINION_CODE]).toBeUndefined();
    await app.close();
  });

  it('offers the documented GPT-6 effort ceiling for both Codex runtimes', async () => {
    const catalog = {
      models: [
        { slug: 'gpt-6-sol', supported_reasoning_levels: [{ effort: 'low' }] },
        { slug: 'gpt-6-luna', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }] },
      ],
    };
    fs.writeFileSync(
      path.join(dataDir, 'bin', 'codex'),
      `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(catalog)}'\n`,
      { mode: 0o755 },
    );
    resetCodexModelCatalogForTests();
    const app = await createApp();

    for (const [model, effort] of [['gpt-6-sol', 'ultra'], ['gpt-6-luna', 'max']] as const) {
      const capabilities = await app.inject({
        method: 'GET',
        url: `/api/providers/capabilities?agentType=CODEX&model=${model}`,
      });
      expect(capabilities.statusCode).toBe(200);
      const options = capabilities.json()[AgentType.CODEX].reasoningEffort.options as string[];
      expect(options).toContain(effort);
      if (model === 'gpt-6-luna') expect(options).not.toContain('ultra');

      for (const runtimeType of [RuntimeType.CLI, RuntimeType.ACP]) {
        const created = await app.inject({
          method: 'POST',
          url: '/api/providers',
          payload: {
            name: `${model} ${runtimeType}`,
            agentType: AgentType.CODEX,
        executionPermission: 'FULL_ACCESS',
            runtimeType,
            simplified: { model, reasoningEffort: effort },
          },
        });
        expect(created.statusCode).toBe(201);
        expect(created.json()).toMatchObject({
          runtimeType,
          config: { model },
          settings: `model_reasoning_effort = "${effort}"`,
        });
      }
    }

    const unsupported = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: {
        name: 'Luna Ultra',
        agentType: AgentType.CODEX,
        executionPermission: 'FULL_ACCESS',
        runtimeType: RuntimeType.ACP,
        simplified: { model: 'gpt-6-luna', reasoningEffort: 'ultra' },
      },
    });
    expect(unsupported.statusCode).toBe(400);
    expect(unsupported.json()).toMatchObject({
      diagnostics: [{ field: 'reasoningEffort', code: 'INVALID_ENUM' }],
    });
    await app.close();
  });

  it('rejects creating a hidden Minion Code provider', async () => {
    const app = await createApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: {
        name: 'Minion Code Hidden',
        agentType: AgentType.MINION_CODE,
        runtimeType: RuntimeType.ACP,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'Invalid provider configuration' });
    await app.close();
  });

  it('creates Codex ACP providers with write-only secrets and keeps their runtime immutable', async () => {
    const app = await createApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: {
        name: 'Codex ACP Custom',
        agentType: AgentType.CODEX,
        executionPermission: 'ASK',
        runtimeType: RuntimeType.ACP,
        env: { OPENAI_API_KEY: { action: 'replace', value: 'acp-route-secret' } },
        config: {},
        simplified: {
          apiBaseUrl: 'https://proxy.example/v1',
          model: 'gpt-acp',
        },
      },
    });

    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain('acp-route-secret');
    expect(created.json()).toMatchObject({
      agentType: AgentType.CODEX,
      runtimeType: RuntimeType.ACP,
      executionPermission: 'ASK',
      config: { model: 'gpt-acp' },
      redactedEnv: { OPENAI_API_KEY: { configured: true, sensitive: true } },
    });
    const providerId = created.json().id as string;

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/providers/${providerId}`,
      payload: { name: 'Codex ACP Renamed', runtimeType: RuntimeType.CLI },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      name: 'Codex ACP Renamed',
      runtimeType: RuntimeType.ACP,
    });
    expect(getProviderById(providerId)?.runtimeType).toBe(RuntimeType.ACP);
    await app.close();
  });

  it.each([
    {
      name: 'Claude Code ACP Custom',
      agentType: AgentType.CLAUDE_CODE,
        executionPermission: 'FULL_ACCESS',
      secretKey: 'ANTHROPIC_API_KEY',
      secret: 'claude-acp-route-secret',
      apiBaseUrl: 'https://anthropic-gateway.example/v1',
      model: 'claude-sonnet-test',
      reasoningEffort: 'high',
    },
    {
      name: 'Qwen Code ACP Custom',
      agentType: AgentType.QWEN_CODE,
      secretKey: 'OPENAI_API_KEY',
      secret: 'qwen-acp-route-secret',
      apiBaseUrl: 'https://dashscope.example/v1',
      model: 'qwen3-coder-test',
      reasoningEffort: undefined,
    },
  ])('creates $name with its Agent credentials and ACP runtime', async ({
    name,
    agentType,
    secretKey,
    secret,
    apiBaseUrl,
    model,
    reasoningEffort,
  }) => {
    const app = await createApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: {
        name,
        agentType,
        runtimeType: RuntimeType.ACP,
        env: { [secretKey]: { action: 'replace', value: secret } },
        config: { permissionMode: 'UNRESTRICTED' },
        simplified: { apiBaseUrl, model, reasoningEffort },
      },
    });

    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain(secret);
    expect(created.json()).toMatchObject({
      agentType,
      runtimeType: RuntimeType.ACP,
      executionPermission: 'FULL_ACCESS',
      config: { model },
      redactedEnv: { [secretKey]: { configured: true, sensitive: true } },
      simplified: {
        apiBaseUrl,
        apiKey: { configured: true, envKey: secretKey },
        model,
      },
    });
    expect(getProviderById(created.json().id)?.runtimeType).toBe(RuntimeType.ACP);
    await app.close();
  });

  it('migrates the legacy ACP AUTO_APPROVE value to FULL_ACCESS', async () => {
    const app = await createApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: {
        name: 'Legacy ACP Permission',
        agentType: AgentType.CODEX,
        runtimeType: RuntimeType.ACP,
        config: { permissionMode: 'AUTO_APPROVE' },
      },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      executionPermission: 'FULL_ACCESS',
      config: {},
    });
    await app.close();
  });

  it('migrates dangerous flags and rejects conflicting legacy ASK fields', async () => {
    const app = await createApp();
    const legacyFlag = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: {
        name: 'Legacy Cursor Force',
        agentType: AgentType.CURSOR_AGENT,
        runtimeType: RuntimeType.ACP,
        config: { force: true },
      },
    });
    expect(legacyFlag.statusCode).toBe(201);
    expect(legacyFlag.json().config).toEqual({});
    expect(legacyFlag.json().executionPermission).toBe('FULL_ACCESS');

    const explicitAsk = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: {
        name: 'Explicit Ask Overrides Legacy',
        agentType: AgentType.QWEN_CODE,
        runtimeType: RuntimeType.ACP,
        config: { permissionMode: 'ASK', yolo: true },
      },
    });
    expect(explicitAsk.statusCode).toBe(400);
    expect(explicitAsk.json().diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'executionPermission', code: 'CONFLICT' })]));
    await app.close();
  });

  it('rejects unsupported Runtime choices and invalid ACP permission values', async () => {
    const app = await createApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: {
        name: 'Kiro CLI Runtime',
        agentType: AgentType.KIRO_CLI,
        runtimeType: RuntimeType.CLI,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      diagnostics: [{ code: 'INVALID_ENUM' }],
    });

    const invalidPermission = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: {
        name: 'Codex ACP Invalid Permission',
        agentType: AgentType.CODEX,
        runtimeType: RuntimeType.ACP,
        config: { permissionMode: 'ALWAYS' },
      },
    });
    expect(invalidPermission.statusCode).toBe(400);
    expect(invalidPermission.json()).toMatchObject({
      diagnostics: [{ field: 'executionPermission', code: 'INVALID_ENUM' }],
    });
    await app.close();
  });

  it('rejects incomplete API URLs before save or test while accepting complete URLs', async () => {
    const app = await createApp();

    for (const [index, apiBaseUrl] of ['http:host', 'https:/host', 'https:host'].entries()) {
      const payload = {
        name: `Invalid URL ${index}`,
        agentType: AgentType.CODEX,
        executionPermission: 'FULL_ACCESS',
        simplified: { apiBaseUrl },
      };
      const created = await app.inject({ method: 'POST', url: '/api/providers', payload });
      expect(created.statusCode).toBe(400);
      expect(created.json()).toMatchObject({
        diagnostics: [{ field: 'apiBaseUrl', code: 'INVALID_URL' }],
      });

      const tested = await app.inject({ method: 'POST', url: '/api/providers/test', payload });
      expect(tested.statusCode).toBe(200);
      expect(tested.json()).toMatchObject({
        ok: false,
        stage: 'validation',
        diagnostics: [{ field: 'apiBaseUrl', code: 'INVALID_URL' }],
      });
    }

    for (const [index, apiBaseUrl] of ['http://localhost:8080', 'https://proxy.example/v1'].entries()) {
      const created = await app.inject({
        method: 'POST',
        url: '/api/providers',
        payload: {
          name: `Valid URL ${index}`,
          agentType: AgentType.CODEX,
        executionPermission: 'FULL_ACCESS',
          simplified: { apiBaseUrl },
        },
      });
      expect(created.statusCode).toBe(201);
    }

    await app.close();
  });

  it('supports write-only Gemini API key create, keep, replace, and clear', async () => {
    const app = await createApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: {
        name: 'Gemini Custom',
        agentType: AgentType.GEMINI_CLI,
        executionPermission: 'FULL_ACCESS',
        env: { GEMINI_API_KEY: { action: 'replace', value: 'gemini-route-secret' } },
        simplified: { model: 'gemini-test' },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain('gemini-route-secret');
    expect(created.json()).toMatchObject({
      redactedEnv: { GEMINI_API_KEY: { configured: true, sensitive: true } },
      simplified: {
        apiKey: { configured: true, envKey: 'GEMINI_API_KEY' },
        model: 'gemini-test',
      },
    });
    const id = created.json().id as string;

    const kept = await app.inject({
      method: 'PUT',
      url: `/api/providers/${id}`,
      payload: { env: { GEMINI_API_KEY: { action: 'keep' } } },
    });
    expect(kept.statusCode).toBe(200);
    expect(getProviderById(id)?.env.GEMINI_API_KEY).toBe('gemini-route-secret');

    const replaced = await app.inject({
      method: 'PUT',
      url: `/api/providers/${id}`,
      payload: { env: { GEMINI_API_KEY: { action: 'replace', value: 'gemini-replaced-secret' } } },
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.body).not.toContain('gemini-replaced-secret');
    expect(getProviderById(id)?.env.GEMINI_API_KEY).toBe('gemini-replaced-secret');

    const cleared = await app.inject({
      method: 'PUT',
      url: `/api/providers/${id}`,
      payload: { env: { GEMINI_API_KEY: { action: 'clear' } } },
    });
    expect(cleared.statusCode).toBe(200);
    expect(getProviderById(id)?.env.GEMINI_API_KEY).toBeUndefined();
    await app.close();
  });

  it('never returns a saved key while keep preserves it internally', async () => {
    const app = await createApp();
    const secret = 'sk-route-secret-value';
    const created = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: {
        name: 'Codex Proxy',
        agentType: AgentType.CODEX,
        executionPermission: 'FULL_ACCESS',
        env: { OPENAI_API_KEY: { action: 'replace', value: secret } },
        simplified: {
          apiBaseUrl: 'https://proxy.example/v1',
          model: 'gpt-test',
          reasoningEffort: 'high',
        },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain(secret);
    const id = created.json().id as string;
    expect(getProviderById(id)?.env.OPENAI_API_KEY).toBe(secret);

    const detail = await app.inject({ method: 'GET', url: `/api/providers/${id}` });
    expect(detail.body).not.toContain(secret);
    expect(detail.json()).toMatchObject({
      redactedEnv: { OPENAI_API_KEY: { configured: true, sensitive: true } },
      simplified: {
        apiBaseUrl: 'https://proxy.example/v1',
        apiKey: { configured: true, envKey: 'OPENAI_API_KEY' },
      },
    });

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/providers/${id}`,
      payload: {
        name: 'Codex Proxy Renamed',
        env: { OPENAI_API_KEY: { action: 'keep' } },
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.body).not.toContain(secret);
    expect(getProviderById(id)?.env.OPENAI_API_KEY).toBe(secret);
    await app.close();
  });

  it('redacts a non-typical active custom credential env key in create and detail responses', async () => {
    const app = await createApp();
    const secret = 'dynamic-route-value-sentinel';
    const created = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: {
        name: 'Codex Dynamic Credential',
        agentType: AgentType.CODEX,
        executionPermission: 'FULL_ACCESS',
        env: { PROXY_ACCESS: { action: 'replace', value: secret } },
        settings: [
          'model_provider = "proxy"',
          '[model_providers.proxy]',
          'base_url = "https://proxy.example/v1"',
          'env_key = "PROXY_ACCESS"',
        ].join('\n'),
      },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      redactedEnv: { PROXY_ACCESS: { configured: true, sensitive: true } },
      simplified: { apiKey: { configured: true, envKey: 'PROXY_ACCESS' } },
    });
    expect(created.body.includes(secret)).toBe(false);

    const detail = await app.inject({ method: 'GET', url: `/api/providers/${created.json().id}` });
    expect(detail.json()).toMatchObject({
      redactedEnv: { PROXY_ACCESS: { configured: true, sensitive: true } },
    });
    expect(detail.body.includes(secret)).toBe(false);
    await app.close();
  });

  it.each([
    ['canonical first', ['PROXY_ACCESS', '  PROXY_ACCESS  ']],
    ['spaced alias first', ['  PROXY_ACCESS  ', 'PROXY_ACCESS']],
  ] as const)('preserves Web explicit writes for duplicate aliases with %s', async (_label, aliasKeys) => {
    const app = await createApp();
    const providerId = `imported-duplicate-credential-${aliasKeys[0] === aliasKeys[0].trim() ? 'canonical' : 'spaced'}`;
    const canonicalKey = 'PROXY_ACCESS';
    const importedSentinels = ['imported-first-sentinel', 'imported-second-sentinel'];
    const firstReplacementSentinel = 'first-replacement-sentinel';
    const secondReplacementSentinel = 'second-replacement-sentinel';
    const unknownSentinel = 'unknown-env-sentinel';
    const backup = {
      version: 1,
      kind: 'provider-backup',
      exportedAt: new Date().toISOString(),
      mode: 'full',
      providers: [{
        id: providerId,
        name: 'Imported Spaced Credential',
        agentType: AgentType.CODEX,
        executionPermission: 'FULL_ACCESS',
        env: Object.fromEntries([
          ...aliasKeys.map((key, index) => [key, importedSentinels[index]!]),
          ['UNKNOWN_ENV', unknownSentinel],
        ]),
        config: {},
        settings: [
          'model_provider = "proxy"',
          '[model_providers.proxy]',
          'base_url = "https://proxy.example/v1"',
          `env_key = "${canonicalKey}"`,
        ].join('\n'),
        isDefault: false,
      }],
    } as const;

    const imported = await app.inject({
      method: 'POST',
      url: '/api/providers/import',
      payload: backup,
    });
    expect(imported.statusCode).toBe(200);
    const importedDetail = await app.inject({ method: 'GET', url: `/api/providers/${providerId}` });
    expect(importedDetail.statusCode).toBe(200);
    expect(Object.keys(importedDetail.json().redactedEnv).filter(key => key.trim() === canonicalKey)).toEqual(aliasKeys);

    const firstWire = await buildBasicCredentialWire(
      importedDetail.json().redactedEnv,
      canonicalKey,
      { action: 'replace', value: firstReplacementSentinel },
    );
    expect(Object.entries(firstWire).filter(([key]) => key.trim() === canonicalKey)).toEqual([
      [canonicalKey, { action: 'replace', value: firstReplacementSentinel }],
    ]);

    const firstReplace = await app.inject({
      method: 'PUT',
      url: `/api/providers/${providerId}`,
      payload: { env: firstWire },
    });
    expect(firstReplace.statusCode).toBe(200);
    expect(firstReplace.body.includes(firstReplacementSentinel)).toBe(false);

    reloadProviders();
    const afterFirstReplace = getProviderById(providerId)!;
    expect(Object.keys(afterFirstReplace.env).filter(key => key.trim() === canonicalKey)).toEqual([canonicalKey]);
    expect(afterFirstReplace.env[canonicalKey] === firstReplacementSentinel).toBe(true);
    expect(afterFirstReplace.env.UNKNOWN_ENV === unknownSentinel).toBe(true);

    const reopened = await app.inject({ method: 'GET', url: `/api/providers/${providerId}` });
    expect(reopened.statusCode).toBe(200);
    expect(Object.keys(reopened.json().redactedEnv).filter(key => key.trim() === canonicalKey)).toEqual([canonicalKey]);
    expect(reopened.body.includes(firstReplacementSentinel)).toBe(false);

    const secondWire = await buildBasicCredentialWire(
      reopened.json().redactedEnv,
      canonicalKey,
      { action: 'replace', value: secondReplacementSentinel },
    );
    const secondReplace = await app.inject({
      method: 'PUT',
      url: `/api/providers/${providerId}`,
      payload: { env: secondWire },
    });
    expect(secondReplace.statusCode).toBe(200);
    expect(secondReplace.body.includes(secondReplacementSentinel)).toBe(false);

    reloadProviders();
    const afterSecondReplace = getProviderById(providerId)!;
    expect(Object.keys(afterSecondReplace.env).filter(key => key.trim() === canonicalKey)).toEqual([canonicalKey]);
    expect(afterSecondReplace.env[canonicalKey] === secondReplacementSentinel).toBe(true);
    expect(afterSecondReplace.env.UNKNOWN_ENV === unknownSentinel).toBe(true);

    const afterSecondDetail = await app.inject({ method: 'GET', url: `/api/providers/${providerId}` });
    expect(afterSecondDetail.statusCode).toBe(200);
    const clearWire = await buildBasicCredentialWire(
      afterSecondDetail.json().redactedEnv,
      canonicalKey,
      { action: 'clear' },
    );
    expect(Object.entries(clearWire).filter(([key]) => key.trim() === canonicalKey)).toEqual([
      [canonicalKey, { action: 'clear' }],
    ]);
    const cleared = await app.inject({
      method: 'PUT',
      url: `/api/providers/${providerId}`,
      payload: { env: clearWire },
    });
    expect(cleared.statusCode).toBe(200);

    reloadProviders();
    const afterClear = getProviderById(providerId)!;
    expect(Object.keys(afterClear.env).some(key => key.trim() === canonicalKey)).toBe(false);
    expect(afterClear.env.UNKNOWN_ENV === unknownSentinel).toBe(true);
    const clearedDetail = await app.inject({ method: 'GET', url: `/api/providers/${providerId}` });
    expect(clearedDetail.statusCode).toBe(200);
    expect(Object.keys(clearedDetail.json().redactedEnv).some(key => key.trim() === canonicalKey)).toBe(false);
    expect(clearedDetail.json().redactedEnv.UNKNOWN_ENV).toMatchObject({ configured: true });
    for (const sentinel of [...importedSentinels, firstReplacementSentinel, secondReplacementSentinel]) {
      expect([
        imported,
        importedDetail,
        firstReplace,
        reopened,
        secondReplace,
        afterSecondDetail,
        cleared,
        clearedDetail,
      ].some(response => response.body.includes(sentinel))).toBe(false);
    }
    await app.close();
  });

  it.each(protectedSubprocessEnvKeys)(
    'rejects protected custom credential env_key %s consistently for test and save',
    async envKey => {
      const app = await createApp();
      const countBefore = getAllProviders().length;
      const secret = 'protected-route-value-sentinel';
      const payload = {
        name: 'Codex Protected Credential',
        agentType: AgentType.CODEX,
        executionPermission: 'FULL_ACCESS',
        env: { [envKey]: { action: 'replace' as const, value: secret } },
        settings: [
          'model_provider = "proxy"',
          '[model_providers.proxy]',
          'base_url = "https://proxy.example/v1"',
          `env_key = ${JSON.stringify(envKey)}`,
        ].join('\n'),
      };
      const expectedDiagnostic = {
        field: 'apiKey',
        code: 'CONFLICT',
        message: 'Active Codex env_key is reserved for Agent Tower subprocess internals',
      };

      const tested = await app.inject({ method: 'POST', url: '/api/providers/test', payload });
      const created = await app.inject({ method: 'POST', url: '/api/providers', payload });

      expect(tested.statusCode).toBe(200);
      expect(tested.json()).toMatchObject({
        ok: false,
        stage: 'validation',
        diagnostics: [expectedDiagnostic],
      });
      expect(created.statusCode).toBe(400);
      expect(created.json()).toMatchObject({ diagnostics: [expectedDiagnostic] });
      expect(tested.body.includes(secret)).toBe(false);
      expect(created.body.includes(secret)).toBe(false);
      expect(getAllProviders()).toHaveLength(countBefore);
      await app.close();
    },
  );

  it('tests an unsaved draft without persisting it or leaking its key', async () => {
    const app = await createApp();
    const countBefore = getAllProviders().length;
    const secret = 'unsaved-test-secret';
    const response = await app.inject({
      method: 'POST',
      url: '/api/providers/test',
      payload: {
        name: 'Unsaved Claude',
        agentType: AgentType.CLAUDE_CODE,
        executionPermission: 'FULL_ACCESS',
        env: { ANTHROPIC_API_KEY: { action: 'replace', value: secret } },
        config: {},
        settings: '{"env":{"ANTHROPIC_API_KEY":"settings-secret"}}',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(secret);
    expect(response.body).not.toContain('settings-secret');
    expect(getAllProviders()).toHaveLength(countBefore);
    await app.close();
  });

  it.each(CODEX_NATIVE_MODEL_PROVIDER_IDS)(
    'saves and availability-tests the native Codex %s provider without requiring a custom table',
    async modelProviderId => {
      const app = await createApp();
      const payload = {
        name: `Native ${modelProviderId}`,
        agentType: AgentType.CODEX,
        executionPermission: 'FULL_ACCESS',
        env: { NATIVE_PROVIDER_OPTION: { action: 'replace' as const, value: 'native-value' } },
        settings: `model_provider = "${modelProviderId}"\n`,
      };

      const tested = await app.inject({ method: 'POST', url: '/api/providers/test', payload });
      expect(tested.statusCode).toBe(200);
      expect(tested.json()).toMatchObject({
        ok: true,
        stage: 'availability',
        target: { kind: 'cli', source: 'codex-native' },
      });
      expect(tested.json().target).not.toHaveProperty('endpoint');

      const created = await app.inject({ method: 'POST', url: '/api/providers', payload });
      expect(created.statusCode).toBe(201);
      expect(created.json().diagnostics ?? []).toEqual([]);
      expect(getProviderById(created.json().id)?.settings).toBe(payload.settings);
      await app.close();
    },
  );

  it('probes each current unsaved Codex URL and key without persisting or returning the key', async () => {
    let expectedKey = '';
    const captured: Array<{ path: string; authMatched: boolean }> = [];
    const loopback = await startLoopback((request, response) => {
      captured.push({
        path: request.url ?? '',
        authMatched: request.headers.authorization === `Bearer ${expectedKey}`,
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"data":[]}');
    });
    const app = await createApp({ timeoutMs: 500 });
    const countBefore = getAllProviders().length;

    try {
      expectedKey = 'draft-key-a-sentinel';
      const first = await app.inject({
        method: 'POST',
        url: '/api/providers/test',
        payload: {
          name: 'Unsaved Codex A',
          agentType: AgentType.CODEX,
        executionPermission: 'FULL_ACCESS',
          env: { OPENAI_API_KEY: { action: 'replace', value: expectedKey } },
          simplified: { apiBaseUrl: `${loopback.baseUrl}/draft-a` },
        },
      });
      expect(first.json()).toMatchObject({ ok: true, stage: 'connection' });
      expect(first.body).not.toContain(expectedKey);

      expectedKey = 'draft-key-b-sentinel';
      const second = await app.inject({
        method: 'POST',
        url: '/api/providers/test',
        payload: {
          name: 'Unsaved Codex B',
          agentType: AgentType.CODEX,
        executionPermission: 'FULL_ACCESS',
          env: { OPENAI_API_KEY: { action: 'replace', value: expectedKey } },
          simplified: { apiBaseUrl: `${loopback.baseUrl}/draft-b` },
        },
      });
      expect(second.json()).toMatchObject({ ok: true, stage: 'connection' });
      expect(second.body).not.toContain(expectedKey);
      expect(captured).toEqual([
        { path: '/draft-a/models', authMatched: true },
        { path: '/draft-b/models', authMatched: true },
      ]);
      expect(getAllProviders()).toHaveLength(countBefore);
    } finally {
      await app.close();
      await loopback.close();
    }
  });

  it.each([
    {
      name: 'Claude ACP gateway',
      agentType: AgentType.CLAUDE_CODE,
        executionPermission: 'FULL_ACCESS',
      secretKey: 'ANTHROPIC_API_KEY',
      expectedHeader: 'x-api-key',
    },
    {
      name: 'Qwen ACP gateway',
      agentType: AgentType.QWEN_CODE,
      secretKey: 'OPENAI_API_KEY',
      expectedHeader: 'authorization',
    },
  ])('probes $name with the current unsaved credential', async ({
    name,
    agentType,
    secretKey,
    expectedHeader,
  }) => {
    const secret = `${agentType.toLowerCase()}-probe-secret`;
    const captured: Array<{ path: string; authenticated: boolean }> = [];
    const loopback = await startLoopback((request, response) => {
      captured.push({
        path: request.url ?? '',
        authenticated: expectedHeader === 'x-api-key'
          ? request.headers['x-api-key'] === secret
          : request.headers.authorization === `Bearer ${secret}`,
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"data":[]}');
    });
    const app = await createApp({ timeoutMs: 500 });
    const countBefore = getAllProviders().length;

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/providers/test',
        payload: {
          name,
          agentType,
          runtimeType: RuntimeType.ACP,
          env: { [secretKey]: { action: 'replace', value: secret } },
          simplified: { apiBaseUrl: `${loopback.baseUrl}/gateway` },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ ok: true, stage: 'connection' });
      expect(response.body).not.toContain(secret);
      expect(captured).toEqual([{ path: '/gateway/models', authenticated: true }]);
      expect(getAllProviders()).toHaveLength(countBefore);
    } finally {
      await app.close();
      await loopback.close();
    }
  });

  it('probes a Codex API draft when the Codex CLI is not available', async () => {
    const capturedPaths: string[] = [];
    const loopback = await startLoopback((request, response) => {
      capturedPaths.push(request.url ?? '');
      response.writeHead(401);
      response.end();
    });
    const app = await createApp({ timeoutMs: 500 });
    const testPath = process.env.PATH;
    process.env.PATH = '';

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/providers/test',
        payload: {
          name: 'Codex without CLI',
          agentType: AgentType.CODEX,
        executionPermission: 'FULL_ACCESS',
          simplified: { apiBaseUrl: loopback.baseUrl },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: false,
        stage: 'connection',
        errorKind: 'authentication',
        availability: 'NOT_FOUND',
        target: { kind: 'api', endpoint: `${loopback.baseUrl}/models` },
      });
      expect(capturedPaths).toEqual(['/models']);
    } finally {
      if (testPath === undefined) delete process.env.PATH;
      else process.env.PATH = testPath;
      await app.close();
      await loopback.close();
    }
  });

  it('uses saved values for keep while URL-only and key-only draft edits take effect immediately', async () => {
    let expectedKey = '';
    const captured: Array<{ path: string; authMatched: boolean }> = [];
    const loopback = await startLoopback((request, response) => {
      captured.push({
        path: request.url ?? '',
        authMatched: request.headers.authorization === `Bearer ${expectedKey}`,
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"data":[]}');
    });
    const app = await createApp({ timeoutMs: 500 });

    try {
      expectedKey = 'saved-key-a-sentinel';
      const created = await app.inject({
        method: 'POST',
        url: '/api/providers',
        payload: {
          name: 'Saved Codex',
          agentType: AgentType.CODEX,
        executionPermission: 'FULL_ACCESS',
          env: { OPENAI_API_KEY: { action: 'replace', value: expectedKey } },
          simplified: { apiBaseUrl: `${loopback.baseUrl}/saved-a` },
        },
      });
      const providerId = created.json().id as string;

      const saved = await app.inject({
        method: 'POST',
        url: '/api/providers/test',
        payload: {
          providerId,
          name: 'Saved Codex',
          agentType: AgentType.CODEX,
        executionPermission: 'FULL_ACCESS',
          env: { OPENAI_API_KEY: { action: 'keep' } },
        },
      });
      expect(saved.json()).toMatchObject({ ok: true, stage: 'connection' });

      const urlOnly = await app.inject({
        method: 'POST',
        url: '/api/providers/test',
        payload: {
          providerId,
          name: 'Saved Codex',
          agentType: AgentType.CODEX,
        executionPermission: 'FULL_ACCESS',
          env: { OPENAI_API_KEY: { action: 'keep' } },
          simplified: { apiBaseUrl: `${loopback.baseUrl}/saved-b` },
        },
      });
      expect(urlOnly.json()).toMatchObject({ ok: true, stage: 'connection' });

      expectedKey = 'saved-key-b-sentinel';
      const keyOnly = await app.inject({
        method: 'POST',
        url: '/api/providers/test',
        payload: {
          providerId,
          name: 'Saved Codex',
          agentType: AgentType.CODEX,
        executionPermission: 'FULL_ACCESS',
          env: { OPENAI_API_KEY: { action: 'replace', value: expectedKey } },
        },
      });
      expect(keyOnly.json()).toMatchObject({ ok: true, stage: 'connection' });
      expect(keyOnly.body).not.toContain(expectedKey);

      expect(captured).toEqual([
        { path: '/saved-a/models', authMatched: true },
        { path: '/saved-b/models', authMatched: true },
        { path: '/saved-a/models', authMatched: true },
      ]);
      expect(getProviderById(providerId)?.env.OPENAI_API_KEY).toBe('saved-key-a-sentinel');
    } finally {
      await app.close();
      await loopback.close();
    }
  });

  it.each([
    [401, 'authentication'],
    [404, 'unsupported'],
    [405, 'unsupported'],
    [400, 'model'],
    [429, 'rate-limit'],
    [503, 'server'],
  ] as const)('classifies HTTP %s connection probes as %s', async (status, errorKind) => {
    const loopback = await startLoopback((_request, response) => {
      response.writeHead(status);
      response.end();
    });
    const app = await createApp({ timeoutMs: 500 });
    const secret = `classification-${status}-sentinel`;
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/providers/test',
        payload: {
          name: `Codex ${status}`,
          agentType: AgentType.CODEX,
        executionPermission: 'FULL_ACCESS',
          env: { OPENAI_API_KEY: { action: 'replace', value: secret } },
          simplified: { apiBaseUrl: loopback.baseUrl },
        },
      });
      expect(response.json()).toMatchObject({ ok: false, stage: 'connection', errorKind });
      expect(response.body).not.toContain(secret);
    } finally {
      await app.close();
      await loopback.close();
    }
  });

  it('classifies a bounded probe timeout without persisting the draft', async () => {
    const loopback = await startLoopback((_request, _response) => {});
    const app = await createApp({ timeoutMs: 20 });
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/providers/test',
        payload: {
          name: 'Codex timeout',
          agentType: AgentType.CODEX,
        executionPermission: 'FULL_ACCESS',
          simplified: { apiBaseUrl: loopback.baseUrl },
        },
      });
      expect(response.json()).toMatchObject({ ok: false, stage: 'connection', errorKind: 'timeout' });
    } finally {
      await app.close();
      await loopback.close();
    }
  });

  it('returns field diagnostics for invalid unsaved settings', async () => {
    const app = await createApp();
    const secret = 'invalid-toml-secret';
    const response = await app.inject({
      method: 'POST',
      url: '/api/providers/test',
      payload: {
        name: 'Broken Codex',
        agentType: AgentType.CODEX,
        executionPermission: 'FULL_ACCESS',
        settings: `api_key = "${secret}"\nbroken = [toml`,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(secret);
    expect(response.json()).toMatchObject({
      ok: false,
      stage: 'validation',
      diagnostics: [{ field: 'settings', code: 'INVALID_FORMAT' }],
    });
    await app.close();
  });

  it('blocks invalid execution permissions, transport controls, and effort before save or test', async () => {
    const app = await createApp();
    const invalidPermission = {
      name: 'Invalid Permission',
      agentType: AgentType.CODEX,
      config: { dangerouslyBypassApprovalsAndSandbox: 'yes' },
    };
    const created = await app.inject({ method: 'POST', url: '/api/providers', payload: invalidPermission });
    expect(created.statusCode).toBe(400);
    expect(created.json()).toMatchObject({
      diagnostics: [{ field: 'executionPermission', code: 'INVALID_TYPE' }],
    });
    const tested = await app.inject({ method: 'POST', url: '/api/providers/test', payload: invalidPermission });
    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toMatchObject({
      ok: false,
      stage: 'validation',
      diagnostics: [{ field: 'executionPermission', code: 'INVALID_TYPE' }],
    });

    const invalidTransport = {
      name: 'Invalid Transport',
      agentType: AgentType.CODEX,
      config: { disableResponsesWebsocket: 'yes' },
    };
    const transportCreated = await app.inject({
      method: 'POST', url: '/api/providers', payload: invalidTransport,
    });
    expect(transportCreated.statusCode).toBe(400);
    expect(transportCreated.json()).toMatchObject({
      diagnostics: [{ field: 'disableResponsesWebsocket', code: 'INVALID_TYPE' }],
    });
    const transportTested = await app.inject({
      method: 'POST', url: '/api/providers/test', payload: invalidTransport,
    });
    expect(transportTested.statusCode).toBe(200);
    expect(transportTested.json()).toMatchObject({
      ok: false,
      stage: 'validation',
      diagnostics: [{ field: 'disableResponsesWebsocket', code: 'INVALID_TYPE' }],
    });

    const invalidEffort = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: {
        name: 'Invalid Effort',
        agentType: AgentType.CODEX,
        settings: 'model_reasoning_effort = "extreme"',
      },
    });
    expect(invalidEffort.statusCode).toBe(400);
    expect(invalidEffort.json()).toMatchObject({
      diagnostics: [{ field: 'reasoningEffort', code: 'INVALID_ENUM' }],
    });
    await app.close();
  });

  it('saves and reopens the Codex transport control from the shared config state', async () => {
    const app = await createApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/providers',
      payload: {
        name: 'Codex HTTP transport',
        agentType: AgentType.CODEX,
        executionPermission: 'FULL_ACCESS',
        config: { disableResponsesWebsocket: true, unknown: { keep: true } },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().config).toEqual({
      disableResponsesWebsocket: true,
      unknown: { keep: true },
    });

    const detail = await app.inject({
      method: 'GET',
      url: `/api/providers/${created.json().id}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().config).toEqual(created.json().config);
    expect(getProviderById(created.json().id)?.config).toEqual(created.json().config);
    await app.close();
  });

  it('rejects a built-in transport alias collision before save and test', async () => {
    const app = await createApp();
    const payload = {
      name: 'Codex reserved alias collision',
      agentType: AgentType.CODEX,
        executionPermission: 'FULL_ACCESS',
      config: { disableResponsesWebsocket: true },
      settings: [
        'model_provider = "openai"',
        '[model_providers.agent-tower-openai-http]',
        'name = "User alias"',
        'env_key = "STALE_ALIAS_KEY"',
      ].join('\n'),
    };

    const created = await app.inject({ method: 'POST', url: '/api/providers', payload });
    expect(created.statusCode).toBe(400);
    expect(created.json()).toMatchObject({
      diagnostics: [{
        field: 'disableResponsesWebsocket',
        code: 'CONFLICT',
      }],
    });

    const tested = await app.inject({ method: 'POST', url: '/api/providers/test', payload });
    expect(tested.statusCode).toBe(200);
    expect(tested.json()).toMatchObject({
      ok: false,
      stage: 'validation',
      diagnostics: [{
        field: 'disableResponsesWebsocket',
        code: 'CONFLICT',
      }],
    });
    await app.close();
  });

  it.each([
    ['string', 'true'],
    ['number', 1],
    ['null', null],
    ['object', { enabled: true }],
  ])('rejects a %s Codex permission consistently during backup preview and import', async (label, invalidValue) => {
    const app = await createApp();
    const providerId = `invalid-import-permission-${label}`;
    const secret = `invalid-import-secret-${label}`;
    const backup = {
      version: 1,
      kind: 'provider-backup',
      exportedAt: new Date().toISOString(),
      mode: 'full',
      providers: [{
        id: providerId,
        name: 'Invalid imported permission',
        agentType: AgentType.CODEX,
        executionPermission: 'FULL_ACCESS',
        env: { OPENAI_API_KEY: secret },
        config: { dangerouslyBypassApprovalsAndSandbox: invalidValue },
        isDefault: false,
      }],
    } as const;

    for (const url of ['/api/providers/import/preview', '/api/providers/import']) {
      const response = await app.inject({ method: 'POST', url, payload: backup });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        message: 'Invalid provider backup',
        diagnostics: [{
          providerIndex: 0,
          providerId,
          field: 'executionPermission',
          code: 'INVALID_TYPE',
          message: 'dangerouslyBypassApprovalsAndSandbox must be true or false',
        }],
      });
      expect(response.body).not.toContain(secret);
    }

    expect(getProviderById(providerId)).toBeNull();
    await app.close();
  });

  it('previews and imports strict true and false permissions without changing or exposing credentials', async () => {
    const app = await createApp();
    const secrets = ['strict-true-import-secret', 'strict-false-import-secret'];
    const backup = {
      version: 1,
      kind: 'provider-backup',
      exportedAt: new Date().toISOString(),
      mode: 'full',
      providers: [true, false].map((value, index) => ({
        id: `valid-import-permission-${index}`,
        name: `Valid imported permission ${index}`,
        agentType: AgentType.CODEX,
        env: { OPENAI_API_KEY: secrets[index]! },
        config: { dangerouslyBypassApprovalsAndSandbox: value },
        isDefault: false,
      })),
    } as const;

    const preview = await app.inject({
      method: 'POST',
      url: '/api/providers/import/preview',
      payload: backup,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().items.map((item: { incoming: { executionPermission: string } }) => (
      item.incoming.executionPermission
    ))).toEqual(['FULL_ACCESS', 'ASK']);

    const imported = await app.inject({
      method: 'POST',
      url: '/api/providers/import',
      payload: backup,
    });
    expect(imported.statusCode).toBe(200);
    reloadProviders();
    expect(backup.providers.map(item => (
      getProviderById(item.id)?.executionPermission
    ))).toEqual(['FULL_ACCESS', 'ASK']);

    for (const response of [preview, imported]) {
      for (const secret of secrets) expect(response.body).not.toContain(secret);
    }
    await app.close();
  });

  it('keeps disabled configurations in management reads and preserves their status across edits and backup imports', async () => {
    const app = await createApp();
    try {
      const created = await app.inject({ method: 'POST', url: '/api/providers', payload: {
        name: 'Disabled Codex', agentType: AgentType.CODEX, runtimeType: RuntimeType.ACP,
        executionPermission: 'ASK', enabled: false,
        env: { OPENAI_API_KEY: { action: 'replace', value: 'disabled-provider-key' } },
      } });
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json().id as string;
      expect(created.json().enabled).toBe(false);
      expect(created.body).not.toContain('disabled-provider-key');

      const edited = await app.inject({ method: 'PUT', url: `/api/providers/${id}`, payload: { name: 'Renamed disabled Codex' } });
      expect(edited.statusCode, edited.body).toBe(200);
      expect(edited.json().enabled).toBe(false);
      const list = await app.inject({ method: 'GET', url: '/api/providers' });
      expect(list.json()).toContainEqual(expect.objectContaining({ provider: expect.objectContaining({ id, enabled: false }) }));
      const reloaded = await app.inject({ method: 'POST', url: '/api/providers/reload' });
      expect(reloaded.json().providers).toContainEqual(expect.objectContaining({ id, enabled: false }));
      expect(reloaded.body).not.toContain('disabled-provider-key');

      const backup = (await app.inject({ method: 'GET', url: '/api/providers/backup' })).json();
      expect(backup.providers).toContainEqual(expect.objectContaining({ id, enabled: false, env: { OPENAI_API_KEY: 'disabled-provider-key' } }));
      expect((await app.inject({ method: 'PUT', url: `/api/providers/${id}`, payload: { enabled: true } })).json().enabled).toBe(true);
      const preview = await app.inject({ method: 'POST', url: '/api/providers/import/preview', payload: backup });
      expect(preview.statusCode, preview.body).toBe(200);
      expect(preview.json().items).toContainEqual(expect.objectContaining({
        action: 'OVERWRITE', incoming: expect.objectContaining({ id, enabled: false }), existing: expect.objectContaining({ enabled: true }),
      }));
      const imported = await app.inject({ method: 'POST', url: '/api/providers/import', payload: backup });
      expect(imported.statusCode, imported.body).toBe(200);
      expect(imported.json().providers).toContainEqual(expect.objectContaining({ id, enabled: false }));
      expect(imported.body).not.toContain('disabled-provider-key');
      reloadProviders();
      expect(getProviderById(id)).toMatchObject({ enabled: false, env: { OPENAI_API_KEY: 'disabled-provider-key' } });

      const invalid = await app.inject({ method: 'PUT', url: `/api/providers/${id}`, payload: { enabled: 'false' } });
      expect(invalid.statusCode).toBe(400);
    } finally { await app.close(); }
  });

  it('toggles visibility without validating or changing configurations that need repair', async () => {
    const id = 'legacy-invalid-provider';
    const settings = '{ malformed native settings';
    fs.writeFileSync(path.join(dataDir, 'providers.json'), JSON.stringify({ providers: [{
      id, name: 'Needs repair', agentType: AgentType.CLAUDE_CODE, runtimeType: RuntimeType.CLI,
      env: { ANTHROPIC_API_KEY: 'legacy-disabled-key' }, config: { dangerouslySkipPermissions: false }, settings, isDefault: false,
    }] }));
    reloadProviders();
    const before = structuredClone(getProviderById(id));
    const app = await createApp();
    try {
      const normalEdit = await app.inject({ method: 'PUT', url: `/api/providers/${id}`, payload: { name: 'Still needs repair' } });
      expect(normalEdit.statusCode).toBe(400);
      for (const enabled of [false, true]) {
        const updated = await app.inject({ method: 'PUT', url: `/api/providers/${id}`, payload: { enabled } });
        expect(updated.statusCode, updated.body).toBe(200);
        expect(updated.json().enabled).toBe(enabled);
        expect(updated.body).not.toContain('legacy-disabled-key');
        reloadProviders();
        expect(getProviderById(id)).toEqual({ ...before, enabled });
      }
    } finally { await app.close(); }
  });

  it('redacts structured secrets from every non-backup provider response', async () => {
    const app = await createApp();
    const secrets = [
      'env-route-secret',
      'config-route-secret',
      'escaped-route-supersecret',
      'array-route-secret',
      'object-route-secret',
    ];
    const backup = {
      version: 1,
      kind: 'provider-backup',
      exportedAt: new Date().toISOString(),
      mode: 'full',
      providers: [{
        id: 'structured-secret-provider',
        name: 'Structured Secret Provider',
        agentType: AgentType.CLAUDE_CODE,
        executionPermission: 'FULL_ACCESS',
        env: { ANTHROPIC_API_KEY: secrets[0] },
        config: { auth_token: { nested: secrets[1] } },
        settings: JSON.stringify({
          api_key: `quoted\\"${secrets[2]}\\\\tail`,
          authorization: [secrets[3], { nested: secrets[4] }],
          safe: true,
        }),
        isDefault: false,
      }],
    };

    const preview = await app.inject({ method: 'POST', url: '/api/providers/import/preview', payload: backup });
    expect(preview.statusCode).toBe(200);
    const imported = await app.inject({ method: 'POST', url: '/api/providers/import', payload: backup });
    expect(imported.statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/api/providers' });
    const detail = await app.inject({ method: 'GET', url: '/api/providers/structured-secret-provider' });
    const reload = await app.inject({ method: 'POST', url: '/api/providers/reload' });

    for (const response of [preview, imported, list, detail, reload]) {
      for (const secret of secrets) expect(response.body).not.toContain(secret);
    }
    await app.close();
  });
});
