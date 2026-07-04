/**
 * 工作空间相关 MCP tools
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TeamMemberCapabilities } from '@agent-tower/shared';
import type { AgentTowerClient } from '../http-client.js';
import type { McpContext } from '../context.js';
import {
  StartWorkspaceSessionInput,
  GetWorkspaceDiffInput,
  MergeWorkspaceInput,
  ListMergeableWorkspacesInput,
  MergeAllMemberWorkspacesInput,
  RecordReviewVerdictInput,
  ReportTestResultInput,
} from '../types.js';

type TeamMemberCapabilityName = keyof TeamMemberCapabilities;

export interface WorkspaceToolAuth {
  resolveBoundTeamRunId(context?: McpContext | null): string | undefined;
  requireCurrentMemberCapabilities(
    client: AgentTowerClient,
    context: McpContext | null,
    teamRunId: string,
    requiredCapabilities: TeamMemberCapabilityName[]
  ): Promise<string>;
}

function requireBoundTeamRunId(
  context: McpContext | null,
  auth: WorkspaceToolAuth,
  toolName: string
): string {
  const teamRunId = auth.resolveBoundTeamRunId(context);
  if (!teamRunId) {
    throw new Error(`${toolName} requires a TeamRun agent session.`);
  }
  return teamRunId;
}

function requireBoundTeamRunInvocation(context: McpContext | null, teamRunId: string): void {
  if (
    process.env.AGENT_TOWER_TEAM_RUN_ID === teamRunId
    && process.env.AGENT_TOWER_INVOCATION_ID
  ) {
    return;
  }

  if (context?.teamRunId === teamRunId && context.invocationId) {
    return;
  }

  throw new Error('A valid TeamRun agent invocation identity is required for this tool.');
}

export function registerWorkspaceTools(
  server: McpServer,
  client: AgentTowerClient,
  context: McpContext | null = null,
  auth?: WorkspaceToolAuth
) {
  server.tool(
    'start_workspace_session',
    'Create a workspace and start an AI agent session for a task.',
    StartWorkspaceSessionInput.shape,
    async (params) => {
      try {
        // 1. 创建工作空间
        const workspace = await client.createWorkspace(params.task_id, {
          workspaceKind: params.mode === 'main_directory' ? 'MAIN_DIRECTORY' : 'WORKTREE',
        });
        // 2. 创建会话
        const session = await client.createSession(
          workspace.id,
          params.prompt,
          params.provider_id
        );
        // 3. 启动会话
        await client.startSession(session.id);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              task_id: params.task_id,
              workspace_id: workspace.id,
              session_id: session.id,
              mode: params.mode ?? 'worktree',
            }, null, 2),
          }],
        };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_workspace_diff',
    'Get the code diff for a workspace.',
    GetWorkspaceDiffInput.shape,
    async (params) => {
      try {
        const result = await client.getWorkspaceDiff(params.workspace_id);
        return { content: [{ type: 'text', text: result.diff || '(no changes)' }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'merge_workspace',
    'Merge a workspace branch into the main branch.',
    MergeWorkspaceInput.shape,
    async (params) => {
      try {
        if (auth) {
          const teamRunId = auth.resolveBoundTeamRunId(context);
          if (teamRunId) {
            await auth.requireCurrentMemberCapabilities(client, context, teamRunId, ['mergeWorkspace']);
          }
        }
        const result = await client.mergeWorkspace(params.workspace_id);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'list_mergeable_workspaces',
    'List TeamRun dedicated member workspaces with merge readiness, blockers, review/test verdicts, and git/activity status.',
    ListMergeableWorkspacesInput.shape,
    async () => {
      try {
        if (!auth) {
          throw new Error('list_mergeable_workspaces is unavailable without TeamRun auth.');
        }
        const teamRunId = requireBoundTeamRunId(context, auth, 'list_mergeable_workspaces');
        await auth.requireCurrentMemberCapabilities(client, context, teamRunId, ['readDiff']);
        const result = await client.listMergeableWorkspaces(teamRunId);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'merge_all_member_workspaces',
    'Merge all merge-ready TeamRun dedicated member workspaces into the TeamRun main workspace. Returns structured per-workspace results.',
    MergeAllMemberWorkspacesInput.shape,
    async (params) => {
      try {
        if (!auth) {
          throw new Error('merge_all_member_workspaces is unavailable without TeamRun auth.');
        }
        const teamRunId = requireBoundTeamRunId(context, auth, 'merge_all_member_workspaces');
        requireBoundTeamRunInvocation(context, teamRunId);
        await auth.requireCurrentMemberCapabilities(client, context, teamRunId, ['mergeWorkspace']);
        const result = await client.mergeAllMemberWorkspaces(teamRunId, {
          workspaceIds: params.workspace_ids,
          dryRun: params.dry_run,
          stopOnConflict: params.stop_on_conflict,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'record_review_verdict',
    'Record a TeamRun workspace review verdict bound to the workspace HEAD SHA.',
    RecordReviewVerdictInput.shape,
    async (params) => {
      try {
        if (!auth) {
          throw new Error('record_review_verdict is unavailable without TeamRun auth.');
        }
        const teamRunId = requireBoundTeamRunId(context, auth, 'record_review_verdict');
        await auth.requireCurrentMemberCapabilities(client, context, teamRunId, ['readDiff']);
        const result = await client.recordWorkspaceVerdict(params.workspace_id, {
          kind: 'REVIEW',
          verdict: params.verdict,
          reviewedSha: params.reviewed_sha,
          reason: params.reason,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'report_test_result',
    'Record a TeamRun workspace test result bound to the workspace HEAD SHA.',
    ReportTestResultInput.shape,
    async (params) => {
      try {
        if (!auth) {
          throw new Error('report_test_result is unavailable without TeamRun auth.');
        }
        const teamRunId = requireBoundTeamRunId(context, auth, 'report_test_result');
        await auth.requireCurrentMemberCapabilities(client, context, teamRunId, ['runCommands']);
        const result = await client.recordWorkspaceVerdict(params.workspace_id, {
          kind: 'TEST',
          verdict: params.verdict,
          reviewedSha: params.reviewed_sha,
          reason: params.reason,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  );
}
