import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CODEX_CLI_ORIGINATOR,
  detectCodexTerminal,
  formatCodexCliUserAgent,
  parseCodexVersion,
  resetCodexCliIdentityCache,
  resolveCodexCliUserAgent,
  resolveCodexVersion,
} from '../acp/codex-cli-identity.js';
import { withCodexCliUserAgent } from '../acp/codex-provider-config.js';

const temporaryDirectories: string[] = [];

/**
 * Create an executable `codex` shim that prints `codex-cli <version>` and
 * records every invocation, so both the parse result and the cache behaviour
 * are observable without mocking `node:child_process`.
 */
function createCodexShim(version: string): { executable: string; callLog: string } {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'codex-cli-identity-'));
  temporaryDirectories.push(directory);
  const callLog = path.join(directory, 'calls.log');
  const executable = path.join(directory, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  const script = process.platform === 'win32'
    ? `@echo off\r\necho called>>"${callLog}"\r\necho codex-cli ${version}\r\n`
    : `#!/bin/sh\necho called >> "${callLog}"\necho "codex-cli ${version}"\n`;
  writeFileSync(executable, script);
  if (process.platform !== 'win32') chmodSync(executable, 0o755);
  return { executable, callLog };
}

function readCallCount(callLog: string): number {
  try {
    return readFileSync(callLog, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

beforeEach(() => {
  resetCodexCliIdentityCache();
});

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe('formatCodexCliUserAgent', () => {
  it('matches the user-agent emitted by a native codex exec process', () => {
    expect(formatCodexCliUserAgent({
      clientName: CODEX_CLI_ORIGINATOR,
      codexVersion: '0.156.0',
      platform: 'Mac OS 15.6.1; arm64',
      terminal: 'Apple_Terminal/455.1',
      clientVersion: '0.156.0',
    })).toBe('codex_exec/0.156.0 (Mac OS 15.6.1; arm64) Apple_Terminal/455.1 (codex_exec; 0.156.0)');
  });
});

describe('detectCodexTerminal', () => {
  it('prefers TERM_PROGRAM with its version', () => {
    expect(detectCodexTerminal({ TERM_PROGRAM: 'Apple_Terminal', TERM_PROGRAM_VERSION: '455.1' }))
      .toBe('Apple_Terminal/455.1');
  });

  it('omits the version separator when TERM_PROGRAM_VERSION is absent', () => {
    expect(detectCodexTerminal({ TERM_PROGRAM: 'WezTerm' })).toBe('WezTerm');
  });

  it.each([
    [{ WT_SESSION: 'session-id' }, 'WindowsTerminal'],
    [{ TERM_SESSION_ID: 'session-id' }, 'Apple_Terminal'],
    [{}, 'unknown'],
  ])('falls back for %j', (environment, expected) => {
    expect(detectCodexTerminal(environment)).toBe(expected);
  });

  it('prefers TERM_PROGRAM over the session markers', () => {
    expect(detectCodexTerminal({
      TERM_PROGRAM: 'iTerm.app',
      TERM_PROGRAM_VERSION: '3.5.14',
      TERM_SESSION_ID: 'session-id',
      WT_SESSION: 'windows-session',
    })).toBe('iTerm.app/3.5.14');
  });
});

describe('parseCodexVersion', () => {
  it.each([
    ['codex-cli 0.156.0', '0.156.0'],
    ['codex-cli 0.157.0-alpha.9', '0.157.0-alpha.9'],
    ['', undefined],
    ['command not found', undefined],
  ])('parses %j', (output, expected) => {
    expect(parseCodexVersion(output)).toBe(expected);
  });
});

describe('resolveCodexVersion', () => {
  it('returns undefined without a resolved runtime', async () => {
    expect(await resolveCodexVersion(undefined, process.env)).toBeUndefined();
  });

  it('reads the version reported by the runtime and caches it per executable', async () => {
    const { executable, callLog } = createCodexShim('9.9.9');

    expect(await resolveCodexVersion(executable, process.env)).toBe('9.9.9');
    expect(await resolveCodexVersion(executable, process.env)).toBe('9.9.9');
    expect(readCallCount(callLog)).toBe(1);
  });

  it('returns undefined when the runtime cannot be probed', async () => {
    expect(await resolveCodexVersion(path.join(os.tmpdir(), 'missing-codex-binary'), process.env))
      .toBeUndefined();
  });
});

describe('resolveCodexCliUserAgent', () => {
  it('returns undefined without a resolved runtime', async () => {
    expect(await resolveCodexCliUserAgent({ codexPath: undefined, environment: process.env }))
      .toBeUndefined();
  });

  it('builds a native codex exec user-agent for the resolved runtime', async () => {
    const { executable } = createCodexShim('9.9.9');

    const userAgent = await resolveCodexCliUserAgent({
      codexPath: executable,
      environment: { ...process.env, TERM_PROGRAM: 'Apple_Terminal', TERM_PROGRAM_VERSION: '455.1' },
    });

    expect(userAgent).toMatch(/^codex_exec\/9\.9\.9 \(.+\) Apple_Terminal\/455\.1 \(codex_exec; 9\.9\.9\)$/);
    expect(userAgent).not.toContain('codex-acp');
  });
});

describe('withCodexCliUserAgent', () => {
  const userAgent = 'codex_exec/0.156.0 (Mac OS 15.6.1; arm64) Apple_Terminal/455.1 (codex_exec; 0.156.0)';
  const customConfig = JSON.stringify({
    model: 'gpt-6-sol',
    model_provider: 'agent-tower-openai-compatible',
    model_providers: {
      'agent-tower-openai-compatible': {
        base_url: 'https://gateway.example/v1',
        http_headers: { originator: 'codex_exec' },
      },
    },
  });

  it('adds the header next to the existing originator', () => {
    expect(JSON.parse(withCodexCliUserAgent(customConfig, userAgent)!)).toMatchObject({
      model_providers: {
        'agent-tower-openai-compatible': {
          http_headers: { originator: 'codex_exec', 'user-agent': userAgent },
        },
      },
    });
  });

  it('keeps headers configured by the Provider itself', () => {
    const configured = JSON.stringify({
      model_provider: 'proxy',
      model_providers: { proxy: { http_headers: { originator: 'stale', 'x-existing': 'keep' } } },
    });

    expect(JSON.parse(withCodexCliUserAgent(configured, userAgent)!)).toMatchObject({
      model_providers: { proxy: { http_headers: { originator: 'stale', 'x-existing': 'keep', 'user-agent': userAgent } } },
    });
  });

  it('never overrides a user-agent the Provider already set', () => {
    const configured = JSON.stringify({
      model_provider: 'proxy',
      model_providers: { proxy: { http_headers: { 'user-agent': 'custom/1.0' } } },
    });

    expect(withCodexCliUserAgent(configured, userAgent)).toBe(configured);
  });

  it.each([
    ['no config', undefined],
    ['no runtime version', customConfig],
    ['invalid JSON', '{not json'],
    ['no active provider', JSON.stringify({ model_providers: { proxy: { http_headers: {} } } })],
    ['built-in provider without an entry', JSON.stringify({ model_provider: 'openai', model_providers: {} })],
    ['non-object model_providers', JSON.stringify({ model_provider: 'proxy', model_providers: 'nope' })],
  ])('leaves the config untouched for %s', (_label, configJson) => {
    const result = withCodexCliUserAgent(configJson, _label === 'no runtime version' ? undefined : userAgent);
    expect(result).toBe(configJson);
  });
});
