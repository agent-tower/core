import { afterAll, describe, expect, it, vi } from 'vitest';
import { runOwnedCommand } from '../../../utils/owned-child-process.js';
import { beginApplicationProcessShutdown } from '../../application-process-cleanup.js';
import { readRuntimeCounters } from '../../runtime-metrics.js';
import { getCommandHelperStatus, startCommandHelper, stopCommandHelper } from '../client.js';

// beginApplicationProcessShutdown() cannot be undone, so this runs in its own
// test file (vitest gives every file fresh module instances).
describe('command helper during application shutdown', () => {
  let helperPid = 0;
  afterAll(async () => {
    await stopCommandHelper();
    if (helperPid) { try { process.kill(helperPid, 'SIGKILL'); } catch { /* already exited */ } }
  });

  it('refuses new commands in the server before sending them, and does not restart the helper', async () => {
    const log = vi.fn();
    expect(await startCommandHelper({ mode: 'on', log, restartDelaysMs: [20] })).toBe(true);
    helperPid = getCommandHelperStatus().pid!;

    beginApplicationProcessShutdown();
    const before = readRuntimeCounters();
    // Same synchronous refusal as the in-process path; nothing reaches the helper.
    expect(() => runOwnedCommand('git', ['status'], { timeout: 5_000 })).toThrow('Application process shutdown is in progress');
    expect(readRuntimeCounters()).toEqual(before);
    expect(getCommandHelperStatus().pendingCommands).toBe(0);

    process.kill(helperPid, 'SIGKILL');
    await vi.waitFor(() => expect(getCommandHelperStatus().state).toBe('stopped'), { timeout: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(getCommandHelperStatus().state).toBe('stopped');
    expect(readRuntimeCounters().helperRestarts).toBe(before.helperRestarts);
    expect(log).toHaveBeenCalledWith('info', expect.stringContaining('not restarted during application shutdown'));
  }, 60_000);
});
