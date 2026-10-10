/**
 * Provider 配置管理
 *
 * Provider = AgentType + 名称 + 环境变量(连接配置) + 运行参数
 *
 * 数据结构: { providers: Provider[] }
 * - 内置默认配置 (default-providers.json)
 * - 用户自定义 ($AGENT_TOWER_DATA_DIR/providers.json)
 * - 合并策略: 内置 providers 始终存在，用户可新增或覆盖内置 provider 的配置
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type {
  ExecutionPermissionMode,
  ProviderBackupFile,
  ProviderImportPreview,
  ProviderImportPreviewItem,
  ProviderImportResult,
} from '@agent-tower/shared';
import { RuntimeType, supportsAgentRuntime, resolveProviderExecutionPermission, withoutLegacyPermissionConfig } from '@agent-tower/shared';
import { AgentType } from '../types/index.js';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

// ─── Types ───────────────────────────────────────────────────────

export interface Provider {
  id: string;
  name: string;
  agentType: AgentType | string;
  runtimeType?: RuntimeType;
  executionPermission?: ExecutionPermissionMode;
  executionPermissionReviewRequired?: boolean;
  /** 环境变量，启动进程时注入（API URL、API Key 等） */
  env: Record<string, string>;
  /** Agent 运行参数（如 dangerouslySkipPermissions、model、plan 等） */
  config: Record<string, unknown>;
  /** Agent 原生配置字符串（Claude Code: JSON, Codex: TOML），由所选 Runtime 投影。 */
  settings?: string;
  /** 是否为该 AgentType 的默认 provider */
  isDefault: boolean;
  /** 是否内置（不可删除） */
  builtIn?: boolean;
  createdAt?: string;
}

export interface ProvidersData {
  providers: Provider[];
  version?: 2;
}

type PersistedProvider = Omit<Provider, 'builtIn'>;
type ProviderCreateData = Omit<Provider, 'id' | 'createdAt' | 'builtIn' | 'runtimeType'> & {
  runtimeType?: RuntimeType;
};

function normalizeRuntimeType(value: unknown): RuntimeType {
  return value === RuntimeType.ACP ? RuntimeType.ACP : RuntimeType.CLI;
}

export function getProviderRuntimeType(provider: Pick<Provider, 'runtimeType'> | { runtimeType?: unknown }): RuntimeType {
  return normalizeRuntimeType(provider.runtimeType);
}

function normalizeProvider(provider: Omit<Provider, 'runtimeType'> & { runtimeType?: unknown }): Provider {
  const runtimeType = normalizeRuntimeType(provider.runtimeType);
  const resolved = resolveProviderExecutionPermission({ ...provider, runtimeType });
  const review = resolved.diagnostics.some(item => item.code === 'LEGACY_PERMISSION_REVIEW_REQUIRED');
  return {
    ...provider, runtimeType,
    executionPermission: provider.executionPermission !== undefined ? provider.executionPermission : resolved.mode,
    ...(review ? { executionPermissionReviewRequired: true } : {}),
    config: resolved.diagnostics.some(item => item.code !== 'LEGACY_PERMISSION_REVIEW_REQUIRED')
      ? provider.config : withoutLegacyPermissionConfig(provider.agentType, provider.config),
  };
}

function assertProviderRuntimeSupported(provider: Pick<Provider, 'agentType' | 'runtimeType'>): void {
  const runtimeType = getProviderRuntimeType(provider);
  if (!supportsAgentRuntime(provider.agentType, runtimeType)) {
    throw new Error(`Agent '${provider.agentType}' does not support the '${runtimeType}' runtime`);
  }
}

function providerDefaultKey(provider: Pick<Provider, 'agentType' | 'runtimeType'>): string {
  return `${String(provider.agentType)}:${getProviderRuntimeType(provider)}`;
}

// ─── Defaults ────────────────────────────────────────────────────

const require = createRequire(import.meta.url);
const defaultProvidersJson = require('./default-providers.json') as ProvidersData;

const DEFAULT_PROVIDERS: ProvidersData = defaultProvidersJson;

// ─── State ───────────────────────────────────────────────────────

