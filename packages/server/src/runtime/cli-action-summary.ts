/** Display only selected action fields. Never serialize the native payload into runtime/log DTOs. */
export function describeCliAction(input: Record<string, unknown>, sensitiveValues: string[] = []): string {
  const redact = (value: string) => sensitiveValues.reduce((text, secret) => secret.length >= 4 ? text.split(secret).join('<redacted>') : text, value)
    .replace(/\b(?:sk|ghp|github_pat)[_-][\w-]+/gi, '<redacted>')
    .replace(/((?:token|password|secret|api[_-]?key|authorization|cookie)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1<redacted>')
    .replace(/((?:--)?(?:token|password|secret|api[_-]?key)\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1<redacted>')
    .replace(/(Bearer\s+)\S+/gi, '$1<redacted>')
    .replace(/(https?:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1<redacted>@');
  const lines = ['command', 'file_path', 'path', 'url', 'description'].flatMap(key => typeof input[key] === 'string' ? [`${key}: ${redact(input[key] as string)}`] : []);
  const text = lines.join('\n') || 'Native tool input is not displayed.';
  return text.length > 4000 ? text.slice(0, 4000) + '\n… (truncated)' : text;
}
