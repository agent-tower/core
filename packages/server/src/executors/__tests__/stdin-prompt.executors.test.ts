import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentType } from '../../types/index.js';
import { ExecutionEnv } from '../execution-env.js';
import { CodexExecutor } from '../codex.executor.js';
import { ClaudeCodeExecutor } from '../claude-code.executor.js';
import { CursorAgentExecutor } from '../cursor-agent.executor.js';
import { GeminiCliExecutor } from '../gemini-cli.executor.js';

const spawnMock = vi.hoisted(() => vi.fn());
const whichMock = vi.hoisted(() => vi.fn(async (command: string) => `/mock/bin/${command}`));

vi.mock('@shitiandmw/node-pty', () => ({
  spawn: spawnMock,
}));

vi.mock('../../utils/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/index.js')>();
  return {
    ...actual,
    which: whichMock,
  };
});

const LONG_PROMPT_MARKER = 'WINDOWS_LONG_PROMPT_MARKER';

function longPrompt(): string {
  return `${LONG_PROMPT_MARKER}\n${'x'.repeat(32_000)}`;
}

function makePty() {
  return {
    pid: 12345,
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
    kill: vi.fn(),
  };
}

function stdinFilesFromSpawnCalls(): string[] {
  const files: string[] = [];
  for (const call of spawnMock.mock.calls) {
    const args = call[1] as string[] | undefined;
    const modeIndex = args?.indexOf('pipe-file') ?? -1;
    if (args && modeIndex >= 0 && args[modeIndex + 2]) {
      files.push(args[modeIndex + 2]);
    }
  }
  return files;
}

function cleanupStdinFiles(files: string[]): void {
  for (const file of files) {
    if (path.basename(file).startsWith('agent-tower-stdin-')) {
      rmSync(file, { force: true });
    }
  }
}

function lastWrapperArgs(): string[] {
  const args = spawnMock.mock.calls.at(-1)?.[1] as string[] | undefined;
  if (!args) {
    throw new Error('Expected pty.spawn to be called');
  }
  return args;
}

function childArgsFromPipeInvocation(args: string[]): string[] {
  const modeIndex = args.indexOf('pipe-file');
  expect(modeIndex).toBeGreaterThanOrEqual(0);
  const programPath = args[modeIndex + 1];
  const stdinFile = args[modeIndex + 2];
  expect(programPath).toMatch(/^\/mock\/bin\//);
  expect(path.basename(stdinFile ?? '')).toMatch(/^agent-tower-stdin-/);
  return args.slice(modeIndex + 3);
}

function expectPromptOnlyInStdin(): string[] {
  const args = lastWrapperArgs();
  expect(JSON.stringify(args)).not.toContain(LONG_PROMPT_MARKER);
  return childArgsFromPipeInvocation(args);
}

const spawnConfig = {
  workingDir: os.tmpdir(),
  prompt: longPrompt(),
  env: ExecutionEnv.default(os.tmpdir()),
};

describe('executor prompt stdin transport', () => {
  const originalPath = process.env.PATH;

  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockReturnValue(makePty());
    whichMock.mockClear();
    process.env.PATH = '/nonexistent-agent-tower-test-path';
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    const stdinFiles = stdinFilesFromSpawnCalls();
    vi.restoreAllMocks();
    process.env.PATH = originalPath;
    cleanupStdinFiles(stdinFiles);
  });

  it('Codex initial and resume prompts use stdin with dash placeholder', async () => {
    const executor = new CodexExecutor();

    await executor.spawn(spawnConfig);
    const initialChildArgs = expectPromptOnlyInStdin();
    expect(initialChildArgs).toContain('exec');
    expect(initialChildArgs).toContain('--json');
    expect(initialChildArgs.at(-1)).toBe('-');

    await executor.spawnFollowUp(spawnConfig, 'codex-session-1');
    const followUpChildArgs = expectPromptOnlyInStdin();
    expect(followUpChildArgs).toEqual(expect.arrayContaining([
      'exec',
      'resume',
      'codex-session-1',
      '-',
    ]));
    expect(followUpChildArgs.at(-1)).toBe('-');
  });

  it('Claude Code sends ordinary text prompts through stream-json stdin', async () => {
    const executor = new ClaudeCodeExecutor();

    await executor.spawn(spawnConfig);
    const childArgs = expectPromptOnlyInStdin();

    expect(childArgs).toEqual(expect.arrayContaining([
      '-p',
      '--output-format=stream-json',
      '--input-format=stream-json',
    ]));
    expect(childArgs).not.toContain(spawnConfig.prompt);
  });

  it('Cursor Agent uses print/headless stdin without a positional prompt', async () => {
    const executor = new CursorAgentExecutor();

    await executor.spawn(spawnConfig);
    const childArgs = expectPromptOnlyInStdin();

    expect(childArgs).toEqual(expect.arrayContaining([
      '--print',
      '--output-format=stream-json',
    ]));
    expect(childArgs).not.toContain(spawnConfig.prompt);
  });

  it('Gemini CLI uses non-interactive stdin and does not start ACP mode', async () => {
    const executor = new GeminiCliExecutor({ model: 'gemini-test' });

    await executor.spawn(spawnConfig);
    const childArgs = expectPromptOnlyInStdin();

    expect(childArgs).toEqual(expect.arrayContaining([
      '-y',
      '@google/gemini-cli@0.23.0',
      '--model',
      'gemini-test',
      '--output-format=stream-json',
      '-p',
      '',
    ]));
    const promptArgIndex = childArgs.indexOf('-p');
    expect(promptArgIndex).toBeGreaterThanOrEqual(0);
    expect(childArgs[promptArgIndex + 1]).toBe('');
    expect(childArgs).not.toContain('--experimental-acp');
    expect(childArgs).not.toContain(spawnConfig.prompt);
  });

  it('Gemini follow-up keeps prompt out of args and passes resume selector', async () => {
    const executor = new GeminiCliExecutor();

    await executor.spawnFollowUp(spawnConfig, 'latest');
    const childArgs = expectPromptOnlyInStdin();

    expect(childArgs).toEqual(expect.arrayContaining([
      '--output-format=stream-json',
      '-p',
      '',
      '--resume',
      'latest',
    ]));
    const promptArgIndex = childArgs.indexOf('-p');
    expect(promptArgIndex).toBeGreaterThanOrEqual(0);
    expect(childArgs[promptArgIndex + 1]).toBe('');
    expect(childArgs).not.toContain('--experimental-acp');
    expect(childArgs).not.toContain(spawnConfig.prompt);
  });
});

describe('executor type smoke', () => {
  it('keeps the tested executors aligned with expected agent types', () => {
    expect(new CodexExecutor().agentType).toBe(AgentType.CODEX);
    expect(new ClaudeCodeExecutor().agentType).toBe(AgentType.CLAUDE_CODE);
    expect(new CursorAgentExecutor().agentType).toBe(AgentType.CURSOR_AGENT);
    expect(new GeminiCliExecutor().agentType).toBe(AgentType.GEMINI_CLI);
  });
});
