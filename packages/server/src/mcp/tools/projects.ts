/**
 * 项目相关 MCP tools
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentTowerClient } from '../http-client.js';

export function registerProjectTools(server: McpServer, client: AgentTowerClient) {
  server.tool(
    'list_projects',
    'List all projects',
    {},
    async () => {
      try {
        const result = await client.listProjects();
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  );
}
