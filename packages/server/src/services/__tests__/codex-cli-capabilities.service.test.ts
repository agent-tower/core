import { chmod, mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Provider } from '@agent-tower/shared';
const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('../../utils/index.js', () => ({ which: lookup }));
import { cachedCodexCliSupport, refreshCodexCliSupport } from '../codex-cli-capabilities.service.js';
const dirs: string[] = [];
afterEach(async () => { lookup.mockReset(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
describe('Codex CLI interactive native build boundary', () => {
  it('does not execute an unknown wrapper even if it claims the verified native version', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tower-codex-capability-')); dirs.push(dir);
    const marker = path.join(dir, 'executed'); const executable = path.join(dir, 'codex');
    await writeFile(executable, `#!/bin/sh\ntouch '${marker}'\necho 'codex-cli 0.161.0'\n`); await chmod(executable, 0o700);
    lookup.mockResolvedValue(executable);
    expect(await refreshCodexCliSupport()).toMatchObject({ supported: false, code: 'CAPABILITY_UNVERIFIED' });
    await expect(access(marker)).rejects.toThrow();
  });
  it('keeps command, arguments and PATH overrides unverified', () => {
    const providers: Array<Pick<Provider, 'config' | 'env'>> = [{ config: { cmd: { baseCommandOverride: 'custom' } }, env: {} }, { config: { cmd: { additionalParams: ['--yolo'] } }, env: {} }, { config: {}, env: { PATH: '/custom' } }];
    for (const provider of providers) {
      expect(cachedCodexCliSupport(provider)).toMatchObject({ supported: false, code: 'CAPABILITY_UNVERIFIED' });
    }
  });
  it('uses the same native build support with a default or another selected model', () => {
    const selected = cachedCodexCliSupport({ config: { model: 'gpt-6-sol' }, env: {} });
    expect(cachedCodexCliSupport({ config: {}, env: {} })).toEqual(selected);
    expect(cachedCodexCliSupport({ config: { model: 'gpt-6.1-sol' }, env: {} })).toEqual(selected);
  });
});
