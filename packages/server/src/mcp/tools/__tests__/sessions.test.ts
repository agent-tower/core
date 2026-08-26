import { describe, expect, it, vi } from 'vitest';
import { registerSessionTools } from '../sessions.js';

function createServerMock() {
  const handlers = new Map<string, (params: any) => Promise<any>>();
  return {
    handlers,
    server: {
      tool: vi.fn((name: string, _description: string, _shape: unknown, handler: (params: any) => Promise<any>) => {
        handlers.set(name, handler);
      }),
    },
  };
}

describe('session MCP tools', () => {
  it('preserves a TeamRun direct-send admission rejection', async () => {
    const { server, handlers } = createServerMock();
    const client = {
      sendMessage: vi.fn(async () => {
        throw new Error('[SESSION_NOT_ADMITTED] TeamRun follow-up requires the current invocation identity');
      }),
      stopSession: vi.fn(),
    };
    registerSessionTools(server as any, client as any);

    const result = await handlers.get('send_message')!({
      session_id: 'session-1',
      message: 'late follow-up',
    });

    expect(client.sendMessage).toHaveBeenCalledWith('session-1', 'late follow-up');
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('SESSION_NOT_ADMITTED');
  });
});