let cachedProviders: Provider[] | null = null;

// ─── User data path ─────────────────────────────────────────────

function getUserProvidersPath(): string {
  if (process.env.AGENT_TOWER_DATA_DIR) {
    return path.join(process.env.AGENT_TOWER_DATA_DIR, 'providers.json');
  }
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const serverRoot = path.resolve(__dirname, '..', '..');
  return path.join(serverRoot, 'data', 'providers.json');
}

// ─── Core functions ──────────────────────────────────────────────

/**
 * 合并内置 + 用户自定义 providers
 * - 用户可新增 provider
 * - 用户可通过相同 id 覆盖内置 provider 的 config/env/name
 * - 内置 provider 不会被删除
 */
function mergeProviders(builtIns: Provider[], userProviders: Provider[]): Provider[] {
  const result: Provider[] = [];
  const userMap = new Map(userProviders.map(p => [p.id, p]));

  // 内置 providers：如果用户有同 id 覆盖，则合并
  for (const builtIn of builtIns) {
    const userOverride = userMap.get(builtIn.id);
    if (userOverride) {
      result.push(normalizeProvider({
        ...builtIn,
        ...userOverride,
        builtIn: true, // 始终标记为内置
      }));
      userMap.delete(builtIn.id);
    } else {
      result.push(normalizeProvider({ ...builtIn }));
    }
  }

  // 用户新增的 providers
  for (const userProvider of userMap.values()) {
    result.push(normalizeProvider({ ...userProvider, builtIn: false }));
  }

  return result;
}

function toPersistedProvider(provider: Provider): PersistedProvider {
  provider = normalizeProvider(provider);
  const normalized: PersistedProvider = {
    id: provider.id,
    name: provider.name,
    agentType: provider.agentType,
    runtimeType: getProviderRuntimeType(provider),
    executionPermission: provider.executionPermission,
    ...(provider.executionPermissionReviewRequired ? { executionPermissionReviewRequired: true } : {}),
    env: { ...(provider.env ?? {}) },
    config: { ...(provider.config ?? {}) },
    isDefault: !!provider.isDefault,
  };

  if (provider.settings?.trim()) {
    normalized.settings = provider.settings;
  }

  if (provider.createdAt) {
    normalized.createdAt = provider.createdAt;
  }

  return normalized;
}

function toComparableProvider(provider: Provider): Omit<PersistedProvider, 'createdAt'> {
  const { createdAt, ...rest } = toPersistedProvider(provider);
  return rest;
}

function normalizeProviderDefaults(providers: Provider[]): Provider[] {
  const lastDefaultIndexByType = new Map<string, number>();

  providers.forEach((provider, index) => {
    if (provider.isDefault) {
      lastDefaultIndexByType.set(providerDefaultKey(provider), index);
    }
  });

  return providers.map((provider, index) => {
    const lastDefaultIndex = lastDefaultIndexByType.get(providerDefaultKey(provider));
    if (lastDefaultIndex === undefined) return provider;
    return {
      ...provider,
      isDefault: lastDefaultIndex === index,
    };
  });
}

function areProvidersEquivalent(a: Provider, b: Provider): boolean {
  return JSON.stringify(toComparableProvider(a)) === JSON.stringify(toComparableProvider(b));
}

function getBuiltInProviderById(id: string): Provider | null {
  const provider = DEFAULT_PROVIDERS.providers.find(p => p.id === id);
  if (!provider) return null;
  return normalizeProvider({ ...structuredClone(provider), builtIn: true as const });
}

/**
 * 提取用户自定义部分（与默认不同的 + 新增的）
 */
function extractUserProviders(merged: Provider[]): Provider[] {
  const builtInIds = new Set(DEFAULT_PROVIDERS.providers.map(p => p.id));
  const userProviders: Provider[] = [];

  for (const provider of merged) {
    if (!builtInIds.has(provider.id)) {
      // 用户新增的
      userProviders.push(provider);
    } else {
      // 内置的，检查是否有修改
      const defaultProvider = DEFAULT_PROVIDERS.providers.find(p => p.id === provider.id);
      if (defaultProvider && !areProvidersEquivalent(provider, normalizeProvider(defaultProvider))) {
        // 有修改，保存覆盖
        const { builtIn, ...rest } = provider;
        userProviders.push(rest);
      }
    }
  }

  return userProviders;
}

