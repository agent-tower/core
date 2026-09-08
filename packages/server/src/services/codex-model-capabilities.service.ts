import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parse as parseToml } from 'smol-toml'
import {
  AgentType,
  type Provider,
  type ProviderConfigDiagnostic,
} from '@agent-tower/shared'
import { which } from '../utils/index.js'

const execFileAsync = promisify(execFile)
const CODEX_FALLBACK_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const
const CODEX_CATALOG_CACHE_TTL_MS = 5 * 60 * 1000
const CODEX_CATALOG_MAX_BUFFER = 16 * 1024 * 1024

interface CodexCatalogModel {
  slug?: string
  supported_reasoning_levels?: Array<{ effort?: string }>
}

interface CodexModelCatalog {
  models?: CodexCatalogModel[]
}

interface CatalogCache {
  expiresAt: number
  models: Map<string, string[]>
}

let catalogCache: CatalogCache | null = null
let catalogPromise: Promise<CatalogCache> | null = null

export function parseCodexModelCatalog(stdout: string): Map<string, string[]> {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('Codex model catalog was not JSON')
  const parsed = JSON.parse(stdout.slice(start, end + 1)) as CodexModelCatalog
  const models = new Map<string, string[]>()
  for (const model of parsed.models ?? []) {
    if (!model.slug || !Array.isArray(model.supported_reasoning_levels)) continue
    const options = model.supported_reasoning_levels
      .map(level => level.effort)
      .filter((effort): effort is string => typeof effort === 'string' && effort.length > 0)
    if (options.length > 0) models.set(model.slug, options)
  }
  return models
}

async function loadCatalog(): Promise<CatalogCache> {
  const now = Date.now()
  if (catalogCache && catalogCache.expiresAt > now) return catalogCache
  if (catalogPromise) return catalogPromise

  catalogPromise = (async () => {
    const configured = process.env.CODEX_PATH?.trim()
    const executable = configured || await which('codex')
    if (!executable) throw new Error('Codex executable was not found')
    const result = await execFileAsync(executable, ['debug', 'models'], {
      env: process.env,
      timeout: 5_000,
      maxBuffer: CODEX_CATALOG_MAX_BUFFER,
      windowsHide: true,
    })
    const cache: CatalogCache = {
      expiresAt: Date.now() + CODEX_CATALOG_CACHE_TTL_MS,
      models: parseCodexModelCatalog(String(result.stdout ?? '')),
    }
    catalogCache = cache
    return cache
  })().catch(() => ({
    expiresAt: Date.now() + CODEX_CATALOG_CACHE_TTL_MS,
    models: new Map<string, string[]>(),
  })).finally(() => {
    catalogPromise = null
  })

  return catalogPromise
}

export function getCodexFallbackReasoningEfforts(): string[] {
  return [...CODEX_FALLBACK_REASONING_EFFORTS]
}

export async function getCodexReasoningEffortOptions(model?: string): Promise<{
  options: string[]
  source: 'catalog' | 'fallback'
}> {
  const normalizedModel = model?.trim()
  if (!normalizedModel) return { options: getCodexFallbackReasoningEfforts(), source: 'fallback' }
  const catalog = await loadCatalog()
  const options = catalog.models.get(normalizedModel)
  return options
    ? { options: [...options], source: 'catalog' }
    : { options: getCodexFallbackReasoningEfforts(), source: 'fallback' }
}

function readCodexModel(provider: Pick<Provider, 'config' | 'settings'>): string | undefined {
  const configModel = provider.config.model
  if (typeof configModel === 'string' && configModel.trim()) return configModel.trim()
  if (!provider.settings?.trim()) return undefined
  try {
    const parsed = parseToml(provider.settings) as Record<string, unknown>
    return typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : undefined
  } catch {
    return undefined
  }
}

function readCodexReasoningEffort(provider: Pick<Provider, 'settings'>): string | undefined {
  if (!provider.settings?.trim()) return undefined
  try {
    const parsed = parseToml(provider.settings) as Record<string, unknown>
    return typeof parsed.model_reasoning_effort === 'string'
      ? parsed.model_reasoning_effort
      : undefined
  } catch {
    return undefined
  }
}

export async function validateCodexReasoningEffort(
  provider: Pick<Provider, 'agentType' | 'config' | 'settings'>,
): Promise<ProviderConfigDiagnostic[]> {
  if (provider.agentType !== AgentType.CODEX) return []
  const effort = readCodexReasoningEffort(provider)
  if (!effort) return []
  const model = readCodexModel(provider)
  const { options, source } = await getCodexReasoningEffortOptions(model)
  if (options.includes(effort)) return []
  return [{
    field: 'reasoningEffort',
    code: 'INVALID_ENUM',
    message: model
      ? `Reasoning effort '${effort}' is not supported by Codex model '${model}'${source === 'fallback' ? ' or the installed Codex runtime' : ''}`
      : `Reasoning effort '${effort}' requires a Codex model that advertises this level`,
  }]
}

export function resetCodexModelCatalogForTests(): void {
  catalogCache = null
  catalogPromise = null
}
