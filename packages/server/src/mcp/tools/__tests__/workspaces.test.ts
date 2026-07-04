import { describe, expect, it, vi } from 'vitest';
import { registerWorkspaceTools } from '../workspaces.js';

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

describe('workspace MCP tools', () => {
  it('lists mergeable workspaces with readDiff capability', async () => {
    const { server, handlers } = createServerMock();
    const client = {
      listMergeableWorkspaces: vi.fn(async () => ({ teamRunId: 'team-run-1', workspaces: [] })),
    };
    const auth = {
      resolveBoundTeamRunId: vi.fn(() => 'team-run-1'),
      requireCurrentMemberCapabilities: vi.fn(async () => 'member-1'),
    };

    registerWorkspaceTools(server as any, client as any, { teamRunId: 'team-run-1', invocationId: 'invocation-1' } as any, auth);
    const result = await handlers.get('list_mergeable_workspaces')!({});

    expect(auth.requireCurrentMemberCapabilities).toHaveBeenCalledWith(
      client,
      { teamRunId: 'team-run-1', invocationId: 'invocation-1' },
      'team-run-1',
      ['readDiff']
    );
    expect(client.listMergeableWorkspaces).toHaveBeenCalledWith('team-run-1');
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({ teamRunId: 'team-run-1' });
  });

  it('merges all member workspaces with mergeWorkspace capability', async () => {
    const { server, handlers } = createServerMock();
    const client = {
      mergeAllMemberWorkspaces: vi.fn(async () => ({ teamRunId: 'team-run-1', results: [] })),
    };
    const auth = {
      resolveBoundTeamRunId: vi.fn(() => 'team-run-1'),
      requireCurrentMemberCapabilities: vi.fn(async () => 'member-1'),
    };

    registerWorkspaceTools(server as any, client as any, { teamRunId: 'team-run-1', invocationId: 'invocation-1' } as any, auth);
    const result = await handlers.get('merge_all_member_workspaces')!({
      workspace_ids: ['workspace-1'],
      dry_run: true,
      stop_on_conflict: true,
    });

    expect(auth.requireCurrentMemberCapabilities).toHaveBeenCalledWith(
      client,
      { teamRunId: 'team-run-1', invocationId: 'invocation-1' },
      'team-run-1',
      ['mergeWorkspace']
    );
    expect(client.mergeAllMemberWorkspaces).toHaveBeenCalledWith('team-run-1', {
      workspaceIds: ['workspace-1'],
      dryRun: true,
      stopOnConflict: true,
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({ teamRunId: 'team-run-1' });
  });

  it('rejects merge_all_member_workspaces without an invocation identity', async () => {
    const { server, handlers } = createServerMock();
    const client = {
      mergeAllMemberWorkspaces: vi.fn(),
    };
    const auth = {
      resolveBoundTeamRunId: vi.fn(() => 'team-run-1'),
      requireCurrentMemberCapabilities: vi.fn(async () => 'member-1'),
    };

    registerWorkspaceTools(server as any, client as any, { teamRunId: 'team-run-1' } as any, auth);
    const result = await handlers.get('merge_all_member_workspaces')!({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('valid TeamRun agent invocation identity');
    expect(auth.requireCurrentMemberCapabilities).not.toHaveBeenCalled();
    expect(client.mergeAllMemberWorkspaces).not.toHaveBeenCalled();
  });
});
