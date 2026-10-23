import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RuntimeType, resolveProviderExecutionPermission, type ProviderBackupFile } from '@agent-tower/shared';
import { AgentType } from '../../types/index.js';
import {
  canDeleteProvider,
  createProvider,
  createProviderBackup,
  deleteProvider,
  getAllProviders,
  getDefaultProviders,
  getDefaultProvider,
  importProvidersFromBackup,
  previewProviderImport,
  reloadProviders,
  updateProvider,
} from '../providers.js';
import { normalizeProviderDraft } from '../../services/provider-config.service.js';
import { ExecutionPermissionService } from '../../services/execution-permission.service.js';

const originalDataDir = process.env.AGENT_TOWER_DATA_DIR;

let tempDataDir = '';

function writeUserProviders(providers: unknown[]) {
  fs.writeFileSync(
    path.join(tempDataDir, 'providers.json'),
    JSON.stringify({ providers }, null, 2),
    'utf-8'
  );
}

describe('providers backup/import', () => {
  it('backs up the original file once, persists review markers and keeps migration idempotent', () => {
    writeUserProviders([
      { id: 'legacy-safe', name: 'Legacy CLI', agentType: AgentType.CODEX, env: {}, config: { dangerouslyBypassApprovalsAndSandbox: false }, isDefault: false },
      { id: 'legacy-full', name: 'Legacy Full', agentType: AgentType.CLAUDE_CODE, env: {}, config: { dangerouslySkipPermissions: true }, isDefault: false },
      { id: 'legacy-acp-ask', name: 'Legacy ACP', agentType: AgentType.CODEX, runtimeType: RuntimeType.ACP, env: {}, config: { permissionMode: 'ASK' }, isDefault: false },
    ]);
    const original = fs.readFileSync(path.join(tempDataDir, 'providers.json'), 'utf-8');
    reloadProviders();
    createProvider({ name: 'New', agentType: AgentType.CLAUDE_CODE, executionPermission: 'FULL_ACCESS', env: {}, config: {}, isDefault: false });
    const backupPath = path.join(tempDataDir, 'providers.json.permission-v1.bak');
    expect(fs.readFileSync(backupPath, 'utf-8')).toBe(original);
    reloadProviders();
    const backup = createProviderBackup();
    expect(backup.version).toBe(2);
    expect(backup.providers.find(item => item.id === 'legacy-safe')).toMatchObject({ executionPermission: 'ASK', executionPermissionReviewRequired: true });
    expect(resolveProviderExecutionPermission(backup.providers.find(item => item.id === 'legacy-safe')!).diagnostics[0]?.code).toBe('LEGACY_PERMISSION_REVIEW_REQUIRED');
    expect(backup.providers.find(item => item.id === 'legacy-full')).toMatchObject({ executionPermission: 'FULL_ACCESS', config: {} });
    expect(backup.providers.find(item => item.id === 'legacy-acp-ask')).toMatchObject({ executionPermission: 'ASK', executionPermissionReviewRequired: true, config: {} });
    expect(previewProviderImport(backup).items.every(item => item.action === 'SKIP')).toBe(true);
    importProvidersFromBackup(backup);
    expect(fs.readFileSync(backupPath, 'utf-8')).toBe(original);
  });

  it.each([{}, { permissionMode: 'ASK' }, { acpPermissionMode: 'ASK' }])('keeps old Codex ACP %j blocked through migration, backup/import and reload until explicit reselection', config => {
    const permissions = new ExecutionPermissionService();
    writeUserProviders([{ id: 'legacy-acp', name: 'Legacy ACP', agentType: AgentType.CODEX,
      runtimeType: RuntimeType.ACP, config, env: {}, isDefault: false }]);
    const original = fs.readFileSync(path.join(tempDataDir, 'providers.json'), 'utf-8');
    const assertBlocked = () => {
      const legacy = getAllProviders().find(item => item.id === 'legacy-acp')!;
      expect(legacy).toMatchObject({ executionPermission: 'ASK', executionPermissionReviewRequired: true });
      expect(() => permissions.authorize(legacy)).toThrow(expect.objectContaining({ code: 'LEGACY_PERMISSION_REVIEW_REQUIRED' }));
      return legacy;
    };
    reloadProviders();
    assertBlocked();
    createProvider({ name: 'Force migration write', agentType: AgentType.CLAUDE_CODE,
      executionPermission: 'FULL_ACCESS', config: {}, env: {}, isDefault: false });
    const backup = createProviderBackup();
    backup.providers = backup.providers.filter(item => item.id === 'legacy-acp');
    writeUserProviders([]);
    reloadProviders();
    expect(importProvidersFromBackup(backup).summary.create).toBe(1);
    reloadProviders();
    const legacy = assertBlocked();
    expect(fs.readFileSync(path.join(tempDataDir, 'providers.json.permission-v1.bak'), 'utf-8')).toBe(original);
    const metadataOnly = normalizeProviderDraft({ name: 'Renamed', agentType: AgentType.CODEX }, legacy);
    expect(metadataOnly.diagnostics).toContainEqual(expect.objectContaining({ code: 'LEGACY_PERMISSION_REVIEW_REQUIRED' }));
    const reselected = normalizeProviderDraft({ name: legacy.name, agentType: AgentType.CODEX, executionPermission: 'ASK' }, legacy);
    expect(reselected.diagnostics).toEqual([]);
    expect(permissions.authorize(reselected.provider)).toBe('ASK');
    updateProvider(legacy.id, reselected.provider);
    reloadProviders();
    const reloaded = getAllProviders().find(item => item.id === legacy.id)!;
    expect(reloaded.executionPermissionReviewRequired).toBeUndefined();
    expect(permissions.authorize(reloaded)).toBe('ASK');
    expect(resolveProviderExecutionPermission(createProviderBackup().providers.find(item => item.id === legacy.id)!).diagnostics).toEqual([]);
  });

  it('retains invalid canonical values through reload so they cannot become valid defaults', () => {
    writeUserProviders([{ id: 'invalid', name: 'Invalid', agentType: AgentType.CODEX, executionPermission: null,
      env: {}, config: { dangerouslyBypassApprovalsAndSandbox: true }, isDefault: false }]);
    reloadProviders();
    const invalid = getAllProviders().find(item => item.id === 'invalid')!;
    expect(invalid.executionPermission).toBeNull();
    expect(resolveProviderExecutionPermission(invalid).diagnostics[0]?.code).toBe('INVALID_ENUM');
  });
  beforeEach(() => {
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tower-providers-'));
    process.env.AGENT_TOWER_DATA_DIR = tempDataDir;
    reloadProviders();
  });

  afterEach(() => {
    if (originalDataDir === undefined) {
      delete process.env.AGENT_TOWER_DATA_DIR;
    } else {
      process.env.AGENT_TOWER_DATA_DIR = originalDataDir;
    }

    if (tempDataDir) {
      fs.rmSync(tempDataDir, { recursive: true, force: true });
    }

    reloadProviders();
  });

  it('exports only user-level provider data', () => {
    writeUserProviders([
      {
        id: 'codex-default',
        name: 'Codex Proxy',
        agentType: AgentType.CODEX,
        env: { OPENAI_API_KEY: 'sk-proxy' },
        config: { fullAuto: false, model: 'gpt-5.3-codex' },
        settings: 'model = "gpt-5.3-codex"',
        isDefault: true,
      },
      {
        id: 'custom-codex',
        name: 'Codex Local',
        agentType: AgentType.CODEX,
        env: { OPENAI_API_KEY: 'sk-local' },
        config: { fullAuto: true },
        isDefault: false,
        createdAt: '2026-03-23T00:00:00.000Z',
      },
    ]);

    reloadProviders();

    const backup = createProviderBackup();

    expect(backup.kind).toBe('provider-backup');
    expect(backup.providers.map(provider => provider.id)).toEqual(['codex-default', 'custom-codex']);
    expect(backup.providers.every(provider => provider.builtIn === undefined)).toBe(true);
  });

  it('persists disabled built-in and custom providers through reload and backup import', () => {
    const custom = createProvider({
      name: 'Disabled custom', agentType: AgentType.CODEX, enabled: false,
      env: { OPENAI_API_KEY: 'preserved-key' }, config: {}, isDefault: false,
    });
    updateProvider('codex-default', { enabled: false });
    reloadProviders();

    expect(getAllProviders().find(provider => provider.id === 'codex-default')).toMatchObject({ enabled: false, builtIn: true });
    expect(getAllProviders().find(provider => provider.id === custom.id)).toMatchObject({ enabled: false, env: custom.env });
    const backup = createProviderBackup();
    expect(backup.providers.find(provider => provider.id === 'codex-default')).toMatchObject({ enabled: false });
    expect(backup.providers.find(provider => provider.id === custom.id)).toMatchObject({ enabled: false, env: custom.env });
    expect(previewProviderImport(backup).summary).toEqual({ create: 0, overwrite: 0, skip: 2 });

    writeUserProviders([]);
    reloadProviders();
    expect(importProvidersFromBackup(backup).summary).toEqual({ create: 1, overwrite: 1, skip: 0 });
    reloadProviders();
    expect(getAllProviders().find(provider => provider.id === custom.id)?.enabled).toBe(false);
    expect(getAllProviders().find(provider => provider.id === 'codex-default')?.enabled).toBe(false);

    updateProvider('codex-default', { enabled: true });
    expect(createProviderBackup().providers.some(provider => provider.id === 'codex-default')).toBe(false);
  });

  it('treats missing enabled flags as enabled when loading and importing older backups', () => {
    const legacy = {
      id: 'legacy-enabled', name: 'Legacy', agentType: AgentType.CODEX,
      env: {}, config: {}, isDefault: false,
    };
    writeUserProviders([legacy]);
    reloadProviders();
    expect(getAllProviders().find(provider => provider.id === legacy.id)?.enabled).toBe(true);
    const backup: ProviderBackupFile = {
      version: 1, kind: 'provider-backup', exportedAt: new Date().toISOString(), mode: 'full', providers: [legacy],
    };
    expect(previewProviderImport(backup).summary.skip).toBe(1);
    updateProvider(legacy.id, { enabled: false });
    expect(previewProviderImport(backup).summary.overwrite).toBe(1);
    importProvidersFromBackup(backup);
    reloadProviders();
    expect(getAllProviders().find(provider => provider.id === legacy.id)?.enabled).toBe(true);
  });

  it('skips disabled defaults and fallbacks while keeping runtime defaults independent', () => {
    const fallback = createProvider({
      name: 'Enabled fallback', agentType: AgentType.CODEX,
      env: {}, config: {}, isDefault: false,
    });
    updateProvider('codex-default', { enabled: false });
    expect(getDefaultProvider(AgentType.CODEX)?.id).toBe(fallback.id);
    expect(getDefaultProvider(AgentType.CODEX, RuntimeType.ACP)?.id).toBe('codex-acp-default');
    updateProvider(fallback.id, { enabled: false, isDefault: true });
    expect(getDefaultProvider(AgentType.CODEX)).toBeNull();
    updateProvider(fallback.id, { enabled: true });
    expect(getDefaultProvider(AgentType.CODEX)?.id).toBe(fallback.id);
  });

  it('previews and imports create/overwrite/skip actions correctly', () => {
    writeUserProviders([
      {
        id: 'same-provider',
        name: 'Same Provider',
        agentType: AgentType.CODEX,
        env: { OPENAI_API_KEY: 'same-key' },
        config: { fullAuto: true },
        isDefault: false,
        createdAt: '2026-03-20T00:00:00.000Z',
      },
      {
        id: 'overwrite-provider',
        name: 'Claude Old',
        agentType: AgentType.CLAUDE_CODE,
        env: { ANTHROPIC_API_KEY: 'old-key' },
        config: { dangerouslySkipPermissions: true },
        isDefault: false,
      },
    ]);

    reloadProviders();

    const backup: ProviderBackupFile = {
      version: 1,
      kind: 'provider-backup',
      exportedAt: '2026-03-23T10:00:00.000Z',
      mode: 'full',
      providers: [
        {
          id: 'same-provider',
          name: 'Same Provider',
          agentType: AgentType.CODEX,
          env: { OPENAI_API_KEY: 'same-key' },
          config: { fullAuto: true },
          isDefault: false,
        },
        {
          id: 'overwrite-provider',
          name: 'Claude New',
          agentType: AgentType.CLAUDE_CODE,
          env: { ANTHROPIC_API_KEY: 'new-key' },
          config: { dangerouslySkipPermissions: false },
          isDefault: true,
        },
        {
          id: 'new-provider',
          name: 'Gemini Team',
          agentType: AgentType.GEMINI_CLI,
          env: { GEMINI_API_KEY: 'new-provider-key' },
          config: { yolo: false },
          isDefault: false,
          createdAt: '2026-03-23T11:00:00.000Z',
        },
      ],
    };

    const preview = previewProviderImport(backup);
    expect(preview.summary).toEqual({
      create: 1,
      overwrite: 1,
      skip: 1,
    });

    const result = importProvidersFromBackup(backup);
    expect(result.summary).toEqual(preview.summary);

    const providers = getAllProviders();
    expect(providers.find(provider => provider.id === 'new-provider')?.name).toBe('Gemini Team');
    expect(providers.find(provider => provider.id === 'overwrite-provider')?.env).toEqual({
      ANTHROPIC_API_KEY: 'new-key',
    });
    expect(providers.find(provider => provider.id === 'overwrite-provider')?.isDefault).toBe(true);
    expect(providers.find(provider => provider.id === 'claude-code-default')?.isDefault).toBe(false);
    expect(providers.find(provider => provider.id === 'same-provider')?.name).toBe('Same Provider');
  });

  it('imports Codex native provider settings byte-for-byte without requiring a custom table', () => {
    const settings = '# native settings\nmodel_provider = "ollama"\nmodel = "local-model"\n';
    const backup: ProviderBackupFile = {
      version: 1,
      kind: 'provider-backup',
      exportedAt: '2026-07-15T00:00:00.000Z',
      mode: 'full',
      providers: [{
        id: 'native-codex-import',
        name: 'Native Codex Import',
        agentType: AgentType.CODEX,
        env: { OLLAMA_HOST: 'http://localhost:11434' },
        config: { model: 'local-model' },
        settings,
        isDefault: false,
      }],
    };

    expect(importProvidersFromBackup(backup).summary.create).toBe(1);
    const imported = getAllProviders().find(item => item.id === 'native-codex-import');
    expect(imported?.settings).toBe(settings);
    expect(imported?.env).toEqual({ OLLAMA_HOST: 'http://localhost:11434' });
  });

  it('deletes a user override for a built-in provider by restoring the default provider', () => {
    writeUserProviders([
      {
        id: 'claude-code-default',
        name: 'Claude Override',
        agentType: AgentType.CLAUDE_CODE,
        env: { ANTHROPIC_BASE_URL: 'https://proxy.example.com' },
        config: { dangerouslySkipPermissions: true, model: 'claude-opus-4-6' },
        isDefault: true,
      },
    ]);

    reloadProviders();

    const beforeDelete = getAllProviders().find(provider => provider.id === 'claude-code-default');
    expect(beforeDelete).toBeDefined();
    expect(beforeDelete?.builtIn).toBe(true);
    expect(canDeleteProvider(beforeDelete!)).toBe(true);

    expect(deleteProvider('claude-code-default')).toBe(true);

    const restored = getAllProviders().find(provider => provider.id === 'claude-code-default');
    const defaultProvider = getDefaultProviders().find(provider => provider.id === 'claude-code-default');

    expect(restored).toBeDefined();
    expect(defaultProvider).toBeDefined();
    expect(restored?.name).toBe(defaultProvider?.name);
    expect(restored?.env).toEqual(defaultProvider?.env);
    expect(canDeleteProvider(restored!)).toBe(false);
  });

  it('rejects deleting a pure built-in provider', () => {
    reloadProviders();

    const builtInProvider = getAllProviders().find(provider => provider.id === 'claude-code-default');
    expect(builtInProvider).toBeDefined();
    expect(canDeleteProvider(builtInProvider!)).toBe(false);

    expect(() => deleteProvider('claude-code-default')).toThrow(/Cannot delete built-in provider/);
  });

  it('keeps CLI and ACP defaults isolated for the same agent identity', () => {
    expect(getDefaultProvider(AgentType.CODEX, RuntimeType.CLI)?.id).toBe('codex-default');
    expect(getDefaultProvider(AgentType.CODEX, RuntimeType.ACP)?.id).toBe('codex-acp-default');
    expect(getDefaultProvider(AgentType.CLAUDE_CODE, RuntimeType.CLI)?.id).toBe('claude-code-default');
    expect(getDefaultProvider(AgentType.CLAUDE_CODE, RuntimeType.ACP)?.id).toBe('claude-code-acp-default');
    expect(getDefaultProvider(AgentType.QWEN_CODE, RuntimeType.ACP)?.id).toBe('qwen-code-acp-default');
    expect(getDefaultProvider(AgentType.GEMINI_CLI, RuntimeType.ACP)?.id).toBe('gemini-cli-acp-default');
    expect(getDefaultProvider(AgentType.CURSOR_AGENT, RuntimeType.ACP)?.id).toBe('cursor-agent-acp-default');
    expect(getDefaultProvider(AgentType.KIRO_CLI, RuntimeType.ACP)?.id).toBe('kiro-cli-acp-default');
    expect(getDefaultProvider(AgentType.OPENCODE, RuntimeType.ACP)?.id).toBe('opencode-acp-default');
    expect(getDefaultProvider(AgentType.PI_CODING_AGENT, RuntimeType.ACP)?.id).toBe('pi-coding-agent-acp-default');
    expect(getDefaultProvider(AgentType.GROK_BUILD, RuntimeType.ACP)?.id).toBe('grok-build-acp-default');
    expect(getDefaultProvider(AgentType.MINION_CODE, RuntimeType.ACP)?.id).toBe('minion-code-acp-default');
  });

  it('rejects unsupported Agent/Runtime combinations', () => {
    expect(() => createProvider({
      name: 'Kiro CLI Runtime',
      agentType: AgentType.KIRO_CLI,
      runtimeType: RuntimeType.CLI,
      env: {},
      config: {},
      isDefault: false,
    })).toThrow(/does not support the 'CLI' runtime/);

    expect(() => createProvider({
      name: 'Qwen CLI',
      agentType: AgentType.QWEN_CODE,
      runtimeType: RuntimeType.CLI,
      env: {},
      config: {},
      isDefault: false,
    })).toThrow(/does not support the 'CLI' runtime/);
  });
});
