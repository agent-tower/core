import { parse as parseToml } from 'smol-toml';
import {
  AgentType,
  RuntimeType,
  getProviderCapability,
  supportsAgentRuntime,
  type Provider,
  type ProviderBackupFile,
  type ProviderConfigDiagnostic,
  type ProviderDraftInput,
  type ProviderSecretWriteState,
  type ProviderSimplifiedConfig,
  type RedactedProvider,
} from '@agent-tower/shared';
import { hasCodexBuiltinProviderAliasCollision } from '../utils/codex-provider-config.js';
import { resolveEffectiveProviderConnection } from './provider-effective-connection.service.js';

const REDACTED_VALUE = '__AGENT_TOWER_REDACTED__';
const SENSITIVE_KEY_PATTERN = /(?:^|[._-])(?:api[_-]?key|token|secret|password|credential|authorization|auth)(?:[._-]|$)/i;
const PROVIDER_AGENT_TYPES = new Set<string>(Object.values(AgentType));

interface TomlAssignment {
  path: string[];
  valueStart: number;
  valueEnd: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isSensitiveProviderKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

function redactObject(value: unknown, parentKey = ''): unknown {
  if (Array.isArray(value)) return value.map(item => redactObject(item, parentKey));
  if (!isRecord(value)) return parentKey && isSensitiveProviderKey(parentKey) ? REDACTED_VALUE : value;

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      isSensitiveProviderKey(key) ? REDACTED_VALUE : redactObject(child, key),
    ]),
  );
}

function collectSensitiveStrings(value: unknown, parentSensitive = false): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(item => collectSensitiveStrings(item, parentSensitive));
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, child]) => (
      collectSensitiveStrings(child, parentSensitive || isSensitiveProviderKey(key))
    ));
  }
  return parentSensitive && typeof value === 'string' && value ? [value] : [];
}

function splitTomlKey(key: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let quote = '';
  let escaped = false;
  for (let index = 0; index <= key.length; index += 1) {
    const char = key[index] ?? '.';
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === '\\') {
      escaped = true;
      continue;
    }
    if ((char === '"' || char === "'") && !quote) quote = char;
    else if (char === quote) quote = '';
    else if (char === '.' && !quote) {
      const raw = key.slice(start, index).trim();
      if (raw.startsWith('"') && raw.endsWith('"')) {
        try {
          segments.push(JSON.parse(raw) as string);
        } catch {
          segments.push(raw.slice(1, -1));
        }
      } else if (raw.startsWith("'") && raw.endsWith("'")) {
        segments.push(raw.slice(1, -1));
      } else if (raw) {
        segments.push(raw);
      }
      start = index + 1;
    }
  }
  return segments;
}

function findTomlEquals(line: string): number {
  let quote = '';
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && char === '\\') {
      escaped = true;
      continue;
    }
    if ((char === '"' || char === "'") && !quote) quote = char;
    else if (char === quote) quote = '';
    else if (char === '=' && !quote) return index;
    else if (char === '#' && !quote) return -1;
  }
  return -1;
}

function trimTomlValueEnd(source: string, start: number, end: number): number {
  let next = end;
  while (next > start && (source[next - 1] === ' ' || source[next - 1] === '\t' || source[next - 1] === '\r')) next -= 1;
  return next;
}

function findTomlValueEnd(source: string, start: number): number {
  let quote = '';
  let triple = false;
  let escaped = false;
  let bracketDepth = 0;
  let braceDepth = 0;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote) {
      if (quote === '"' && escaped) {
        escaped = false;
        continue;
      }
      if (quote === '"' && char === '\\') {
        escaped = true;
        continue;
      }
      if (triple && source.slice(index, index + 3) === quote.repeat(3)) {
        quote = '';
        triple = false;
        index += 2;
      } else if (!triple && char === quote) {
        quote = '';
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      triple = source.slice(index, index + 3) === char.repeat(3);
      if (triple) index += 2;
      continue;
    }
    if (char === '[') bracketDepth += 1;
    else if (char === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (char === '{') braceDepth += 1;
    else if (char === '}') braceDepth = Math.max(0, braceDepth - 1);
    else if (char === '#') {
      if (bracketDepth === 0 && braceDepth === 0) return trimTomlValueEnd(source, start, index);
      const newline = source.indexOf('\n', index);
      if (newline === -1) return trimTomlValueEnd(source, start, source.length);
      index = newline - 1;
    } else if (char === '\n' && bracketDepth === 0 && braceDepth === 0) {
      return trimTomlValueEnd(source, start, index);
    }
  }
  return trimTomlValueEnd(source, start, source.length);
}

