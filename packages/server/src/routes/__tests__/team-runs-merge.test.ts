import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { ServiceError } from '../../errors.js';
import { teamRunRoutes } from '../team-runs.js';

function buildWorkspaceService(overrides: Record<string, unknown> = {}) {
  return {
    listTeamRunMergeableWorkspaces: vi.fn(async (teamRunId: string) => ({
      teamRunId,
      taskId: 'task-1',
      projectId: 'project-1',
      mainWorkspace: {
        id: 'main-workspace',
        branchName: 'team-main',
        status: 'ACTIVE',
        hasActiveWriteSession: false,
      },
      generatedAt: '2026-01-01T00:00:00.000Z',
      workspaces: [],
    })),
    resolveInvocationMemberForTeamRun: vi.fn(async () => ({
      teamRunId: 'team-run-1',
      memberId: 'member-from-invocation',
      invocationId: 'invocation-1',
    })),
    mergeTeamRunMembers: vi.fn(async () => ({
      teamRunId: 'team-run-1',
      taskId: 'task-1',
      projectId: 'project-1',
      mainWorkspaceId: 'main-workspace',
      dryRun: false,
      stopOnConflict: false,
      summary: {
        requested: 0,
        considered: 0,
        merged: 0,
        alreadyMerged: 0,
        wouldMerge: 0,
        skipped: 0,
        conflicts: 0,
        failed: 0,
      },
      results: [],
    })),
    ...overrides,
  };
}

async function buildTestApp(workspaceService: ReturnType<typeof buildWorkspaceService>) {
  const app = Fastify();
  await app.register(teamRunRoutes, {
    prefix: '/api',
    workspaceService: workspaceService as any,
  });
  return app;
}

describe('TeamRun merge routes', () => {
  it('returns mergeable workspace readiness envelope', async () => {
    const workspaceService = buildWorkspaceService();
    const app = await buildTestApp(workspaceService);

    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/team-runs/team-run-1/mergeable-workspaces',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        teamRunId: 'team-run-1',
        taskId: 'task-1',
        projectId: 'project-1',
        mainWorkspace: { id: 'main-workspace' },
        workspaces: [],
      });
      expect(workspaceService.listTeamRunMergeableWorkspaces).toHaveBeenCalledWith('team-run-1');
    } finally {
      await app.close();
    }
  });

  it('uses invocation identity for batch merge and ignores client member identity', async () => {
    const workspaceService = buildWorkspaceService();
    const app = await buildTestApp(workspaceService);

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/team-runs/team-run-1/merge-members',
        headers: {
          'x-agent-tower-invocation-id': 'invocation-1',
        },
        payload: {
          workspaceIds: ['workspace-1'],
          dryRun: true,
          requesterMemberId: 'client-forged-member',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(workspaceService.resolveInvocationMemberForTeamRun).toHaveBeenCalledWith('team-run-1', 'invocation-1');
      expect(workspaceService.mergeTeamRunMembers).toHaveBeenCalledWith('team-run-1', expect.objectContaining({
        workspaceIds: ['workspace-1'],
        dryRun: true,
        invocationId: 'invocation-1',
        requesterMemberId: 'member-from-invocation',
      }));
    } finally {
      await app.close();
    }
  });

  it('preserves explicit empty workspaceIds for batch merge', async () => {
    const workspaceService = buildWorkspaceService();
    const app = await buildTestApp(workspaceService);

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/team-runs/team-run-1/merge-members',
        headers: {
          'x-agent-tower-invocation-id': 'invocation-1',
        },
        payload: {
          workspaceIds: [],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(workspaceService.mergeTeamRunMembers).toHaveBeenCalledWith('team-run-1', expect.objectContaining({
        workspaceIds: [],
        invocationId: 'invocation-1',
        requesterMemberId: 'member-from-invocation',
      }));
    } finally {
      await app.close();
    }
  });

  it('returns 403 when batch merge service rejects missing or invalid invocation', async () => {
    const workspaceService = buildWorkspaceService({
      resolveInvocationMemberForTeamRun: vi.fn(async () => null),
      mergeTeamRunMembers: vi.fn(async () => {
        throw new ServiceError(
          'TeamRun member merge requires an agent invocation identity',
          'TEAM_RUN_MERGE_INVOCATION_REQUIRED',
          403
        );
      }),
    });
    const app = await buildTestApp(workspaceService);

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/team-runs/team-run-1/merge-members',
        payload: {},
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        code: 'TEAM_RUN_MERGE_INVOCATION_REQUIRED',
      });
    } finally {
      await app.close();
    }
  });
});
