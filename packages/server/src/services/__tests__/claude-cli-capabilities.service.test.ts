import { chmod, mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('../../utils/index.js', () => ({ which: lookup }));
import { cachedClaudeCliAskSupport, refreshClaudeCliAskSupport } from '../claude-cli-capabilities.service.js';
const dirs: string[] = [];
afterEach(async () => { lookup.mockReset(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
describe('Claude CLI ASK verification boundary', () => {
  it('reports a missing executable and bounds lookup', async () => {
    lookup.mockResolvedValue(null);
    expect(await refreshClaudeCliAskSupport()).toMatchObject({ supported: false, code: 'RUNTIME_MODE_UNSUPPORTED' });
    expect(lookup).toHaveBeenCalledWith('claude', { timeoutMs: 3000 });
  });
  it('does not execute an unknown wrapper even if it claims the verified native version', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tower-claude-capability-')); dirs.push(dir);
    const marker = path.join(dir, 'executed'); const executable = path.join(dir, 'claude');
    await writeFile(executable, `#!/bin/sh\ntouch '${marker}'\necho '2.1.293 (Claude Code)'\n`); await chmod(executable, 0o700);
    lookup.mockResolvedValue(executable);
    expect(await refreshClaudeCliAskSupport()).toMatchObject({ supported: false, code: 'CAPABILITY_UNVERIFIED' });
    await expect(access(marker)).rejects.toThrow();
    await writeFile(executable, `#!/bin/sh\ntouch '${marker}'\necho '2.1.294 (Claude Code)'\n`);
    expect(await refreshClaudeCliAskSupport()).toMatchObject({ supported: false, code: 'CAPABILITY_UNVERIFIED' });
    await expect(access(marker)).rejects.toThrow();
  });
  it('keeps router and unknown launch overrides unverified', () => {
    for (const config of [{ claudeCodeRouter: true }, { cmd: { baseCommandOverride: 'custom' } }, { cmd: { additionalParams: ['--permission-mode=bypassPermissions'] } }]) {
      expect(cachedClaudeCliAskSupport({ config, env: {} })).toMatchObject({ supported: false, code: 'CAPABILITY_UNVERIFIED' });
    }
  });
});