function scanTomlAssignments(source: string): TomlAssignment[] {
  const assignments: TomlAssignment[] = [];
  let tablePath: string[] = [];
  let lineStart = 0;

  while (lineStart < source.length) {
    const lineEnd = source.indexOf('\n', lineStart);
    const contentEnd = lineEnd === -1 ? source.length : lineEnd;
    const line = source.slice(lineStart, contentEnd);
    const uncommented = splitTomlComment(line).value.trim();
    const tableMatch = uncommented.match(/^\[\[?(.+?)\]\]?$/);
    if (tableMatch) {
      tablePath = splitTomlKey(tableMatch[1]!);
      lineStart = lineEnd === -1 ? source.length : lineEnd + 1;
      continue;
    }

    const equals = findTomlEquals(line);
    if (equals >= 0) {
      const keyPath = splitTomlKey(line.slice(0, equals));
      let valueStart = lineStart + equals + 1;
      while (source[valueStart] === ' ' || source[valueStart] === '\t') valueStart += 1;
      const valueEnd = findTomlValueEnd(source, valueStart);
      if (keyPath.length > 0 && valueEnd > valueStart) {
        assignments.push({ path: [...tablePath, ...keyPath], valueStart, valueEnd });
      }
      const nextLine = source.indexOf('\n', valueEnd);
      lineStart = nextLine === -1 ? source.length : nextLine + 1;
      continue;
    }
    lineStart = lineEnd === -1 ? source.length : lineEnd + 1;
  }
  return assignments;
}

function containsSensitiveKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveKey);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => (
    isSensitiveProviderKey(key) || containsSensitiveKey(child)
  ));
}

function isSensitiveTomlAssignment(source: string, assignment: TomlAssignment): boolean {
  return assignment.path.some(isSensitiveProviderKey)
    || containsSensitiveKey(parseTomlAssignmentValue(source, assignment));
}

function maskTomlValue(raw: string): string {
  const masked = [...raw];
  let quote = '';
  let triple = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!;
    if (quote) {
      if (quote === '"' && escaped) escaped = false;
      else if (quote === '"' && char === '\\') escaped = true;
      else if (triple && raw.slice(index, index + 3) === quote.repeat(3)) {
        masked[index] = ' ';
        masked[index + 1] = ' ';
        masked[index + 2] = ' ';
        quote = '';
        triple = false;
        index += 2;
        continue;
      } else if (!triple && char === quote) quote = '';
      if (char !== '\n' && char !== '\r' && char !== '\t') masked[index] = ' ';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      triple = raw.slice(index, index + 3) === char.repeat(3);
      masked[index] = ' ';
      continue;
    }
    if (char === '#') {
      const newline = raw.indexOf('\n', index);
      if (newline === -1) break;
      index = newline - 1;
      continue;
    }
    if (char !== '\n' && char !== '\r' && char !== '\t' && char !== ' ') masked[index] = ' ';
  }
  return `${JSON.stringify(REDACTED_VALUE)}${masked.join('')}`;
}

function redactTomlSettings(settings: string): string {
  const sensitive = scanTomlAssignments(settings).filter(assignment => isSensitiveTomlAssignment(settings, assignment));
  return sensitive.reduceRight((redacted, assignment) => (
    redacted.slice(0, assignment.valueStart)
    + maskTomlValue(redacted.slice(assignment.valueStart, assignment.valueEnd))
    + redacted.slice(assignment.valueEnd)
  ), settings);
}

function parseTomlAssignmentValue(source: string, assignment: TomlAssignment): unknown {
  try {
    return (parseToml(`value = ${source.slice(assignment.valueStart, assignment.valueEnd)}`) as Record<string, unknown>).value;
  } catch {
    return undefined;
  }
}

function restoreObject(existing: unknown, incoming: unknown): unknown {
  if (incoming === REDACTED_VALUE) return existing;
  if (Array.isArray(incoming)) {
    const existingArray = Array.isArray(existing) ? existing : [];
    return incoming.map((item, index) => restoreObject(existingArray[index], item));
  }
  if (!isRecord(incoming)) return incoming;

  const existingRecord = isRecord(existing) ? existing : {};
  return Object.fromEntries(
    Object.entries(incoming).map(([key, child]) => [key, restoreObject(existingRecord[key], child)]),
  );
}

export function redactSettings(settings?: string): string | undefined {
  if (!settings) return settings;
  try {
    const parsed = JSON.parse(settings) as unknown;
    return JSON.stringify(redactObject(parsed), null, settings.includes('\n') ? 2 : undefined);
  } catch {
    return redactTomlSettings(settings);
  }
}

function getSettingsSecretValues(settings?: string): string[] {
  if (!settings) return [];
  try {
    return collectSensitiveStrings(JSON.parse(settings) as unknown);
  } catch {
    try {
      return collectSensitiveStrings(parseToml(settings) as unknown);
    } catch {
      return scanTomlAssignments(settings)
        .filter(assignment => isSensitiveTomlAssignment(settings, assignment))
        .flatMap(assignment => {
          const parsed = parseTomlAssignmentValue(settings, assignment);
          return parsed === undefined
            ? [settings.slice(assignment.valueStart, assignment.valueEnd).trim()]
            : collectSensitiveStrings(parsed, true);
        })
        .filter(Boolean);
    }
  }
}

function redactValues(message: string, values: string[]): string {
  return values.reduce(
    (redacted, value) => value ? redacted.split(value).join('[redacted]') : redacted,
    message,
  );
}

