import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeCodeExecutor } from '../claude-code.executor.js';
import type { ExecutorSpawnConfig, SpawnedChild } from '../base.executor.js';
import type { CommandParts } from '../command-builder.js';
import { AGENT_TOWER_MCP_IDENTITY_ENV_KEYS, AGENT_TOWER_MCP_SERVICE_ENV_KEYS, ExecutionEnv } from '../execution-env.js';
import { isPreChildProcessFailure } from '../start-error.js';
import * as mcpConfigService from '../../services/mcp-config.service.js';

vi.mock('../../services/claude-cli-capabilities.service.js', () => ({
  refreshClaudeCliAskSupport: vi.fn(async () => ({ supported: true })),
  cachedClaudeCliAskSupport: vi.fn(() => ({ supported: true, executable: '/verified/claude' })),
}));

class CaptureExecutor extends ClaudeCodeExecutor {
  readonly launches: Array<{ parts: CommandParts; transport: 'stdin' | 'duplex'; input?: string }> = [];

  protected override async spawnWithStdin(_config: ExecutorSpawnConfig, parts: CommandParts, input: string): Promise<SpawnedChild> {
    this.launches.push({ parts, transport: 'stdin', input });
    return {} as SpawnedChild;
  }

  protected override async spawnWithDuplex(_config: ExecutorSpawnConfig, parts: CommandParts): Promise<SpawnedChild> {
    this.launches.push({ parts, transport: 'duplex' });
    return {} as SpawnedChild;
  }
}

type McpServer = { type: string; command: string; args: string[]; env: Record<string, string> };
function managedServer(parts: CommandParts): [string, McpServer] {
  const index = parts.args.lastIndexOf('--mcp-config');
  expect(index).toBeGreaterThanOrEqual(0);
  const config = JSON.parse(parts.args[index + 1]) as { mcpServers: Record<string, McpServer> };
  expect(Object.keys(config.mcpServers)).toHaveLength(1);
  const entry = Object.entries(config.mcpServers)[0];
  expect(entry[0]).toMatch(/^agent-tower-[a-f0-9]{8}$/);
  return entry;
}

