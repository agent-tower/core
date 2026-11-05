import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../core/event-bus.js';
import { TerminalManager } from '../terminal-manager.js';
import type { UnixProcessIdentityAdapter } from '../../utils/unix-process-identity.js';
import type { WindowsProcessTreeAdapter } from '../../runtime/acp/process-manager.js';
import type { ProcessScopeRuntime } from '../../runtime/process-scope/process-scope.js';
import { resolveScopeHelper } from '../../runtime/process-scope/scope-helper.js';

function fakeScope(overrides: Partial<ProcessScopeRuntime> = {}): ProcessScopeRuntime {
  return {
    helper: { path: '/fake/agent-tower-scope', capabilities: { subreaper: true, pidfd: true, childrenFile: true } },
    buildInvocation: (policy, command, args) => ({ command: '/fake/agent-tower-scope', args: ['--id', policy.id, '--grace', String(policy.graceMs), '--', command, ...args] }),
    requestStop: vi.fn(() => true),
    forceStop: vi.fn(() => true),
    ...overrides,
  };
}

vi.mock('../../utils/error-log.js', () => ({ writeErrorLog: vi.fn() }));

class FakePty {
  pid = 4242;
  write = vi.fn();
  resize = vi.fn();
  private exits = new Set<(event: { exitCode: number }) => void>();
  onData() { return { dispose() {} }; }
  onExit(listener: (event: { exitCode: number }) => void) {
    this.exits.add(listener);
    return { dispose: () => this.exits.delete(listener) };
  }
  exit() { for (const listener of [...this.exits]) listener({ exitCode: 0 }); }
}

