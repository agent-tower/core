/**
 * MCP 服务器创建与 tool 注册
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AgentTowerClient } from './http-client.js';
import { fetchContext, type McpContext } from './context.js';
import { registerProjectTools } from './tools/projects.js';
import { registerTaskTools } from './tools/tasks.js';
import { registerWorkspaceTools } from './tools/workspaces.js';
import { registerSessionTools } from './tools/sessions.js';

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
  registerWorkspaceTools(server, client);
  registerSessionTools(server, client);

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
