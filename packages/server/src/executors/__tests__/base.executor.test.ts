import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentType } from '../../types/index.js';
import { BaseExecutor, type AvailabilityInfo } from '../base.executor.js';
import { CommandBuilder, type CommandParts } from '../command-builder.js';
import {
  AGENT_SUBPROCESS_BLOCKED_ENV_KEYS,
  AGENT_TOWER_MCP_IDENTITY_ENV_KEYS,
  AGENT_TOWER_MCP_SERVICE_ENV_KEYS,
  ExecutionEnv,
} from '../execution-env.js';
import { PTY_WRAPPER_ENV_KEYS } from '../../utils/process-launch.js';

const spawnMock = vi.hoisted(() => vi.fn());
const whichMock = vi.hoisted(() => vi.fn(async (command: string) => `/bin/${command}`));

vi.mock('@shitiandmw/node-pty', () => ({
  spawn: spawnMock,
}));

vi.mock('../../utils/index.js', () => ({
  which: whichMock,
}));

class TestExecutor extends BaseExecutor {
  readonly agentType = AgentType.CLAUDE_CODE;
  readonly displayName = 'Test Executor';

  protected buildCommandBuilder(): CommandBuilder {
    return CommandBuilder.new('mock-agent');
  }

  async getAvailabilityInfo(): Promise<AvailabilityInfo> {
    return { type: 'INSTALLATION_FOUND' };
  }

  spawnForTest(commandParts: CommandParts, stdinData: string, env = ExecutionEnv.default(os.tmpdir())) {
    return this.spawnWithStdin({
      workingDir: os.tmpdir(),
      prompt: '',
      env,
    }, commandParts, stdinData);
  }

  spawnInternalForTest(commandParts: CommandParts, env: ExecutionEnv) {
    return this.spawnInternal({
      workingDir: os.tmpdir(),
      prompt: 'prompt',
      env,
    }, commandParts);
  }
}

const tmpFilePrefixForNow = (now: number) => `agent-tower-stdin-${now}-`;
const tmpFilesForNow = (now: number) => readdirSync(os.tmpdir())
  .filter((name) => name.startsWith(tmpFilePrefixForNow(now)))
  .map((name) => path.join(os.tmpdir(), name));
const removeTmpFilesForNow = (now: number) => {
  for (const file of tmpFilesForNow(now)) {
    rmSync(file, { force: true });
  }
};
const envKeysToRestore = [
  ...AGENT_SUBPROCESS_BLOCKED_ENV_KEYS,
  ...AGENT_TOWER_MCP_IDENTITY_ENV_KEYS,
  ...AGENT_TOWER_MCP_SERVICE_ENV_KEYS,
  'AGENT_TOWER_TEST_NORMAL_ENV',
] as const;

