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
  it('does not cache direct-child ownership when the child exits during a probe', async () => {
    let current = true;
    const execFileMock = vi.fn((_command: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
      current = false;
      callback(null, `123 ${process.pid} 123 Mon Jan  1 00:00:00 2026${args[0] === 'eww' ? ' /bin/sh' : ''}\n`);
    }) as unknown as typeof execFile;
    const adapter = createUnixProcessIdentityAdapter('darwin', { execFile: execFileMock });
    await expect(adapter.captureChildProcess!(123, 'owner-token', () => current)).resolves.toBeNull();
    await expect(adapter.captureOwnedGroups!('owner-token')).resolves.toEqual([]);
  });

  it('binds an env-hidden direct child only to its original parent and birth identity', async () => {
    let parentPid = process.pid + 1;
    let birth = 'Mon Jan  1 00:00:00 2026';
    const execFileMock = vi.fn((_command: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
      callback(null, args[0] === '-axo' ? `123 ${parentPid} 123 ${birth}\n` : '/bin/sh\n');
    }) as unknown as typeof execFile;
    const adapter = createUnixProcessIdentityAdapter('darwin', { execFile: execFileMock });
    await expect(adapter.captureChildProcess!(123, 'owner-token', () => true)).resolves.toBeNull();
    parentPid = process.pid;
    const identity = await adapter.captureChildProcess!(123, 'owner-token', () => true);
    expect(identity).toMatchObject({ pid: 123, ownershipToken: 'owner-token' });
    await expect(adapter.isProcessAlive(identity!)).resolves.toBe(true);
    await expect(adapter.captureChildProcess!(123, 'another-owner', () => true)).resolves.toBeNull();
    birth = 'Mon Jan  1 00:00:01 2026';
    await expect(adapter.isProcessAlive(identity!)).resolves.toBe(false);
    await expect(adapter.captureChildProcess!(123, 'owner-token', () => true)).resolves.toBeNull();
    adapter.releaseOwnership!('owner-token');
    await expect(adapter.captureChildProcess!(123, 'another-owner', () => true)).resolves.toMatchObject({
      pid: 123, ownershipToken: 'another-owner',
    });
  });

  it('skips protected Linux processes owned by another UID without hiding candidate probe failures', async () => {
    const uid = process.getuid?.() ?? 0;
    let candidateDenied = false;
    const readFileMock = vi.fn(async (filePath: string) => {
      if (filePath.endsWith('/stat')) return linuxStat.replaceAll('123', filePath.split('/')[2]!);
      if (filePath.endsWith('/status')) {
        const owner = filePath.startsWith('/proc/1/') ? uid + 1 : uid;
        return `Uid:\t${owner}\t${owner}\t${owner}\t${owner}\n`;
      }
      if (filePath.startsWith('/proc/1/') || candidateDenied) throw fsError('EACCES');
      return Buffer.from('AGENT_TOWER_PROCESS_IDENTITY=owner-token\0');
    });
    const adapter = createUnixProcessIdentityAdapter('linux', {
      readdir: (async () => [1, 123].map((pid) => ({ name: String(pid), isDirectory: () => true }))) as unknown as typeof readdir,
      readFile: readFileMock as unknown as typeof readFile,
    });

    await expect(adapter.captureOwnedGroups!('owner-token')).resolves.toMatchObject([
      { members: [{ pid: 123, ownershipToken: 'owner-token' }] },
    ]);
    expect(readFileMock.mock.calls.some(([filePath]) => filePath === '/proc/1/environ')).toBe(false);
    candidateDenied = true;
    await expect(adapter.captureOwnedGroups!('owner-token')).rejects.toThrow(
      'Unix process environment probe failed for pid 123',
    );
  });

  it('ignores only same-UID protected processes proven older than the verified launch', async () => {
    const uid = process.getuid?.() ?? 0;
    let unrelatedTicks = 41;
    const readFileMock = vi.fn(async (filePath: string) => {
      const pid = Number(filePath.split('/')[2]);
      if (filePath.endsWith('/stat')) return `${pid} (node) ${['S', String(process.pid), String(pid), ...Array(16).fill('0'), String(pid === 123 ? 42 : unrelatedTicks)].join(' ')}`;
      if (filePath.endsWith('/status')) return `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;
      if (pid === 321) throw fsError('EACCES');
      return Buffer.from('AGENT_TOWER_PROCESS_IDENTITY=owner-token\0');
    });
    const adapter = createUnixProcessIdentityAdapter('linux', {
      readdir: (async () => [123, 321].map((pid) => ({ name: String(pid), isDirectory: () => true }))) as unknown as typeof readdir,
      readFile: readFileMock as unknown as typeof readFile,
    });
    await expect(adapter.captureOwnedGroups!('owner-token')).resolves.toMatchObject([
      { members: [{ pid: 123, ownershipToken: 'owner-token' }] },
    ]);
    unrelatedTicks = 42;
    await expect(adapter.captureOwnedGroups!('owner-token')).rejects.toThrow('Unix process environment probe failed for pid 321');
    unrelatedTicks = 43;
    await expect(adapter.captureOwnedGroups!('owner-token')).rejects.toThrow('Unix process environment probe failed for pid 321');
  });

  it('keeps a previously token-verified root as a candidate when its environ becomes protected', async () => {
    const uid = process.getuid?.() ?? 0;
    let denied = false;
    const adapter = createUnixProcessIdentityAdapter('linux', {
      readdir: (async () => [{ name: '123', isDirectory: () => true }]) as unknown as typeof readdir,
      readFile: (async (filePath: string) => {
        if (filePath.endsWith('/stat')) return linuxStat;
        if (filePath.endsWith('/status')) return `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;
        if (denied) throw fsError('EACCES');
        return Buffer.from('AGENT_TOWER_PROCESS_IDENTITY=owner-token\0');
      }) as unknown as typeof readFile,
    });
    expect(await adapter.captureProcess(123, 'owner-token')).not.toBeNull();
    denied = true;
    await expect(adapter.captureOwnedGroups!('owner-token')).rejects.toThrow('Unix process environment probe failed for pid 123');
  });

  it.each(['Z', 'X'])('excludes cached %s members from liveness while retaining their live descendants', async (state) => {
    const uid = process.getuid?.() ?? 0;
    let rootExited = false;
    const adapter = createUnixProcessIdentityAdapter('linux', {
      readdir: (async () => [123, 124, 125].map((pid) => ({ name: String(pid), isDirectory: () => true }))) as unknown as typeof readdir,
      readFile: (async (filePath: string) => {
        const pid = Number(filePath.split('/')[2]);
        if (filePath.endsWith('/stat')) {
          const parent = pid === 123 ? process.pid : pid - 1;
          return `${pid} (node) ${[rootExited && pid !== 125 ? state : 'S', String(parent), String(pid), ...Array(16).fill('0'), String(pid)].join(' ')}`;
        }
        if (filePath.endsWith('/status')) return `Uid:\t${uid}\t${uid}\t${uid}\t${uid}\n`;
        if (rootExited && pid !== 125) throw fsError('EACCES');
        return Buffer.from(pid === 123 ? 'AGENT_TOWER_PROCESS_IDENTITY=owner-token\0' : '');
      }) as unknown as typeof readFile,
    });
    const initial = await adapter.captureOwnedGroups!('owner-token');
    expect(initial.flatMap((group) => group.members.map((member) => member.pid))).toEqual([123, 124, 125]);
    rootExited = true;
    const remaining = await adapter.captureOwnedGroups!('owner-token');
    expect(remaining.flatMap((group) => group.members.map((member) => member.pid))).toEqual([125]);
    await expect(adapter.isProcessGroupAlive(initial.find((group) => group.pgid === 124)!)).resolves.toBe(false);
    await expect(adapter.isProcessGroupAlive(remaining[0]!)).resolves.toBe(true);
  });

  it('treats Linux zombie rows as exited identities', async () => {
    const readFileMock = vi.fn(async (filePath: string) => {
      if (filePath.endsWith('/stat')) return `123 (node) ${['Z', '1', '123', ...Array(16).fill('0'), '42'].join(' ')}`;
      if (filePath.endsWith('/status')) return 'Uid:\t0\t0\t0\t0\n';
      return Buffer.from('AGENT_TOWER_PROCESS_IDENTITY=owner-token\0');
    });
    const adapter = createUnixProcessIdentityAdapter('linux', {
      readdir: (async () => [{ name: '123', isDirectory: () => true }]) as unknown as typeof readdir,
      readFile: readFileMock as unknown as typeof readFile,
    });
    await expect(adapter.captureProcess(123, 'owner-token')).resolves.toBeNull();
  });

  it('retains markerless descendants after root exit and rejects reused process identities', async () => {
    const birth = 'Mon Jan  1 00:00:00 2026';
    let rows = [
      { pid: 123, ppid: 1, pgid: 123, birth, env: 'AGENT_TOWER_PROCESS_IDENTITY=owner-token' },
      { pid: 124, ppid: 123, pgid: 123, birth, env: '' },
      { pid: 125, ppid: 124, pgid: 125, birth, env: '' },
      { pid: 321, ppid: 1, pgid: 321, birth, env: '' },
    ];
    const execFileMock = vi.fn((_command: string, args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
      if (args.includes('-p')) {
        callback(null, rows.find((row) => row.pid === Number(args[args.indexOf('-p') + 1]))?.env ?? '');
      } else {
        callback(null, rows.map((row) => `${row.pid} ${row.ppid} ${row.pgid} ${row.birth}${args[0] === 'eww' ? ` node ${row.env}` : ''}`).join('\n'));
      }
    }) as unknown as typeof execFile;
    const adapter = createUnixProcessIdentityAdapter('darwin', { execFile: execFileMock });
    const groups = await adapter.captureOwnedGroups!('owner-token');
    expect(groups.flatMap((group) => group.members.map((member) => member.pid))).toEqual([123, 124, 125]);
    rows = rows.filter((row) => row.pid !== 123).map((row) => ({ ...row, ppid: 1 }));
    const remaining = await adapter.captureOwnedGroups!('owner-token');
    expect(remaining.flatMap((group) => group.members.map((member) => member.pid))).toEqual([124, 125]);
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      await expect(adapter.signalProcessGroup(remaining.find((group) => group.pgid === 125)!, 'SIGKILL')).resolves.toBe(true);
      expect(kill).toHaveBeenCalledWith(-125, 'SIGKILL');
      kill.mockClear();
      rows = rows.map((row) => row.pid === 125 ? { ...row, birth: 'Mon Jan  1 00:00:01 2026' } : row);
      await expect(adapter.signalProcessGroup(remaining.find((group) => group.pgid === 125)!, 'SIGKILL')).resolves.toBe(false);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

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
