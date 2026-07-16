import type { AgentCliInstallLogEntry } from '@agent-tower/shared';
import {
  buildUnixPathWithUserBinFallbacks,
  buildWindowsPathWithUserBinFallbacks,
} from '../../utils/process-launch.js';

export const SENSITIVE_ENV_KEY_PATTERN = /(?:^|_)(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)(?:_|$)/i;

const REDACTION_PATTERNS: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:sk|sk-proj|sk-ant|xoxb|ghp|github_pat)_[A-Za-z0-9._-]{8,}\b/gi,
  /\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|CURSOR_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|CODEX_HOME|ANTHROPIC_AUTH_TOKEN)\s*=\s*["']?[^"'\s]+/gi,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|secret)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/gi,
];

const STREAM_REDACTOR_CARRY_LIMIT = 512;

export function redactAgentCliLog(data: string): string {
  let redacted = data;
  for (const pattern of REDACTION_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => {
      const separatorIndex = Math.max(match.lastIndexOf('='), match.lastIndexOf(':'));
      if (separatorIndex > 0) {
        return `${match.slice(0, separatorIndex + 1)}[REDACTED]`;
      }
      if (/^Bearer\s+/i.test(match)) {
        return 'Bearer [REDACTED]';
      }
      return '[REDACTED]';
    });
  }
  return redacted;
}

export function buildCleanAgentCliEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform | 'darwin' | 'linux' | 'win32' | null = process.platform
): NodeJS.ProcessEnv {
  const allowedKeys = new Set([
    'PATH',
    'Path',
    'path',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LC_ALL',
    'TERM',
    'SystemRoot',
    'COMSPEC',
    'ComSpec',
    'PATHEXT',
    'LOCALAPPDATA',
    'APPDATA',
    'USERPROFILE',
  ]);
  const cleaned: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!allowedKeys.has(key)) continue;
    if (key.startsWith('AGENT_TOWER_')) continue;
    if (SENSITIVE_ENV_KEY_PATTERN.test(key)) continue;
    cleaned[key] = value;
  }

  if (platform === 'win32') {
    const nextPath = buildWindowsPathWithUserBinFallbacks(env);
    if (nextPath) {
      cleaned.PATH = nextPath;
      cleaned.Path = nextPath;
    }
  } else if (platform === 'darwin' || platform === 'linux') {
    const nextPath = buildUnixPathWithUserBinFallbacks(env, platform);
    if (nextPath) {
      cleaned.PATH = nextPath;
    }
  }

  return cleaned;
}

export function parseWhitelistedVersion(output: string, versionPattern?: string): string | null {
  const pattern = versionPattern
    ? new RegExp(versionPattern)
    : /\d+(?:\.\d+){1,3}/;
  const match = output.match(pattern);
  if (!match) return null;
  const value = match[0];
  return /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(value) ? value : null;
}

export class AgentCliLogRingBuffer {
  private entries: AgentCliInstallLogEntry[] = [];
  private next = 1;
  private totalBytes = 0;

  constructor(
    private readonly maxEntries = 2000,
    private readonly maxBytes = 256 * 1024
  ) {}

  push(source: AgentCliInstallLogEntry['source'], data: string): AgentCliInstallLogEntry {
    return this.pushRedacted(source, redactAgentCliLog(data));
  }

  pushRedacted(source: AgentCliInstallLogEntry['source'], data: string): AgentCliInstallLogEntry {
    const entry: AgentCliInstallLogEntry = {
      seq: this.next++,
      timestamp: new Date().toISOString(),
      source,
      data,
    };

    this.entries.push(entry);
    this.totalBytes += Buffer.byteLength(entry.data, 'utf8');
    this.trim();
    return entry;
  }

  list(afterSeq = 0): { entries: AgentCliInstallLogEntry[]; nextSeq: number; truncated: boolean } {
    const entries = this.entries.filter((entry) => entry.seq > afterSeq);
    const firstSeq = this.entries[0]?.seq ?? this.next;
    return {
      entries,
      nextSeq: this.next,
      truncated: afterSeq > 0 && afterSeq < firstSeq - 1,
    };
  }

  private trim(): void {
    while (this.entries.length > this.maxEntries || this.totalBytes > this.maxBytes) {
      const removed = this.entries.shift();
      if (!removed) return;
      this.totalBytes -= Buffer.byteLength(removed.data, 'utf8');
    }
  }
}

export class AgentCliStreamingLogRedactor {
  private carry = '';
  private overflowed = false;

  push(data: string): string[] {
    if (this.overflowed) {
      const lineBreak = data.search(/\r?\n/);
      if (lineBreak < 0) return [];

      this.overflowed = false;
      this.carry = '';
      const newlineLength = data[lineBreak] === '\r' && data[lineBreak + 1] === '\n' ? 2 : 1;
      return this.push(data.slice(lineBreak + newlineLength));
    }

    const combined = this.carry + data;
    const lines = combined.split(/\r?\n/);
    const completeLines = lines.slice(0, -1);
    this.carry = lines[lines.length - 1] ?? '';

    const output = completeLines.map((line) => `${redactAgentCliLog(line)}\n`);

    if (this.carry.length > STREAM_REDACTOR_CARRY_LIMIT) {
      this.carry = '';
      this.overflowed = true;
      output.push('[log line exceeded redaction window; partial content withheld]\n');
    }

    return output;
  }

  flush(): string[] {
    if (this.overflowed) {
      this.overflowed = false;
      this.carry = '';
      return [];
    }
    if (!this.carry) return [];
    const data = redactAgentCliLog(this.carry);
    this.carry = '';
    return [data];
  }
}