describe('TerminalManager process ownership', () => {
  it('retains descendants after root exit and retries failed termination', async () => {
    const shell = new FakePty();
    let rootAlive = true;
    let childAlive = true;
    let token = '';
    const identity = (pid: number) => ({ pid, pgid: pid, birthIdentity: `birth-${pid}`, ownershipToken: token });
    const adapter: UnixProcessIdentityAdapter = {
      captureProcess: vi.fn(async (_pid, ownershipToken) => { token = ownershipToken; return identity(shell.pid); }),
      captureDescendantGroups: vi.fn(async () => [{ pgid: 4243, members: [identity(4243)] }]),
      captureOwnedGroups: vi.fn(async () => childAlive ? [{ pgid: 4243, members: [identity(4243)] }] : []),
      isProcessAlive: vi.fn(async member => member.pid === shell.pid ? rootAlive : childAlive),
      isProcessGroupAlive: vi.fn(async group => group.pgid === shell.pid ? rootAlive : childAlive),
      signalProcess: vi.fn(async () => true),
      signalProcessGroup: vi.fn(async group => {
        if (group.pgid === shell.pid && rootAlive) { rootAlive = false; shell.exit(); }
        return true;
      }),
    };
    const manager = new TerminalManager(new EventBus(), {
      spawn: vi.fn(() => shell) as any, unixProcessAdapter: adapter,
      platform: 'linux', gracefulTimeoutMs: 0, forceTimeoutMs: 30, processScope: null,
    });
    const terminal = manager.create('socket');
    try {
      await expect(manager.destroy(terminal.terminalId)).rejects.toThrow('process tree did not exit');
      expect(rootAlive).toBe(false);
      expect(manager.has(terminal.terminalId)).toBe(true);
      childAlive = false;
      await manager.cleanupBySocket('socket');
      expect(manager.size).toBe(0);
    } finally { childAlive = false; await manager.destroyAll(); }
  });

  it('runs a supervised terminal under the scope helper and stops it through the supervisor', async () => {
    const shell = new FakePty();
    const scope = fakeScope({ requestStop: vi.fn(() => { shell.exit(); return true; }) });
    const spawn = vi.fn(() => shell);
    const adapter = { captureOwnedGroups: vi.fn(), captureDescendantGroups: vi.fn() } as unknown as UnixProcessIdentityAdapter;
    const manager = new TerminalManager(new EventBus(), {
      spawn: spawn as any, unixProcessAdapter: adapter, processScope: scope, platform: 'linux',
      shell: { command: '/bin/sh', args: ['-l'] }, gracefulTimeoutMs: 10, forceTimeoutMs: 20,
    });
    const terminal = manager.create('socket');
    try {
      const [command, args, options] = spawn.mock.calls[0] as unknown as [string, string[], { env: Record<string, string> }];
      expect(command).toBe('/fake/agent-tower-scope');
      expect(args).toEqual(['--id', terminal.terminalId, '--grace', '10', '--', '/bin/sh', '-l']);
      expect(options.env.AGENT_TOWER_PROCESS_IDENTITY).toBeUndefined();
      await manager.destroy(terminal.terminalId);
      expect(scope.requestStop).toHaveBeenCalledWith(shell.pid, 'SIGHUP');
      expect(scope.forceStop).not.toHaveBeenCalled();
      expect(adapter.captureOwnedGroups).not.toHaveBeenCalled();
      expect(adapter.captureDescendantGroups).not.toHaveBeenCalled();
      expect(manager.size).toBe(0);
    } finally { shell.exit(); await manager.destroyAll(); }
  });

  it('escalates a lingering supervised terminal and keeps it retryable when it never exits', async () => {
    const shell = new FakePty();
    let exitOnForce = false;
    const scope = fakeScope({ forceStop: vi.fn(() => { if (exitOnForce) shell.exit(); return true; }) });
    const manager = new TerminalManager(new EventBus(), {
      spawn: vi.fn(() => shell) as any, processScope: scope, platform: 'linux', gracefulTimeoutMs: 5, forceTimeoutMs: 10,
    });
    const terminal = manager.create('socket');
    try {
      await expect(manager.destroy(terminal.terminalId)).rejects.toThrow('process tree did not exit');
      expect(scope.requestStop).toHaveBeenCalledWith(shell.pid, 'SIGHUP');
      expect(scope.forceStop).toHaveBeenCalledWith(shell.pid);
      expect(manager.has(terminal.terminalId)).toBe(true);
      exitOnForce = true;
      await manager.cleanupBySocket('socket');
      expect(manager.size).toBe(0);
    } finally { shell.exit(); await manager.destroyAll(); }
  });

  it('reclaims verified Windows descendants after the terminal root exits', async () => {
    const shell = new FakePty();
    let rootAlive = true;
    let childAlive = true;
    const root = { pid: shell.pid, parentPid: process.pid, birthMarker: 'root-birth' };
    const child = { pid: 4243, parentPid: shell.pid, birthMarker: 'child-birth' };
    const adapter: WindowsProcessTreeAdapter = {
      captureProcess: vi.fn(async () => root),
      captureDescendants: vi.fn(async pid => pid === shell.pid ? [child] : []),
      isProcessAlive: vi.fn(async identity => identity.pid === shell.pid ? rootAlive : childAlive),
      terminateTree: vi.fn(async pid => { if (pid === child.pid) childAlive = false; }),
    };
    const manager = new TerminalManager(new EventBus(), {
      spawn: vi.fn(() => shell) as any, windowsProcessAdapter: adapter, platform: 'win32',
    });
    const terminal = manager.create('windows-terminal');
    try {
      await vi.waitFor(() => expect(adapter.captureDescendants).toHaveBeenCalledWith(root.pid));
      rootAlive = false;
      shell.exit();
      await manager.destroy(terminal.terminalId);
      expect(adapter.terminateTree).toHaveBeenCalledWith(child.pid);
      expect(adapter.terminateTree).not.toHaveBeenCalledWith(root.pid);
      expect(manager.size).toBe(0);
    } finally { childAlive = false; rootAlive = false; shell.exit(); await manager.destroyAll(); }
  });

  it('terminates a Windows terminal even when identity probes exceed the exit wait budget', async () => {
    const shell = new FakePty();
    let rootAlive = true;
    let now = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const root = { pid: shell.pid, parentPid: process.pid, birthMarker: 'root-birth' };
    const adapter: WindowsProcessTreeAdapter = {
      captureProcess: vi.fn(async () => root),
      captureDescendants: vi.fn(async () => { now += 50; return []; }),
      isProcessAlive: vi.fn(async () => rootAlive),
      terminateTree: vi.fn(async () => { now += 50; rootAlive = false; shell.exit(); }),
    };
    const manager = new TerminalManager(new EventBus(), {
      spawn: vi.fn(() => shell) as any, windowsProcessAdapter: adapter,
      platform: 'win32', forceTimeoutMs: 10,
    });
    const terminal = manager.create('windows-slow-identity-probe');
    try {
      await manager.destroy(terminal.terminalId);
      expect(adapter.terminateTree).toHaveBeenCalledWith(root.pid);
      expect(rootAlive).toBe(false);
      expect(manager.size).toBe(0);
    } finally {
      rootAlive = false;
      shell.exit();
      try { await manager.destroyAll(); } finally { clock.mockRestore(); }
    }
  });

  it('retains Windows terminal ownership when termination fails and allows a retry', async () => {
    const shell = new FakePty();
    let rootAlive = true;
    let canTerminate = false;
    const root = { pid: shell.pid, parentPid: process.pid, birthMarker: 'root-birth' };
    const adapter: WindowsProcessTreeAdapter = {
      captureProcess: vi.fn(async () => root),
      captureDescendants: vi.fn(async () => []),
      isProcessAlive: vi.fn(async () => rootAlive),
      terminateTree: vi.fn(async () => {
        if (canTerminate) { rootAlive = false; shell.exit(); }
      }),
    };
    const manager = new TerminalManager(new EventBus(), {
      spawn: vi.fn(() => shell) as any, windowsProcessAdapter: adapter,
      platform: 'win32', forceTimeoutMs: 30,
    });
    const terminal = manager.create('windows-termination-retry');
    try {
      await expect(manager.destroy(terminal.terminalId)).rejects.toThrow('process tree did not exit');
      expect(adapter.terminateTree).toHaveBeenCalledWith(root.pid);
      expect(manager.has(terminal.terminalId)).toBe(true);
      canTerminate = true;
      await manager.cleanupBySocket('windows-termination-retry');
      expect(rootAlive).toBe(false);
      expect(manager.size).toBe(0);
    } finally { rootAlive = false; shell.exit(); await manager.destroyAll(); }
  });

  it('does not terminate a Windows PID reused after its descendant was recorded', async () => {
    const shell = new FakePty();
    let alive = true;
    const root = { pid: shell.pid, parentPid: process.pid, birthMarker: 'root-birth' };
    const child = { pid: 4243, parentPid: shell.pid, birthMarker: 'old-child-birth' };
    const adapter: WindowsProcessTreeAdapter = {
      captureProcess: vi.fn(async () => root),
      captureDescendants: vi.fn(async pid => pid === shell.pid ? [child] : []),
      isProcessAlive: vi.fn(async () => alive),
      terminateTree: vi.fn(async () => undefined),
    };
    const manager = new TerminalManager(new EventBus(), {
      spawn: vi.fn(() => shell) as any, windowsProcessAdapter: adapter, platform: 'win32',
    });
    const terminal = manager.create('windows-reused-pid');
    try {
      await vi.waitFor(() => expect(adapter.captureDescendants).toHaveBeenCalledWith(root.pid));
      // The adapter rejects the new birth marker even though its PID exists.
      alive = false;
      shell.exit();
      await manager.destroy(terminal.terminalId);
      expect(adapter.terminateTree).not.toHaveBeenCalled();
      expect(manager.size).toBe(0);
    } finally { alive = false; shell.exit(); await manager.destroyAll(); }
  });

  const realBackends = [
    { backend: 'supervised', options: {}, enabled: process.platform === 'linux' && resolveScopeHelper() !== null },
    { backend: 'compat', options: { processScope: null }, enabled: process.platform !== 'win32' },
  ] as const;
  for (const { backend, options, enabled } of realBackends) {
    it.skipIf(!enabled).each(['foreground', 'background', 'markerless-background'])(`reclaims a real %s child that ignores SIGHUP (${backend})`, async (mode) => {
      const bus = new EventBus();
      const manager = new TerminalManager(bus, {
        shell: { command: '/bin/sh', args: [] }, gracefulTimeoutMs: 100, ...options,
      });
      const terminal = manager.create('real-terminal-test', { cwd: '/tmp' });
      let childPid = 0;
      let output = '';
      bus.on('terminal:stdout', event => {
        output += event.data;
        const match = /TERMINAL_TEST_CHILD=(\d+)/.exec(output);
        if (match) childPid = Number(match[1]);
      });
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
      try {
        if (backend === 'supervised') {
          // The PTY root is the supervisor, not the shell. Poll: right after
          // spawn the child may not have exec'd the supervisor yet.
          const rootCommand = () => { try { return fs.readFileSync(`/proc/${terminal.pid}/cmdline`, 'utf8').split('\0')[0]; } catch { return ''; } };
          await expect.poll(rootCommand, { timeout: 5000 }).toBe(resolveScopeHelper()!.path);
        }
        manager.write(terminal.terminalId, `${mode === 'markerless-background' ? 'env -i ' : ''}${quote(process.execPath)} -e ${quote("process.on('SIGHUP',()=>{});console.log('TERMINAL_TEST_CHILD='+process.pid);setInterval(()=>{},1000)")} ${mode !== 'foreground' ? '&' : ''}\r`);
        await expect.poll(() => childPid, { timeout: 5000 }).toBeGreaterThan(0);
        if (mode !== 'foreground') {
          if (mode === 'markerless-background' && backend === 'compat') {
            // Establish ancestry while the shell is alive; after exit the job
            // has neither its launch token nor a live parent to discover it by.
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          manager.write(terminal.terminalId, 'exit\r');
          await expect.poll(() => manager.size, { timeout: 4000 }).toBe(0);
        } else {
          await Promise.all([manager.destroy(terminal.terminalId), manager.cleanupBySocket('real-terminal-test')]);
        }
        expect(manager.size).toBe(0);
        await expect.poll(() => alive(childPid)).toBe(false);
        await manager.destroyAll();
        expect(() => manager.create('after-shutdown')).toThrow('stopped');
      } finally {
        for (const pid of [childPid, terminal.pid]) if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
        await manager.destroyAll();
      }
    }, 10000);
  }
});