export function getProviderSecretValues(provider: Pick<Provider, 'env' | 'config' | 'settings'>): string[] {
  const values = [...Object.values(provider.env), ...getSettingsSecretValues(provider.settings)];
  const visit = (value: unknown, parentKey = '') => {
    if (Array.isArray(value)) {
      value.forEach(item => visit(item, parentKey));
      return;
    }
    if (isRecord(value)) {
      Object.entries(value).forEach(([key, child]) => visit(child, key));
      return;
    }
    if (parentKey && isSensitiveProviderKey(parentKey) && typeof value === 'string') values.push(value);
  };
  visit(provider.config);
  return values.filter(Boolean);
}

function restoreSettings(existing: string | undefined, incoming: string | undefined): string | undefined {
  if (incoming === undefined) return existing;
  if (!existing || !incoming.includes(REDACTED_VALUE)) return incoming;
  if (incoming === redactSettings(existing)) return existing;
  try {
    const existingJson = JSON.parse(existing) as unknown;
    const incomingJson = JSON.parse(incoming) as unknown;
    return JSON.stringify(restoreObject(existingJson, incomingJson), null, incoming.includes('\n') ? 2 : undefined);
  } catch {
    const existingValues = new Map<string, string[]>();
    for (const assignment of scanTomlAssignments(existing).filter(assignment => isSensitiveTomlAssignment(existing, assignment))) {
      const key = assignment.path.join('\u0000');
      const values = existingValues.get(key) ?? [];
      values.push(existing.slice(assignment.valueStart, assignment.valueEnd));
      existingValues.set(key, values);
    }
    const replacements = scanTomlAssignments(incoming)
      .filter(assignment => (
        isSensitiveTomlAssignment(incoming, assignment)
        && parseTomlAssignmentValue(incoming, assignment) === REDACTED_VALUE
      ))
      .flatMap(assignment => {
        const original = existingValues.get(assignment.path.join('\u0000'))?.shift();
        return original === undefined ? [] : [{ ...assignment, original }];
      });
    return replacements.reduceRight((restored, replacement) => (
      restored.slice(0, replacement.valueStart)
      + replacement.original
      + restored.slice(replacement.valueEnd)
    ), incoming);
  }
}

export function validateSettings(
  agentType: AgentType | string,
  settings?: string,
): ProviderConfigDiagnostic[] {
  if (!settings?.trim()) return [];

  try {
    if (agentType === AgentType.CLAUDE_CODE) {
      const parsed = JSON.parse(settings) as unknown;
      if (!isRecord(parsed)) throw new Error('Claude settings must be a JSON object');
    } else if (agentType === AgentType.CODEX) {
      parseToml(settings);
    }
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid settings format';
    return [{
      field: 'settings',
      code: 'INVALID_FORMAT',
      message: redactValues(message, getSettingsSecretValues(settings)),
    }];
  }
}

function readTomlString(settings: string | undefined, key: string): string | undefined {
  if (!settings?.trim()) return undefined;
  try {
    const parsed = parseToml(settings) as Record<string, unknown>;
    return typeof parsed[key] === 'string' ? parsed[key] : undefined;
  } catch {
    return undefined;
  }
}

export function validateProviderMappedFields(
  provider: Pick<Provider, 'agentType' | 'config' | 'settings'>,
): ProviderConfigDiagnostic[] {
  const capability = getProviderCapability(provider.agentType);
  if (!capability) return [];

  const diagnostics: ProviderConfigDiagnostic[] = [];
  // Agents with no permission-bypass surface declare no path and no toggle.
  const permissionPath = capability.executionPermission.path;
  const permissionValue = permissionPath ? provider.config[permissionPath] : undefined;
  if (permissionPath && permissionValue !== undefined && typeof permissionValue !== 'boolean') {
    diagnostics.push({
      field: 'executionPermission',
      code: 'INVALID_TYPE',
      message: `${permissionPath} must be true or false`,
    });
  }

  const fastModeCapability = capability.fastMode;
  if (fastModeCapability) {
    const fastMode = provider.config[fastModeCapability.path];
    if (fastMode !== undefined && typeof fastMode !== 'boolean') {
      diagnostics.push({
        field: 'fastMode',
        code: 'INVALID_TYPE',
        message: `${fastModeCapability.path} must be true or false`,
      });
    }
  }

  const websocketCapability = capability.disableResponsesWebsocket;
  if (websocketCapability) {
    const disableResponsesWebsocket = provider.config[websocketCapability.path];
    if (disableResponsesWebsocket !== undefined && typeof disableResponsesWebsocket !== 'boolean') {
      diagnostics.push({
        field: 'disableResponsesWebsocket',
        code: 'INVALID_TYPE',
        message: `${websocketCapability.path} must be true or false`,
      });
    }
    if (
      provider.agentType === AgentType.CODEX
      && disableResponsesWebsocket === true
      && hasCodexBuiltinProviderAliasCollision(provider.settings, 'agent-tower-openai-http')
    ) {
      diagnostics.push({
        field: 'disableResponsesWebsocket',
        code: 'CONFLICT',
        message: "disableResponsesWebsocket conflicts with reserved Codex model provider alias 'agent-tower-openai-http'",
      });
    }
  }

  if (capability.reasoningEffort?.options) {
    let effort: unknown;
    if (capability.reasoningEffort.kind === 'config') {
      effort = provider.config[capability.reasoningEffort.path];
    } else if (provider.settings?.trim() && validateSettings(provider.agentType, provider.settings).length === 0) {
      effort = (parseToml(provider.settings) as Record<string, unknown>)[capability.reasoningEffort.path];
    }
    const codexDynamicEffort = provider.agentType === AgentType.CODEX
      && (effort === 'max' || effort === 'ultra');
    if (effort !== undefined && (
      typeof effort !== 'string'
      || (!capability.reasoningEffort.options.includes(effort) && !codexDynamicEffort)
    )) {
      diagnostics.push({
        field: 'reasoningEffort',
        code: 'INVALID_ENUM',
        message: `Unsupported reasoning effort: ${String(effort)}`,
      });
    }
  }

  return diagnostics;
}

