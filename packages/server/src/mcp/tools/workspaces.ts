/**
 * 工作空间相关 MCP tools
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentTowerClient } from '../http-client.js';
import {
  StartWorkspaceSessionInput,
  GetWorkspaceDiffInput,
  MergeWorkspaceInput,
} from '../types.js';

export function registerWorkspaceTools(server: McpServer, client: AgentTowerClient) {
  server.tool(
    'start_workspace_session',
    'Create a workspace and start an AI agent session for a task.',
    StartWorkspaceSessionInput.shape,
    async (params) => {
      try {
        // 1. 创建工作空间
        const workspace = await client.createWorkspace(params.task_id);
        // 2. 创建会话
        const session = await client.createSession(
          workspace.id,
          params.agent_type,
          params.prompt,
          params.variant
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
        const result = await client.mergeWorkspace(params.workspace_id);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  );
}
