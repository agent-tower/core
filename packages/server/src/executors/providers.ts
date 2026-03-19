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
import { AgentType } from '../types/index.js';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

// ─── Types ───────────────────────────────────────────────────────

export interface Provider {
  id: string;
  name: string;
  agentType: AgentType | string;
  /** 环境变量，启动进程时注入（API URL、API Key 等） */
  env: Record<string, string>;
  /** Agent 运行参数（如 dangerouslySkipPermissions、model、plan 等） */
  config: Record<string, unknown>;
  /** CLI 原生配置（如 Claude Code 的 settings.json 覆盖） */
  settings?: Record<string, unknown>;
  /** 是否为该 AgentType 的默认 provider */
  isDefault: boolean;
  /** 是否内置（不可删除） */
  builtIn?: boolean;
  createdAt?: string;
}

export interface ProvidersData {
  providers: Provider[];
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
      result.push({
        ...builtIn,
        ...userOverride,
        builtIn: true, // 始终标记为内置
      });
      userMap.delete(builtIn.id);
    } else {
      result.push({ ...builtIn });
    }
  }

  // 用户新增的 providers
  for (const userProvider of userMap.values()) {
    result.push({ ...userProvider, builtIn: false });
  }

  return result;
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
      if (defaultProvider && JSON.stringify(defaultProvider) !== JSON.stringify({ ...provider, builtIn: true })) {
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
  const builtIns = structuredClone(DEFAULT_PROVIDERS.providers).map(p => ({ ...p, builtIn: true as const }));
  const userPath = getUserProvidersPath();

  let userProviders: Provider[] = [];
  try {
    if (fs.existsSync(userPath)) {
      const content = fs.readFileSync(userPath, 'utf-8');
      const data = JSON.parse(content) as ProvidersData;
      userProviders = data.providers ?? [];
    }
  } catch (e) {
    console.error('[Providers] Failed to load user providers.json:', e);
  }

  cachedProviders = mergeProviders(builtIns, userProviders);
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
export function getDefaultProvider(agentType: AgentType | string): Provider | null {
  const providers = getProvidersByAgentType(agentType);
  return providers.find(p => p.isDefault) ?? providers[0] ?? null;
}

// ─── Persistence ─────────────────────────────────────────────────

function saveProviders(providers: Provider[]): void {
  const userProviders = extractUserProviders(providers);
  const userPath = getUserProvidersPath();
  const dir = path.dirname(userPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const data: ProvidersData = { providers: userProviders };
  fs.writeFileSync(userPath, JSON.stringify(data, null, 2), 'utf-8');

  // 更新缓存
  cachedProviders = providers;
}

// ─── CRUD ────────────────────────────────────────────────────────

export function createProvider(data: Omit<Provider, 'id' | 'createdAt' | 'builtIn'>): Provider {
  const providers = [...getAllProviders()];

  const provider: Provider = {
    ...data,
    id: randomUUID().slice(0, 8),
    builtIn: false,
    createdAt: new Date().toISOString(),
  };

  // 如果设为默认，取消同类型其他默认
  if (provider.isDefault) {
    for (const p of providers) {
      if (p.agentType === provider.agentType) {
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

  const updated = { ...providers[index], ...data };

  // 如果设为默认，取消同类型其他默认
  if (data.isDefault) {
    for (const p of providers) {
      if (p.agentType === updated.agentType && p.id !== id) {
        p.isDefault = false;
      }
    }
  }

  providers[index] = updated;
  saveProviders(providers);
  return updated;
}

export function deleteProvider(id: string): boolean {
  const providers = getAllProviders();
  const provider = providers.find(p => p.id === id);

  if (!provider) return false;
  if (provider.builtIn) {
    throw new Error(`Cannot delete built-in provider '${provider.name}'`);
  }

  const filtered = providers.filter(p => p.id !== id);
  saveProviders(filtered);
  return true;
}

/**
 * 获取内置默认 providers（不含用户自定义）
 */
export function getDefaultProviders(): Provider[] {
  return structuredClone(DEFAULT_PROVIDERS.providers).map(p => ({ ...p, builtIn: true as const }));
}