/**
 * 加载 providers（内置 + 用户合并）
 */
export function loadProviders(): Provider[] {
  const builtIns = structuredClone(DEFAULT_PROVIDERS.providers).map(p => normalizeProvider({ ...p, builtIn: true as const }));
  const userPath = getUserProvidersPath();

  let userProviders: Provider[] = [];
  try {
    if (fs.existsSync(userPath)) {
      const content = fs.readFileSync(userPath, 'utf-8');
      const data = JSON.parse(content) as ProvidersData;
      userProviders = (data.providers ?? []).map(normalizeProvider);
    }
  } catch (e) {
    console.error('[Providers] Failed to load user providers.json:', e);
  }

  cachedProviders = mergeProviders(builtIns, userProviders);

  // 旧数据兼容：settings 从 Record<string, unknown> 迁移为 string
  for (const p of cachedProviders) {
    if (p.settings && typeof p.settings === 'object') {
      (p as any).settings = JSON.stringify(p.settings, null, 2);
    }
  }

  return cachedProviders;
}

/**
 * 获取所有 providers（带缓存）
 */
export function getAllProviders(): Provider[] {
  if (!cachedProviders) {
    return loadProviders();
  }
  return cachedProviders;
}

/**
 * 重新加载
 */
export function reloadProviders(): Provider[] {
  cachedProviders = null;
  return loadProviders();
}

/**
 * 根据 ID 获取 provider
 */
export function getProviderById(id: string): Provider | null {
  return getAllProviders().find(p => p.id === id) ?? null;
}

/**
 * 根据 agentType 获取所有 providers
 */
export function getProvidersByAgentType(agentType: AgentType | string): Provider[] {
  return getAllProviders().filter(p => p.agentType === agentType);
}

/**
 * 获取某个 agentType 的默认 provider
 */
export function getDefaultProvider(agentType: AgentType | string, runtimeType: RuntimeType = RuntimeType.CLI): Provider | null {
  const providers = getProvidersByAgentType(agentType)
    .filter(provider => getProviderRuntimeType(provider) === runtimeType);
  return providers.find(p => p.isDefault) ?? providers[0] ?? null;
}

export function getUserProviders(): Provider[] {
  return structuredClone(extractUserProviders(getAllProviders()));
}

export function createProviderBackup(): ProviderBackupFile {
  return {
    version: 2,
    kind: 'provider-backup',
    exportedAt: new Date().toISOString(),
    mode: 'full',
    providers: getUserProviders().map(toPersistedProvider),
  };
}

export function previewProviderImport(backup: ProviderBackupFile): ProviderImportPreview {
  const existingProviders = getAllProviders();
  const existingById = new Map(existingProviders.map(provider => [provider.id, provider]));
  const items: ProviderImportPreviewItem[] = [];
  const summary = {
    create: 0,
    overwrite: 0,
    skip: 0,
  };

  for (const rawProvider of backup.providers) {
    const incoming = toPersistedProvider(rawProvider);
    assertProviderRuntimeSupported(incoming);
    const existing = existingById.get(incoming.id) ?? null;

    let action: ProviderImportPreviewItem['action'];
    if (!existing) {
      action = 'CREATE';
      summary.create += 1;
    } else if (areProvidersEquivalent(existing, incoming)) {
      action = 'SKIP';
      summary.skip += 1;
    } else {
      action = 'OVERWRITE';
      summary.overwrite += 1;
    }

    items.push({
      action,
      incoming,
      existing,
    });
  }

  return { summary, items };
}