function readClaudeSettingsEnv(settings: string | undefined, key: string): string | undefined {
  if (!settings?.trim()) return undefined;
  try {
    const parsed = JSON.parse(settings) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.env)) return undefined;
    return typeof parsed.env[key] === 'string' ? parsed.env[key] as string : undefined;
  } catch {
    return undefined;
  }
}

function removeClaudeSettingsEnv(settings: string | undefined, key: string): string | undefined {
  if (!settings?.trim()) return settings;
  try {
    const parsed = JSON.parse(settings) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.env) || !(key in parsed.env)) return settings;
    delete parsed.env[key];
    return JSON.stringify(parsed, null, 2);
  } catch {
    return settings;
  }
}

function splitTomlComment(value: string): { value: string; comment: string } {
  let quote = '';
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if ((char === '"' || char === "'") && !quote) quote = char;
    else if (char === quote) quote = '';
    else if (char === '#' && !quote) {
      return { value: value.slice(0, index).trimEnd(), comment: value.slice(index) };
    }
  }
  return { value: value.trimEnd(), comment: '' };
}

export function updateTomlString(
  settings: string | undefined,
  key: string,
  value: string | undefined,
): string {
  const source = settings ?? '';
  if (validateSettings(AgentType.CODEX, source).length > 0) return source;

  const lines = source.split('\n');
  const assignment = new RegExp(`^(\\s*)${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=(.*)$`);
  let tableStarted = false;
  let matchedIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim();
    if (/^\[\[?.+\]\]?$/.test(trimmed)) tableStarted = true;
    if (!tableStarted && assignment.test(lines[index]!)) {
      matchedIndex = index;
      break;
    }
  }

  if (matchedIndex >= 0) {
    const match = lines[matchedIndex]!.match(assignment)!;
    const { comment } = splitTomlComment(match[2] ?? '');
    if (value === undefined || value === '') {
      if (comment) lines[matchedIndex] = `${match[1]}${comment}`;
      else lines.splice(matchedIndex, 1);
    } else {
      lines[matchedIndex] = `${match[1]}${key} = ${JSON.stringify(value)}${comment ? ` ${comment}` : ''}`;
    }
    return lines.join('\n');
  }

  if (value === undefined || value === '') return source;
  const insertAt = lines.findIndex(line => /^\s*\[\[?.+\]\]?>?\s*$/.test(line));
  const nextLine = `${key} = ${JSON.stringify(value)}`;
  if (insertAt === -1) {
    if (!source) return nextLine;
    return source.endsWith('\n') ? `${source}${nextLine}\n` : `${source}\n${nextLine}`;
  }
  lines.splice(insertAt, 0, nextLine);
  return lines.join('\n');
}

function updateTomlStringAtPath(
  settings: string | undefined,
  path: string[],
  value: string | undefined,
): { settings: string; updated: boolean } {
  const source = settings ?? '';
  if (validateSettings(AgentType.CODEX, source).length > 0) return { settings: source, updated: false };
  if (path.length === 1) return { settings: updateTomlString(source, path[0]!, value), updated: true };

  const matches = scanTomlAssignments(source).filter(assignment => (
    assignment.path.length === path.length
    && assignment.path.every((part, index) => part === path[index])
  ));
  if (matches.length === 1) {
    const assignment = matches[0]!;
    if (value !== undefined && value !== '') {
      return {
        settings: source.slice(0, assignment.valueStart)
          + JSON.stringify(value)
          + source.slice(assignment.valueEnd),
        updated: true,
      };
    }

    const lineStart = source.lastIndexOf('\n', assignment.valueStart - 1) + 1;
    const nextNewline = source.indexOf('\n', assignment.valueEnd);
    const lineEnd = nextNewline === -1 ? source.length : nextNewline;
    const suffix = source.slice(assignment.valueEnd, lineEnd);
    const commentIndex = suffix.indexOf('#');
    if (commentIndex >= 0) {
      const indent = source.slice(lineStart).match(/^\s*/)?.[0] ?? '';
      const comment = suffix.slice(commentIndex);
      return {
        settings: source.slice(0, lineStart) + indent + comment + source.slice(lineEnd),
        updated: true,
      };
    }
    const removeEnd = nextNewline === -1 ? lineEnd : lineEnd + 1;
    return { settings: source.slice(0, lineStart) + source.slice(removeEnd), updated: true };
  }
  if (matches.length > 1) return { settings: source, updated: false };
  if (value === undefined || value === '') return { settings: source, updated: true };

  const tablePath = path.slice(0, -1);
  const lines = source.split('\n');
  const tableIndex = lines.findIndex(line => {
    const uncommented = splitTomlComment(line).value.trim();
    const match = uncommented.match(/^\[(.+)\]$/);
    if (!match || uncommented.startsWith('[[')) return false;
    const candidate = splitTomlKey(match[1]!);
    return candidate.length === tablePath.length
      && candidate.every((part, index) => part === tablePath[index]);
  });
  if (tableIndex < 0) return { settings: source, updated: false };
  lines.splice(tableIndex + 1, 0, `${path.at(-1)} = ${JSON.stringify(value)}`);
  return { settings: lines.join('\n'), updated: true };
}

