#!/usr/bin/env node
/**
 * agent-tower MCP 服务器入口
 * 通过 stdio 传输与 MCP 客户端通信，代理调用 agent-tower 后端 API
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  // 按优先级确定后端 URL
  let port: number | string = process.env.AGENT_TOWER_PORT ?? 12580;
  // 开发模式: 尝试从 monorepo 路径计算确定性端口
  if (!process.env.AGENT_TOWER_PORT && !process.env.AGENT_TOWER_URL) {
    try {
      const monorepoRoot = path.resolve(__dirname, '../../..');
      const { getDevPort } = await import('@agent-tower/shared/dev-port');
      port = getDevPort(monorepoRoot);
    } catch {
      // 非 monorepo 环境（npm 全局安装），使用默认端口
    }
  }
  const baseUrl = process.env.AGENT_TOWER_URL ?? `http://127.0.0.1:${port}`;

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