export function importProvidersFromBackup(backup: ProviderBackupFile): ProviderImportResult {
  const preview = previewProviderImport(backup);
  const providers = [...getAllProviders()];

  for (const item of preview.items) {
    if (item.action === 'SKIP') continue;

    const incoming = toPersistedProvider(item.incoming);
    const index = providers.findIndex(provider => provider.id === incoming.id);

    if (index === -1) {
      providers.push({
        ...incoming,
        builtIn: false,
      });
      continue;
    }

    providers[index] = {
      ...providers[index],
      ...incoming,
      builtIn: providers[index].builtIn ?? false,
    };
  }

  saveProviders(normalizeProviderDefaults(providers));

  return {
    summary: preview.summary,
    providers: getAllProviders(),
  };
}

// ─── Persistence ─────────────────────────────────────────────────

function saveProviders(providers: Provider[]): void {
  const userProviders = extractUserProviders(providers).map(toPersistedProvider);
  const userPath = getUserProvidersPath();
  const dir = path.dirname(userPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const data: ProvidersData = { version: 2, providers: userProviders };
  const tempPath = `${userPath}.tmp`;
  const backupPath = `${userPath}.bak`;
  if (fs.existsSync(userPath)) {
    const migrationBackup = `${userPath}.permission-v1.bak`;
    if (!fs.existsSync(migrationBackup)) {
      const oldData = JSON.parse(fs.readFileSync(userPath, 'utf-8')) as ProvidersData;
      if (oldData.version !== 2) fs.copyFileSync(userPath, migrationBackup);
    }
    fs.copyFileSync(userPath, backupPath);
  }
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tempPath, userPath);

  // 更新缓存
  cachedProviders = providers;
}

// ─── CRUD ────────────────────────────────────────────────────────

export function createProvider(data: ProviderCreateData): Provider {
  const providers = [...getAllProviders()];

  const provider: Provider = normalizeProvider({
    ...data,
    id: randomUUID().slice(0, 8),
    builtIn: false,
    createdAt: new Date().toISOString(),
  });
  assertProviderRuntimeSupported(provider);

  // 如果设为默认，取消同类型其他默认
  if (provider.isDefault) {
    for (const p of providers) {
      if (providerDefaultKey(p) === providerDefaultKey(provider)) {
        p.isDefault = false;
      }
    }
  }

  providers.push(provider);
  saveProviders(providers);
  return provider;
}

export function updateProvider(id: string, data: Partial<Omit<Provider, 'id' | 'builtIn'>>): Provider | null {
  const providers = [...getAllProviders()];
  const index = providers.findIndex(p => p.id === id);
  if (index === -1) return null;

  const updated = normalizeProvider({ ...providers[index], ...data });
  assertProviderRuntimeSupported(updated);

  // 如果设为默认，取消同类型其他默认
  if (data.isDefault) {
    for (const p of providers) {
      if (providerDefaultKey(p) === providerDefaultKey(updated) && p.id !== id) {
        p.isDefault = false;
      }
    }
  }

  providers[index] = updated;
  saveProviders(providers);
  return updated;
}

export function deleteProvider(id: string): boolean {
  const providers = [...getAllProviders()];
  const provider = providers.find(p => p.id === id);

  if (!provider) return false;
  if (provider.builtIn) {
    const builtInProvider = getBuiltInProviderById(id);
    const isOverridden = builtInProvider ? !areProvidersEquivalent(provider, builtInProvider) : false;

    if (!builtInProvider || !isOverridden) {
      throw new Error(`Cannot delete built-in provider '${provider.name}'`);
    }

    const restored = providers.map(p => (p.id === id ? builtInProvider : p));
    saveProviders(normalizeProviderDefaults(restored));
    return true;
  }

  const filtered = providers.filter(p => p.id !== id);
  saveProviders(normalizeProviderDefaults(filtered));
  return true;
}

export function canDeleteProvider(provider: Provider): boolean {
  if (!provider.builtIn) return true;
  const builtInProvider = getBuiltInProviderById(provider.id);
  if (!builtInProvider) return false;
  return !areProvidersEquivalent(provider, builtInProvider);
}

/**
 * 获取内置默认 providers（不含用户自定义）
 */
export function getDefaultProviders(): Provider[] {
  return structuredClone(DEFAULT_PROVIDERS.providers).map(p => normalizeProvider({ ...p, builtIn: true as const }));
}
