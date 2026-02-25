/**
 * ExecutorProfiles — 执行器配置管理
 *
 * 数据结构: { executors: { [AgentType]: { [variant]: config } } }
 * - 内置默认配置 (default-profiles.json)
 * - 用户自定义覆盖 (data 目录下 profiles.json)
 * - 合并策略: 用户配置覆盖默认，但不能删除内置 executor
 */

import * as fs from 'fs';
import * as path from 'path';
import { AgentType } from '../types/index.js';
import { fileURLToPath } from 'url';

// ─── Types ───────────────────────────────────────────────────────

/** 单个 variant 的配置，字段取决于 agent 类型 */
export type VariantConfig = Record<string, unknown>;

/** 某个 agent 的所有 variant 配置 */
export type AgentVariants = Record<string, VariantConfig>;

/** 完整的 profiles 结构 */
export interface ExecutorProfiles {
  executors: Record<string, AgentVariants>;
}

// ─── Defaults ────────────────────────────────────────────────────

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const defaultProfilesJson = require('./default-profiles.json');

const DEFAULT_PROFILES: ExecutorProfiles = defaultProfilesJson as ExecutorProfiles;

// ─── State ───────────────────────────────────────────────────────

let cachedProfiles: ExecutorProfiles | null = null;

// ─── User overrides path ─────────────────────────────────────────

function getUserProfilesPath(): string {
  if (process.env.AGENT_TOWER_DATA_DIR) {
    return path.join(process.env.AGENT_TOWER_DATA_DIR, 'profiles.json');
  }
  // 开发模式回退: server 包根目录的 data 目录
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const serverRoot = path.resolve(__dirname, '..', '..');
  return path.join(serverRoot, 'data', 'profiles.json');
}

// ─── Core functions ──────────────────────────────────────────────

/**
 * 深度合并: 用户配置覆盖默认配置
 * - 用户可以新增 executor / variant
 * - 用户可以覆盖已有 variant 的配置
 * - 不会删除默认的 executor 或 variant
 */
export function mergeWithDefaults(
  defaults: ExecutorProfiles,
  overrides: ExecutorProfiles
): ExecutorProfiles {
  const merged: ExecutorProfiles = {
    executors: { ...defaults.executors },
  };

  for (const [agentType, overrideVariants] of Object.entries(overrides.executors)) {
    if (merged.executors[agentType]) {
      // 合并 variant 级别
      merged.executors[agentType] = {
        ...merged.executors[agentType],
        ...overrideVariants,
      };
    } else {
      // 新增的 agent 类型
      merged.executors[agentType] = { ...overrideVariants };
    }
  }

  return merged;
}

/**
 * 计算用户覆盖部分（与默认不同的配置）
 */
function computeOverrides(
  defaults: ExecutorProfiles,
  current: ExecutorProfiles
): ExecutorProfiles {
  const overrides: ExecutorProfiles = { executors: {} };

  for (const [agentType, variants] of Object.entries(current.executors)) {
    const defaultVariants = defaults.executors[agentType];

    if (!defaultVariants) {
      // 整个 agent 是用户新增的
      overrides.executors[agentType] = { ...variants };
      continue;
    }

    for (const [variantName, config] of Object.entries(variants)) {
      const defaultConfig = defaultVariants[variantName];
      if (!defaultConfig || JSON.stringify(defaultConfig) !== JSON.stringify(config)) {
        if (!overrides.executors[agentType]) {
          overrides.executors[agentType] = {};
        }
        overrides.executors[agentType][variantName] = config;
      }
    }
  }

  return overrides;
}

/**
 * 加载 profiles（默认 + 用户覆盖合并）
 */
export function loadProfiles(): ExecutorProfiles {
  const defaults = structuredClone(DEFAULT_PROFILES);
  const userPath = getUserProfilesPath();

  let userOverrides: ExecutorProfiles | null = null;
  try {
    if (fs.existsSync(userPath)) {
      const content = fs.readFileSync(userPath, 'utf-8');
      userOverrides = JSON.parse(content) as ExecutorProfiles;
    }
  } catch (e) {
    console.error('[Profiles] Failed to load user profiles.json:', e);
  }

  if (userOverrides) {
    cachedProfiles = mergeWithDefaults(defaults, userOverrides);
  } else {
    cachedProfiles = defaults;
  }

  return cachedProfiles;
}

/**
 * 获取当前 profiles（带缓存）
 */
export function getProfiles(): ExecutorProfiles {
  if (!cachedProfiles) {
    return loadProfiles();
  }
  return cachedProfiles;
}

/**
 * 重新加载 profiles
 */
export function reloadProfiles(): ExecutorProfiles {
  cachedProfiles = null;
  return loadProfiles();
}

/**
 * 获取某个 agent 的某个 variant 配置
 */
export function getVariantConfig(
  agentType: AgentType | string,
  variant: string = 'DEFAULT'
): VariantConfig | null {
  const profiles = getProfiles();
  const agentVariants = profiles.executors[agentType];
  if (!agentVariants) return null;

  const normalizedVariant = variant.toUpperCase();
  return agentVariants[normalizedVariant] ?? null;
}

/**
 * 获取某个 agent 的所有 variant 名称
 */
export function getVariantNames(agentType: AgentType | string): string[] {
  const profiles = getProfiles();
  const agentVariants = profiles.executors[agentType];
  if (!agentVariants) return [];
  return Object.keys(agentVariants);
}

/**
 * 保存用户覆盖配置
 */
export function saveProfiles(profiles: ExecutorProfiles): void {
  const defaults = structuredClone(DEFAULT_PROFILES);
  const overrides = computeOverrides(defaults, profiles);

  const userPath = getUserProfilesPath();
  const dir = path.dirname(userPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(userPath, JSON.stringify(overrides, null, 2), 'utf-8');

  // 更新缓存
  cachedProfiles = profiles;
}

/**
 * 更新某个 variant 配置
 */
export function setVariantConfig(
  agentType: AgentType | string,
  variant: string,
  config: VariantConfig
): void {
  const profiles = structuredClone(getProfiles());
  const normalizedVariant = variant.toUpperCase();

  if (!profiles.executors[agentType]) {
    profiles.executors[agentType] = {};
  }
  profiles.executors[agentType][normalizedVariant] = config;

  saveProfiles(profiles);
}

/**
 * 删除某个 variant 配置（不允许删除内置默认的 DEFAULT）
 */
export function deleteVariantConfig(
  agentType: AgentType | string,
  variant: string
): boolean {
  const normalizedVariant = variant.toUpperCase();

  // 检查是否是内置默认配置
  const defaultVariants = DEFAULT_PROFILES.executors[agentType];
  if (defaultVariants && normalizedVariant in defaultVariants) {
    throw new Error(
      `Cannot delete built-in variant '${normalizedVariant}' of '${agentType}'. You can override it instead.`
    );
  }

  const profiles = structuredClone(getProfiles());
  const agentVariants = profiles.executors[agentType];
  if (!agentVariants || !(normalizedVariant in agentVariants)) {
    return false;
  }

  delete agentVariants[normalizedVariant];
  saveProfiles(profiles);
  return true;
}

/**
 * 获取默认 profiles（不含用户覆盖）
 */
export function getDefaultProfiles(): ExecutorProfiles {
  return structuredClone(DEFAULT_PROFILES);
}
