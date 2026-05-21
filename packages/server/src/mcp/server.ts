/**
 * MCP 服务器创建与 tool 注册
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AgentTowerClient } from './http-client.js';
import { fetchContext, type McpContext } from './context.js';
import { registerProjectTools } from './tools/projects.js';
import { registerTaskTools } from './tools/tasks.js';
import { registerProviderTools } from './tools/providers.js';
import { registerWorkspaceTools } from './tools/workspaces.js';
import { registerSessionTools } from './tools/sessions.js';

const RoomMessageMentionInput = z.object({
  memberId: z.string().min(1).describe('The target TeamMember ID to mention.'),
  label: z.string().optional().describe('Optional display label for the mention.'),
  ifBusy: z.enum(['queue', 'cancel_current_and_start']).optional()
    .describe("How to handle the target member if busy: 'queue' or 'cancel_current_and_start'."),
  cancelQueued: z.boolean().optional().describe('Whether to cancel queued requests for the same target member.'),
});

const PostRoomMessageInput = z.object({
  team_run_id: z.string().min(1).optional().describe('TeamRun ID. Optional inside a TeamRun agent session.'),
  content: z.string().min(1).describe('Room message content.'),
  mentions: z.array(RoomMessageMentionInput).optional()
    .describe('Mentioned members. Non-empty mentions create WorkRequests via the existing room message API.'),
  attachmentIds: z.array(z.string().min(1)).optional().describe('Attachment IDs to associate with the message.'),
  artifactRefs: z.array(z.string().min(1)).optional().describe('Artifact references to associate with the message.'),
  kind: z.enum(['chat', 'work_request', 'artifact', 'review', 'decision', 'system']).optional()
    .describe('Optional room message kind.'),
});

const ListRoomMessagesInput = z.object({
  team_run_id: z.string().min(1).optional().describe('TeamRun ID. Optional inside a TeamRun agent session.'),
  limit: z.number().int().min(1).max(200).optional().describe('Return only the last N messages.'),
});

const WorkRequestControlInput = z.object({
  work_request_id: z.string().min(1).describe('WorkRequest ID.'),
});

const StopMemberWorkInput = z.object({
  team_run_id: z.string().min(1).optional().describe('TeamRun ID. Optional inside a TeamRun agent session.'),
  member_id: z.string().min(1).describe('TeamMember ID whose current work should be stopped.'),
  cancel_queued: z.boolean().optional().describe('Whether to cancel queued/pending WorkRequests for this member.'),
});

function resolveTeamRunId(explicitTeamRunId?: string): string {
  const teamRunId = process.env.AGENT_TOWER_TEAM_RUN_ID || explicitTeamRunId;
  if (!teamRunId) {
    throw new Error('team_run_id is required outside a TeamRun agent session.');
  }
  return teamRunId;
}

function registerTeamRoomTools(server: McpServer, client: AgentTowerClient): void {
  server.tool(
    'post_room_message',
    'Post a TeamRun room message. Mentions create WorkRequests through the existing RoomMessage flow.',
    PostRoomMessageInput.shape,
    async (params) => {
      try {
        const teamRunId = resolveTeamRunId(params.team_run_id);
        const invocationId = process.env.AGENT_TOWER_INVOCATION_ID;
        const memberId = process.env.AGENT_TOWER_MEMBER_ID;
        const message = await client.createRoomMessage(teamRunId, {
          content: params.content,
          mentions: params.mentions,
          attachmentIds: params.attachmentIds,
          artifactRefs: params.artifactRefs,
          kind: params.kind,
          ...(invocationId || memberId
            ? {
              senderType: 'agent',
              senderId: memberId ?? null,
              senderInvocationId: invocationId ?? null,
            }
            : {}),
        });
        return { content: [{ type: 'text', text: JSON.stringify(message, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'list_room_messages',
    'List TeamRun room messages. Uses the current TeamRun session env when available.',
    ListRoomMessagesInput.shape,
    async (params) => {
      try {
        const teamRunId = resolveTeamRunId(params.team_run_id);
        const messages = await client.listRoomMessages(teamRunId);
        const limited = params.limit ? messages.slice(-params.limit) : messages;
        return { content: [{ type: 'text', text: JSON.stringify(limited, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'approve_work_request',
    'Approve a pending TeamRun WorkRequest, queue it, and try to start the next eligible work.',
    WorkRequestControlInput.shape,
    async (params) => {
      try {
        const result = await client.approveWorkRequest(params.work_request_id);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'reject_work_request',
    'Reject a pending TeamRun WorkRequest without starting any invocation.',
    WorkRequestControlInput.shape,
    async (params) => {
      try {
        const result = await client.rejectWorkRequest(params.work_request_id);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'cancel_work_request',
    'Cancel a pending or queued TeamRun WorkRequest.',
    WorkRequestControlInput.shape,
    async (params) => {
      try {
        const result = await client.cancelWorkRequest(params.work_request_id);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'stop_member_work',
    'Stop a TeamRun member current work and optionally cancel queued/pending work for that member.',
    StopMemberWorkInput.shape,
    async (params) => {
      try {
        const teamRunId = resolveTeamRunId(params.team_run_id);
        const result = await client.stopMemberWork(teamRunId, params.member_id, {
          cancelQueued: params.cancel_queued,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  );
}

export async function createMcpServer(baseUrl: string): Promise<McpServer> {
  const client = new AgentTowerClient(baseUrl);
  const context = await fetchContext(client);

  const server = new McpServer({
    name: 'agent-tower',
    version: '0.1.0',
  });

  // 注册所有 tools
  registerProjectTools(server, client);
  registerTaskTools(server, client);
  registerProviderTools(server, client);
  registerWorkspaceTools(server, client);
  registerSessionTools(server, client);
  registerTeamRoomTools(server, client);

  // 条件注册 get_context（仅当检测到工作空间上下文时）
  if (context) {
    server.tool(
      'get_context',
      'Get workspace context for the current directory (project, task, workspace info).',
      {},
      async () => {
        return { content: [{ type: 'text', text: JSON.stringify(context, null, 2) }] };
      }
    );
    console.error(`[agent-tower-mcp] Context loaded: project=${context.projectName}, task=${context.taskTitle}`);
  }

  return server;
}
