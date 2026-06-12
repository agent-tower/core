import { describe, expect, it, afterAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildAgentTowerMcpEnvConfigOverrides,
  getCodexDeclaredMcpServerNames,
  queryCodexMcpServerNames,
  detectDeclaredMcpServers,
} from '../codex.executor.js';
import { ExecutionEnv } from '../execution-env.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-executor-test-'));
afterAll(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

const savedCodexHome = process.env.CODEX_HOME;
afterEach(() => {
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
});

/**
 * Create a fake `codex` executable that writes argv to a file and outputs the given stdout.
 * Returns the directory containing the fake binary (for prepending to PATH).
 */
function createFakeCodex(name: string, stdout: string, exitCode = 0): string {
  const binDir = path.join(tmpDir, `fake-codex-${name}`);
  fs.mkdirSync(binDir, { recursive: true });
  const argsFile = path.join(binDir, 'captured-args.json');
  const script = `#!/bin/sh
printf '%s\\n' "$@" > "${argsFile}"
cat <<'FAKE_EOF'
${stdout}
FAKE_EOF
exit ${exitCode}
`;
  fs.writeFileSync(path.join(binDir, 'codex'), script, { mode: 0o755 });
  return binDir;
}

function readCapturedArgs(binDir: string): string[] {
  const argsFile = path.join(binDir, 'captured-args.json');
  return fs.readFileSync(argsFile, 'utf-8').trim().split('\n');
}

// ─── getCodexDeclaredMcpServerNames (config.toml fallback) ───────

describe('getCodexDeclaredMcpServerNames', () => {
  it('returns mcp_servers keys from a valid config.toml', () => {
    const configPath = path.join(tmpDir, 'both.toml');
    fs.writeFileSync(configPath, `
[mcp_servers.agent-tower]
command = "agent-tower-mcp"

[mcp_servers.agent-tower.env]
AGENT_TOWER_URL = "http://127.0.0.1:12580"

[mcp_servers.agent-tower-dev]
command = "npx"
args = ["tsx", "index.ts"]
`);
    const result = getCodexDeclaredMcpServerNames(configPath);
    expect(result).toEqual(new Set(['agent-tower', 'agent-tower-dev']));
  });

  it('returns only declared servers when agent-tower-dev is absent', () => {
    const configPath = path.join(tmpDir, 'only-at.toml');
    fs.writeFileSync(configPath, `
[mcp_servers.agent-tower]
command = "agent-tower-mcp"
`);
    const result = getCodexDeclaredMcpServerNames(configPath);
    expect(result).toEqual(new Set(['agent-tower']));
  });

  it('returns empty set when config file does not exist', () => {
    const result = getCodexDeclaredMcpServerNames(path.join(tmpDir, 'nonexistent.toml'));
    expect(result).toEqual(new Set());
  });

  it('returns empty set when config has no mcp_servers section', () => {
    const configPath = path.join(tmpDir, 'no-mcp.toml');
    fs.writeFileSync(configPath, `model = "gpt-5.5"\n`);
    const result = getCodexDeclaredMcpServerNames(configPath);
    expect(result).toEqual(new Set());
  });

  it('uses CODEX_HOME env to resolve config path when no explicit path given', () => {
    const customDir = path.join(tmpDir, 'custom-codex-home');
    fs.mkdirSync(customDir, { recursive: true });
    fs.writeFileSync(path.join(customDir, 'config.toml'), `
[mcp_servers.agent-tower]
command = "agent-tower-mcp"
`);
    process.env.CODEX_HOME = customDir;
    const result = getCodexDeclaredMcpServerNames();
    expect(result).toEqual(new Set(['agent-tower']));
  });

  it('returns empty set for invalid TOML content', () => {
    const configPath = path.join(tmpDir, 'invalid.toml');
    fs.writeFileSync(configPath, `[mcp_servers.agent-tower\nbroken`);
    const result = getCodexDeclaredMcpServerNames(configPath);
    expect(result).toEqual(new Set());
  });

  it('returns empty set when mcp_servers is not an object', () => {
    const configPath = path.join(tmpDir, 'mcp-string.toml');
    fs.writeFileSync(configPath, `mcp_servers = "not-an-object"\n`);
    const result = getCodexDeclaredMcpServerNames(configPath);
    expect(result).toEqual(new Set());
  });
});

// ─── queryCodexMcpServerNames (CLI primary path, fake codex) ─────

describe('queryCodexMcpServerNames', () => {
  it('parses valid JSON array and returns server names', () => {
    const json = JSON.stringify([
      { name: 'agent-tower', transport: 'stdio', enabled: true },
      { name: 'agent-tower-dev', transport: 'stdio', enabled: true },
    ]);
    const binDir = createFakeCodex('valid', json);
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${origPath}`;
    try {
      const result = queryCodexMcpServerNames();
      expect(result).toEqual(new Set(['agent-tower', 'agent-tower-dev']));
    } finally {
      process.env.PATH = origPath;
    }
  });

  it('places configOverrideArgs before subcommand (codex ...args mcp list --json)', () => {
    const json = JSON.stringify([{ name: 'agent-tower', transport: 'stdio', enabled: true }]);
    const binDir = createFakeCodex('arg-order', json);
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${origPath}`;
    try {
      queryCodexMcpServerNames(['--profile', 'myprofile', '-c', 'mcp_servers.x.command="y"']);
      const args = readCapturedArgs(binDir);
      expect(args).toEqual([
        '--profile', 'myprofile',
        '-c', 'mcp_servers.x.command="y"',
        'mcp', 'list', '--json',
      ]);
    } finally {
      process.env.PATH = origPath;
    }
  });

  it('returns only agent-tower when CLI output has one server', () => {
    const json = JSON.stringify([{ name: 'agent-tower', transport: 'stdio', enabled: true }]);
    const binDir = createFakeCodex('one-server', json);
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${origPath}`;
    try {
      const result = queryCodexMcpServerNames();
      expect(result).toEqual(new Set(['agent-tower']));
    } finally {
      process.env.PATH = origPath;
    }
  });

  it('returns empty set when CLI outputs empty array', () => {
    const binDir = createFakeCodex('empty-array', '[]');
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${origPath}`;
    try {
      const result = queryCodexMcpServerNames();
      expect(result).toEqual(new Set());
    } finally {
      process.env.PATH = origPath;
    }
  });

  it('returns null when CLI outputs non-JSON', () => {
    const binDir = createFakeCodex('non-json', 'not json at all');
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${origPath}`;
    try {
      expect(queryCodexMcpServerNames()).toBeNull();
    } finally {
      process.env.PATH = origPath;
    }
  });

  it('returns null when CLI outputs non-array JSON (object)', () => {
    const binDir = createFakeCodex('non-array', '{"servers": []}');
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${origPath}`;
    try {
      expect(queryCodexMcpServerNames()).toBeNull();
    } finally {
      process.env.PATH = origPath;
    }
  });

  it('returns null when array contains element without name field', () => {
    const json = JSON.stringify([
      { name: 'agent-tower', transport: 'stdio' },
      { transport: 'stdio', enabled: true },
    ]);
    const binDir = createFakeCodex('missing-name', json);
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${origPath}`;
    try {
      expect(queryCodexMcpServerNames()).toBeNull();
    } finally {
      process.env.PATH = origPath;
    }
  });

  it('returns null when array contains element with non-string name', () => {
    const json = JSON.stringify([
      { name: 'agent-tower', transport: 'stdio' },
      { name: 123, transport: 'stdio' },
    ]);
    const binDir = createFakeCodex('bad-name-type', json);
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${origPath}`;
    try {
      expect(queryCodexMcpServerNames()).toBeNull();
    } finally {
      process.env.PATH = origPath;
    }
  });

  it('returns null when array contains non-object element', () => {
    const json = JSON.stringify([
      { name: 'agent-tower', transport: 'stdio' },
      'not-an-object',
    ]);
    const binDir = createFakeCodex('non-object-element', json);
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${origPath}`;
    try {
      expect(queryCodexMcpServerNames()).toBeNull();
    } finally {
      process.env.PATH = origPath;
    }
  });

  it('returns null when CLI exits with non-zero code', () => {
    const binDir = createFakeCodex('exit-error', '', 1);
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${origPath}`;
    try {
      expect(queryCodexMcpServerNames()).toBeNull();
    } finally {
      process.env.PATH = origPath;
    }
  });

  it('returns null when codex CLI is not in PATH', () => {
    const origPath = process.env.PATH;
    process.env.PATH = '/nonexistent-path-only';
    try {
      expect(queryCodexMcpServerNames()).toBeNull();
    } finally {
      process.env.PATH = origPath;
    }
  });
});

// ─── detectDeclaredMcpServers (CLI + fallback) ──────────────────

describe('detectDeclaredMcpServers', () => {
  it('uses CLI result when available', () => {
    const json = JSON.stringify([
      { name: 'agent-tower', transport: 'stdio', enabled: true },
      { name: 'injected-mcp', transport: 'stdio', enabled: true },
    ]);
    const binDir = createFakeCodex('detect-cli', json);
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${origPath}`;
    try {
      const result = detectDeclaredMcpServers(['-c', 'mcp_servers.injected-mcp.command="x"']);
      expect(result).toEqual(new Set(['agent-tower', 'injected-mcp']));
    } finally {
      process.env.PATH = origPath;
    }
  });

  it('falls back to config.toml when CLI is unavailable', () => {
    const configPath = path.join(tmpDir, 'fallback.toml');
    fs.writeFileSync(configPath, `
[mcp_servers.agent-tower]
command = "echo"
`);
    const origPath = process.env.PATH;
    process.env.PATH = '/nonexistent-path-only';
    try {
      const result = detectDeclaredMcpServers([], configPath);
      expect(result).toEqual(new Set(['agent-tower']));
    } finally {
      process.env.PATH = origPath;
    }
  });

  it('falls back to config.toml when CLI output has bad schema', () => {
    const binDir = createFakeCodex('detect-bad-schema', '{"not": "array"}');
    const configPath = path.join(tmpDir, 'fallback-schema.toml');
    fs.writeFileSync(configPath, `
[mcp_servers.agent-tower]
command = "echo"
[mcp_servers.agent-tower-dev]
command = "npx"
`);
    const origPath = process.env.PATH;
    process.env.PATH = `${binDir}:${origPath}`;
    try {
      const result = detectDeclaredMcpServers([], configPath);
      expect(result).toEqual(new Set(['agent-tower', 'agent-tower-dev']));
    } finally {
      process.env.PATH = origPath;
    }
  });

  it('returns empty set when both CLI and config.toml fail', () => {
    const origPath = process.env.PATH;
    process.env.PATH = '/nonexistent-path-only';
    try {
      const result = detectDeclaredMcpServers([], path.join(tmpDir, 'no-such-file.toml'));
      expect(result).toEqual(new Set());
    } finally {
      process.env.PATH = origPath;
    }
  });
});

// ─── buildAgentTowerMcpEnvConfigOverrides ────────────────────────

describe('buildAgentTowerMcpEnvConfigOverrides', () => {
  it('generates overrides only for declared MCP servers (both present)', () => {
    const env = ExecutionEnv.default('/tmp/worktree').merge({
      AGENT_TOWER_SESSION_ID: 'session-1',
      AGENT_TOWER_INVOCATION_ID: 'invocation-1',
      AGENT_TOWER_TEAM_RUN_ID: 'team-run-1',
      AGENT_TOWER_MEMBER_ID: 'member-1',
      AGENT_TOWER_URL: 'http://127.0.0.1:42232',
      AGENT_TOWER_PORT: '42232',
    });
    const declared = new Set(['agent-tower', 'agent-tower-dev']);

    expect(buildAgentTowerMcpEnvConfigOverrides(env, declared)).toEqual([
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_SESSION_ID="session-1"',
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_INVOCATION_ID="invocation-1"',
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_TEAM_RUN_ID="team-run-1"',
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_MEMBER_ID="member-1"',
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_URL="http://127.0.0.1:42232"',
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_PORT="42232"',
      '-c',
      'mcp_servers.agent-tower-dev.env.AGENT_TOWER_SESSION_ID="session-1"',
      '-c',
      'mcp_servers.agent-tower-dev.env.AGENT_TOWER_INVOCATION_ID="invocation-1"',
      '-c',
      'mcp_servers.agent-tower-dev.env.AGENT_TOWER_TEAM_RUN_ID="team-run-1"',
      '-c',
      'mcp_servers.agent-tower-dev.env.AGENT_TOWER_MEMBER_ID="member-1"',
      '-c',
      'mcp_servers.agent-tower-dev.env.AGENT_TOWER_URL="http://127.0.0.1:42232"',
      '-c',
      'mcp_servers.agent-tower-dev.env.AGENT_TOWER_PORT="42232"',
    ]);
  });

  it('generates overrides only for agent-tower when agent-tower-dev is not declared', () => {
    const env = ExecutionEnv.default('/tmp/worktree').merge({
      AGENT_TOWER_SESSION_ID: 'session-1',
      AGENT_TOWER_INVOCATION_ID: 'invocation-1',
      AGENT_TOWER_TEAM_RUN_ID: 'team-run-1',
      AGENT_TOWER_MEMBER_ID: 'member-1',
      AGENT_TOWER_URL: 'http://127.0.0.1:42232',
    });
    const declared = new Set(['agent-tower']);

    expect(buildAgentTowerMcpEnvConfigOverrides(env, declared)).toEqual([
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_SESSION_ID="session-1"',
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_INVOCATION_ID="invocation-1"',
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_TEAM_RUN_ID="team-run-1"',
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_MEMBER_ID="member-1"',
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_URL="http://127.0.0.1:42232"',
    ]);
  });

  it('returns empty array when no MCP servers are declared', () => {
    const env = ExecutionEnv.default('/tmp/worktree').merge({
      AGENT_TOWER_SESSION_ID: 'session-1',
      AGENT_TOWER_TEAM_RUN_ID: 'team-run-1',
    });
    const declared = new Set<string>();

    expect(buildAgentTowerMcpEnvConfigOverrides(env, declared)).toEqual([]);
  });

  it('omits MCP identity overrides for non-TeamRun sessions', () => {
    const env = ExecutionEnv.default('/tmp/worktree');
    const declared = new Set(['agent-tower', 'agent-tower-dev']);

    expect(buildAgentTowerMcpEnvConfigOverrides(env, declared)).toEqual([]);
  });

  it('only projects Agent Tower MCP env keys', () => {
    const env = ExecutionEnv.default('/tmp/worktree').merge({
      AGENT_TOWER_TEAM_RUN_ID: 'team-run-1',
      AGENT_TOWER_URL: 'http://127.0.0.1:42232',
      OPENAI_API_KEY: 'provider-secret',
    });
    const declared = new Set(['agent-tower', 'agent-tower-dev']);

    expect(buildAgentTowerMcpEnvConfigOverrides(env, declared)).toEqual([
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_TEAM_RUN_ID="team-run-1"',
      '-c',
      'mcp_servers.agent-tower.env.AGENT_TOWER_URL="http://127.0.0.1:42232"',
      '-c',
      'mcp_servers.agent-tower-dev.env.AGENT_TOWER_TEAM_RUN_ID="team-run-1"',
      '-c',
      'mcp_servers.agent-tower-dev.env.AGENT_TOWER_URL="http://127.0.0.1:42232"',
    ]);
  });
});
