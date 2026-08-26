import type { execFile } from 'node:child_process';
import type { readdir, readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { createUnixProcessIdentityAdapter } from '../unix-process-identity.js';

const linuxStat = `123 (node) ${[
  'S', '1', '123', ...Array.from({ length: 16 }, () => '0'), '42',
].join(' ')}`;

function fsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function linuxDependencies(environError: NodeJS.ErrnoException) {
  const readdirMock = vi.fn(async () => [{ name: '123', isDirectory: () => true }]);
  const readFileMock = vi.fn(async (filePath: string) => {
    if (filePath.endsWith('/stat')) return linuxStat;
    throw environError;
  });
  return {
    readdir: readdirMock as unknown as typeof readdir,
    readFile: readFileMock as unknown as typeof readFile,
  };
}

describe('default Unix process identity adapter', () => {
  it.each(['EACCES', 'EPERM', 'EIO'])('propagates Linux environ %s failures', async (code) => {
    const adapter = createUnixProcessIdentityAdapter('linux', linuxDependencies(fsError(code)));

    await expect(adapter.captureProcess(123, 'owner-token')).rejects.toThrow(
      'Unix process environment probe failed for pid 123',
    );
  });

  it('maps a disappeared Linux process environ to a missing identity', async () => {
    const adapter = createUnixProcessIdentityAdapter('linux', linuxDependencies(fsError('ENOENT')));

    await expect(adapter.captureProcess(123, 'owner-token')).resolves.toBeNull();
  });

  it('propagates a ps environment command failure on macOS', async () => {
    const execFileMock = vi.fn((
      _command: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      if (args[0] === '-axo') {
        callback(null, '123 1 123 Mon Jan  1 00:00:00 2026\n');
      } else {
        callback(fsError('EPERM'), '');
      }
      return undefined;
    }) as unknown as typeof execFile;
    const adapter = createUnixProcessIdentityAdapter('darwin', { execFile: execFileMock });

    await expect(adapter.captureProcess(123, 'owner-token')).rejects.toThrow(
      'Unix process enumeration failed: ps',
    );
  });

  it('forces a stable C locale for macOS ps probes', async () => {
    const calls: Array<{ command: string; args: string[]; options: { env?: NodeJS.ProcessEnv } }> = [];
    const execFileMock = vi.fn((
      command: string,
      args: string[],
      options: { env?: NodeJS.ProcessEnv },
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      calls.push({ command, args, options });
      if (args[0] === '-axo') {
        callback(null, '123 1 123 Mon Jan  1 00:00:00 2026\n');
      } else {
        callback(null, '123 1 123 Mon Jan  1 00:00:00 2026 AGENT_TOWER_PROCESS_IDENTITY=owner-token\n');
      }
      return undefined;
    }) as unknown as typeof execFile;
    const adapter = createUnixProcessIdentityAdapter('darwin', { execFile: execFileMock });

    await adapter.captureProcess(123, 'owner-token');

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.command).toBe('ps');
      expect(call.options.env?.LC_ALL).toBe('C');
      expect(call.options.env?.LANG).toBe('C');
    }
  });

  it.each(['', 'not-a-process-row'])('fails closed for empty or malformed macOS ps output (%j)', async (stdout) => {
    const execFileMock = vi.fn((
      _command: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      callback(null, stdout);
      return undefined;
    }) as unknown as typeof execFile;
    const adapter = createUnixProcessIdentityAdapter('darwin', { execFile: execFileMock });

    await expect(adapter.captureOwnedGroups?.('owner-token')).rejects.toThrow(
      /Unix process enumeration returned (empty|malformed) output/,
    );
  });
});
