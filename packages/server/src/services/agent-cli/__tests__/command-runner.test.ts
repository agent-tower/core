import { describe, expect, it, vi } from 'vitest';
import type { AgentCliExecFile } from '../command-runner.js';
import { runAgentCliCommand } from '../command-runner.js';

describe('runAgentCliCommand', () => {
  it('resolves Windows commands with where and executes .cmd shims through cmd.exe', async () => {
    const execFileImpl = vi.fn<AgentCliExecFile>(async (command) => {
      if (command === 'where') {
        return {
          stdout: 'C:\\Users\\alice\\AppData\\Roaming\\npm\\codex.cmd\r\n',
          stderr: '',
        };
      }
      return { stdout: 'codex 1.2.3', stderr: '' };
    });

    await runAgentCliCommand(
      { command: 'codex', args: ['--version'], timeoutMs: 5000 },
      {
        platform: 'win32',
        env: {
          PATH: 'C:\\Windows\\System32',
          COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
        },
        execFileImpl,
      }
    );

    expect(execFileImpl).toHaveBeenNthCalledWith(
      1,
      'where',
      ['codex'],
      expect.objectContaining({ shell: false, windowsHide: true })
    );
    expect(execFileImpl).toHaveBeenNthCalledWith(
      2,
      'C:\\Windows\\System32\\cmd.exe',
      [
        '/d',
        '/s',
        '/c',
        '"C:\\Users\\alice\\AppData\\Roaming\\npm\\codex.cmd --version"',
      ],
      expect.objectContaining({ shell: false, windowsHide: true })
    );
  });

  it('maps Windows lookup failures to command missing', async () => {
    const execFileImpl = vi.fn<AgentCliExecFile>(async () => {
      throw Object.assign(new Error('where exited 1'), { code: 1 });
    });

    await expect(runAgentCliCommand(
      { command: 'missing-tool', args: ['--version'], timeoutMs: 5000 },
      { platform: 'win32', env: { PATH: 'C:\\Windows\\System32' }, execFileImpl }
    )).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('adds the Cursor official install directory to Windows lookup PATH for verify', async () => {
    const execFileImpl = vi.fn<AgentCliExecFile>(async (command, _args, options) => {
      if (command === 'where') {
        expect(options.env.PATH).toContain('C:\\Users\\alice\\AppData\\Local\\cursor-agent');
        return {
          stdout: 'C:\\Users\\alice\\AppData\\Local\\cursor-agent\\agent.cmd\r\n',
          stderr: '',
        };
      }
      return { stdout: 'agent 1.0.0', stderr: '' };
    });

    await runAgentCliCommand(
      { command: 'agent', args: ['--version'], timeoutMs: 5000 },
      {
        platform: 'win32',
        env: {
          PATH: 'C:\\Windows\\System32',
          COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
          LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local',
        },
        execFileImpl,
      }
    );

    expect(execFileImpl).toHaveBeenLastCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      [
        '/d',
        '/s',
        '/c',
        '"C:\\Users\\alice\\AppData\\Local\\cursor-agent\\agent.cmd --version"',
      ],
      expect.objectContaining({ shell: false, windowsHide: true })
    );
  });
});
