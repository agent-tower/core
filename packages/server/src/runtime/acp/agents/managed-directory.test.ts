import { describe, expect, it, vi } from 'vitest';

const fsState = vi.hoisted(() => ({
  rm: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  chmod: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  mkdtemp: vi.fn(async () => '/tmp/agent-tower-managed-retry'),
  rm: fsState.rm,
  writeFile: vi.fn(async () => undefined),
}));

import { createManagedDirectory } from './managed-directory.js';

describe('managed launch directory cleanup', () => {
  it('retries after a transient rm failure instead of caching a rejected cleanup', async () => {
    fsState.rm.mockReset();
    fsState.rm
      .mockRejectedValueOnce(new Error('temporary filesystem failure'))
      .mockResolvedValueOnce(undefined);

    const managed = await createManagedDirectory('retry', { 'config.json': '{}' });
    await expect(managed.cleanup()).rejects.toThrow('temporary filesystem failure');
    await expect(managed.cleanup()).resolves.toBeUndefined();
    expect(fsState.rm).toHaveBeenCalledTimes(2);
  });
});