function applyCodexApiBaseUrl<T extends Pick<Provider, 'agentType' | 'env' | 'config' | 'settings'>>(
  provider: T,
  value: string,
): { provider: T; diagnostics: ProviderConfigDiagnostic[] } {
  const normalizedValue = value.trim();
  const connection = resolveEffectiveProviderConnection(provider);
  const diagnostics = connection.diagnostics.filter(item => item.code !== 'INVALID_FORMAT');
  if (diagnostics.length > 0) return { provider, diagnostics };

  const env = { ...provider.env };
  delete env.OPENAI_BASE_URL;
  if (
    connection.providerKind === 'built-in'
    || connection.source === 'codex-openai-compatible'
  ) {
    return {
      provider: {
        ...provider,
        env,
        settings: updateTomlString(provider.settings, 'openai_base_url', normalizedValue || undefined),
      },
      diagnostics: [],
    };
  }

  if (connection.providerKind === 'custom' && connection.modelProviderId) {
    const updated = updateTomlStringAtPath(
      provider.settings,
      ['model_providers', connection.modelProviderId, 'base_url'],
      normalizedValue || undefined,
    );
    if (!updated.updated) {
      return {
        provider,
        diagnostics: [{
          field: 'apiBaseUrl',
          code: 'CONFLICT',
          message: `Cannot safely update base_url for active Codex model provider '${connection.modelProviderId}'`,
        }],
      };
    }
    return { provider: { ...provider, env, settings: updated.settings }, diagnostics: [] };
  }

  if (connection.providerKind === 'native') {
    return {
      provider,
      diagnostics: [{
        field: 'apiBaseUrl',
        code: 'CONFLICT',
        message: `API URL for native Codex model provider '${connection.modelProviderId}' is managed by Codex settings`,
      }],
    };
  }

  return { provider, diagnostics: connection.diagnostics };
}

export function mapAdvancedToSimple(provider: Pick<Provider, 'agentType' | 'env' | 'config' | 'settings'>): ProviderSimplifiedConfig {
  const capability = getProviderCapability(provider.agentType);
  if (!capability) return {};

  const configModel = provider.config[capability.model.path];
  const simple: ProviderSimplifiedConfig = {
    model: typeof configModel === 'string'
      ? configModel
      : (provider.agentType === AgentType.CODEX ? readTomlString(provider.settings, 'model') : undefined),
  };

  if (provider.agentType === AgentType.CODEX) {
    const connection = resolveEffectiveProviderConnection(provider);
    if (connection.baseUrl && connection.source !== 'default') simple.apiBaseUrl = connection.baseUrl;
    const credentialEnvKey = connection.credentialEnvKey ?? connection.envKey;
    if (credentialEnvKey) {
      simple.apiKey = {
        configured: !!connection.secret,
        envKey: credentialEnvKey,
      };
    }
  } else if (capability.apiBaseUrl) {
    const value = provider.env[capability.apiBaseUrl.path]
      ?? (provider.agentType === AgentType.CLAUDE_CODE
        ? readClaudeSettingsEnv(provider.settings, capability.apiBaseUrl.path)
        : undefined);
    if (value) simple.apiBaseUrl = value;
  }
  if (capability.apiKey && provider.agentType !== AgentType.CODEX) {
    simple.apiKey = {
      configured: !!provider.env[capability.apiKey.path]
        || (provider.agentType === AgentType.CLAUDE_CODE
          && !!readClaudeSettingsEnv(provider.settings, capability.apiKey.path)),
      envKey: capability.apiKey.path,
    };
  }
  if (capability.reasoningEffort?.kind === 'config') {
    const value = provider.config[capability.reasoningEffort.path];
    if (typeof value === 'string') simple.reasoningEffort = value;
  } else if (capability.reasoningEffort?.kind === 'settings') {
    simple.reasoningEffort = readTomlString(provider.settings, capability.reasoningEffort.path);
  }
  return simple;
}

