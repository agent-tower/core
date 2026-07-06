/**
 * MCP 服务器创建与 tool 注册
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { TeamMemberCapabilities } from '@agent-tower/shared';
import { AgentTowerClient } from './http-client.js';
import { fetchContext, type McpContext } from './context.js';
import { registerProjectTools } from './tools/projects.js';
import { registerTaskTools } from './tools/tasks.js';
import { registerProviderTools } from './tools/providers.js';
import { registerWorkspaceTools } from './tools/workspaces.js';
import { registerSessionTools } from './tools/sessions.js';

type McpRoomMessage = Record<string, unknown>;
type McpTeamMemberSummary = { id: string; name?: string };

function getStringField(value: Record<string, unknown>, field: string): string | undefined {
  const raw = value[field];
  return typeof raw === 'string' ? raw : undefined;
}

function formatMcpRoomMessageSender(
  message: McpRoomMessage,
  memberById: Map<string, McpTeamMemberSummary>
) {
  const senderType = getStringField(message, 'senderType') ?? 'unknown';
  const senderId = getStringField(message, 'senderId');
  if (!senderId) {
    return { type: senderType };
  }

  const member = memberById.get(senderId);
  if (!member) {
    return { type: senderType };
  }

  return {
    type: senderType,
    memberId: senderId,
    ...(member.name ? { name: member.name } : {}),
  };
}

function serializeMcpRoomMessageListItem(
  message: McpRoomMessage,
  memberById: Map<string, McpTeamMemberSummary>
): Record<string, unknown> {
  const output: Record<string, unknown> = {
    id: getStringField(message, 'id'),
    createdAt: getStringField(message, 'createdAt'),
    kind: getStringField(message, 'kind'),
    sender: formatMcpRoomMessageSender(message, memberById),
    content: getStringField(message, 'content') ?? '',
    fullContentAvailable: message.fullContentAvailable === true,
    mentions: Array.isArray(message.mentions) ? message.mentions : [],
  };

  if (Array.isArray(message.workRequestIds) && message.workRequestIds.length > 0) {
    output.workRequestIds = message.workRequestIds;
  }
  if (Array.isArray(message.artifactRefs) && message.artifactRefs.length > 0) {
    output.artifactRefs = message.artifactRefs;
  }
  if (Array.isArray(message.attachmentIds) && message.attachmentIds.length > 0) {
    output.attachmentIds = message.attachmentIds;
  }

  return output;
}

const RoomMessageMentionInput = z.object({
  memberId: z.string().min(1).describe('The target TeamMember ID to mention.'),
  label: z.string().optional().describe('Optional display label for the mention.'),
  ifBusy: z.enum(['queue', 'cancel_current_and_start']).optional()
    .describe("How to handle the target member if busy: 'queue' or 'cancel_current_and_start'."),
  cancelQueued: z.boolean().optional().describe('Whether to cancel queued requests for the same target member.'),
  target: z.object({
    kind: z.literal('WORKSPACE_COMMIT').describe('Bind this WorkRequest to a workspace commit.'),
    purpose: z.enum(['REVIEW', 'TEST']).describe('Whether the target is for review or test execution.'),
    sourceWorkspaceId: z.string().min(1).describe('Workspace whose commit should be reviewed or tested.'),
    headSha: z.string().min(1).describe('Target commit SHA to prepare before the agent starts.'),
    branchName: z.string().min(1).describe('Source workspace branch name for display and validation context.'),
    planItemId: z.string().min(1).nullable().optional().describe('Optional plan item ID this handoff belongs to.'),
  }).nullable().optional().describe('Optional target commit payload for review/test handoff.'),
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

const PostPrivateMessageInput = z.object({
  team_run_id: z.string().min(1).optional().describe('TeamRun ID. Optional inside a TeamRun agent session.'),
  recipient_member_ids: z.array(z.string().min(1)).min(1).describe('TeamMember IDs that can see and respond to this private message.'),
  content: z.string().min(1).describe('Private message content. Recipients receive WorkRequests like normal room mentions.'),
  target: RoomMessageMentionInput.shape.target.describe('Optional target commit payload copied to each recipient WorkRequest.'),
  attachmentIds: z.array(z.string().min(1)).optional().describe('Attachment IDs to associate with the private message.'),
  artifactRefs: z.array(z.string().min(1)).optional().describe('Artifact references to associate with the private message.'),
  ifBusy: z.enum(['queue', 'cancel_current_and_start']).optional()
    .describe("How to handle each recipient if busy: 'queue' or 'cancel_current_and_start'."),
  cancelQueued: z.boolean().optional().describe('Whether to cancel queued requests for each recipient.'),
});

const ListRoomMessagesInput = z.object({
  team_run_id: z.string().min(1).optional().describe('TeamRun ID. Optional inside a TeamRun agent session.'),
  limit: z.number().int().min(1).max(200).optional().describe('Return only the last N messages.'),
});

const GetRoomMessageInput = z.object({
  team_run_id: z.string().min(1).optional().describe('TeamRun ID. Optional inside a TeamRun agent session.'),
  message_id: z.string().min(1).describe('RoomMessage ID.'),
});

const ListTeamMembersInput = z.object({
  team_run_id: z.string().min(1).optional().describe('TeamRun ID. Optional inside a TeamRun agent session.'),
});

const ListMemberWorkRequestsInput = z.object({
  team_run_id: z.string().min(1).optional().describe('TeamRun ID. Optional inside a TeamRun agent session.'),
});

const WorkRequestControlInput = z.object({
  work_request_id: z.string().min(1).describe('WorkRequest ID.'),
});

const CancelWorkRequestInput = WorkRequestControlInput.extend({
  team_run_id: z.string().min(1).optional().describe('TeamRun ID. Optional inside a TeamRun agent session.'),
});

const StopMemberWorkInput = z.object({
  team_run_id: z.string().min(1).optional().describe('TeamRun ID. Optional inside a TeamRun agent session.'),
  member_id: z.string().min(1).describe('TeamMember ID whose current work should be stopped.'),
  cancel_queued: z.boolean().optional().describe('Whether to cancel queued/pending WorkRequests for this member.'),
});

const TEAM_RUN_MISMATCH_ERROR = 'team_run_id does not match the current TeamRun session.';
type TeamMemberCapabilityName = keyof TeamMemberCapabilities;

function resolveBoundTeamRunId(context?: McpContext | null): string | undefined {
  return process.env.AGENT_TOWER_TEAM_RUN_ID ?? context?.teamRunId;
}

function resolveTeamRunId(explicitTeamRunId?: string, context?: McpContext | null): string {
  const boundTeamRunId = resolveBoundTeamRunId(context);
  if (boundTeamRunId) {
    if (explicitTeamRunId && explicitTeamRunId !== boundTeamRunId) {
      throw new Error(TEAM_RUN_MISMATCH_ERROR);
    }
    return boundTeamRunId;
  }

  if (!explicitTeamRunId) {
    throw new Error('team_run_id is required outside a TeamRun agent session.');
  }
  return explicitTeamRunId;
}

function resolveTeamRunAgentIdentity(context: McpContext | null, teamRunId: string): {
  memberId?: string;
  invocationId?: string;
} {
  if (
    process.env.AGENT_TOWER_TEAM_RUN_ID === teamRunId
    && process.env.AGENT_TOWER_MEMBER_ID
    && process.env.AGENT_TOWER_INVOCATION_ID
  ) {
    return {
      memberId: process.env.AGENT_TOWER_MEMBER_ID,
      invocationId: process.env.AGENT_TOWER_INVOCATION_ID,
    };
  }

  if (
    context?.teamRunId === teamRunId
    && context.memberId
    && context.invocationId
  ) {
    return {
      memberId: context.memberId,
      invocationId: context.invocationId,
    };
  }

  return {};
}

function resolveCurrentTeamMemberId(context: McpContext | null, teamRunId: string): string | null {
  if (process.env.AGENT_TOWER_TEAM_RUN_ID === teamRunId && process.env.AGENT_TOWER_MEMBER_ID) {
    return process.env.AGENT_TOWER_MEMBER_ID;
  }

  if (context?.teamRunId === teamRunId && context.memberId) {
    return context.memberId;
  }

  return null;
}

function requireCurrentTeamMemberId(context: McpContext | null, teamRunId: string): string {
  const memberId = resolveCurrentTeamMemberId(context, teamRunId);
  if (!memberId) {
    throw new Error('Current TeamRun member identity is required for this tool.');
  }
  return memberId;
}

async function requireCurrentMemberCapabilities(
  client: AgentTowerClient,
  context: McpContext | null,
  teamRunId: string,
  requiredCapabilities: TeamMemberCapabilityName[]
): Promise<string> {
  const memberId = requireCurrentTeamMemberId(context, teamRunId);
  const members = await client.listTeamMembers(teamRunId);
  const member = members.find((item) => item.id === memberId);
  if (!member) {
    throw new Error('Current TeamRun member was not found.');
  }
  if (member.membershipStatus === 'REMOVED') {
    throw new Error('Current TeamRun member has been removed.');
  }

  const missing = requiredCapabilities.filter((capability) => member.capabilities?.[capability] !== true);
  if (missing.length > 0) {
    throw new Error(`Current TeamRun member lacks required capabilities: ${missing.join(', ')}`);
  }

  return memberId;
}

async function requireCurrentActiveTeamMember(
  client: AgentTowerClient,
  context: McpContext | null,
  teamRunId: string
): Promise<string> {
  const memberId = requireCurrentTeamMemberId(context, teamRunId);
  const members = await client.listTeamMembers(teamRunId);
  const member = members.find((item) => item.id === memberId);
  if (!member) {
    throw new Error('Current TeamRun member was not found.');
  }
  if (member.membershipStatus === 'REMOVED') {
    throw new Error('Current TeamRun member has been removed.');
  }
  return memberId;
}

async function assertCurrentTeamMemberActiveIfPresent(
  client: AgentTowerClient,
  context: McpContext | null,
  teamRunId: string
): Promise<void> {
  const memberId = resolveCurrentTeamMemberId(context, teamRunId);
  if (!memberId) return;

  const members = await client.listTeamMembers(teamRunId);
  const member = members.find((item) => item.id === memberId);
  if (!member) {
    throw new Error('Current TeamRun member was not found.');
  }
  if (member.membershipStatus === 'REMOVED') {
    throw new Error('Current TeamRun member has been removed.');
  }
}

function formatTeamMembersForAgent(teamRunId: string, members: any[]) {
  const currentMemberId = process.env.AGENT_TOWER_TEAM_RUN_ID === teamRunId
    ? process.env.AGENT_TOWER_MEMBER_ID || null
    : null;

  return {
    teamRunId,
    currentMemberId,
    members: members
      .filter((member) => member.membershipStatus !== 'REMOVED')
      .map((member) => ({
      id: member.id,
      name: member.name,
      aliases: member.aliases ?? [],
      status: member.status,
      capabilities: member.capabilities,
      workspacePolicy: member.workspacePolicy,
      triggerPolicy: member.triggerPolicy,
      sessionPolicy: member.sessionPolicy,
      queueManagementPolicy: member.queueManagementPolicy,
      providerId: member.providerId,
    })),
  };
}

function registerTeamRoomTools(server: McpServer, client: AgentTowerClient, context: McpContext | null): void {
  server.tool(
    'post_room_message',
    'Post a TeamRun room message. Mentions create WorkRequests through the existing RoomMessage flow.',
    PostRoomMessageInput.shape,
    async (params) => {
      try {
        const teamRunId = resolveTeamRunId(params.team_run_id, context);
        await assertCurrentTeamMemberActiveIfPresent(client, context, teamRunId);
        const { invocationId, memberId } = resolveTeamRunAgentIdentity(context, teamRunId);
        const message = await client.createRoomMessage(teamRunId, {
          content: params.content,
          mentions: params.mentions,
          attachmentIds: params.attachmentIds,
          artifactRefs: params.artifactRefs,
          kind: params.kind,
          ...(invocationId && memberId
            ? {
              senderType: 'agent',
              senderId: memberId,
              senderInvocationId: invocationId,
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
    'post_private_message',
    'Post a TeamRun private message to selected members. Creates WorkRequests for recipients and is visible only to the sender/recipients in MCP; human host views can see all private messages.',
    PostPrivateMessageInput.shape,
    async (params) => {
      try {
        const teamRunId = resolveTeamRunId(params.team_run_id, context);
        const { invocationId, memberId } = resolveTeamRunAgentIdentity(context, teamRunId);
        if (!invocationId || !memberId) {
          throw new Error('Current TeamRun agent identity is required to post a private message.');
        }
        await requireCurrentMemberCapabilities(client, context, teamRunId, ['postRoomMessage', 'mentionMembers']);
        const message = await client.createPrivateRoomMessage(teamRunId, {
          content: params.content,
          recipientMemberIds: params.recipient_member_ids,
          target: params.target,
          attachmentIds: params.attachmentIds,
          artifactRefs: params.artifactRefs,
          ifBusy: params.ifBusy,
          cancelQueued: params.cancelQueued,
          senderType: 'agent',
          senderId: memberId,
          senderInvocationId: invocationId,
        });
        return { content: [{ type: 'text', text: JSON.stringify(message, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'list_room_messages',
    'List TeamRun room messages visible to the current TeamRun member. Returns compact list items for room context; use get_room_message with an item id for full message details.',
    ListRoomMessagesInput.shape,
    async (params) => {
      try {
        const teamRunId = resolveTeamRunId(params.team_run_id, context);
        const { invocationId, memberId } = resolveTeamRunAgentIdentity(context, teamRunId);
        if (!invocationId || !memberId) {
          throw new Error('Current TeamRun agent identity is required to list room messages.');
        }
        await requireCurrentMemberCapabilities(client, context, teamRunId, ['readRoom']);
        const [messages, members] = await Promise.all([
          client.listRoomMessages(teamRunId, { limit: params.limit }),
          client.listTeamMembers(teamRunId),
        ]);
        const memberById = new Map<string, McpTeamMemberSummary>(
          members
            .filter((member) => typeof member.id === 'string')
            .map((member) => [member.id, { id: member.id, name: member.name }])
        );
        const output = messages.map((message) => serializeMcpRoomMessageListItem(message, memberById));
        return { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'get_room_message',
    'Get a single TeamRun room message visible to the current TeamRun member, including full content when available.',
    GetRoomMessageInput.shape,
    async (params) => {
      try {
        const teamRunId = resolveTeamRunId(params.team_run_id, context);
        const { invocationId, memberId } = resolveTeamRunAgentIdentity(context, teamRunId);
        if (!invocationId || !memberId) {
          throw new Error('Current TeamRun agent identity is required to get a room message.');
        }
        await requireCurrentMemberCapabilities(client, context, teamRunId, ['readRoom']);
        const message = await client.getRoomMessage(teamRunId, params.message_id);
        return { content: [{ type: 'text', text: JSON.stringify(message, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'list_team_members',
    'List TeamRun members for assigning work. Returns member IDs for post_room_message mentions plus status, capabilities, workspace policy, trigger policy, session policy, queue management policy, and provider ID. Does not expose role prompts.',
    ListTeamMembersInput.shape,
    async (params) => {
      try {
        const teamRunId = resolveTeamRunId(params.team_run_id, context);
        await assertCurrentTeamMemberActiveIfPresent(client, context, teamRunId);
        const members = await client.listTeamMembers(teamRunId);
        const memberId = resolveCurrentTeamMemberId(context, teamRunId);
        const result = {
          ...formatTeamMembersForAgent(teamRunId, members),
          currentMemberId: memberId,
        };
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'list_member_work_requests',
    'List pending/queued TeamRun WorkRequests visible to the current member. Regular members see only requests targeting themselves; queue managers may see the TeamRun queue.',
    ListMemberWorkRequestsInput.shape,
    async (params) => {
      try {
        const teamRunId = resolveTeamRunId(params.team_run_id, context);
        const memberId = await requireCurrentActiveTeamMember(client, context, teamRunId);
        const result = await client.listMemberWorkRequests(teamRunId, memberId);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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
        const teamRunId = resolveTeamRunId(undefined, context);
        const memberId = await requireCurrentActiveTeamMember(client, context, teamRunId);
        const result = await client.approveWorkRequest(params.work_request_id, {
          teamRunId,
          requesterMemberId: memberId,
        });
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
        const teamRunId = resolveTeamRunId(undefined, context);
        const memberId = await requireCurrentActiveTeamMember(client, context, teamRunId);
        const result = await client.rejectWorkRequest(params.work_request_id, {
          teamRunId,
          requesterMemberId: memberId,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'cancel_work_request',
    'Cancel a pending or queued TeamRun WorkRequest.',
    CancelWorkRequestInput.shape,
    async (params) => {
      try {
        const teamRunId = resolveTeamRunId(params.team_run_id, context);
        const memberId = await requireCurrentActiveTeamMember(client, context, teamRunId);
        const result = await client.cancelWorkRequest(params.work_request_id, {
          teamRunId,
          requesterMemberId: memberId,
        });
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
        const teamRunId = resolveTeamRunId(params.team_run_id, context);
        await requireCurrentMemberCapabilities(client, context, teamRunId, ['stopMemberWork']);
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

export async function createMcpServer(
  baseUrl: string,
  options: { internalApiToken?: string } = {},
): Promise<McpServer> {
  const client = new AgentTowerClient(baseUrl);
  client.setInternalApiToken(options.internalApiToken);
  const context = await fetchContext(client);
  client.setInvocationId(process.env.AGENT_TOWER_INVOCATION_ID ?? context?.invocationId);

  const server = new McpServer({
    name: 'agent-tower',
    version: '0.1.0',
  });

  // 注册所有 tools
  registerProjectTools(server, client);
  registerTaskTools(server, client);
  registerProviderTools(server, client);
  registerWorkspaceTools(server, client, context, {
    resolveBoundTeamRunId,
    requireCurrentMemberCapabilities,
  });
  registerSessionTools(server, client);
  registerTeamRoomTools(server, client, context);

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
