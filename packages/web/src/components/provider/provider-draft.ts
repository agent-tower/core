import { parse as parseToml } from 'smol-toml'
import {
  isCodexNativeModelProviderId,
  type AgentType,
  type ProviderBooleanConfigCapability,
  type ProviderCapability,
  type ProviderConflictResolution,
  type ProviderSecretWriteState,
  type ProviderSimplifiedConfig,
  type RedactedProvider,
} from '@agent-tower/shared'

export interface ProviderEnvDraftRow {
  key: string
  value: string
  write: ProviderSecretWriteState
  configured: boolean
  sensitive: boolean
}

export type ProviderSimplifiedDraftField = 'apiBaseUrl' | 'model' | 'reasoningEffort'
export type ProviderApiKeyDraftStatus = 'configured' | 'unconfigured' | 'advanced'

export interface ProviderBooleanConfigState {
  enabled: boolean
  error: string | null
}

export type ProviderExecutionPermissionState = ProviderBooleanConfigState

export interface ProviderDraftTestSequence {
  begin(): number
  invalidate(): void
  isCurrent(requestId: number): boolean
}

type ProviderConflictField = NonNullable<RedactedProvider['diagnostics']>[number]['field']

export function getApiBaseUrlValidationError(value: string | undefined): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return 'API URL must be a complete http:// or https:// URL'
  }
  try {
    const url = new URL(trimmed)
    if (url.host) return null
  } catch {
    // Fall through to the actionable field error.
  }
  return 'API URL must be a complete http:// or https:// URL'
}

export function getApiKeyDraftStatus(
  row: ProviderEnvDraftRow | undefined,
  configured: boolean,
  resolution: ProviderConflictResolution | undefined,
): ProviderApiKeyDraftStatus {
  if (resolution === 'advanced') return 'advanced'
  if (row?.write.action === 'clear') return 'unconfigured'
  if (row?.write.action === 'replace') return row.value ? 'configured' : 'unconfigured'
  return row?.configured || configured ? 'configured' : 'unconfigured'
}

export function updateSimplifiedDraftValue<T extends {
  agentType: AgentType
  config: Record<string, unknown>
  settings: string
  simplified: ProviderSimplifiedConfig
}>(
  draft: T,
  field: ProviderSimplifiedDraftField,
  value: string,
  capability: ProviderCapability,
): T {
  let config = draft.config
  let settings = draft.settings

  const updateConfigValue = (path: string) => {
    config = { ...config }
    if (value) config[path] = value
    else delete config[path]
  }

  if (field === 'apiBaseUrl' && capability.apiBaseUrl) {
    if (capability.apiBaseUrl.kind === 'config') {
      updateConfigValue(capability.apiBaseUrl.path)
    } else if (capability.apiBaseUrl.kind === 'settings') {
      settings = draft.agentType === 'CODEX'
        ? updateCodexApiBaseUrl(settings, value)
        : updateTomlString(settings, capability.apiBaseUrl.path, value || undefined)
    }
  } else if (field === 'model') {
    if (capability.model.kind === 'config') updateConfigValue(capability.model.path)
    else if (capability.model.kind === 'settings') {
      settings = updateTomlString(settings, capability.model.path, value || undefined)
    }
    if (draft.agentType === 'CODEX') settings = updateTomlString(settings, 'model', undefined)
  } else if (field === 'reasoningEffort' && capability.reasoningEffort) {
    if (capability.reasoningEffort.kind === 'config') {
      updateConfigValue(capability.reasoningEffort.path)
    } else if (capability.reasoningEffort.kind === 'settings') {
      settings = updateTomlString(settings, capability.reasoningEffort.path, value || undefined)
    }
  }

  return {
    ...draft,
    config,
    settings,
    simplified: { ...draft.simplified, [field]: value },
  }
}

