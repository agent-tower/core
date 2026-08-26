import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentTowerApiError, AgentTowerClient } from './http-client.js';

describe('AgentTowerClient workspace services', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('URL-encodes the bound workspace and service names', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'service-1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new AgentTowerClient('http://127.0.0.1:12580');

    await client.startWorkspaceService('workspace/one', 'web dev', { command: 'pnpm', args: ['dev'] });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:12580/api/workspaces/workspace%2Fone/services/web%20dev',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('preserves structured REST status and code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'wrong workspace',
      code: 'INVOCATION_WORKSPACE_MISMATCH',
    }), { status: 403 })));
    const client = new AgentTowerClient('http://127.0.0.1:12580');

    await expect(client.listWorkspaceServices('workspace-1')).rejects.toEqual(
      expect.objectContaining<Partial<AgentTowerApiError>>({
        status: 403,
        code: 'INVOCATION_WORKSPACE_MISMATCH',
        apiMessage: 'wrong workspace',
        message: '[INVOCATION_WORKSPACE_MISMATCH] wrong workspace',
      }),
    );
  });

  it('sends the internal token with bound Solo or TeamRun identities', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ services: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new AgentTowerClient('http://127.0.0.1:12580');
    client.setInternalApiToken('internal-token');
    client.setSessionId('session-1');
    client.setInvocationId('invocation-1');

    await client.listWorkspaceServices('workspace-1');

    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({
        'x-agent-tower-internal-token': 'internal-token',
        'x-agent-tower-session-id': 'session-1',
        'x-agent-tower-invocation-id': 'invocation-1',
      }),
    }));
  });

  it('carries the bound invocation identity through sessions.send_message', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new AgentTowerClient('http://127.0.0.1:12580');
    client.setInternalApiToken('internal-token');
    client.setSessionId('session-1');
    client.setInvocationId('invocation-1');

    await client.sendMessage('session-1', 'continue');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:12580/api/sessions/session-1/message',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-agent-tower-internal-token': 'internal-token',
          'x-agent-tower-session-id': 'session-1',
          'x-agent-tower-invocation-id': 'invocation-1',
        }),
      }),
    );
  });

  it('prefers a bound Agent credential over the global internal token', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ services: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new AgentTowerClient('http://127.0.0.1:12580');
    client.setInternalApiToken('internal-token');
    client.setAgentApiCredential('agent-credential');

    await client.listWorkspaceServices('workspace-1');

    expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      headers: expect.objectContaining({
        'x-agent-tower-agent-credential': 'agent-credential',
      }),
    }));
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty('x-agent-tower-internal-token');
  });
});
