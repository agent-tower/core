import Fastify from 'fastify';
import { AgentType, RuntimeType } from '@agent-tower/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceError, ValidationError } from '../../errors.js';
import { INTERNAL_API_INVOCATION_ID_HEADER } from '../../utils/internal-api-token.js';

const { findWorkspace, findSession, createSession, getRuntimeState, resolveRuntimePermission, getProviderById, stopSession, sendMessage } = vi.hoisted(() => ({
  findWorkspace: vi.fn(),
  findSession: vi.fn(),
  createSession: vi.fn(),
  getRuntimeState: vi.fn(),
  resolveRuntimePermission: vi.fn(),
  getProviderById: vi.fn(),
  stopSession: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock('../../core/container.js', () => ({
  getSessionManager: () => ({
    create: createSession,
    getRuntimeState,
    resolveRuntimePermission,
    sendMessage,
  }),
}));

vi.mock('../../utils/index.js', () => ({
  prisma: {
    workspace: { findUnique: findWorkspace },
    session: { findUnique: findSession },
  },
}));

vi.mock('../../executors/index.js', () => ({ getProviderById }));
vi.mock('../../services/team-scheduler.service.js', () => ({
  TeamSchedulerService: class {
    stopSession = stopSession;
  },
}));

import { sessionRoutes } from '../sessions.js';

async function buildTestApp(options: { internalAuth?: boolean } = {}) {
  const app = Fastify();
  if (options.internalAuth) {
    app.addHook('onRequest', async (request) => {
      request.agentTowerAuthKind = 'internal';
    });
  }
  await app.register(sessionRoutes, { prefix: '/api' });
  return app;
}

describe('session runtime routes', () => {
  beforeEach(() => {
    findWorkspace.mockReset();
    findSession.mockReset();
    createSession.mockReset();
    getRuntimeState.mockReset();
    resolveRuntimePermission.mockReset();
    getProviderById.mockReset();
    stopSession.mockReset();
    sendMessage.mockReset();
  });

  it('maps an unsupported Agent runtime combination to a validation response', async () => {
    const app = await buildTestApp();
    findWorkspace.mockResolvedValue({
      id: 'workspace-1',
      task: {
        deletedAt: null,
        project: { name: 'Project', archivedAt: null, repoDeletedAt: null },
      },
    });
    createSession.mockRejectedValue(
      new ValidationError("Agent 'QWEN_CODE' does not support the 'CLI' runtime"),
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/workspaces/workspace-1/sessions',
      payload: { agentType: AgentType.QWEN_CODE, prompt: 'run qwen' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: "Agent 'QWEN_CODE' does not support the 'CLI' runtime",
      code: 'VALIDATION_ERROR',
    });
    await app.close();
  });

  it('returns the authoritative runtime state using the persisted runtime type', async () => {
    const app = await buildTestApp();
    findSession.mockResolvedValue({ id: 'session-1', runtimeType: RuntimeType.ACP });
    getRuntimeState.mockReturnValue({
      sessionId: 'session-1',
      runtimeType: RuntimeType.ACP,
      turnState: 'AWAITING_PERMISSION',
      capabilities: { loadSession: true, terminalInput: false, terminalResize: false, permissions: true },
      pendingPermissions: [],
    });

    const response = await app.inject({ method: 'GET', url: '/api/sessions/session-1/runtime' });

    expect(response.statusCode).toBe(200);
    expect(getRuntimeState).toHaveBeenCalledWith('session-1', RuntimeType.ACP);
    expect(response.json()).toMatchObject({ runtimeType: RuntimeType.ACP, turnState: 'AWAITING_PERMISSION' });
    await app.close();
  });

  it('resolves only a currently active permission decision', async () => {
    const app = await buildTestApp();
    findSession.mockResolvedValue({ id: 'session-1' });
    resolveRuntimePermission.mockResolvedValue(undefined);

    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-1/permissions/permission-1/resolve',
      payload: { optionId: 'allow-once' },
    });

    expect(response.statusCode).toBe(200);
    expect(resolveRuntimePermission).toHaveBeenCalledWith('session-1', 'permission-1', 'allow-once');
    await app.close();
  });

  it('returns conflict when a permission request is stale', async () => {
    const app = await buildTestApp();
    findSession.mockResolvedValue({ id: 'session-1' });
    resolveRuntimePermission.mockRejectedValue(new Error('Permission request is no longer active'));

    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-1/permissions/permission-1/resolve',
      payload: { optionId: 'allow-once' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'Permission request is no longer active' });
    await app.close();
  });

  it('routes direct session stop through the TeamRun scheduler admission boundary', async () => {
    const app = await buildTestApp();
    stopSession.mockResolvedValue({ id: 'session-1' });

    const response = await app.inject({ method: 'POST', url: '/api/sessions/session-1/stop' });

    expect(response.statusCode).toBe(200);
    expect(stopSession).toHaveBeenCalledWith('session-1');
    await app.close();
  });

  it('maps a rejected TeamRun direct follow-up without turning it into a 500', async () => {
    const app = await buildTestApp();
    findSession.mockResolvedValue({
      id: 'session-1',
      workspace: {
        task: {
          deletedAt: null,
          project: { name: 'Project', archivedAt: null, repoDeletedAt: null },
        },
      },
      conversation: null,
    });
    sendMessage.mockRejectedValue(new ServiceError(
      'TeamRun follow-up requires the current invocation identity',
      'SESSION_NOT_ADMITTED',
      409,
    ));

    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-1/message',
      payload: { message: 'late follow-up' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'TeamRun follow-up requires the current invocation identity',
      code: 'SESSION_NOT_ADMITTED',
    });
    await app.close();
  });

  it('passes a trusted internal invocation identity to direct follow-up admission', async () => {
    const app = await buildTestApp({ internalAuth: true });
    findSession.mockResolvedValue({
      id: 'session-1',
      workspace: {
        task: {
          deletedAt: null,
          project: { name: 'Project', archivedAt: null, repoDeletedAt: null },
        },
      },
      conversation: null,
    });
    sendMessage.mockResolvedValue({ id: 'session-1' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions/session-1/message',
      headers: { [INTERNAL_API_INVOCATION_ID_HEADER]: 'invocation-1' },
      payload: { message: 'continue' },
    });

    expect(response.statusCode).toBe(200);
    expect(sendMessage).toHaveBeenCalledWith('session-1', 'continue', undefined, 'invocation-1');
    await app.close();
  });
});
