import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../core/event-bus.js';
import { TerminalManager } from '../terminal-manager.js';
import type { UnixProcessIdentityAdapter } from '../../utils/unix-process-identity.js';
import type { WindowsProcessTreeAdapter } from '../../runtime/acp/process-manager.js';

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
      platform: 'linux', gracefulTimeoutMs: 0, forceTimeoutMs: 30,
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

  it.skipIf(process.platform === 'win32').each(['foreground', 'background', 'markerless-background'])('reclaims a real %s child that ignores SIGHUP', async (mode) => {
    const bus = new EventBus();
    const manager = new TerminalManager(bus, {
      shell: { command: '/bin/sh', args: [] }, gracefulTimeoutMs: 100,
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
      manager.write(terminal.terminalId, `${mode === 'markerless-background' ? 'env -i ' : ''}${quote(process.execPath)} -e ${quote("process.on('SIGHUP',()=>{});console.log('TERMINAL_TEST_CHILD='+process.pid);setInterval(()=>{},1000)")} ${mode !== 'foreground' ? '&' : ''}\r`);
      await expect.poll(() => childPid, { timeout: 5000 }).toBeGreaterThan(0);
      if (mode !== 'foreground') {
        if (mode === 'markerless-background') {
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
});
