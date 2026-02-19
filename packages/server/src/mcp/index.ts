#!/usr/bin/env node
/**
 * agent-tower MCP 服务器入口
 * 通过 stdio 传输与 MCP 客户端通信，代理调用 agent-tower 后端 API
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getDevPort } from '@agent-tower/shared/dev-port';
import { createMcpServer } from './server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  // 按优先级确定后端 URL
  const monorepoRoot = path.resolve(__dirname, '../../..');
  const baseUrl = process.env.AGENT_TOWER_URL
    ?? `http://127.0.0.1:${process.env.AGENT_TOWER_PORT ?? getDevPort(monorepoRoot)}`;

  console.error(`[agent-tower-mcp] Connecting to backend at ${baseUrl}`);

  const server = await createMcpServer(baseUrl);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[agent-tower-mcp] MCP server started (stdio)');
}

main().catch((err) => {
  console.error('[agent-tower-mcp] Fatal error:', err);
  process.exit(1);
});
