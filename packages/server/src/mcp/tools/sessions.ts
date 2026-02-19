/**
 * 会话相关 MCP tools
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentTowerClient } from '../http-client.js';
import { StopSessionInput, SendMessageInput } from '../types.js';

export function registerSessionTools(server: McpServer, client: AgentTowerClient) {
  server.tool(
    'stop_session',
    'Stop a running AI agent session.',
    StopSessionInput.shape,
    async (params) => {
      try {
        await client.stopSession(params.session_id);
        return { content: [{ type: 'text', text: JSON.stringify({ success: true }, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  );

  server.tool(
    'send_message',
    'Send a message to a running or completed AI agent session.',
    SendMessageInput.shape,
    async (params) => {
      try {
        await client.sendMessage(params.session_id, params.message);
        return { content: [{ type: 'text', text: JSON.stringify({ success: true }, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  );
}