describe('Claude Code managed MCP', () => {
  let directory: string;
  const managedEnv = () => ExecutionEnv.default(directory).merge({
    AGENT_TOWER_SESSION_ID: 'tower-session',
    AGENT_TOWER_AGENT_CREDENTIAL: 'session-credential',
    AGENT_TOWER_URL: 'http://127.0.0.1:42001',
  });
  const spawnConfig = (env = managedEnv()): ExecutorSpawnConfig => ({ workingDir: directory, prompt: 'hello', env });

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'tower-claude-mcp-'));
    for (const key of [
      ...AGENT_TOWER_MCP_SERVICE_ENV_KEYS, ...AGENT_TOWER_MCP_IDENTITY_ENV_KEYS,
      'AGENT_TOWER_MCP_ENTRY', 'AGENT_TOWER_NODE_RUNTIME', 'AGENT_TOWER_DESKTOP_NODE',
      'AGENT_TOWER_DESKTOP_RUNTIME_MODE', 'ELECTRON_RUN_AS_NODE',
    ]) vi.stubEnv(key, undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it.each(['FULL_ACCESS', 'ASK'] as const)('registers MCP on new and resumed %s launches with the current identity', async executionPermission => {
    const executor = new CaptureExecutor({ executionPermission });
    const env = managedEnv().merge({
      AGENT_TOWER_INVOCATION_ID: 'invocation', AGENT_TOWER_TEAM_RUN_ID: 'team', AGENT_TOWER_MEMBER_ID: 'member',
      AGENT_TOWER_INTERNAL_TOKEN: 'must-not-forward',
    });
    const first = await executor.spawn(spawnConfig(env));
    env.set('AGENT_TOWER_AGENT_CREDENTIAL', 'renewed-credential');
    const resumed = await executor.spawnFollowUp(spawnConfig(env), 'native-session', 'message-id');

    expect(executor.launches).toHaveLength(2);
    const names = executor.launches.map((launch, index) => {
      const [name, server] = managedServer(launch.parts);
      expect(launch.transport).toBe(executionPermission === 'ASK' ? 'duplex' : 'stdin');
      expect(server.type).toBe('stdio');
      expect(server.command).toBe(process.execPath);
      expect(server.args[0]).toBe('--import');
      expect(server.args.at(-1)).toMatch(/[\\/]src[\\/]mcp[\\/]index\.ts$/);
      expect(server.env).toEqual({
        AGENT_TOWER_URL: 'http://127.0.0.1:42001',
        AGENT_TOWER_AGENT_CREDENTIAL: index ? 'renewed-credential' : 'session-credential',
        AGENT_TOWER_SESSION_ID: 'tower-session',
        AGENT_TOWER_INVOCATION_ID: 'invocation', AGENT_TOWER_TEAM_RUN_ID: 'team', AGENT_TOWER_MEMBER_ID: 'member',
      });
      expect(launch.parts.args).not.toContain('--strict-mcp-config');
      expect(launch.parts.args).toContain('--disallowedTools=AskUserQuestion');
      expect(launch.parts.args).toEqual(expect.arrayContaining(['--disallowedTools', 'mcp__agent-tower__*', 'mcp__agent-tower-dev__*']));
      expect(launch.parts.args.join(' ')).not.toContain('must-not-forward');
      return name;
    });
    expect(names[0]).toBe(names[1]);
    expect(executor.launches[1].parts.args.slice(-4)).toEqual(['--resume', 'native-session', '--resume-session-at', 'message-id']);
    if (executionPermission === 'ASK') {
      expect(first.initialInput).toContain('hello');
      expect(resumed.initialInput).toContain('hello');
    }
  });

  it('keeps Provider MCP arguments and appends the managed config last', async () => {
    const executor = new CaptureExecutor({ executionPermission: 'FULL_ACCESS' });
    await executor.spawn(spawnConfig());
    const [name] = managedServer(executor.launches[0].parts);
    const userConfig = JSON.stringify({ mcpServers: {
      [name]: { type: 'http', url: 'http://old.example/mcp' },
      custom: { command: 'custom-mcp' },
    } });
    const custom = new CaptureExecutor({ executionPermission: 'FULL_ACCESS', cmd: {
      additionalParams: ['--mcp-config', 'user-mcp.json', userConfig, '--disallowedTools', 'Bash'],
    } });
    await custom.spawn(spawnConfig());
    const { parts } = custom.launches[0];

    expect(parts.args.slice(parts.args.indexOf('--mcp-config'), parts.args.lastIndexOf('--mcp-config')))
      .toEqual(['--mcp-config', 'user-mcp.json', userConfig, '--disallowedTools', 'Bash']);
    expect(managedServer(parts)[1]).not.toHaveProperty('url');
    expect(parts.args).not.toContain('--strict-mcp-config');
  });

  it('isolates concurrent sessions and excludes inherited team identity', async () => {
    vi.stubEnv('AGENT_TOWER_TEAM_RUN_ID', 'stale-parent-team');
    const first = new CaptureExecutor();
    const second = new CaptureExecutor();
    await first.spawn(spawnConfig(managedEnv().set('AGENT_TOWER_TEAM_RUN_ID', 'first-team')));
    await second.spawn(spawnConfig(managedEnv().merge({
      AGENT_TOWER_SESSION_ID: 'second-session', AGENT_TOWER_AGENT_CREDENTIAL: 'second-credential',
      AGENT_TOWER_URL: 'http://127.0.0.1:42002',
    })));
    const [firstName] = managedServer(first.launches[0].parts);
    const [secondName, server] = managedServer(second.launches[0].parts);
    expect(firstName).not.toBe(secondName);
    expect(server.env).toEqual({
      AGENT_TOWER_SESSION_ID: 'second-session', AGENT_TOWER_AGENT_CREDENTIAL: 'second-credential',
      AGENT_TOWER_URL: 'http://127.0.0.1:42002',
    });
  });

  it.each(['workspace', 'packaged'])('uses trusted %s runtime paths despite Provider overrides', async mode => {
    const entry = path.join(directory, 'Tower install', 'mcp', 'index.js');
    mkdirSync(path.dirname(entry), { recursive: true });
    writeFileSync(entry, '');
    vi.stubEnv('AGENT_TOWER_MCP_ENTRY', entry);
    vi.stubEnv('AGENT_TOWER_DESKTOP_RUNTIME_MODE', mode);
    vi.stubEnv('AGENT_TOWER_NODE_RUNTIME', 'C:\\Program Files\\Agent Tower\\node.exe');
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1');
    const executor = new CaptureExecutor({ cmd: { env: {
      AGENT_TOWER_MCP_ENTRY: '/incorrect/entry', AGENT_TOWER_NODE_RUNTIME: '/incorrect/node',
      AGENT_TOWER_URL: 'http://incorrect.example', AGENT_TOWER_AGENT_CREDENTIAL: 'incorrect-secret',
      AGENT_TOWER_SESSION_ID: 'incorrect-session', ANTHROPIC_API_KEY: 'provider-secret',
    } } });
    await executor.spawn(spawnConfig());
    const [, server] = managedServer(executor.launches[0].parts);
    expect(server.command).toBe(mode === 'packaged' ? 'C:\\Program Files\\Agent Tower\\node.exe' : process.execPath);
    expect(server.args).toEqual([entry]);
    expect(server.env).toEqual({
      AGENT_TOWER_URL: 'http://127.0.0.1:42001', AGENT_TOWER_AGENT_CREDENTIAL: 'session-credential',
      AGENT_TOWER_SESSION_ID: 'tower-session', ...(mode === 'packaged' ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    });
  });

  it('does not auto-register using parent or Provider credentials', async () => {
    vi.stubEnv('AGENT_TOWER_AGENT_CREDENTIAL', 'parent-secret');
    vi.stubEnv('AGENT_TOWER_INTERNAL_TOKEN', 'parent-internal');
    const executor = new CaptureExecutor({ cmd: { env: { AGENT_TOWER_AGENT_CREDENTIAL: 'provider-secret' } } });
    await executor.spawn(spawnConfig(ExecutionEnv.default(directory)));
    expect(executor.launches[0].parts.args).not.toContain('--mcp-config');
    expect(executor.launches[0].parts.args).not.toContain('mcp__agent-tower__*');
  });

  it('supports an explicitly supplied internal credential and port for trusted callers', async () => {
    const executor = new CaptureExecutor();
    await executor.spawn(spawnConfig(ExecutionEnv.default(directory).merge({
      AGENT_TOWER_INTERNAL_TOKEN: 'explicit-internal', AGENT_TOWER_PORT: '42003',
    })));
    expect(managedServer(executor.launches[0].parts)[1].env).toEqual({
      AGENT_TOWER_INTERNAL_TOKEN: 'explicit-internal', AGENT_TOWER_URL: 'http://127.0.0.1:42003', AGENT_TOWER_PORT: '42003',
    });
  });

  describe.each(['FULL_ACCESS', 'ASK'] as const)('%s startup failures', executionPermission => {
    it.each([
      ['new', 'entry'], ['resume', 'entry'],
      ['new', 'backend'], ['resume', 'backend'],
      ['new', 'loader'], ['resume', 'loader'],
    ] as const)('marks a %s launch with a missing %s as a pre-child failure', async (mode, missing) => {
      const config = spawnConfig();
      let message: string;
      if (missing === 'entry') {
        vi.stubEnv('AGENT_TOWER_MCP_ENTRY', path.join(directory, 'missing.js'));
        message = 'Agent Tower MCP entry not found';
      } else if (missing === 'backend') {
        config.env.unset('AGENT_TOWER_URL');
        message = 'AGENT_TOWER_URL or AGENT_TOWER_PORT is required';
      } else {
        message = 'Agent Tower MCP tsx loader not found for development-source runtime';
        vi.spyOn(mcpConfigService, 'buildMcpConfigResponse').mockImplementationOnce(() => {
          throw new Error(message, { cause: new Error('Cannot find module tsx') });
        });
      }
      const executor = new CaptureExecutor({ executionPermission });
      const failure = await (mode === 'new' ? executor.spawn(config) : executor.spawnFollowUp(config, 'native-session'))
        .then(() => undefined, error => error);

      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toContain(message);
      expect(isPreChildProcessFailure(failure)).toBe(true);
      if (missing === 'loader') expect(failure.cause?.message).toBe('Cannot find module tsx');
      expect(executor.launches).toEqual([]);
    });

    it.each(['new', 'resume'] as const)('does not mark an error from the %s spawn transport as pre-child', async mode => {
      const failure = new Error('Process identity could not be captured after spawning');
      class FailingTransportExecutor extends CaptureExecutor {
        protected override async spawnWithStdin(): Promise<SpawnedChild> { throw failure; }
        protected override async spawnWithDuplex(): Promise<SpawnedChild> { throw failure; }
      }
      const executor = new FailingTransportExecutor({ executionPermission });
      await expect(mode === 'new' ? executor.spawn(spawnConfig()) : executor.spawnFollowUp(spawnConfig(), 'native-session'))
        .rejects.toBe(failure);
      expect(isPreChildProcessFailure(failure)).toBe(false);
    });
  });
});