function splitTomlComment(value: string): { value: string; comment: string } {
  let quote = ''
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (quote === '"' && char === '\\') {
      escaped = true
      continue
    }
    if ((char === '"' || char === "'") && !quote) quote = char
    else if (char === quote) quote = ''
    else if (char === '#' && !quote) {
      return { value: value.slice(0, index).trimEnd(), comment: value.slice(index) }
    }
  }
  return { value: value.trimEnd(), comment: '' }
}

function splitTomlKey(key: string): string[] {
  const segments: string[] = []
  let start = 0
  let quote = ''
  let escaped = false
  for (let index = 0; index <= key.length; index += 1) {
    const char = key[index] ?? '.'
    if (escaped) {
      escaped = false
      continue
    }
    if (quote === '"' && char === '\\') {
      escaped = true
      continue
    }
    if ((char === '"' || char === "'") && !quote) quote = char
    else if (char === quote) quote = ''
    else if (char === '.' && !quote) {
      const raw = key.slice(start, index).trim()
      if (raw.startsWith('"') && raw.endsWith('"')) {
        try {
          segments.push(JSON.parse(raw) as string)
        } catch {
          segments.push(raw.slice(1, -1))
        }
      } else if (raw.startsWith("'") && raw.endsWith("'")) {
        segments.push(raw.slice(1, -1))
      } else if (raw) {
        segments.push(raw)
      }
      start = index + 1
    }
  }
  return segments
}

function findTomlEquals(line: string): number {
  let quote = ''
  let escaped = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (quote === '"' && char === '\\') {
      escaped = true
      continue
    }
    if ((char === '"' || char === "'") && !quote) quote = char
    else if (char === quote) quote = ''
    else if (char === '=' && !quote) return index
    else if (char === '#' && !quote) return -1
  }
  return -1
}

function pathsMatch(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index])
}

type TomlMultilineStringDelimiter = '"""' | "'''"

function scanTomlMultilineStringState(
  line: string,
  initial: TomlMultilineStringDelimiter | undefined,
): {
  multiline: TomlMultilineStringDelimiter | undefined
  closingDelimiterEnd: number | undefined
} {
  let multiline = initial
  let quote: '"' | "'" | undefined
  let closingDelimiterEnd: number | undefined

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!
    if (multiline) {
      if (multiline === '"""' && char === '\\') {
        index += 1
        continue
      }
      const delimiterQuote = multiline[0]!
      if (char === delimiterQuote) {
        let quoteRunEnd = index + 1
        while (line[quoteRunEnd] === delimiterQuote) quoteRunEnd += 1
        const quoteRunLength = quoteRunEnd - index
        if (quoteRunLength < multiline.length) continue

        // In a 4/5 quote run, the leading 1/2 quotes are string content.
        closingDelimiterEnd ??= quoteRunEnd
        multiline = undefined
        index = quoteRunEnd - 1
      }
      continue
    }

    if (quote) {
      if (quote === '"' && char === '\\') {
        index += 1
      } else if (char === quote) {
        quote = undefined
      }
      continue
    }

    if (char === '#') break
    const delimiter = line.startsWith('"""', index)
      ? '"""'
      : line.startsWith("'''", index)
        ? "'''"
        : undefined
    if (delimiter) {
      multiline = delimiter
      index += 2
    } else if (char === '"' || char === "'") {
      quote = char
    }
  }

  return { multiline, closingDelimiterEnd }
}

function analyzeTomlLines(lines: string[]): {
  structural: boolean[]
  multilineSpanByStart: Map<number, { end: number; suffix: string }>
} {
  const structural: boolean[] = []
  const multilineSpanByStart = new Map<number, { end: number; suffix: string }>()
  let multiline: TomlMultilineStringDelimiter | undefined
  let multilineStart: number | undefined

  for (let index = 0; index < lines.length; index += 1) {
    structural[index] = multiline === undefined
    const { multiline: next, closingDelimiterEnd } = scanTomlMultilineStringState(
      lines[index]!,
      multiline,
    )
    if (multiline === undefined && next !== undefined) multilineStart = index
    if (multiline !== undefined && closingDelimiterEnd !== undefined && multilineStart !== undefined) {
      multilineSpanByStart.set(multilineStart, {
        end: index,
        suffix: lines[index]!.slice(closingDelimiterEnd),
      })
      multilineStart = undefined
    }
    multiline = next
  }

  return { structural, multilineSpanByStart }
}

