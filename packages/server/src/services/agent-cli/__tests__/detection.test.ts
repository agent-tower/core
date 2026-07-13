import { describe, expect, it, vi } from 'vitest';
import type { AgentCliInstallManifestItem } from '@agent-tower/shared';
import { AgentCliDetector } from '../detection.js';
import type { AgentCliExecFile } from '../command-runner.js';

const manifest: AgentCliInstallManifestItem[] = [
  {
    id: 'codex',
    displayName: 'Codex',
    legacy: false,
    officialSources: [],
    supportedPlatforms: ['darwin'],
    install: { kind: 'detect-only', reason: 'test' },
    detectionCommands: [{ command: 'codex', args: ['--version'], timeoutMs: 5000 }],
    versionCommand: {
      command: 'codex',
      args: ['--version'],
      timeoutMs: 5000,
      versionPattern: String.raw`\d+\.\d+\.\d+`,
    },
    authCommand: {
      command: 'codex',
      args: ['login', 'status'],
      timeoutMs: 5000,
    },
    lastVerifiedAt: '2026-06-18',
  },
];

const cursorManifest: AgentCliInstallManifestItem[] = [
  {
    id: 'cursor-agent',
    displayName: 'Cursor Agent',
    legacy: false,
    officialSources: [],
    supportedPlatforms: ['win32'],
    install: { kind: 'detect-only', reason: 'test' },
    detectionCommands: [
      { command: 'agent', args: ['--version'], timeoutMs: 5000 },
      { command: 'cursor-agent', args: ['--version'], timeoutMs: 5000 },
    ],
    versionCommand: {
      command: 'agent',
      args: ['--version'],
      timeoutMs: 5000,
      versionPattern: String.raw`\d+\.\d+\.\d+`,
    },
    lastVerifiedAt: '2026-06-18',
  },
];

describe('AgentCliDetector', () => {
  it('returns stale unknown cache without executing detection', () => {
    const execFileImpl = vi.fn() as unknown as AgentCliExecFile;
    const detector = new AgentCliDetector(execFileImpl, 'darwin');

    const status = detector.getCachedStatus(manifest);

    expect(execFileImpl).not.toHaveBeenCalled();
    expect(status).toMatchObject({
      stale: true,
      tools: [expect.objectContaining({ installStatus: 'unknown', checkedAt: null })],
    });
  });

  it('uses execFile fixed argv with shell disabled and returns only parsed status/version', async () => {
    const execFileImpl = vi.fn<AgentCliExecFile>(async (command, args, options) => {
      expect(command).toBe('codex');
      expect(args).toEqual(expect.any(Array));
      expect(options.shell).toBe(false);
      expect(options.timeout).toBe(5000);
      expect(options.env.OPENAI_API_KEY).toBeUndefined();
      return {
        stdout: 'codex 1.2.3 token=super-secret-value',
        stderr: '',
      };
    });
    process.env.OPENAI_API_KEY = 'sk-proj_should-not-pass';
    const detector = new AgentCliDetector(execFileImpl, 'darwin');

    const status = await detector.refresh(manifest);

    expect(execFileImpl).toHaveBeenCalled();
    expect(status.tools[0]).toMatchObject({
      installStatus: 'installed',
      versionStatus: 'detected',
      version: '1.2.3',
      authStatus: 'detected',
    });
    expect(JSON.stringify(status)).not.toContain('super-secret-value');
    delete process.env.OPENAI_API_KEY;
  });

  it('maps missing commands to missing without raw stderr', async () => {
    const error = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
    const execFileImpl = vi.fn<AgentCliExecFile>(async () => {
      throw error;
    });
    const detector = new AgentCliDetector(execFileImpl, 'darwin');

    const status = await detector.refresh(manifest);

    expect(status.tools[0]).toMatchObject({
      installStatus: 'missing',
      version: null,
      authStatus: 'unknown',
    });
    expect(JSON.stringify(status)).not.toContain('spawn codex ENOENT');
  });

  it('uses Windows where lookup and falls back from agent to cursor-agent.cmd', async () => {
    const execFileImpl = vi.fn<AgentCliExecFile>(async (command, args, options) => {
      expect(options.shell).toBe(false);
      if (command === 'where' && args[0] === 'agent') {
        throw Object.assign(new Error('agent not found'), { code: 1 });
      }
      if (command === 'where' && args[0] === 'cursor-agent') {
        return {
          stdout: 'C:\\Users\\alice\\AppData\\Roaming\\npm\\cursor-agent.cmd\r\n',
          stderr: '',
        };
      }
      if (command.endsWith('cmd.exe')) {
        return { stdout: 'cursor-agent 0.3.0', stderr: '' };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const detector = new AgentCliDetector(execFileImpl, 'win32');

    const status = await detector.refresh(cursorManifest);

    expect(status.tools[0]).toMatchObject({
      installStatus: 'installed',
      versionStatus: 'unknown',
    });
    expect(execFileImpl).toHaveBeenCalledWith(
      'where',
      ['agent'],
      expect.objectContaining({ shell: false, windowsHide: true })
    );
    expect(execFileImpl).toHaveBeenCalledWith(
      'where',
      ['cursor-agent'],
      expect.objectContaining({ shell: false, windowsHide: true })
    );
    expect(execFileImpl).toHaveBeenCalledWith(
      expect.stringMatching(/cmd\.exe$/i),
      expect.arrayContaining(['/d', '/s', '/c']),
      expect.objectContaining({ shell: false, windowsHide: true })
    );
  });
});