export function mapSimpleToAdvanced<T extends Pick<Provider, 'agentType' | 'env' | 'config' | 'settings'>>(
  provider: T,
  simplified: ProviderSimplifiedConfig,
): T {
  return mapSimpleToAdvancedWithDiagnostics(provider, simplified).provider;
}

function mapSimpleToAdvancedWithDiagnostics<T extends Pick<Provider, 'agentType' | 'env' | 'config' | 'settings'>>(
  provider: T,
  simplified: ProviderSimplifiedConfig,
): { provider: T; diagnostics: ProviderConfigDiagnostic[] } {
  const capability = getProviderCapability(provider.agentType);
  if (!capability) return { provider, diagnostics: [] };
  const env = { ...provider.env };
  const config = { ...provider.config };
  let settings = provider.settings;
  const diagnostics: ProviderConfigDiagnostic[] = [];

  if (capability.apiBaseUrl && simplified.apiBaseUrl !== undefined) {
    if (provider.agentType === AgentType.CODEX) {
      const mapped = applyCodexApiBaseUrl({ ...provider, env, config, settings }, simplified.apiBaseUrl);
      Object.assign(env, mapped.provider.env);
      if (!('OPENAI_BASE_URL' in mapped.provider.env)) delete env.OPENAI_BASE_URL;
      settings = mapped.provider.settings;
      diagnostics.push(...mapped.diagnostics);
    } else {
      if (simplified.apiBaseUrl) env[capability.apiBaseUrl.path] = simplified.apiBaseUrl;
      else delete env[capability.apiBaseUrl.path];
    }
    if (provider.agentType === AgentType.CLAUDE_CODE) {
      settings = removeClaudeSettingsEnv(settings, capability.apiBaseUrl.path);
    }
  }
  if (simplified.model !== undefined) {
    if (simplified.model) config[capability.model.path] = simplified.model;
    else delete config[capability.model.path];
    if (provider.agentType === AgentType.CODEX) settings = updateTomlString(settings, 'model', undefined);
  }
  if (capability.reasoningEffort && simplified.reasoningEffort !== undefined) {
    if (capability.reasoningEffort.kind === 'config') {
      if (simplified.reasoningEffort) config[capability.reasoningEffort.path] = simplified.reasoningEffort;
      else delete config[capability.reasoningEffort.path];
    } else {
      settings = updateTomlString(settings, capability.reasoningEffort.path, simplified.reasoningEffort || undefined);
    }
  }

  return { provider: { ...provider, env, config, settings }, diagnostics };
}

export function detectDraftConflicts(
  provider: Pick<Provider, 'agentType' | 'env' | 'config' | 'settings'>,
  simplified: ProviderSimplifiedConfig,
): ProviderConfigDiagnostic[] {
  const mapped = mapAdvancedToSimple(provider);
  const fields: Array<keyof Pick<ProviderSimplifiedConfig, 'apiBaseUrl' | 'model' | 'reasoningEffort'>> = [
    'apiBaseUrl',
    'model',
    'reasoningEffort',
  ];
  return fields.flatMap(field => (
    simplified[field] !== undefined && simplified[field] !== mapped[field]
      ? [{
          field,
          code: 'CONFLICT' as const,
          message: `${field} differs between simplified and advanced configuration`,
        }]
      : []
  ));
}

export function detectAdvancedConflicts(
  provider: Pick<Provider, 'agentType' | 'env' | 'config' | 'settings'>,
): ProviderConfigDiagnostic[] {
  const diagnostics: ProviderConfigDiagnostic[] = [];
  if (provider.agentType === AgentType.CLAUDE_CODE) {
    for (const [field, key] of [
      ['apiBaseUrl', 'ANTHROPIC_BASE_URL'],
      ['apiKey', 'ANTHROPIC_API_KEY'],
    ] as const) {
      const envValue = provider.env[key];
      const settingsValue = readClaudeSettingsEnv(provider.settings, key);
      if (envValue && settingsValue && envValue !== settingsValue) {
        diagnostics.push({
          field,
          code: 'CONFLICT',
          message: `${field} differs between env and Claude settings.env`,
        });
      }
    }
  }
  if (provider.agentType === AgentType.CODEX) {
    const configModel = provider.config.model;
    const settingsModel = readTomlString(provider.settings, 'model');
    if (typeof configModel === 'string' && settingsModel && configModel !== settingsModel) {
      diagnostics.push({
        field: 'model',
        code: 'CONFLICT',
        message: 'model differs between runtime config and Codex TOML',
      });
    }
  }
  return diagnostics;
}

function resolveAdvancedConflicts(provider: Provider, input: ProviderDraftInput): Provider {
  const resolutions = input.conflictResolutions;
  if (!resolutions) return provider;
  const next = { ...provider, env: { ...provider.env }, config: { ...provider.config } };

  if (provider.agentType === AgentType.CLAUDE_CODE) {
    for (const [field, key] of [
      ['apiBaseUrl', 'ANTHROPIC_BASE_URL'],
      ['apiKey', 'ANTHROPIC_API_KEY'],
    ] as const) {
      const resolution = resolutions[field];
      if (resolution === 'simple') next.settings = removeClaudeSettingsEnv(next.settings, key);
      else if (resolution === 'advanced') delete next.env[key];
    }
  }
  if (provider.agentType === AgentType.CODEX && resolutions.model) {
    if (resolutions.model === 'simple') next.settings = updateTomlString(next.settings, 'model', undefined);
    else delete next.config.model;
  }
  return next;
}

