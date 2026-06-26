const DESKTOP_LOG_STRING_LIMIT = 4000;
const DESKTOP_LOG_SENSITIVE_KEY_PATTERN = /(api[_-]?key|token|secret|password|cookie|authorization|auth)/i;
const DESKTOP_LOG_QUOTED_AUTHORIZATION_PATTERN = /(["'])authorization\1(\s*:\s*)(["'])(?:\\.|(?!\3)[^\\\r\n])*\3/gi;
const DESKTOP_LOG_ESCAPED_QUOTED_AUTHORIZATION_PATTERN = /(\\["'])authorization\1(\s*:\s*)(\\["'])(?:\\.|(?!\3)[^\\\r\n])*\3/gi;
const DESKTOP_LOG_SENSITIVE_HEADER_PATTERN = /(^|[^\w-])([A-Za-z0-9_-]*(?:authorization|cookie)[A-Za-z0-9_-]*)(\s*[:=]\s*)/gi;
const DESKTOP_LOG_SENSITIVE_ASSIGNMENT_PATTERN = /(^|[^\w-])([A-Za-z0-9_-]*(?:api[_-]?key|auth[_-]?token|access[_-]?token|token|secret|password|cookie|authorization)[A-Za-z0-9_-]*)(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;'"})\]]+)/gi;
const DESKTOP_LOG_FIELD_BOUNDARY_PATTERN = /(^|[\s,])([A-Za-z][A-Za-z0-9_-]*)(\s*[:=]\s*)(?=[^\s=])/g;

export function sanitizeDesktopLogValue(value: unknown, key = '', depth = 0): unknown {
  if (key && DESKTOP_LOG_SENSITIVE_KEY_PATTERN.test(key)) {
    return '[REDACTED]';
  }
  if (value == null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return redactDesktopLogText(value);
  }
  if (depth >= 4) {
    return '[MaxDepth]';
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDesktopLogValue(item, key, depth + 1));
  }
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      result[childKey] = sanitizeDesktopLogValue(childValue, childKey, depth + 1);
    }
    return result;
  }
  return String(value);
}

export function redactDesktopLogText(value: string): string {
  const redactedQuotedAuthorization = redactDesktopQuotedAuthorizationHeaders(value);
  const truncated = redactedQuotedAuthorization.length > DESKTOP_LOG_STRING_LIMIT
    ? `${redactedQuotedAuthorization.slice(0, DESKTOP_LOG_STRING_LIMIT)}...[truncated]`
    : redactedQuotedAuthorization;

  return redactDesktopSensitiveHeaders(truncated
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(DESKTOP_LOG_SENSITIVE_ASSIGNMENT_PATTERN, '$1$2$3[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, 'sk-[REDACTED]'));
}

function redactDesktopQuotedAuthorizationHeaders(value: string): string {
  return value
    .replace(DESKTOP_LOG_ESCAPED_QUOTED_AUTHORIZATION_PATTERN, '$1authorization$1$2$3[REDACTED]$3')
    .replace(DESKTOP_LOG_QUOTED_AUTHORIZATION_PATTERN, '$1authorization$1$2$3[REDACTED]$3');
}

function redactDesktopSensitiveHeaders(value: string): string {
  const pattern = new RegExp(DESKTOP_LOG_SENSITIVE_HEADER_PATTERN);
  let result = '';
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value)) !== null) {
    const valueStart = match.index + match[0].length;
    if (valueStart <= cursor) continue;

    result += `${value.slice(cursor, valueStart)}[REDACTED]`;
    cursor = findDesktopSensitiveHeaderEnd(value, valueStart, match[2]);
    pattern.lastIndex = cursor;
  }

  return `${result}${value.slice(cursor)}`;
}

function findDesktopSensitiveHeaderEnd(value: string, valueStart: number, headerKey: string): number {
  const newlineOffset = value.slice(valueStart).search(/[\r\n]/);
  const lineEnd = newlineOffset === -1 ? value.length : valueStart + newlineOffset;
  const isAuthorizationHeader = headerKey.toLowerCase().includes('authorization');
  const isCookieHeader = headerKey.toLowerCase().includes('cookie');
  const pattern = new RegExp(DESKTOP_LOG_SENSITIVE_HEADER_PATTERN);
  pattern.lastIndex = valueStart;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    if (match.index >= lineEnd) break;
    return match.index;
  }

  if (isAuthorizationHeader) {
    return lineEnd;
  }

  const fieldPattern = new RegExp(DESKTOP_LOG_FIELD_BOUNDARY_PATTERN);
  fieldPattern.lastIndex = valueStart;
  while ((match = fieldPattern.exec(value)) !== null) {
    if (match.index >= lineEnd) break;
    if (isCookieHeader && isDesktopCookiePairBoundary(value, match.index)) continue;
    return match.index;
  }

  return lineEnd;
}

function isDesktopCookiePairBoundary(value: string, boundaryIndex: number): boolean {
  let index = boundaryIndex - 1;
  while (index >= 0 && /\s/.test(value[index])) {
    index -= 1;
  }
  return value[index] === ';';
}
