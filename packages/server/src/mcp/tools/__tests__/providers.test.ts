import { describe, expect, it, vi } from 'vitest';
import { registerProviderTools } from '../providers.js';

describe('provider MCP tools', () => {
  it('only exposes enabled and legacy configurations in the provider selection list', async () => {
    let handler: (() => Promise<any>) | undefined;
    const server = {
      tool: vi.fn((_name: string, _description: string, _shape: unknown, callback: () => Promise<any>) => {
        handler = callback;
      }),
    };
    const entries = [
      { provider: { id: 'enabled', enabled: true }, availability: { type: 'INSTALLED' } },
      { provider: { id: 'legacy' }, availability: { type: 'NOT_FOUND' } },
      { provider: { id: 'disabled', enabled: false }, availability: { type: 'INSTALLED' } },
    ];
    const client = { listProviders: vi.fn(async () => entries) };
    registerProviderTools(server as any, client as any);

    const result = await handler!();
    expect(JSON.parse(result.content[0].text)).toEqual(entries.slice(0, 2));
  });
});