function updateTomlStringAtPath(
  settings: string,
  path: string[],
  value: string | undefined,
): string {
  try {
    parseToml(settings)
  } catch {
    return settings
  }

  const lines = settings.split('\n')
  const { structural, multilineSpanByStart } = analyzeTomlLines(lines)
  let tablePath: string[] = []
  let matchingTableIndex = path.length === 1 ? -1 : undefined
  const matches: Array<{
    index: number
    equals: number
    end: number
    closingSuffix: string | undefined
  }> = []

  for (let index = 0; index < lines.length; index += 1) {
    if (!structural[index]) continue
    const uncommented = splitTomlComment(lines[index]!).value.trim()
    const arrayTableMatch = uncommented.match(/^\[\[(.+)\]\]$/)
    const tableMatch = arrayTableMatch ?? uncommented.match(/^\[(.+)\]$/)
    if (tableMatch) {
      tablePath = splitTomlKey(tableMatch[1]!)
      if (!arrayTableMatch && pathsMatch(tablePath, path.slice(0, -1))) matchingTableIndex = index
      continue
    }
    const equals = findTomlEquals(lines[index]!)
    if (equals < 0) continue
    const assignmentPath = [...tablePath, ...splitTomlKey(lines[index]!.slice(0, equals))]
    if (pathsMatch(assignmentPath, path)) {
      const multilineSpan = multilineSpanByStart.get(index)
      matches.push({
        index,
        equals,
        end: multilineSpan?.end ?? index,
        closingSuffix: multilineSpan?.suffix,
      })
    }
  }

  if (matches.length > 1) return settings
  if (matches.length === 1) {
    const match = matches[0]!
    const line = lines[match.index]!
    const prefix = line.slice(0, match.equals + 1)
    const rawValue = line.slice(match.equals + 1)
    const whitespace = rawValue.match(/^\s*/)?.[0] ?? ' '
    const { comment } = splitTomlComment(rawValue)
    const deleteCount = match.end - match.index + 1
    const replacementSuffix = match.closingSuffix ?? (comment ? ` ${comment}` : '')
    if (value) {
      lines.splice(
        match.index,
        deleteCount,
        `${prefix}${whitespace}${JSON.stringify(value)}${replacementSuffix}`,
      )
    } else if (match.closingSuffix && splitTomlComment(match.closingSuffix).comment) {
      lines.splice(
        match.index,
        deleteCount,
        `${line.match(/^\s*/)?.[0] ?? ''}${match.closingSuffix}`,
      )
    } else if (comment) {
      lines.splice(match.index, deleteCount, `${line.match(/^\s*/)?.[0] ?? ''}${comment}`)
    } else {
      lines.splice(match.index, deleteCount)
    }
    return lines.join('\n')
  }

  if (!value) return settings
  const assignment = `${path.at(-1)} = ${JSON.stringify(value)}`
  if (path.length > 1) {
    if (matchingTableIndex === undefined) return settings
    lines.splice(matchingTableIndex + 1, 0, assignment)
    return lines.join('\n')
  }

  const firstTable = lines.findIndex((line, index) => {
    if (!structural[index]) return false
    const uncommented = splitTomlComment(line).value.trim()
    return /^\[\[?.+\]\]?$/.test(uncommented)
  })
  if (firstTable >= 0) {
    lines.splice(firstTable, 0, assignment)
    return lines.join('\n')
  }
  if (!settings) return assignment
  return settings.endsWith('\n') ? `${settings}${assignment}\n` : `${settings}\n${assignment}`
}

function updateTomlString(settings: string, key: string, value: string | undefined): string {
  return updateTomlStringAtPath(settings, [key], value)
}

