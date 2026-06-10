import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentType } from '../../types/index.js';
import { BaseExecutor, type AvailabilityInfo } from '../base.executor.js';
import { CommandBuilder, type CommandParts } from '../command-builder.js';
import { ExecutionEnv } from '../execution-env.js';

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

  spawnForTest(commandParts: CommandParts, stdinData: string) {
    return this.spawnWithStdin({
      workingDir: os.tmpdir(),
      prompt: '',
      env: ExecutionEnv.default(os.tmpdir()),
    }, commandParts, stdinData);
  }
}

const tmpFileForNow = (now: number) => path.join(os.tmpdir(), `agent-tower-stdin-${now}.json`);

describe('BaseExecutor.spawnWithStdin', () => {
  let now = 0;

  beforeEach(() => {
    now += 1;
    spawnMock.mockReset();
    whichMock.mockClear();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    rmSync(tmpFileForNow(now), { force: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpFileForNow(now), { force: true });
  });

  it('removes the stdin temp file when pty.spawn throws after writing it', async () => {
    const error = new Error('spawn failed');
    spawnMock.mockImplementationOnce(() => {
      throw error;
    });

    const executor = new TestExecutor();

    await expect(executor.spawnForTest({ program: 'mock-agent', args: [] }, '{"message":"hello"}'))
      .rejects.toThrow(error);

    expect(existsSync(tmpFileForNow(now))).toBe(false);
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

  it('leaves the stdin temp file for the wrapper cleanup after successful spawn', async () => {
    spawnMock.mockReturnValueOnce({
      pid: 12345,
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
      kill: vi.fn(),
    });

    const executor = new TestExecutor();
    await executor.spawnForTest({ program: 'mock-agent', args: [] }, '{"message":"hello"}');

    expect(existsSync(tmpFileForNow(now))).toBe(true);
  });
});