export function applySecretWrites(
  existing: Record<string, string>,
  writes: Record<string, ProviderSecretWriteState> | undefined,
): Record<string, string> {
  if (!writes) return { ...existing };
  const env = { ...existing };
  const groupedWrites = new Map<string, Array<[string, ProviderSecretWriteState]>>();
  for (const entry of Object.entries(writes)) {
    const canonicalKey = entry[0].trim();
    const group = groupedWrites.get(canonicalKey) ?? [];
    group.push(entry);
    groupedWrites.set(canonicalKey, group);
  }

  for (const [canonicalKey, group] of groupedWrites) {
    const explicitWrites = group.filter(([, write]) => write.action !== 'keep');
    if (explicitWrites.length === 0) continue;

    const canonicalWrite = explicitWrites.find(([key]) => key === canonicalKey);
    const selectedWrite = canonicalWrite
      ?? explicitWrites.find(([, write]) => write.action === 'clear')
      ?? [...explicitWrites].sort(([left], [right]) => left.localeCompare(right))[0];

    for (const key of Object.keys(env)) {
      if (key.trim() === canonicalKey) delete env[key];
    }
    if (selectedWrite?.[1].action === 'replace') {
      env[canonicalKey] = selectedWrite[1].value;
    }
  }
  return env;
}

export function normalizeProviderDraft(
  input: ProviderDraftInput,
  existing?: Provider | null,
): { provider: Provider; diagnostics: ProviderConfigDiagnostic[] } {
  const base: Provider = existing ? structuredClone(existing) : {
    id: '',
    name: '',
    agentType: input.agentType,
    runtimeType: input.runtimeType ?? RuntimeType.CLI,
    env: {},
    config: {},
    isDefault: false,
  };
  const incomingConfig = input.config === undefined
    ? base.config
    : restoreObject(base.config, input.config) as Record<string, unknown>;
  const restoredSettings = restoreSettings(base.settings, input.settings);
  let provider: Provider = {
    ...base,
    name: input.name.trim(),
    agentType: input.agentType,
    runtimeType: existing?.runtimeType ?? input.runtimeType ?? RuntimeType.CLI,
    env: applySecretWrites(base.env, input.env),
    config: incomingConfig,
    settings: restoredSettings,
    isDefault: input.isDefault ?? base.isDefault,
  };
  const diagnostics: ProviderConfigDiagnostic[] = [];
  const runtimeType = provider.runtimeType ?? RuntimeType.CLI;

  if (!provider.name) diagnostics.push({ field: 'name', code: 'REQUIRED', message: 'Provider name is required' });
  if (!supportsAgentRuntime(provider.agentType, runtimeType)) {
    diagnostics.push({
      field: 'config',
      code: 'INVALID_ENUM',
      message: `Agent '${provider.agentType}' does not support the '${runtimeType}' runtime`,
    });
  }
  const capability = getProviderCapability(input.agentType);
  const legacyPermissionPath = capability?.executionPermission.path;
  const legacyPermissionValue = legacyPermissionPath ? provider.config[legacyPermissionPath] : undefined;
  const rawAcpPermissionMode = provider.config.permissionMode
    ?? provider.config.acpPermissionMode
    ?? (typeof legacyPermissionValue === 'boolean'
      ? legacyPermissionValue ? 'UNRESTRICTED' : 'ASK'
      : undefined);
  if (runtimeType === RuntimeType.ACP && rawAcpPermissionMode !== undefined) {
    if (
      rawAcpPermissionMode !== 'ASK'
      && rawAcpPermissionMode !== 'UNRESTRICTED'
      && rawAcpPermissionMode !== 'AUTO_APPROVE'
    ) {
      diagnostics.push({
        field: 'executionPermission',
        code: 'INVALID_ENUM',
        message: 'ACP permissionMode must be ASK or UNRESTRICTED',
      });
    } else {
      const config = { ...provider.config };
      config.permissionMode = rawAcpPermissionMode === 'AUTO_APPROVE' ? 'UNRESTRICTED' : rawAcpPermissionMode;
      delete config.acpPermissionMode;
      if (legacyPermissionPath) delete config[legacyPermissionPath];
      provider = { ...provider, config };
    }
  }
  for (const [key, write] of Object.entries(input.env ?? {})) {
    if (write.action === 'replace' && !write.value.trim()) {
      diagnostics.push({ field: 'env', code: 'REQUIRED', message: `Environment value is required for ${key}` });
    }
  }

  const apiKeyPath = capability?.apiKey?.path;
  const oldSettingsDiagnostics = existing ? validateSettings(existing.agentType, existing.settings) : [];
  const currentSettingsDiagnostics = validateSettings(provider.agentType, provider.settings);
  const hasAdvancedChanges = !!existing && (
    JSON.stringify(provider.env) !== JSON.stringify(base.env)
    || JSON.stringify(provider.config) !== JSON.stringify(base.config)
    || provider.settings !== base.settings
  );
  const hasMappedChanges = Object.values(input.simplified ?? {}).some(value => value !== undefined)
    || Object.values(input.conflictResolutions ?? {}).some(value => value !== undefined);
  const invalidSettingsBlockChanges = oldSettingsDiagnostics.length > 0
    && currentSettingsDiagnostics.length > 0
    && (hasAdvancedChanges || hasMappedChanges);

  if (invalidSettingsBlockChanges) {
    provider = {
      ...provider,
      env: structuredClone(base.env),
      config: structuredClone(base.config),
      settings: base.settings,
    };
    diagnostics.push(...oldSettingsDiagnostics);
  } else {
    provider = resolveAdvancedConflicts(provider, input);
    if (input.simplified) {
      const mapped = mapSimpleToAdvancedWithDiagnostics(provider, input.simplified);
      provider = mapped.provider;
      diagnostics.push(...mapped.diagnostics);
    }
    if (
      input.agentType === AgentType.CLAUDE_CODE
      && apiKeyPath
      && input.env?.[apiKeyPath]
      && input.env[apiKeyPath].action !== 'keep'
    ) {
      provider.settings = removeClaudeSettingsEnv(provider.settings, apiKeyPath);
    }
  }
  const baseUrl = input.simplified?.apiBaseUrl;
  if (baseUrl) {
    const trimmed = baseUrl.trim();
    try {
      if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
        throw new Error('missing protocol separator');
      }
      const url = new URL(trimmed);
      if (!url.host) throw new Error('missing host');
    } catch {
      diagnostics.push({ field: 'apiBaseUrl', code: 'INVALID_URL', message: 'API URL must be a complete http:// or https:// URL' });
    }
  }
  if (oldSettingsDiagnostics.length === 0 || provider.settings !== existing?.settings) {
    diagnostics.push(...validateSettings(provider.agentType, provider.settings));
  }
  if (provider.settings?.includes(REDACTED_VALUE)) {
    diagnostics.push({ field: 'settings', code: 'INVALID_FORMAT', message: 'A redacted value must be replaced or kept unchanged' });
  }
  diagnostics.push(...validateProviderMappedFields(provider));
  diagnostics.push(...detectAdvancedConflicts(provider));
  diagnostics.push(...resolveEffectiveProviderConnection(provider).diagnostics.filter(item => (
    item.code !== 'INVALID_FORMAT'
    && !diagnostics.some(existingDiagnostic => (
      existingDiagnostic.field === item.field && existingDiagnostic.code === item.code
    ))
  )));

  return { provider, diagnostics };
}