function updateCodexApiBaseUrl(settings: string, value: string): string {
  let parsed: Record<string, unknown>
  try {
    parsed = parseToml(settings) as Record<string, unknown>
  } catch {
    return settings
  }
  const providerId = typeof parsed.model_provider === 'string' && parsed.model_provider.trim()
    ? parsed.model_provider.trim()
    : 'openai'
  const normalizedValue = value.trim() || undefined
  if (providerId === 'openai') return updateTomlString(settings, 'openai_base_url', normalizedValue)
  if (isCodexNativeModelProviderId(providerId)) return settings
  return updateTomlStringAtPath(
    settings,
    ['model_providers', providerId, 'base_url'],
    normalizedValue,
  )
}

export function getExecutionPermissionState(
  config: Record<string, unknown>,
  capability: ProviderCapability,
): ProviderExecutionPermissionState {
  const permission = capability.executionPermission
  // An agent without a permission-bypass surface has no path and no toggle.
  if (!permission.path) return { enabled: false, error: null }
  return getProviderBooleanConfigState(config, permission as ProviderBooleanConfigCapability)
}

export function getProviderBooleanConfigState(
  config: Record<string, unknown>,
  capability: ProviderBooleanConfigCapability,
): ProviderBooleanConfigState {
  const value = config[capability.path]
  if (value === undefined || value === false) return { enabled: false, error: null }
  if (value === true) return { enabled: true, error: null }
  return { enabled: false, error: `${capability.path} must be true or false` }
}

export function updateExecutionPermission<T extends { config: Record<string, unknown> }>(
  draft: T,
  capability: ProviderCapability,
  enabled: boolean,
): Omit<T, 'config'> & { config: Record<string, unknown> } {
  const permission = capability.executionPermission
  if (!permission.path) return draft
  return updateProviderBooleanConfig(draft, permission as ProviderBooleanConfigCapability, enabled)
}

export function updateProviderBooleanConfig<T extends { config: Record<string, unknown> }>(
  draft: T,
  capability: ProviderBooleanConfigCapability,
  enabled: boolean | undefined,
): Omit<T, 'config'> & { config: Record<string, unknown> } {
  const config = { ...draft.config }
  if (enabled === undefined) delete config[capability.path]
  else config[capability.path] = enabled
  return {
    ...draft,
    config,
  }
}

export function isSameProviderEnvKey(
  key: string,
  expectedKey: string | undefined,
): boolean {
  const normalizedExpectedKey = expectedKey?.trim()
  return !!normalizedExpectedKey && key.trim() === normalizedExpectedKey
}

function isActiveCredentialEnvKey(
  key: string,
  simplified: ProviderSimplifiedConfig,
): boolean {
  return isSameProviderEnvKey(key, simplified.apiKey?.envKey)
}

export function isProviderEnvDraftRowSensitive(
  row: Pick<ProviderEnvDraftRow, 'key' | 'sensitive'>,
  simplified: ProviderSimplifiedConfig,
): boolean {
  return row.sensitive
    || /key|token|secret|password|auth/i.test(row.key)
    || isActiveCredentialEnvKey(row.key, simplified)
}

export function createProviderEnvDraftRows(
  provider: RedactedProvider,
  capability: ProviderCapability,
): ProviderEnvDraftRow[] {
  const simplified = provider.simplified ?? {}
  return Object.entries(provider.redactedEnv ?? {}).map(([key, metadata]) => ({
    key,
    value: capability.apiBaseUrl?.kind === 'env' && key === capability.apiBaseUrl.path
      ? (simplified.apiBaseUrl ?? '')
      : '',
    write: { action: 'keep' },
    configured: metadata.configured,
    sensitive: isProviderEnvDraftRowSensitive({ key, sensitive: metadata.sensitive }, simplified),
  }))
}

