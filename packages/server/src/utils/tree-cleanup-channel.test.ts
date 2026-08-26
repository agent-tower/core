import { describe, expect, it } from 'vitest';
import { createTreeCleanupChannel } from './tree-cleanup-channel.js';

describe('tree cleanup completion channel', () => {
  it('does not expose a discoverable or writable child capability', async () => {
    const channel = await createTreeCleanupChannel();
    expect(channel.isCompleted()).toBe(false);
    expect(channel.env).toEqual({});
    channel.markCompleted();
    expect(channel.isCompleted()).toBe(true);
    channel.close();
    channel.markCompleted();
    expect(channel.isCompleted()).toBe(true);
  });
});
