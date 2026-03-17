/**
 * Provider 相关 MCP tools
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentTowerClient } from '../http-client.js';
import { ListProvidersInput } from '../types.js';

export function registerProviderTools(server: McpServer, client: AgentTowerClient) {
  server.tool(
    'list_providers',
    'List all configured AI agent providers with their availability status.',
    ListProvidersInput.shape,
    async () => {
      try {
        const result = await client.listProviders();
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
      }
    }
  );
}