export function markActiveCredentialEnvRowSensitive(
  rows: ProviderEnvDraftRow[],
  simplified: ProviderSimplifiedConfig,
): ProviderEnvDraftRow[] {
  return rows.map(row => isProviderEnvDraftRowSensitive(row, simplified) && !row.sensitive
    ? { ...row, sensitive: true }
    : row)
}

export function createProviderDraftTestSequence(): ProviderDraftTestSequence {
  let current = 0
  return {
    begin: () => {
      current += 1
      return current
    },
    invalidate: () => {
      current += 1
    },
    isCurrent: requestId => requestId === current,
  }
}

export function buildProviderEnvWrites(
  rows: ProviderEnvDraftRow[],
): Record<string, ProviderSecretWriteState> {
  const groupedRows = new Map<string, ProviderEnvDraftRow[]>()
  for (const row of rows) {
    const canonicalKey = row.key.trim()
    if (!canonicalKey) continue
    const group = groupedRows.get(canonicalKey) ?? []
    group.push(row)
    groupedRows.set(canonicalKey, group)
  }

  const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0
  const selectWrite = (
    canonicalKey: string,
    group: ProviderEnvDraftRow[],
  ): ProviderSecretWriteState => {
    const explicitRows = group.filter(row => row.write.action !== 'keep')
    if (explicitRows.length === 0) return { action: 'keep' }

    // Match the server boundary: an exact canonical row wins, then clear, then lexical aliases.
    const canonicalRows = explicitRows.filter(row => row.key === canonicalKey)
    const candidates = canonicalRows.length > 0 ? canonicalRows : explicitRows
    const clear = candidates.find(row => row.write.action === 'clear')
    if (clear) return clear.write

    return [...candidates]
      .sort((left, right) => (
        compareText(left.key, right.key)
        || compareText(
          left.write.action === 'replace' ? left.write.value : '',
          right.write.action === 'replace' ? right.write.value : '',
        )
      ))[0]!.write
  }

  return Object.fromEntries(
    [...groupedRows.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([canonicalKey, group]) => [canonicalKey, selectWrite(canonicalKey, group)]),
  )
}

export function syncSimplifiedFromConfig(
  current: ProviderSimplifiedConfig,
  config: Record<string, unknown>,
  capability: ProviderCapability,
): ProviderSimplifiedConfig {
  return {
    ...current,
    model: typeof config[capability.model.path] === 'string'
      ? config[capability.model.path] as string
      : '',
    reasoningEffort: capability.reasoningEffort?.kind === 'config'
      ? (typeof config[capability.reasoningEffort.path] === 'string'
          ? config[capability.reasoningEffort.path] as string
          : '')
      : current.reasoningEffort,
  }
}

export function syncSimplifiedFromSettings(
  current: ProviderSimplifiedConfig,
  settings: string,
  agentType: AgentType,
  configuredEnvKeys: ReadonlySet<string> = new Set(),
): ProviderSimplifiedConfig {
  if (agentType !== 'CODEX') return current
  const parsed = parseToml(settings) as Record<string, unknown>
  const providerId = typeof parsed.model_provider === 'string' && parsed.model_provider.trim()
    ? parsed.model_provider.trim()
    : 'openai'
  const effort = typeof parsed.model_reasoning_effort === 'string' ? parsed.model_reasoning_effort : ''
  const hasConfiguredEnvKey = (envKey: string) => (
    [...configuredEnvKeys].some(key => isSameProviderEnvKey(key, envKey))
  )

  if (providerId === 'openai') {
    return {
      ...current,
      apiBaseUrl: typeof parsed.openai_base_url === 'string' ? parsed.openai_base_url : '',
      apiKey: {
        configured: isSameProviderEnvKey(current.apiKey?.envKey ?? '', 'OPENAI_API_KEY')
          ? (current.apiKey?.configured ?? false)
          : hasConfiguredEnvKey('OPENAI_API_KEY'),
        envKey: 'OPENAI_API_KEY',
      },
      reasoningEffort: effort,
    }
  }

  if (isCodexNativeModelProviderId(providerId)) {
    return {
      ...current,
      apiBaseUrl: undefined,
      apiKey: undefined,
      reasoningEffort: effort,
    }
  }

  const providers = parsed.model_providers
  const selected = providers && typeof providers === 'object' && !Array.isArray(providers)
    ? (providers as Record<string, unknown>)[providerId]
    : undefined
  const selectedRecord = selected && typeof selected === 'object' && !Array.isArray(selected)
    ? selected as Record<string, unknown>
    : {}
  const envKey = typeof selectedRecord.env_key === 'string' && selectedRecord.env_key.trim()
    ? selectedRecord.env_key.trim()
    : undefined
  return {
    ...current,
    apiBaseUrl: typeof selectedRecord.base_url === 'string' ? selectedRecord.base_url : '',
    apiKey: envKey
      ? {
          configured: isSameProviderEnvKey(current.apiKey?.envKey ?? '', envKey)
            ? (current.apiKey?.configured ?? false)
            : hasConfiguredEnvKey(envKey),
          envKey,
        }
      : undefined,
    reasoningEffort: effort,
  }
}

