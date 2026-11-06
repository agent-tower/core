import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AgentTowerApiError, type AgentTowerClient } from '../http-client.js';
import type { McpContext } from '../context.js';
import type { WorkspaceToolAuth } from './workspaces.js';
import {
  ControlWorkspaceServiceInput,
  GetWorkspaceServiceLogsInput,
  ListWorkspaceServicesInput,
  ScheduleWakeupInput,
  SendWorkspaceServiceInput,
  StartWorkspaceServiceInput,
  WaitForWorkspaceServiceInput,
} from '../types.js';

function errorResult(error: unknown) {
  if (error instanceof AgentTowerApiError) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({
        error: error.apiMessage,
        code: error.code,
        status: error.status,
      }) }],
      isError: true,
    };
  }
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        error: error instanceof Error ? error.message : 'Workspace service request failed',
        code: 'INTERNAL_ERROR',
      }),
    }],
    isError: true,
  };
}

async function requireRunCommands(
  client: AgentTowerClient,
  context: McpContext,
  auth?: WorkspaceToolAuth,
): Promise<void> {
  const teamRunId = auth?.resolveBoundTeamRunId(context);
  if (teamRunId && auth) {
    try {
      await auth.requireCurrentMemberCapabilities(client, context, teamRunId, ['runCommands']);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'TeamRun authorization failed';
      throw new AgentTowerApiError(
        403,
        message.includes('lacks required capabilities')
          ? 'TEAM_RUN_MEMBER_CAPABILITY_REQUIRED'
          : 'FORBIDDEN',
        message,
      );
    }
  }
}

export function registerWorkspaceServiceTools(
  server: McpServer,
  client: AgentTowerClient,
  context: McpContext | null,
  auth?: WorkspaceToolAuth,
): void {
  if (!context?.workspaceId) return;
  const workspaceId = context.workspaceId;

  server.tool(
    'start_workspace_service',
    'Start a long-running server, watcher, or background worker owned by the current workspace. Use this instead of the normal terminal for commands expected to keep running after the agent turn ends.',
    StartWorkspaceServiceInput.shape,
    async (params) => {
      try {
        await requireRunCommands(client, context, auth);
        const result = await client.startWorkspaceService(workspaceId, params.service_name, {
          command: params.command,
          args: params.args,
          relativeCwd: params.relative_cwd,
        });
        if (!params.wake_on_exit) {
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }
        const wakeup = await client.waitForWorkspaceService(workspaceId, params.service_name);
        return { content: [{ type: 'text', text: JSON.stringify({
          ...result,
          wakeup,
          note: 'Finish your turn now. Agent Tower re-invokes this session with a system notification when the service exits.',
        }, null, 2) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'list_workspace_services',
    'List long-running services and their current state in the current workspace.',
    ListWorkspaceServicesInput.shape,
    async () => {
      try {
        await requireRunCommands(client, context, auth);
        const result = await client.listWorkspaceServices(workspaceId);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'get_workspace_service_logs',
    'Read a bounded page of logs from a long-running service in the current workspace.',
    GetWorkspaceServiceLogsInput.shape,
    async (params) => {
      try {
        await requireRunCommands(client, context, auth);
        const result = await client.getWorkspaceServiceLogs(workspaceId, params.service_name, {
          afterSeq: params.after_seq,
          runtimeInstanceId: params.runtime_instance_id,
          limit: params.limit,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'send_workspace_service_input',
    'Write input to a running workspace service PTY.',
    SendWorkspaceServiceInput.shape,
    async (params) => {
      try {
        await requireRunCommands(client, context, auth);
        const result = await client.sendWorkspaceServiceInput(workspaceId, params.service_name, params.data);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'control_workspace_service',
    'Stop or restart an existing long-running service in the current workspace.',
    ControlWorkspaceServiceInput.shape,
    async (params) => {
      try {
        await requireRunCommands(client, context, auth);
        const result = await client.controlWorkspaceService(
          workspaceId,
          params.service_name,
          params.action,
        );
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'wait_for_workspace_service',
    'Ask Agent Tower to re-invoke this session with a system notification when a workspace service exits. Returns immediately; finish your turn afterwards instead of polling the logs.',
    WaitForWorkspaceServiceInput.shape,
    async (params) => {
      try {
        await requireRunCommands(client, context, auth);
        const wakeup = await client.waitForWorkspaceService(workspaceId, params.service_name);
        return { content: [{ type: 'text', text: JSON.stringify({
          wakeup,
          note: 'Finish your turn now. You will be re-invoked when the service exits; the notification includes its exit code and last log lines.',
        }, null, 2) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.tool(
    'schedule_wakeup',
    'Ask Agent Tower to re-invoke this session after a delay with a system notification. Use it instead of sleeping inside your turn; finish your turn after scheduling.',
    ScheduleWakeupInput.shape,
    async (params) => {
      try {
        const sessionId = process.env.AGENT_TOWER_SESSION_ID;
        if (!sessionId) {
          throw new AgentTowerApiError(400, 'SESSION_CONTEXT_REQUIRED', 'schedule_wakeup requires an Agent Tower session context');
        }
        const wakeup = await client.scheduleWakeup(sessionId, { delaySeconds: params.delay_seconds, reason: params.reason });
        return { content: [{ type: 'text', text: JSON.stringify({
          wakeup,
          note: 'Finish your turn now. You will be re-invoked when the wake-up fires.',
        }, null, 2) }] };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
