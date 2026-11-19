import fs from 'node:fs';
import { expect, it, vi } from 'vitest';
import { runOwnedCommand, runOwnedCommandInProcess } from '../../../utils/owned-child-process.js';
import { getCommandHelperStatus, startCommandHelper, stopCommandHelper } from '../client.js';

it.each([undefined, '7'])('preserves the command environment with helper allocator setting %s', async (operator) => {
  vi.stubEnv('MALLOC_ARENA_MAX', operator);
  try {
    expect(await startCommandHelper({ mode: 'on' })).toBe(true);
    if (process.platform === 'linux' && operator) {
      const env = fs.readFileSync(`/proc/${getCommandHelperStatus().pid}/environ`, 'utf8').split('\0');
      const setting = env.find(item => item.startsWith('MALLOC_ARENA_MAX='));
      expect(setting).toBe('MALLOC_ARENA_MAX=' + operator);
    }
    delete process.env.MALLOC_ARENA_MAX;
    // The compatibility supervisor assigns a fresh identity to each command.
    // Compare every other value without printing the caller's environment on failure.
    const script = `
      const env = { ...process.env };
      if ('AGENT_TOWER_PROCESS_IDENTITY' in env) env.AGENT_TOWER_PROCESS_IDENTITY = '<command>';
      const hash = require('node:crypto').createHash('sha256').update(JSON.stringify(Object.entries(env).sort())).digest('hex');
      process.stdout.write(JSON.stringify({ hash, arenas: env.MALLOC_ARENA_MAX ?? null }));
    `;
    for (const env of [undefined, { PATH: process.env.PATH, VALUE: 'custom' }, { MALLOC_ARENA_MAX: '9', VALUE: '' }]) {
      const options = { timeout: 10_000, env };
      const direct = await runOwnedCommandInProcess(process.execPath, ['-e', script], options);
      const viaHelper = await runOwnedCommand(process.execPath, ['-e', script], options);
      expect(viaHelper).toEqual(direct);
      expect(JSON.parse(viaHelper.stdout).arenas).toBe(env?.MALLOC_ARENA_MAX ?? null);
    }
  } finally {
    vi.unstubAllEnvs();
    await stopCommandHelper();
  }
}, 30_000);