export type ProviderBackupDiagnostic = ProviderConfigDiagnostic & {
  providerIndex: number;
  providerId: string;
};

function isProviderAgentType(value: string): value is AgentType {
  return PROVIDER_AGENT_TYPES.has(value);
}

export function validateProviderBackupDrafts(
  backup: Pick<ProviderBackupFile, 'providers'>,
): ProviderBackupDiagnostic[] {
  return backup.providers.flatMap((incoming, providerIndex) => {
    if (!isProviderAgentType(incoming.agentType)) {
      return [{
        providerIndex,
        providerId: incoming.id,
        field: 'config',
        code: 'INVALID_ENUM',
        message: `Unsupported agent type: ${incoming.agentType}`,
      }];
    }
    const { diagnostics } = normalizeProviderDraft({
      name: incoming.name,
      agentType: incoming.agentType,
      runtimeType: incoming.runtimeType,
      env: Object.fromEntries(Object.entries(incoming.env ?? {}).map(([key, value]) => [
        key,
        { action: 'replace' as const, value },
      ])),
      config: incoming.config ?? {},
      settings: incoming.settings,
      isDefault: incoming.isDefault,
    });

    return diagnostics.map(diagnostic => ({
      ...diagnostic,
      providerIndex,
      providerId: incoming.id,
    }));
  });
}

export function redactProvider(provider: Provider, deletable?: boolean): RedactedProvider {
  const connection = resolveEffectiveProviderConnection(provider);
  return {
    ...provider,
    env: {},
    redactedEnv: Object.fromEntries(Object.entries(provider.env).map(([key, value]) => [
      key,
      {
        configured: !!value,
        sensitive: key === connection.envKey
          || key === connection.credentialEnvKey
          || isSensitiveProviderKey(key),
      },
    ])),
    config: redactObject(provider.config) as Record<string, unknown>,
    settings: redactSettings(provider.settings),
    simplified: mapAdvancedToSimple(provider),
    diagnostics: [
      ...validateSettings(provider.agentType, provider.settings),
      ...validateProviderMappedFields(provider),
      ...detectAdvancedConflicts(provider),
      ...connection.diagnostics.filter(item => item.code !== 'INVALID_FORMAT'),
    ],
    ...(deletable === undefined ? {} : { deletable }),
  };
}