function snapshotEnv(keys: readonly string[]): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of keys) {
    snapshot[key] = process.env[key];
  }
  return snapshot;
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe('ExecutionEnv.getFullEnv', () => {
  const originalEnv = snapshotEnv(envKeysToRestore);

  afterEach(() => {
    restoreEnv(originalEnv);
  });

  it('filters Agent Tower service env while preserving normal and TeamRun/MCP env', () => {
    process.env.DATABASE_URL = 'file:/prod/database-url.db';
    process.env.AGENT_TOWER_DATABASE_URL = 'file:/prod/agent-tower.db';
    process.env.AGENT_TOWER_DATA_DIR = '/prod/agent-tower-data';
    process.env.AGENT_TOWER_WEB_DIR = '/prod/agent-tower-web';
    process.env.AGENT_TOWER_NODE_RUNTIME = '/prod/Agent Tower.exe';
    process.env.AGENT_TOWER_DESKTOP_RUNTIME_MODE = 'packaged';
    process.env.AGENT_TOWER_MCP_ENTRY = '/prod/runtime/server/dist/mcp/index.js';
    process.env.ELECTRON_RUN_AS_NODE = '1';
    process.env.DATA_DIR = '/prod/data-dir';
    process.env.AGENT_TOWER_SESSION_ID = 'inherited-session';
    process.env.AGENT_TOWER_INVOCATION_ID = 'inherited-invocation';
    process.env.AGENT_TOWER_TEAM_RUN_ID = 'inherited-team-run';
    process.env.AGENT_TOWER_MEMBER_ID = 'inherited-member';
    process.env.AGENT_TOWER_URL = 'http://127.0.0.1:12580';
    process.env.AGENT_TOWER_PORT = '12580';
    process.env.AGENT_TOWER_INTERNAL_TOKEN = 'inherited-internal-token';
    process.env.AGENT_TOWER_TEST_NORMAL_ENV = 'keep-me';

    const env = ExecutionEnv.default(os.tmpdir()).merge({
      DATABASE_URL: 'file:/provider/database-url.db',
      AGENT_TOWER_DATABASE_URL: 'file:/provider/agent-tower.db',
      AGENT_TOWER_DATA_DIR: '/provider/agent-tower-data',
      AGENT_TOWER_WEB_DIR: '/provider/agent-tower-web',
      AGENT_TOWER_NODE_RUNTIME: '/provider/Agent Tower.exe',
      AGENT_TOWER_DESKTOP_RUNTIME_MODE: 'packaged',
      AGENT_TOWER_MCP_ENTRY: '/provider/runtime/server/dist/mcp/index.js',
      ELECTRON_RUN_AS_NODE: '1',
      DATA_DIR: '/provider/data-dir',
      AGENT_TOWER_SESSION_ID: 'session-1',
      AGENT_TOWER_INVOCATION_ID: 'invocation-1',
      AGENT_TOWER_TEAM_RUN_ID: 'team-run-1',
      AGENT_TOWER_MEMBER_ID: 'member-1',
      AGENT_TOWER_URL: 'http://127.0.0.1:42232',
      AGENT_TOWER_PORT: '42232',
      AGENT_TOWER_INTERNAL_TOKEN: 'explicit-internal-token',
      PROVIDER_SAFE_ENV: 'provider-value',
    });

    const fullEnv = env.getFullEnv();

    for (const key of AGENT_SUBPROCESS_BLOCKED_ENV_KEYS) {
      expect(fullEnv).not.toHaveProperty(key);
    }
    expect(fullEnv).toMatchObject({
      AGENT_TOWER_SESSION_ID: 'session-1',
      AGENT_TOWER_INVOCATION_ID: 'invocation-1',
      AGENT_TOWER_TEAM_RUN_ID: 'team-run-1',
      AGENT_TOWER_MEMBER_ID: 'member-1',
      AGENT_TOWER_URL: 'http://127.0.0.1:42232',
      AGENT_TOWER_PORT: '42232',
      AGENT_TOWER_INTERNAL_TOKEN: 'explicit-internal-token',
      AGENT_TOWER_TEST_NORMAL_ENV: 'keep-me',
      PROVIDER_SAFE_ENV: 'provider-value',
    });
  });

  it('filters internal env from cmd override profiles without replacing explicit MCP env', () => {
    const env = ExecutionEnv.default(os.tmpdir()).merge({
      AGENT_TOWER_SESSION_ID: 'session-1',
      AGENT_TOWER_INVOCATION_ID: 'invocation-1',
      AGENT_TOWER_TEAM_RUN_ID: 'team-run-1',
      AGENT_TOWER_MEMBER_ID: 'member-1',
      AGENT_TOWER_URL: 'http://127.0.0.1:42232',
      AGENT_TOWER_PORT: '42232',
      AGENT_TOWER_INTERNAL_TOKEN: 'explicit-internal-token',
    });

    const profiledEnv = env.withProfile({
      env: {
        DATABASE_URL: 'file:/provider/database-url.db',
        AGENT_TOWER_SESSION_ID: 'provider-session',
        AGENT_TOWER_URL: 'http://127.0.0.1:9999',
        AGENT_TOWER_INTERNAL_TOKEN: 'provider-token',
        PROVIDER_SAFE_ENV: 'provider-value',
      },
    });

    expect(profiledEnv.getFullEnv()).toMatchObject({
      AGENT_TOWER_SESSION_ID: 'session-1',
      AGENT_TOWER_INVOCATION_ID: 'invocation-1',
      AGENT_TOWER_TEAM_RUN_ID: 'team-run-1',
      AGENT_TOWER_MEMBER_ID: 'member-1',
      AGENT_TOWER_URL: 'http://127.0.0.1:42232',
      AGENT_TOWER_PORT: '42232',
      AGENT_TOWER_INTERNAL_TOKEN: 'explicit-internal-token',
      PROVIDER_SAFE_ENV: 'provider-value',
    });
    expect(profiledEnv.getFullEnv()).not.toHaveProperty('DATABASE_URL');
  });

  it('does not inherit parent TeamRun identity or internal token env without explicit injection', () => {
    process.env.AGENT_TOWER_SESSION_ID = 'inherited-session';
    process.env.AGENT_TOWER_INVOCATION_ID = 'inherited-invocation';
    process.env.AGENT_TOWER_TEAM_RUN_ID = 'inherited-team-run';
    process.env.AGENT_TOWER_MEMBER_ID = 'inherited-member';
    process.env.AGENT_TOWER_INTERNAL_TOKEN = 'inherited-internal-token';

    const fullEnv = ExecutionEnv.default(os.tmpdir()).getFullEnv();

    for (const key of AGENT_TOWER_MCP_IDENTITY_ENV_KEYS) {
      expect(fullEnv).not.toHaveProperty(key);
    }
    expect(fullEnv).not.toHaveProperty('AGENT_TOWER_INTERNAL_TOKEN');
  });
});