export function usesCodexNativeModelProvider(settings: string): boolean {
  try {
    const parsed = parseToml(settings) as Record<string, unknown>
    return typeof parsed.model_provider === 'string'
      && isCodexNativeModelProviderId(parsed.model_provider.trim())
  } catch {
    return false
  }
}

function readAdvancedValue(
  draft: { agentType: AgentType; settings: string },
  field: ProviderConflictField,
  capability: ProviderCapability,
): string | undefined {
  try {
    if (draft.agentType === 'CLAUDE_CODE' && (field === 'apiBaseUrl' || field === 'apiKey')) {
      const settings = JSON.parse(draft.settings) as { env?: Record<string, unknown> }
      const path = field === 'apiBaseUrl' ? capability.apiBaseUrl?.path : capability.apiKey?.path
      const value = path ? settings.env?.[path] : undefined
      return typeof value === 'string' ? value : undefined
    }
    if (draft.agentType === 'CODEX' && (field === 'model' || field === 'reasoningEffort')) {
      const settings = parseToml(draft.settings) as Record<string, unknown>
      const path = field === 'model' ? 'model' : capability.reasoningEffort?.path
      const value = path ? settings[path] : undefined
      return typeof value === 'string' ? value : undefined
    }
  } catch {
    return undefined
  }
  return undefined
}

export function resolveProviderDraftConflict<T extends {
  agentType: AgentType
  config: Record<string, unknown>
  env: ProviderEnvDraftRow[]
  settings: string
  simplified: ProviderSimplifiedConfig
}>(
  draft: T,
  field: ProviderConflictField,
  resolution: ProviderConflictResolution,
  capability: ProviderCapability,
): T {
  if (resolution === 'simple') return draft

  const advancedValue = readAdvancedValue(draft, field, capability)
  const config = { ...draft.config }
  const simplified = { ...draft.simplified }
  let env = draft.env

  if (field === 'apiBaseUrl' && capability.apiBaseUrl) {
    if (advancedValue !== undefined) simplified.apiBaseUrl = advancedValue
    env = env.map(row => row.key === capability.apiBaseUrl!.path
      ? { ...row, value: '', write: { action: 'clear' as const } }
      : row)
  } else if (field === 'apiKey' && capability.apiKey) {
    simplified.apiKey = {
      configured: advancedValue !== undefined,
      envKey: capability.apiKey.path,
    }
    env = env.map(row => row.key === capability.apiKey!.path
      ? { ...row, value: '', write: { action: 'clear' as const } }
      : row)
  } else if (field === 'model') {
    if (advancedValue !== undefined) simplified.model = advancedValue
    delete config[capability.model.path]
  } else if (field === 'reasoningEffort' && advancedValue !== undefined) {
    simplified.reasoningEffort = advancedValue
  }

  return { ...draft, config, env, simplified }
}
