import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { resolveDataDir } from './data-dir.js';

export type ErrorLogLevel = 'info' | 'warn' | 'error';

export interface ErrorLogEntry {
  level: ErrorLogLevel;
  source: string;
  message: string;
  error?: unknown;
  metadata?: Record<string, unknown>;
}

interface ErrorLogOptions {
  dataDir?: string;
  fileName?: string;
  now?: Date;
}

const DEFAULT_LOG_FILE = 'server.log';
const MAX_STRING_LENGTH = 4000;
const MAX_DEPTH = 4;
const SENSITIVE_KEY_PATTERN = /(api[_-]?key|token|secret|password|cookie|authorization|auth)/i;
const QUOTED_AUTHORIZATION_PATTERN = /(["'])authorization\1(\s*:\s*)(["'])(?:\\.|(?!\3)[^\\\r\n])*\3/gi;
const ESCAPED_QUOTED_AUTHORIZATION_PATTERN = /(\\["'])authorization\1(\s*:\s*)(\\["'])(?:\\.|(?!\3)[^\\\r\n])*\3/gi;
const SENSITIVE_HEADER_PATTERN = /(^|[^\w-])([A-Za-z0-9_-]*(?:authorization|cookie)[A-Za-z0-9_-]*)(\s*[:=]\s*)/gi;
const SENSITIVE_ASSIGNMENT_PATTERN = /(^|[^\w-])([A-Za-z0-9_-]*(?:api[_-]?key|auth[_-]?token|access[_-]?token|token|secret|password|cookie|authorization)[A-Za-z0-9_-]*)(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;'"})\]]+)/gi;
const FIELD_BOUNDARY_PATTERN = /(^|[\s,])([A-Za-z][A-Za-z0-9_-]*)(\s*[:=]\s*)(?=[^\s=])/g;

let processHandlersInstalled = false;
const loggedUnhandledRejections = new WeakSet<object>();

export function getLogsDir(dataDir = resolveDataDir()): string {
  return path.join(dataDir, 'logs');
}

export function getErrorLogFilePath(dataDir = resolveDataDir(), fileName = DEFAULT_LOG_FILE): string {
  return path.join(getLogsDir(dataDir), fileName);
}

export function writeErrorLog(entry: ErrorLogEntry, options: ErrorLogOptions = {}): string | null {
  try {
    const logFile = getErrorLogFilePath(options.dataDir, options.fileName ?? DEFAULT_LOG_FILE);
    mkdirSync(path.dirname(logFile), { recursive: true });
    appendFileSync(logFile, `${formatErrorLogEntry(entry, options.now)}\n`, 'utf-8');
    return logFile;
  } catch {
    return null;
  }
}

export function installProcessErrorLogging(dataDir?: string): void {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;

  process.on('uncaughtExceptionMonitor', (error) => {
    if (loggedUnhandledRejections.has(error)) return;
    writeErrorLog({
      level: 'error',
      source: 'process.uncaughtException',
      message: error instanceof Error ? error.message : String(error),
      error,
    }, { dataDir });
  });

  process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? reason : new Error(`Unhandled rejection: ${String(reason)}`);
    writeErrorLog({
      level: 'error',
      source: 'process.unhandledRejection',
      message: error.message,
      error,
    }, { dataDir });
    loggedUnhandledRejections.add(error);
    setImmediate(() => {
      throw error;
    });
  });
}

export function formatErrorLogEntry(entry: ErrorLogEntry, now = new Date()): string {
  const error = normalizeError(entry.error);
  return JSON.stringify({
    time: now.toISOString(),
    level: entry.level,
    source: entry.source,
    message: redactSensitiveText(entry.message),
    ...(error ? { error } : {}),
    ...(entry.metadata ? { metadata: sanitizeValue(entry.metadata) } : {}),
  });
}

function normalizeError(error: unknown): Record<string, unknown> | null {
  if (error == null) return null;
  if (error instanceof Error) {
    return sanitizeValue({
      name: error.name,
      message: error.message,
      stack: error.stack,
      code: (error as { code?: unknown }).code,
    }) as Record<string, unknown>;
  }
  return sanitizeValue({ message: String(error) }) as Record<string, unknown>;
}

function sanitizeValue(value: unknown, key = '', depth = 0): unknown {
  if (key && SENSITIVE_KEY_PATTERN.test(key)) {
    return '[REDACTED]';
  }
  if (value == null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return redactSensitiveText(value);
  }
  if (value instanceof Error) {
    return normalizeError(value);
  }
  if (depth >= MAX_DEPTH) {
    return '[MaxDepth]';
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, key, depth + 1));
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      result[childKey] = sanitizeValue(childValue, childKey, depth + 1);
    }
    return result;
  }
  return String(value);
}

function redactSensitiveText(value: string): string {
  const redactedQuotedAuthorization = redactQuotedAuthorizationHeaders(value);
  const truncated = redactedQuotedAuthorization.length > MAX_STRING_LENGTH
    ? `${redactedQuotedAuthorization.slice(0, MAX_STRING_LENGTH)}...[truncated]`
    : redactedQuotedAuthorization;

  return redactSensitiveHeaders(truncated
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, '$1$2$3[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, 'sk-[REDACTED]'));
}

function redactQuotedAuthorizationHeaders(value: string): string {
  return value
    .replace(ESCAPED_QUOTED_AUTHORIZATION_PATTERN, '$1authorization$1$2$3[REDACTED]$3')
    .replace(QUOTED_AUTHORIZATION_PATTERN, '$1authorization$1$2$3[REDACTED]$3');
}

function redactSensitiveHeaders(value: string): string {
  const pattern = new RegExp(SENSITIVE_HEADER_PATTERN);
  let result = '';
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value)) !== null) {
    const valueStart = match.index + match[0].length;
    if (valueStart <= cursor) continue;

    result += `${value.slice(cursor, valueStart)}[REDACTED]`;
    cursor = findSensitiveHeaderEnd(value, valueStart, match[2]);
    pattern.lastIndex = cursor;
  }

  return `${result}${value.slice(cursor)}`;
}

function findSensitiveHeaderEnd(value: string, valueStart: number, headerKey: string): number {
  const newlineOffset = value.slice(valueStart).search(/[\r\n]/);
  const lineEnd = newlineOffset === -1 ? value.length : valueStart + newlineOffset;
  const isAuthorizationHeader = headerKey.toLowerCase().includes('authorization');
  const isCookieHeader = headerKey.toLowerCase().includes('cookie');
  const pattern = new RegExp(SENSITIVE_HEADER_PATTERN);
  pattern.lastIndex = valueStart;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    if (match.index >= lineEnd) break;
    return match.index;
  }

  if (isAuthorizationHeader) {
    return lineEnd;
  }

  const fieldPattern = new RegExp(FIELD_BOUNDARY_PATTERN);
  fieldPattern.lastIndex = valueStart;
  while ((match = fieldPattern.exec(value)) !== null) {
    if (match.index >= lineEnd) break;
    if (isCookieHeader && isCookiePairBoundary(value, match.index)) continue;
    return match.index;
  }

  return lineEnd;
}

function isCookiePairBoundary(value: string, boundaryIndex: number): boolean {
  let index = boundaryIndex - 1;
  while (index >= 0 && /\s/.test(value[index])) {
    index -= 1;
  }
  return value[index] === ';';
}