describe('BaseExecutor.spawnWithStdin', () => {
  let now = 0;

  beforeEach(() => {
    now += 1;
    spawnMock.mockReset();
    whichMock.mockClear();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    removeTmpFilesForNow(now);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    removeTmpFilesForNow(now);
  });

  it('removes the stdin temp file when pty.spawn throws after writing it', async () => {
    const error = new Error('spawn failed');
    spawnMock.mockImplementationOnce(() => {
      throw error;
    });

    const executor = new TestExecutor();

    await expect(executor.spawnForTest({ program: 'mock-agent', args: [] }, '{"message":"hello"}'))
      .rejects.toThrow(error);

    expect(tmpFilesForNow(now)).toEqual([]);
  });

  it('disposes data and exit listeners when the pty exits', async () => {
    const dataDispose = vi.fn();
    const exitDispose = vi.fn();
    let onDataCallback: ((data: string) => void) | undefined;
    let onExitCallback: ((event: { exitCode: number; signal?: number }) => void) | undefined;

    spawnMock.mockReturnValueOnce({
      pid: 12345,
      onData: vi.fn((callback: (data: string) => void) => {
        onDataCallback = callback;
        return { dispose: dataDispose };
      }),
      onExit: vi.fn((callback: (event: { exitCode: number; signal?: number }) => void) => {
        onExitCallback = callback;
        return { dispose: exitDispose };
      }),
      kill: vi.fn(),
    });

    const executor = new TestExecutor();
    const result = await executor.spawnForTest({ program: 'mock-agent', args: ['--json'] }, '{"message":"hello"}');

    expect(result.pid).toBe(12345);
    expect(onDataCallback).toBeDefined();
    expect(onExitCallback).toBeDefined();

    onDataCallback?.('x'.repeat(9000));
    onExitCallback?.({ exitCode: 0 });

    expect(dataDispose).toHaveBeenCalledTimes(1);
    expect(exitDispose).toHaveBeenCalledTimes(1);
  });

  it('buffers PTY events fired before pipeline attach and hands them over exactly once', async () => {
    // 模拟支持多 listener 的 PTY（真实 node-pty 语义），
    // 以便 early-event collector 和日志 listener 同时收到事件
    const dataListeners: Array<(data: string) => void> = [];
    const exitListeners: Array<(e: { exitCode: number; signal?: number }) => void> = [];
    spawnMock.mockReturnValueOnce({
      pid: 12345,
      onData: vi.fn((cb: (data: string) => void) => {
        dataListeners.push(cb);
        return { dispose: () => dataListeners.splice(dataListeners.indexOf(cb), 1) };
      }),
      onExit: vi.fn((cb: (e: { exitCode: number; signal?: number }) => void) => {
        exitListeners.push(cb);
        return { dispose: () => exitListeners.splice(exitListeners.indexOf(cb), 1) };
      }),
      kill: vi.fn(),
    });

    const executor = new TestExecutor();
    const result = await executor.spawnForTest({ program: 'mock-agent', args: [] }, '{"message":"hello"}');

    // spawn 返回后、pipeline attach 前，进程输出并退出（快速失败场景）
    for (const l of [...dataListeners]) l('{"type":"thread.started","thread_id":"t1"}\n');
    for (const l of [...exitListeners]) l({ exitCode: 2 });

    const early = result.takeEarlyEvents?.() ?? [];
    expect(early).toEqual([
      { type: 'data', data: '{"type":"thread.started","thread_id":"t1"}\n' },
      { type: 'exit', exitCode: 2 },
    ]);

    // 二次取走返回空；取走后事件不再缓存（实时 listener 已接管）
    expect(result.takeEarlyEvents?.()).toEqual([])
    for (const l of [...dataListeners]) l('late data');
    expect(result.takeEarlyEvents?.()).toEqual([])
  });

  it('leaves the stdin temp file for the wrapper cleanup after successful spawn', async () => {
    spawnMock.mockReturnValueOnce({
      pid: 12345,
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
      kill: vi.fn(),
    });

    const executor = new TestExecutor();
    await executor.spawnForTest({ program: 'mock-agent', args: [] }, '{"message":"hello"}');

    const tmpFiles = tmpFilesForNow(now);
    expect(tmpFiles).toHaveLength(1);
    expect(existsSync(tmpFiles[0]!)).toBe(true);
  });

  it('does not log stdin contents when spawning with stdin', async () => {
    const secretMarker = 'SECRET_LONG_PROMPT_MARKER';
    const stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    spawnMock.mockReturnValueOnce({
      pid: 12345,
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
      kill: vi.fn(),
    });

    const executor = new TestExecutor();
    await executor.spawnForTest({ program: 'mock-agent', args: ['--json'] }, `${secretMarker} ${'x'.repeat(200)}`);

    const logs = stdoutWriteSpy.mock.calls.map(([line]) => String(line)).join('\n');
    expect(logs).not.toContain(secretMarker);
    expect(logs).toContain('length=');
    expect(logs).toContain('sha256=');
  });

  it('logs sanitized PTY output instead of only its byte length', async () => {
    const stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let onDataCallback: ((data: string) => void) | undefined;
    spawnMock.mockReturnValueOnce({
      pid: 12345,
      onData: vi.fn((callback: (data: string) => void) => {
        onDataCallback = callback;
        return { dispose: vi.fn() };
      }),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
      kill: vi.fn(),
    });

    const executor = new TestExecutor();
    await executor.spawnForTest({ program: 'mock-agent', args: ['--json'] }, '{"message":"hello"}');
    onDataCallback?.('\u001b[32mfirst line\u001b[0m\r\nsecond line');

    const logs = stdoutWriteSpy.mock.calls.map(([line]) => String(line)).join('\n');
    expect(logs).toContain('PTY> first line second line');
    expect(logs).not.toMatch(/PTY> <\d+ bytes>/);
  });

  it('redacts token-like config override values from spawn logs', async () => {
    const stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    spawnMock.mockReturnValueOnce({
      pid: 12345,
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
      kill: vi.fn(),
    });

    const executor = new TestExecutor();
    await executor.spawnInternalForTest({
      program: 'mock-agent',
      args: [
        '-c',
        'mcp_servers.agent-tower.env.AGENT_TOWER_INTERNAL_TOKEN=secret-internal-token',
      ],
    }, ExecutionEnv.default(os.tmpdir()));

    const logs = stdoutWriteSpy.mock.calls.map(([line]) => String(line)).join('\n');
    expect(logs).not.toContain('secret-internal-token');
    expect(logs).toContain('mcp_servers.agent-tower.env.AGENT_TOWER_INTERNAL_TOKEN=<redacted>');
  });

  it('uses bundled node runtime for the stdin PTY wrapper while sanitizing agent env', async () => {
    const originalEnv = snapshotEnv(envKeysToRestore);
    process.env.DATABASE_URL = 'file:/prod/database-url.db';
    process.env.AGENT_TOWER_DATABASE_URL = 'file:/prod/agent-tower.db';
    process.env.AGENT_TOWER_DATA_DIR = '/prod/agent-tower-data';
    process.env.AGENT_TOWER_WEB_DIR = '/prod/agent-tower-web';
    process.env.AGENT_TOWER_NODE_RUNTIME = '/prod/resources/runtime/node/node.exe';
    process.env.AGENT_TOWER_DESKTOP_RUNTIME_MODE = 'packaged';
    process.env.AGENT_TOWER_MCP_ENTRY = '/prod/runtime/server/dist/mcp/index.js';
    process.env.DATA_DIR = '/prod/data-dir';

    spawnMock.mockReturnValueOnce({
      pid: 12345,
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
      kill: vi.fn(),
    });

    try {
      const env = ExecutionEnv.default(os.tmpdir()).merge({
        AGENT_TOWER_URL: 'http://127.0.0.1:42232',
        DATABASE_URL: 'file:/provider/database-url.db',
      });
      const executor = new TestExecutor();

      await executor.spawnForTest({ program: 'mock-agent', args: ['--json'] }, '{"message":"hello"}', env);

      const [command, args, spawnOptions] = spawnMock.mock.calls[0]! as [
        string,
        string[],
        { env: Record<string, string> },
      ];
      expect(command).toBe('/prod/resources/runtime/node/node.exe');
      expect(args).toContain('pipe-file');

      const wrapperEnvKeys = new Set<string>(PTY_WRAPPER_ENV_KEYS);
      for (const key of AGENT_SUBPROCESS_BLOCKED_ENV_KEYS) {
        if (!wrapperEnvKeys.has(key)) {
          expect(spawnOptions.env).not.toHaveProperty(key);
        }
      }
      expect(spawnOptions.env).toMatchObject({
        AGENT_TOWER_NODE_RUNTIME: '/prod/resources/runtime/node/node.exe',
        AGENT_TOWER_URL: 'http://127.0.0.1:42232',
      });
      expect(spawnOptions.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    } finally {
      restoreEnv(originalEnv);
    }
  });
});

describe('BaseExecutor subprocess env', () => {
  const originalEnv = snapshotEnv(envKeysToRestore);

  beforeEach(() => {
    spawnMock.mockReset();
    whichMock.mockClear();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreEnv(originalEnv);
  });

  it('uses bundled node runtime for the PTY wrapper while sanitizing other internal env', async () => {
    process.env.DATABASE_URL = 'file:/prod/database-url.db';
    process.env.AGENT_TOWER_DATABASE_URL = 'file:/prod/agent-tower.db';
    process.env.AGENT_TOWER_DATA_DIR = '/prod/agent-tower-data';
    process.env.AGENT_TOWER_WEB_DIR = '/prod/agent-tower-web';
    process.env.AGENT_TOWER_NODE_RUNTIME = '/prod/resources/runtime/node/node.exe';
    process.env.AGENT_TOWER_DESKTOP_RUNTIME_MODE = 'packaged';
    process.env.AGENT_TOWER_MCP_ENTRY = '/prod/runtime/server/dist/mcp/index.js';
    process.env.DATA_DIR = '/prod/data-dir';
    process.env.AGENT_TOWER_SESSION_ID = 'inherited-session';
    process.env.AGENT_TOWER_INVOCATION_ID = 'inherited-invocation';
    process.env.AGENT_TOWER_TEAM_RUN_ID = 'inherited-team-run';
    process.env.AGENT_TOWER_MEMBER_ID = 'inherited-member';

    spawnMock.mockReturnValueOnce({
      pid: 12345,
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
      kill: vi.fn(),
    });

    const env = ExecutionEnv.default(os.tmpdir()).merge({
      AGENT_TOWER_SESSION_ID: 'session-1',
      AGENT_TOWER_INVOCATION_ID: 'invocation-1',
      AGENT_TOWER_TEAM_RUN_ID: 'team-run-1',
      AGENT_TOWER_MEMBER_ID: 'member-1',
      AGENT_TOWER_URL: 'http://127.0.0.1:42232',
      DATABASE_URL: 'file:/provider/database-url.db',
    });

    const executor = new TestExecutor();
    await executor.spawnInternalForTest({ program: 'mock-agent', args: ['--json'] }, env);

    const spawnOptions = spawnMock.mock.calls[0]![2] as { env: Record<string, string> };
    const wrapperEnvKeys = new Set<string>(PTY_WRAPPER_ENV_KEYS);
    for (const key of AGENT_SUBPROCESS_BLOCKED_ENV_KEYS) {
      if (!wrapperEnvKeys.has(key)) {
        expect(spawnOptions.env).not.toHaveProperty(key);
      }
    }
    expect(spawnOptions.env).toMatchObject({
      AGENT_TOWER_NODE_RUNTIME: '/prod/resources/runtime/node/node.exe',
      AGENT_TOWER_SESSION_ID: 'session-1',
      AGENT_TOWER_INVOCATION_ID: 'invocation-1',
      AGENT_TOWER_TEAM_RUN_ID: 'team-run-1',
      AGENT_TOWER_MEMBER_ID: 'member-1',
      AGENT_TOWER_URL: 'http://127.0.0.1:42232',
    });
    expect(spawnOptions.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
  });
});
