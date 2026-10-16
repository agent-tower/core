import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { captureSpawnedProcessIdentity } from '../spawned-process-identity.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

describe('fresh PTY process identity', () => {
  afterEach(() => vi.resetAllMocks());

  function processTable(parentPid: number, duringProbe?: () => void) {
    vi.mocked(execFile).mockImplementation((_command: any, args: any, _options: any, callback: any) => {
      duringProbe?.();
      callback(null, args[0] === '-axo'
        ? `123 ${parentPid} 123 Fri Oct 16 09:24:00 2026\n`
        : '/path/to/spawn-helper\n');
      return {} as never;
    });
  }

  it('captures a live direct PTY child before its environment marker becomes visible', async () => {
    processTable(process.pid);
    await expect(captureSpawnedProcessIdentity(123, 'launch-token', 'darwin', () => true))
      .resolves.toMatchObject({ processGroupId: '123', ownershipToken: 'launch-token' });
    // Recovery with only a PID cannot claim this same unmarked process.
    await expect(captureSpawnedProcessIdentity(123, 'launch-token', 'darwin')).resolves.toBeNull();
  });

  it('rejects a different parent and a handle that exits during identity capture', async () => {
    processTable(process.pid + 1);
    await expect(captureSpawnedProcessIdentity(123, 'launch-token', 'darwin', () => true)).resolves.toBeNull();
    let current = true;
    processTable(process.pid, () => { current = false; });
    await expect(captureSpawnedProcessIdentity(123, 'launch-token', 'darwin', () => current)).resolves.toBeNull();
  });
});
