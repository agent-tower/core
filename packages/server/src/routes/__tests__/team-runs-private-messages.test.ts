import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { teamRunRoutes } from '../team-runs.js';

function buildTeamRunService(overrides: Record<string, unknown> = {}) {
  return {
    createPrivateRoomMessage: vi.fn(async (_teamRunId: string, input: any) => ({
      id: 'message-1',
      teamRunId: 'team-run-1',
      senderType: input.senderType,
      senderId: input.senderId ?? null,
      senderInvocationId: input.senderInvocationId ?? null,
      kind: 'work_request',
      visibility: 'PRIVATE',
      content: input.content,
      mentions: [],
      workRequestIds: ['work-request-1'],
      artifactRefs: [],
      attachmentIds: [],
      recipientMemberIds: input.recipientMemberIds,
      participantMemberIds: input.recipientMemberIds,
      participants: [],
      createdAt: '2026-01-01T00:00:00.000Z',
    })),
    getTeamRunById: vi.fn(async () => ({
      id: 'team-run-1',
      mode: 'CONFIRM',
    })),
    resolveAgentInvocationIdentity: vi.fn(async () => null),
    ...overrides,
  };
}

async function buildTestApp(service: ReturnType<typeof buildTeamRunService>) {
  const app = Fastify();
  await app.register(teamRunRoutes, {
    prefix: '/api',
    service: service as any,
    scheduler: {
      startNextSessions: vi.fn(),
      approveWorkRequestAndStartNext: vi.fn(),
      rejectWorkRequest: vi.fn(),
      cancelWorkRequest: vi.fn(),
      stopMemberWork: vi.fn(),
    } as any,
    workspaceService: {} as any,
  });
  return app;
}

describe('TeamRun private message routes', () => {
  it('passes target commit metadata to the TeamRun service', async () => {
    const service = buildTeamRunService();
    const app = await buildTestApp(service);
    const target = {
      kind: 'WORKSPACE_COMMIT',
      purpose: 'TEST',
      sourceWorkspaceId: 'source-workspace-1',
      headSha: 'a'.repeat(40),
      branchName: 'feature/source',
      planItemId: 'plan-1',
    };

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/team-runs/team-run-1/private-messages',
        payload: {
          content: 'Run targeted tests',
          recipientMemberIds: ['tester-1'],
          target,
        },
      });

      expect(response.statusCode).toBe(201);
      expect(service.createPrivateRoomMessage).toHaveBeenCalledWith(
        'team-run-1',
        expect.objectContaining({
          content: 'Run targeted tests',
          recipientMemberIds: ['tester-1'],
          target,
        })
      );
    } finally {
      await app.close();
    }
  });
});
